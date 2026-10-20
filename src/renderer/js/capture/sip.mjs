import { reassembleStream } from './reassemble.mjs';
import { parseSdp } from './sdp.mjs';

// RFC 3261 message boundaries are octet-based. Calls span transport legs, while
// reassembly remains owned by reassembleStream and UDP datagrams stay separate.
export const SIP_LIMITS = Object.freeze({
  maxScanPackets: 200000, maxTcpStreams: 256, maxInputBytes: 32 * 1024 * 1024,
  maxStreamBytes: 4 * 1024 * 1024, maxHeaderBytes: 64 * 1024,
  maxBodyBytes: 256 * 1024, maxMessages: 2000, maxCalls: 1000,
  maxRetransmissionWorkBytes: 64 * 1024 * 1024,
});
const utf8 = new TextDecoder('utf-8');
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const latin = new TextDecoder('iso-8859-1');
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const REQUEST = new RegExp(`^(${TOKEN}) ([^\\x00-\\x20\\x7f]+) SIP/2\\.0$`);
const RESPONSE = /^SIP\/2\.0 ([1-6][0-9]{2})(?: ([^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*))?$/;
const TOKEN_RE = new RegExp(`^${TOKEN}$`);
const COMPACT = { i: 'call-id', f: 'from', t: 'to', v: 'via', c: 'content-type', l: 'content-length', e: 'content-encoding' };
const ows = (value) => value.replace(/^[ \t]+|[ \t]+$/g, '');
const note = (list, value) => { if (!list.includes(value)) list.push(value); };
const endpoint = (address, port) => `${String(address).includes(':') ? '[' + address + ']' : address}:${port}`;
const overlap = (a, b, start, end) => a < end && b > start;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function find(bytes, pattern, start, end = bytes.length) {
  outer: for (let i = start; i <= end - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}
function join(parts, length) {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
function startAt(bytes, offset = 0) {
  const end = find(bytes, [13, 10], offset, Math.min(bytes.length, offset + 4096));
  const line = utf8.decode(bytes.subarray(offset, end < 0 ? Math.min(bytes.length, offset + 4096) : end));
  const request = REQUEST.exec(line), response = RESPONSE.exec(line);
  return request ? { type: 'request', method: request[1], status: null, reason: null, startLine: line, lineEnd: end }
    : response ? { type: 'response', method: null, status: Number(response[1]), reason: response[2] || '', startLine: line, lineEnd: end }
      : null;
}

function parseHeaders(text, warnings) {
  const headers = [];
  let valid = true;
  for (const line of text.split('\r\n')) {
    if (!line) continue;
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line)) {
      note(warnings, 'Forbidden control byte in SIP headers.'); valid = false; continue;
    }
    if (/^[ \t]/.test(line)) {
      if (!headers.length) { note(warnings, 'Header continuation has no preceding field.'); valid = false; }
      else headers[headers.length - 1].value += ' ' + ows(line);
      continue;
    }
    const colon = line.indexOf(':');
    const name = ows(line.slice(0, colon)).toLowerCase();
    if (colon < 1 || !TOKEN_RE.test(name)) { note(warnings, 'Malformed SIP header field.'); valid = false; continue; }
    headers.push({ name: COMPACT[name] || name, value: ows(line.slice(colon + 1)) });
  }
  return { headers, valid };
}
function single(headers, name, warnings) {
  const fields = headers.filter((h) => h.name === name);
  if (fields.length > 1) { note(warnings, `Duplicate ${name} fields are ambiguous.`); return { value: null, ambiguous: true }; }
  return { value: fields[0]?.value ?? null, ambiguous: false };
}

// Split only outside quoted strings and URI brackets; tag/branch text inside a
// display name or URI is not a header parameter.
function splitOutside(value, separator) {
  const parts = [];
  let quote = false, escaped = false, angle = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) { escaped = false; continue; }
    if (quote && char === '\\') { escaped = true; continue; }
    if (char === '"') quote = !quote;
    if (quote) continue;
    if (char === '<') angle++;
    if (char === '>') angle = Math.max(0, angle - 1);
    if (!angle && char === separator) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  parts.push(value.slice(start));
  return { parts, valid: !quote && !escaped && angle === 0 };
}
function parameter(value, name, warnings) {
  if (value == null) return null;
  const parsed = splitOutside(value, ';');
  if (!parsed.valid) { note(warnings, `Unbalanced quoting or brackets prevent reading ${name}.`); return null; }
  const found = parsed.parts.slice(1).filter((part) => ows(part.split('=')[0]).toLowerCase() === name);
  if (found.length > 1) { note(warnings, `Duplicate ${name} parameters are ambiguous.`); return null; }
  if (!found.length) return null;
  const index = found[0].indexOf('=');
  const result = index < 0 ? '' : ows(found[0].slice(index + 1));
  if (!TOKEN_RE.test(result)) { note(warnings, `Invalid ${name} parameter.`); return null; }
  return result;
}

function identity(message) {
  let valid = true;
  const field = (name) => { const result = single(message.headers, name, message.warnings); if (result.ambiguous) valid = false; return result.value; };
  const callId = field('call-id');
  message.callId = callId && /^[^\x00-\x20\x7f]+$/.test(callId) ? callId : null;
  if (!message.callId) note(message.warnings, 'Call-ID is missing, invalid or ambiguous; this message cannot be assigned to a known call.');
  message.from = field('from');
  message.to = field('to');
  message.fromTag = parameter(message.from, 'tag', message.warnings);
  message.toTag = parameter(message.to, 'tag', message.warnings);
  const cseq = field('cseq');
  const match = cseq && new RegExp(`^(\\d+)[ \\t]+(${TOKEN})$`).exec(cseq);
  message.cseq = match && Number(match[1]) <= 0xffffffff ? { number: Number(match[1]), method: match[2] } : null;
  if (!message.cseq) note(message.warnings, 'CSeq is missing, invalid or ambiguous; transaction association is unknown.');
  if (message.type === 'request' && message.cseq && message.method !== message.cseq.method) {
    note(message.warnings, 'CSeq method differs from the request method.'); message.cseq = null; valid = false;
  }
  if (message.type === 'response') message.method = message.cseq?.method || null;
  const via = message.headers.find((h) => h.name === 'via')?.value;
  const topVia = via && splitOutside(via, ',');
  message.branch = topVia?.valid ? parameter(topVia.parts[0], 'branch', message.warnings) : null;
  if (!message.branch) note(message.warnings, 'Top Via branch is unavailable; transaction association is unknown.');
  return valid;
}
function unknownIdentity(message) {
  message.callId = null;
  message.fromTag = null;
  message.toTag = null;
  message.cseq = null;
  message.branch = null;
  if (message.type === 'response') message.method = null;
}

function frameSources(context, start, end) {
  if (context.packet) return [context.packet.no];
  const frames = new Set();
  const ranges = context.direction.ranges;
  let low = 0, high = ranges.length;
  while (low < high) { const mid = (low + high) >>> 1; if (ranges[mid].end <= start) low = mid + 1; else high = mid; }
  for (let i = low; i < ranges.length && ranges[i].start < end; i++) {
    const range = ranges[i];
    if (range.kind !== 'data' || !overlap(range.start, range.end, start, end)) continue;
    for (const source of range.sources) if (overlap(source.start, source.end, start, end)) frames.add(source.frame);
  }
  return [...frames].sort((a, b) => a - b);
}

function parseMessages(bytes, context, state) {
  let pos = 0;
  while (pos < bytes.length) {
    if (context.transport === 'TCP') while (bytes[pos] === 13 && bytes[pos + 1] === 10) pos += 2;
    if (pos === bytes.length) break;
    const first = startAt(bytes, pos);
    if (!first) break; // Opaque/encrypted bytes are not guessed to be SIP.
    if (state.messages.length >= state.limits.maxMessages) { state.limit('SIP message limit reached; remaining messages were not analyzed.'); break; }
    const begin = pos;
    const warnings = [...context.warnings];
    const message = {
      id: `sip-message-${state.messages.length + 1}`, ...first, headers: [], bodyText: '', rawText: '',
      callId: null, from: null, to: null, fromTag: null, toTag: null, cseq: null, branch: null,
      src: context.src, dst: context.dst, transport: context.transport, ts: null, frames: [],
      complete: false, warnings, retransmission: false, dialogId: null, transactionId: null, sdp: null,
    };
    delete message.lineEnd;
    state.messages.push(message);
    const headerEnd = find(bytes, [13, 10, 13, 10], pos, Math.min(bytes.length, pos + state.limits.maxHeaderBytes));
    const headerStop = headerEnd < 0 ? Math.min(bytes.length, pos + state.limits.maxHeaderBytes) : headerEnd;
    let headerText, headerEncodingValid = true;
    let completeHeaderStop = headerStop;
    if (headerEnd < 0) {
      // An unfinished field can have an unfinished Call-ID. Only terminated
      // header lines are attributable when the header block is incomplete.
      completeHeaderStop = first.lineEnd < 0 ? headerStop : first.lineEnd + 2;
      for (let at = completeHeaderStop; at + 1 < headerStop; at++) if (bytes[at] === 13 && bytes[at + 1] === 10) completeHeaderStop = at + 2;
    }
    const headerBytes = bytes.subarray(first.lineEnd < 0 ? headerStop : first.lineEnd + 2, completeHeaderStop);
    try { headerText = strictUtf8.decode(headerBytes); }
    catch { headerText = latin.decode(headerBytes); headerEncodingValid = false; note(warnings, 'Invalid UTF-8 in SIP headers; identity is uncertain.'); }
    const parsed = parseHeaders(headerText, warnings);
    message.headers = parsed.headers;
    const identityValid = identity(message);
    const length = single(message.headers, 'content-length', warnings);
    const type = single(message.headers, 'content-type', warnings);
    const encoding = single(message.headers, 'content-encoding', warnings);
    let body = new Uint8Array();
    let stop = false;
    if (headerEnd < 0) {
      pos = headerStop;
      note(warnings, 'SIP header block is incomplete or exceeds the header limit.');
      if (headerStop < bytes.length) state.limit('SIP header byte limit reached.');
      stop = true;
    } else {
      pos = headerEnd + 4;
      const numericLength = length.value != null && /^\d+$/.test(length.value) && Number.isSafeInteger(Number(length.value)) ? Number(length.value) : null;
      const missingStreamLength = context.transport === 'TCP' && length.value == null;
      const invalidLength = length.ambiguous || (length.value != null && numericLength == null);
      if (missingStreamLength || invalidLength) {
        note(warnings, missingStreamLength ? 'SIP over TCP requires an unambiguous Content-Length; message boundary is unknown.' : 'SIP Content-Length is invalid or ambiguous.');
        body = bytes.subarray(pos, Math.min(bytes.length, pos + state.limits.maxBodyBytes));
        pos += body.length;
        stop = true;
      } else {
        const desired = numericLength ?? bytes.length - pos;
        const take = Math.min(desired, bytes.length - pos, state.limits.maxBodyBytes);
        body = bytes.subarray(pos, pos + take);
        pos += take;
        message.complete = take === desired && parsed.valid && headerEncodingValid && identityValid && !type.ambiguous && !encoding.ambiguous;
        if (take < desired) {
          note(warnings, `SIP body is incomplete: ${take} of ${desired} bytes available before a gap or capture end.`);
          if (desired > state.limits.maxBodyBytes) state.limit('SIP body byte limit reached.');
          stop = true;
        }
      }
    }
    const absoluteStart = context.start + begin, absoluteEnd = context.start + pos;
    message.frames = frameSources(context, absoluteStart, absoluteEnd);
    message.ts = message.frames.map((frame) => state.packetByNo.get(frame)?.ts).filter(finite).reduce((min, ts) => min == null ? ts : Math.min(min, ts), null);
    if (context.incomplete) { message.complete = false; note(warnings, 'Capture truncation, IP fragmentation or resource limits make this message incomplete.'); }
    if (context.direction?.conflicts.some((range) => overlap(range.start, range.end, absoluteStart, absoluteEnd))) {
      message.complete = false; note(warnings, 'Conflicting TCP overlap affects this SIP message.');
      if (context.direction.conflicts.some((range) => overlap(range.start, range.end, absoluteStart, context.start + headerStop))) {
        unknownIdentity(message); note(warnings, 'Conflicting SIP header bytes prevent reliable call assignment.');
      }
    }
    if (!headerEncodingValid) unknownIdentity(message);
    const wire = bytes.subarray(begin, pos);
    state.wire.set(message, wire);
    message.rawText = utf8.decode(wire);
    const mediaType = type.value ? ows(type.value.split(';')[0]).toLowerCase() : '';
    const bodyEncoded = encoding.ambiguous || (encoding.value != null && encoding.value.toLowerCase() !== 'identity');
    if (bodyEncoded) note(warnings, 'Encoded SIP message bodies are not decoded.');
    else {
      try { message.bodyText = strictUtf8.decode(body); }
      catch { message.bodyText = utf8.decode(body); note(warnings, 'SIP body is not valid UTF-8; replacement characters are shown.'); message.complete = false; }
      if (mediaType === 'application/sdp' && body.length) {
        if (message.complete) {
          message.sdp = parseSdp(message.bodyText);
          for (const warning of message.sdp.warnings || []) note(warnings, `SDP: ${warning}`);
        } else note(warnings, 'SDP media details are unavailable because this message is incomplete or ambiguous.');
      }
    }
    if (context.transport === 'UDP') {
      if (pos < bytes.length) note(warnings, `${bytes.length - pos} trailing datagram bytes are outside the declared SIP message.`);
      break;
    }
    if (stop || !parsed.valid || !identityValid) break;
  }
}

function sameBytes(a, b, state) {
  if (a.length !== b.length) return false;
  if (state.comparedBytes + a.length > state.limits.maxRetransmissionWorkBytes) {
    state.limit('SIP retransmission comparison limit reached; further duplicate classification is unknown.'); return null;
  }
  state.comparedBytes += a.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function wireHash(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `${bytes.length}:${hash >>> 0}`;
}
function timeRange(messages) {
  const times = messages.map((m) => m.ts).filter(finite);
  return { startTime: times.length ? Math.min(...times) : null, endTime: times.length ? Math.max(...times) : null };
}
function elapsed(start, end) { return finite(start) && finite(end) && end >= start ? end - start : null; }
function callOutcome(messages) {
  const unique = messages.filter((m) => !m.retransmission);
  const answered = unique.find((m) => m.type === 'response' && m.method === 'INVITE' && m.status >= 200 && m.status < 300 && m.complete);
  const invite = unique.find((m) => m.type === 'request' && m.method === 'INVITE');
  const tags = (m) => m?.fromTag && m.toTag ? JSON.stringify([m.fromTag, m.toTag].sort()) : null;
  const bye = answered && tags(answered) && unique.find((m) => m.type === 'response' && m.method === 'BYE' && m.status >= 200 && m.status < 300 && m.complete && tags(m) === tags(answered) && elapsed(answered.ts, m.ts) != null);
  let outcome = 'SIP messages observed';
  if (answered) outcome = bye ? 'Ended (BYE success observed)' : 'Answered (INVITE success observed)';
  else {
    const lastInvite = unique.filter((m) => m.type === 'request' && m.method === 'INVITE').at(-1);
    const finals = unique.filter((m) => m.type === 'response' && m.status >= 200 && m.complete && (!lastInvite || (m.method === 'INVITE' && m.cseq?.number === lastInvite.cseq?.number)));
    const final = finals.at(-1);
    if (final?.status === 401 || final?.status === 407) outcome = 'Authentication challenge observed';
    else if (final?.status >= 300 && final.status < 400) outcome = `Redirect response observed (${final.status})`;
    else if (final?.status >= 400) outcome = `Failure response observed (${final.status})`;
    else if (final) outcome = `Success response observed (${final.status})`;
    else if (invite) outcome = 'INVITE observed; final response not captured';
  }
  return { outcome, setupTime: answered && invite ? elapsed(invite.ts, answered.ts) : null, duration: answered && bye ? elapsed(answered.ts, bye.ts) : null };
}

function groupCalls(state) {
  const groups = new Map();
  const sorted = [...state.messages].sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity) || (a.frames[0] ?? Infinity) - (b.frames[0] ?? Infinity));
  for (const message of sorted) {
    const key = message.callId == null ? message : message.callId;
    let call = groups.get(key);
    if (!call) {
      if (groups.size >= state.limits.maxCalls) { state.limit('SIP call limit reached; additional call groups were omitted.'); continue; }
      call = { id: `sip-call-${groups.size + 1}`, callId: message.callId, from: message.from, to: message.to, messages: [], frames: [], warnings: [], dialogs: [], transactions: [] };
      groups.set(key, call);
    }
    call.messages.push(message);
  }
  for (const call of groups.values()) {
    const dialogs = new Map(), transactions = new Map(), seen = new Map();
    for (const message of call.messages) {
      for (const warning of message.warnings) note(call.warnings, warning);
      if (message.fromTag && message.toTag) {
        const key = JSON.stringify([message.fromTag, message.toTag].sort());
        let dialog = dialogs.get(key);
        if (!dialog) {
          dialog = { id: `${call.id}-dialog-${dialogs.size + 1}`, fromTag: message.fromTag, toTag: message.toTag, messages: [], frames: [], warnings: [] };
          dialogs.set(key, dialog);
        }
        message.dialogId = dialog.id;
        dialog.messages.push(message);
      }
      if (message.branch && message.cseq) {
        const key = JSON.stringify([message.branch, message.cseq.number, message.cseq.method, message.fromTag, ...[message.src, message.dst].sort(), message.transport]);
        let transaction = transactions.get(key);
        if (!transaction) {
          transaction = { id: `${call.id}-transaction-${transactions.size + 1}`, branch: message.branch, cseq: message.cseq, messages: [], frames: [], warnings: [] };
          transactions.set(key, transaction);
        }
        message.transactionId = transaction.id;
        transaction.messages.push(message);
      }
      const repeatKey = JSON.stringify([message.src, message.dst, message.transport, message.startLine, message.branch, message.cseq, wireHash(state.wire.get(message))]);
      const prior = seen.get(repeatKey) || [];
      if (message.complete) for (const other of prior) {
        if (!other.complete) continue;
        const same = sameBytes(state.wire.get(other), state.wire.get(message), state);
        if (same === null) {
          message.retransmissionUnknown = true;
          note(message.warnings, 'Retransmission classification is unknown because its comparison limit was reached.');
          note(call.warnings, 'Some retransmission classifications are unknown because a resource limit was reached.');
          break;
        }
        if (same) { message.retransmission = true; break; }
      }
      prior.push(message);
      seen.set(repeatKey, prior);
    }
    call.frames = [...new Set(call.messages.flatMap((m) => m.frames))].sort((a, b) => a - b);
    Object.assign(call, timeRange(call.messages), callOutcome(call.messages));
    for (const dialog of dialogs.values()) {
      const initial = call.messages.filter((m) => m.type === 'request' && m.method === 'INVITE' && !m.toTag && (m.fromTag === dialog.fromTag || m.fromTag === dialog.toTag));
      const events = [...initial, ...dialog.messages].sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));
      dialog.frames = [...new Set(dialog.messages.flatMap((m) => m.frames))].sort((a, b) => a - b);
      dialog.warnings = [...new Set(dialog.messages.flatMap((m) => m.warnings))];
      Object.assign(dialog, timeRange(events), callOutcome(events));
    }
    for (const transaction of transactions.values()) {
      transaction.frames = [...new Set(transaction.messages.flatMap((m) => m.frames))].sort((a, b) => a - b);
      transaction.request = transaction.messages.find((m) => m.type === 'request') || null;
      transaction.responses = transaction.messages.filter((m) => m.type === 'response');
      transaction.response = transaction.responses.find((m) => m.status >= 200) || null;
      transaction.elapsed = transaction.request && transaction.response ? elapsed(transaction.request.ts, transaction.response.ts) : null;
    }
    call.dialogs = [...dialogs.values()];
    call.transactions = [...transactions.values()];
    const answered = call.dialogs.filter((d) => /^(Answered|Ended)/.test(d.outcome));
    if (answered.length === 1) { call.outcome = answered[0].outcome; call.duration = answered[0].duration; }
    if (answered.length > 1) {
      call.outcome = answered.every((d) => d.outcome.startsWith('Ended')) ? `Ended (${answered.length} answered dialogs observed)` : `Answered (${answered.length} dialogs observed)`;
      call.duration = null;
      note(call.warnings, 'Multiple answered dialogs are present; inspect their individual durations.');
    }
  }
  return [...groups.values()];
}

/** Analyze an existing decoded packet snapshot; never capture or execute traffic. */
export function analyzeSipCalls(packets, options = {}) {
  const limits = { ...SIP_LIMITS };
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw new RangeError(`Invalid SIP limit: ${key}`);
    limits[key] = value;
  }
  const state = {
    limits, messages: [], warnings: [], limited: false, scannedPackets: 0, comparedBytes: 0, packetByNo: new Map(), wire: new WeakMap(),
    limit(warning) { this.limited = true; note(this.warnings, warning); },
  };
  const tcp = new Map();
  let inputBytes = 0;
  for (const packet of packets) {
    if (state.scannedPackets >= limits.maxScanPackets) { state.limit('Packet scan limit reached; capture-wide SIP coverage is incomplete.'); break; }
    state.scannedPackets++;
    state.packetByNo.set(packet.no, packet);
    const d = packet.d;
    if (!d || (!d.udp && !d.tcp)) continue;
    const length = d.payloadLen || 0, offset = d.payloadOff;
    const payload = Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length >= 0 && packet.data instanceof Uint8Array
      ? packet.data.subarray(offset, Math.min(packet.data.length, offset + length)) : new Uint8Array();
    if (d.udp) {
      if (!startAt(payload)) continue;
      if (inputBytes + payload.length > limits.maxInputBytes) { state.limit('SIP analysis byte budget reached; later payload was not examined.'); break; }
      inputBytes += payload.length;
      parseMessages(payload, {
        packet, start: 0, transport: 'UDP', src: endpoint(d.src, d.sport), dst: endpoint(d.dst, d.dport), warnings: [],
        incomplete: !!d.fragmented || payload.length < length || packet.caplen < packet.len,
      }, state);
      continue;
    }
    // No arbitrary TCP boundary is guessed when the Analyzer has not identified
    // a connection. Reusing its stream identity also avoids merging port reuse.
    if (packet.ann?.stream == null) { if (startAt(payload)) note(state.warnings, 'SIP-looking TCP packets without stream identity were not reconstructed.'); continue; }
    const key = packet.ann.stream;
    let group = tcp.get(key);
    if (!group) {
      if (tcp.size >= limits.maxTcpStreams) { state.limit('TCP conversation limit reached; additional TCP streams were not examined.'); continue; }
      group = { packets: [], bytes: 0, limited: false, conv: { id: key, proto: 'TCP', a: `${d.src}:${d.sport}`, b: `${d.dst}:${d.dport}` }, endpoints: [endpoint(d.src, d.sport), endpoint(d.dst, d.dport)] };
      tcp.set(key, group);
    }
    if (group.bytes + payload.length > limits.maxStreamBytes) { group.limited = true; state.limit('A TCP stream exceeded the SIP analysis byte limit.'); continue; }
    if (inputBytes + payload.length > limits.maxInputBytes) { group.limited = true; state.limit('SIP analysis byte budget reached; later payload was not examined.'); break; }
    group.bytes += payload.length;
    inputBytes += payload.length;
    group.packets.push(packet);
  }
  for (const group of tcp.values()) {
    if (!group.bytes) continue;
    const rebuilt = reassembleStream(group.packets, group.conv, { maxBytes: limits.maxStreamBytes });
    if (rebuilt.limited) state.limit('TCP reassembly limits reduced SIP analysis coverage.');
    for (const direction of rebuilt.directions) {
      const parts = [];
      let length = 0, start = null, end = null, gap = false;
      for (const range of direction.ranges) {
        if (range.kind === 'gap') { gap = true; break; }
        if (end !== null && range.start !== end) { gap = true; break; }
        if (start === null) start = range.start;
        parts.push(range.data); length += range.data.length; end = range.end;
      }
      const data = join(parts, length);
      const warnings = [...direction.warnings];
      if (gap) note(warnings, 'SIP parsing stops at a missing TCP byte range; later bytes are not joined across the gap.');
      if (!direction.startKnown) note(warnings, 'The start of this TCP direction was not captured; earlier SIP context is unknown.');
      const before = state.messages.length;
      parseMessages(data, {
        direction, start: start ?? 0, transport: 'TCP', src: group.endpoints[direction.fromA ? 0 : 1], dst: group.endpoints[direction.fromA ? 1 : 0],
        warnings, incomplete: group.limited || direction.limited || direction.truncated,
      }, state);
      if (state.messages.length > before && gap) note(state.warnings, 'A SIP TCP stream has missing bytes; messages after its first gap were not analyzed.');
    }
  }
  return { calls: groupCalls(state), warnings: state.warnings, limited: state.limited, scannedPackets: state.scannedPackets };
}
