// Offline observations from bounded captured evidence. No network probes, TLS
// decryption, capture-wide health claims, or alignment of separate capture clocks.
import { decode } from './decode.mjs';
import { reassembleStream } from './reassemble.mjs';
import { parseHttpStream } from './http.mjs';

export const COMPARE_LIMITS = Object.freeze({ maxPackets: 50000, maxBytes: 64 * 1024 * 1024,
  maxFlows: 500, maxQuestions: 500, maxHttpMessages: 1000, maxHttpMessagesPerFlow: 32,
  maxWorkBytes: 64 * 1024 * 1024, maxSources: 64, maxMetrics: 1500,
  maxSummaryBytes: 2 * 1024 * 1024, maxChanges: 2000, maxReportBytes: 8 * 1024 * 1024 });
const encoder = new TextEncoder();
const size = value => encoder.encode(JSON.stringify(value)).length;
const key = value => JSON.stringify(value);
const bounded = (value, cap = 512) => String(value ?? '').slice(0, cap);
const round = value => Math.round(value * 1000) / 1000;
const addWarning = (list, message) => { if (list.length < 64 && !list.includes(message)) list.push(message); };
const identityId = identity => key([identity.transport, identity.clientIp, identity.serverIp, identity.serverPort]);
const endpoint = (d, src = true) => `${src ? d.src : d.dst}:${src ? d.sport : d.dport}`;
const sourceSet = packets => new Set(packets.map(p => p.no));
const domains = value => bounded(value, 256).replace(/\.$/, '').toLowerCase();
const limitsOf = input => {
  const limits = { ...COMPARE_LIMITS };
  for (const [name, value] of Object.entries(input || {})) {
    if (!Object.hasOwn(limits, name) || !Number.isSafeInteger(value) || value < 1 || value > limits[name]) throw new RangeError('Invalid comparison limit: ' + name);
    limits[name] = value;
  }
  return limits;
};
const scope = [
  'Counts describe observed packets and transactions, not capture-wide health or proof that missing traffic failed.',
  'Service identity uses transport, client IP, server IP and server port. Client ephemeral ports are not matched across captures.',
  'Durations use timestamps within one transaction in one capture. Separate capture clocks are never aligned.',
  'Duplicate TCP sequence ranges are retransmission candidates; duplicate capture records, reordering and capture-point artifacts can look similar.',
  'HTTP comparison supports plaintext HTTP/1 using the existing reassembly and framing parser. TLS, HTTP/2 and HTTP/3 content is unavailable.',
  'DNS comparison supports decoded single-question UDP DNS. DNS over TCP, encrypted DNS, unsupported records and incomplete replies remain unknown.',
];

function timing(first, second) {
  if (!first || !second || first.timestampKnown === false || second.timestampKnown === false || !Number.isFinite(first.ts) || !Number.isFinite(second.ts)) return null;
  const elapsed = (second.ts - first.ts) * 1000;
  return elapsed < 0 || !Number.isFinite(elapsed) ? null : round(elapsed);
}
function durationSummary(values, unknown = 0) {
  return { samples: values.length, unknown, minMs: values.length ? Math.min(...values) : null,
    meanMs: values.length ? round(values.reduce((sum, n) => sum + n, 0) / values.length) : null,
    maxMs: values.length ? Math.max(...values) : null };
}
function metricSources(frames, limits) {
  const values = [...frames].sort((a, b) => a - b);
  return { sources: values.slice(0, limits.maxSources).map(frame => ({ frame })), sourceCount: values.length, sourcesLimited: values.length > limits.maxSources };
}
function metric(state, service, category, name, value, frames, status = 'observed', reason = null) {
  let item = { category, metric: name, value, status, ...metricSources(frames, state.limits) };
  if (reason) item.reason = reason;
  if (size(value) > 8192) { item.value = null; item.status = 'unknown'; item.reason = 'Metric value exceeds the display budget; original source frames remain available.'; }
  const bytes = size(item);
  if (state.metricCount >= state.limits.maxMetrics || state.metricBytes + bytes > Math.max(0, state.limits.maxSummaryBytes - 256 * 1024)) {
    state.coverage.limited = true; addWarning(state.warnings, 'Summary metric/display limit reached; omitted observations remain unknown.'); return;
  }
  state.metricCount++; state.metricBytes += bytes; service.metrics.push(item);
}
function serviceFor(state, identity) {
  const id = identityId(identity);
  let service = state.services.get(id);
  if (!service) {
    if (state.services.size >= state.limits.maxFlows) { state.coverage.limited = true; addWarning(state.warnings, 'Service identity limit reached.'); return null; }
    service = { id, identity, coverage: 'observed', metrics: [], warnings: [], _dns: new Map(), _tcp: [], _http: [] };
    state.services.set(id, service);
  }
  return service;
}
function damage(packet) { return !!packet.d.malformed || !!packet.d.fragmented || packet.caplen !== packet.len || packet.data.length !== packet.caplen; }
function freshState(label, limits, sourceCoverage) {
  const coverage = { providedPackets: 0, examinedPackets: 0, examinedBytes: 0, examinedAllProvided: true,
    limited: !!sourceCoverage?.limited, truncatedPackets: 0, malformedPackets: 0, fragmentedPackets: 0,
    missingTimestamps: 0, unclassifiedPackets: 0, flowCount: 0, sourceRecordsComplete: typeof sourceCoverage?.examinedAllRecords === 'boolean' ? sourceCoverage.examinedAllRecords : null,
    sourceTruncated: !!sourceCoverage?.truncated };
  const warnings = [];
  for (const warning of (Array.isArray(sourceCoverage?.warnings) ? sourceCoverage.warnings : []).slice(0, 32)) addWarning(warnings, bounded(warning));
  if (coverage.sourceRecordsComplete === null) addWarning(warnings, 'Source-file record coverage is unknown; file completeness has not been established.');
  return { label: bounded(label || 'Capture', 256), limits, coverage, warnings, services: new Map(), flows: new Map(), allFlows: [],
    unidentified: [], metricCount: 0, metricBytes: 0, questions: 0, httpMessages: 0, workBytes: limits.maxWorkBytes };
}

function addDns(state, packet) {
  const d = packet.d, dns = d.dns;
  if (!dns || dns.kind !== 'DNS' || !d.udp) return;
  const identity = { transport: 'UDP', clientIp: dns.qr ? d.dst : d.src, serverIp: dns.qr ? d.src : d.dst, serverPort: dns.qr ? d.sport : d.dport };
  const service = serviceFor(state, identity); if (!service) return;
  const name = domains(dns.qname), qtype = dns.qtype, qclass = dns.questions?.[0]?.class ?? null, questionKey = key([name, qtype, qclass]);
  let question = service._dns.get(questionKey);
  if (!question) {
    if (state.questions >= state.limits.maxQuestions) { state.coverage.limited = true; addWarning(service.warnings, 'DNS question limit reached.'); return; }
    state.questions++;
    question = { name, qtype, qclass, queries: 0, responses: 0, answers: new Map(), rcodes: new Map(), pending: new Map(),
      durations: [], unknownTiming: 0, unanswered: 0, frames: new Set(), responseFrames: new Set(), timingFrames: new Set(), partial: false };
    service._dns.set(questionKey, question);
  }
  question.frames.add(packet.no);
  const complete = !damage(packet) && dns.complete === true && dns.questionCount === 1 && !dns.truncated && dns.answers.every(a => a.decoded === true);
  if (!complete) { question.partial = true; service.coverage = 'partial'; addWarning(service.warnings, 'Incomplete, truncated, multi-question or unsupported DNS records prevent a complete answer comparison.'); }
  const tuple = dns.qr ? [d.dst, d.dport, d.src, d.sport, dns.id, name, qtype, dns.questions?.[0]?.class] : [d.src, d.sport, d.dst, d.dport, dns.id, name, qtype, dns.questions?.[0]?.class];
  const transactionKey = key(tuple);
  if (!dns.qr) {
    question.queries++;
    const pending = question.pending.get(transactionKey);
    if (pending) { pending.count++; pending.frames.add(packet.no); }
    else question.pending.set(transactionKey, { packet, count: 1, frames: new Set([packet.no]), complete });
  } else {
    question.responses++; question.responseFrames.add(packet.no);
    question.rcodes.set(dns.rcode, (question.rcodes.get(dns.rcode) || 0) + 1);
    for (const answer of dns.answers) {
      if (question.answers.size >= 128) { question.partial = true; addWarning(service.warnings, 'DNS answer-set limit reached.'); break; }
      const record = { name: domains(answer.name), type: answer.type, class: answer.class ?? null, data: [2, 5, 12].includes(answer.type) ? domains(answer.data) : bounded(answer.data) };
      question.answers.set(key(record), record);
    }
    const pending = question.pending.get(transactionKey); question.pending.delete(transactionKey);
    const elapsed = pending?.count === 1 && pending.complete && complete ? timing(pending.packet, packet) : null;
    if (elapsed == null) question.unknownTiming++; else question.durations.push(elapsed);
    question.timingFrames.add(packet.no); if (pending) for (const frame of pending.frames) question.timingFrames.add(frame);
  }
}

function indexPackets(state, packets) {
  if (!Array.isArray(packets)) throw new TypeError('Capture packets must be an array');
  state.coverage.providedPackets = packets.length;
  const numbers = new Set();
  for (let index = 0; index < packets.length; index++) {
    if (index >= state.limits.maxPackets) { state.coverage.limited = true; state.coverage.examinedAllProvided = false; addWarning(state.warnings, 'Packet scan limit reached.'); break; }
    const source = packets[index];
    if (!source || !(source.data instanceof Uint8Array)) throw new TypeError('Every captured packet must contain a byte array');
    if (state.coverage.examinedBytes + source.data.length > state.limits.maxBytes) { state.coverage.limited = true; state.coverage.examinedAllProvided = false; addWarning(state.warnings, 'Captured-byte scan limit reached.'); break; }
    const no = source.no ?? index + 1;
    if (!Number.isSafeInteger(no) || no < 1 || numbers.has(no)) throw new Error('Original capture frame numbers must be distinct positive integers');
    numbers.add(no);
    const data = new Uint8Array(source.data), linktype = source.linktype ?? source.lt ?? 1;
    const decoded = decode(linktype, data);
    // Retain only owning-parser facts used by comparison/reassembly. Packet
    // trees, explanation strings, filters and credential previews are available
    // in the original capture and need not multiply memory for two snapshots.
    const facts = { src: decoded.src, dst: decoded.dst, sport: decoded.sport, dport: decoded.dport,
      tcp: decoded.tcp, udp: decoded.udp, dns: decoded.dns, proto: decoded.proto, tls: !!decoded.tls,
      malformed: !!decoded.malformed, fragmented: !!decoded.fragmented, payloadOff: decoded.payloadOff, payloadLen: decoded.payloadLen };
    const packet = { no, data, linktype, ts: source.ts, timestampKnown: source.timestampKnown !== false && Number.isFinite(source.ts),
      caplen: Number.isSafeInteger(source.caplen) && source.caplen >= 0 ? source.caplen : data.length,
      len: Number.isSafeInteger(source.len) && source.len >= 0 ? source.len : data.length, d: facts };
    state.coverage.examinedPackets++; state.coverage.examinedBytes += data.length;
    if (!packet.timestampKnown) state.coverage.missingTimestamps++;
    if (packet.caplen < packet.len || data.length < packet.caplen) state.coverage.truncatedPackets++;
    if (packet.d.malformed || packet.caplen > packet.len || packet.data.length > packet.caplen) state.coverage.malformedPackets++;
    if (packet.d.fragmented) state.coverage.fragmentedPackets++;
    addDns(state, packet);
    const d = packet.d;
    if (!d.tcp || !d.src || !d.dst || !Number.isInteger(d.sport) || !Number.isInteger(d.dport)) {
      if (!d.dns) state.coverage.unclassifiedPackets++; continue;
    }
    const endpoints = [endpoint(d), endpoint(d, false)], flowKey = key([...endpoints].sort());
    let flow = state.flows.get(flowKey);
    const freshSyn = !!(d.tcp.flags & 2) && !(d.tcp.flags & 16);
    if (flow && freshSyn && flow.synSeq != null && flow.synSeq !== d.tcp.seq) {
      if (flow.closed) flow = null;
      else { flow.ambiguous = true; addWarning(flow.warnings, 'A different SYN reused this transport tuple before a captured close; connection identity is ambiguous.'); }
    }
    if (!flow) {
      if (state.allFlows.length >= state.limits.maxFlows) { state.coverage.limited = true; addWarning(state.warnings, 'TCP flow limit reached; later flows were not reconstructed.'); continue; }
      flow = { id: state.allFlows.length, a: endpoints[0], b: endpoints[1], endpoints: [{ ip: d.src, port: d.sport }, { ip: d.dst, port: d.dport }],
        packets: [], synSeq: null, closed: false, ambiguous: false, warnings: [], payloadBytes: 0 };
      state.flows.set(flowKey, flow); state.allFlows.push(flow);
    }
    if (freshSyn) flow.synSeq = d.tcp.seq;
    if (d.tcp.flags & (1 | 4)) flow.closed = true;
    packet.ann = { stream: flow.id }; flow.packets.push(packet); flow.payloadBytes += Math.max(0, d.payloadLen || 0);
  }
  state.coverage.flowCount = state.allFlows.length;
}

function firstMessagePacket(stream, message, byFrame) {
  const direction = stream.directions.find(d => d.fromA === message.fromA);
  const frames = new Set();
  for (const range of direction?.ranges || []) {
    if (range.kind !== 'data' || range.start > message.start || range.end <= message.start) continue;
    for (const source of range.sources || []) if (source.start <= message.start && source.end > message.start) frames.add(source.frame);
  }
  return frames.size === 1 ? byFrame.get([...frames][0]) : null;
}
async function inspectTcp(state, flow) {
  const candidates = new Map(), synGroups = new Map(), duplicateFrames = new Set(), resetFrames = new Set(), startFrames = new Set();
  let duplicateCount = 0, resetCount = 0;
  const clientDirections = new Set();
  for (const packet of flow.packets) {
    const d = packet.d, t = d.tcp, from = endpoint(d), to = endpoint(d, false);
    if ((t.flags & 2) && !(t.flags & 16)) {
      clientDirections.add(from); startFrames.add(packet.no);
      const synKey = key([from, t.seq]); let group = synGroups.get(synKey);
      if (!group) { group = { from, to, seq: t.seq, packets: [], answers: [], payload: t.plen }; synGroups.set(synKey, group); }
      group.packets.push(packet);
    }
    if ((t.flags & 2) && (t.flags & 16)) {
      const group = synGroups.get(key([to, (t.ack - 1) >>> 0]));
      if (group && group.to === from && !group.payload) { group.answers.push(packet); startFrames.add(packet.no); }
    }
    if (t.flags & 4) { resetCount++; resetFrames.add(packet.no); }
    if (t.plen > 0 || (t.flags & (2 | 1))) {
      const sequenceKey = key([from, t.seq, t.plen, t.flags & (2 | 1)]), prior = candidates.get(sequenceKey);
      if (prior) { duplicateCount++; duplicateFrames.add(prior.no); duplicateFrames.add(packet.no); } else candidates.set(sequenceKey, packet);
    }
  }
  let stream = null, http = null;
  if (flow.payloadBytes && state.workBytes > 0 && state.httpMessages < state.limits.maxHttpMessages) {
    const allowance = Math.min(state.workBytes, Math.max(65536, flow.payloadBytes * 2)); state.workBytes -= allowance;
    stream = reassembleStream(flow.packets, { id: flow.id, proto: 'TCP', a: flow.a, b: flow.b }, {
      maxScanPackets: Math.max(1, flow.packets.length), maxPackets: Math.max(1, flow.packets.length), maxBytes: Math.min(16 * 1024 * 1024, state.limits.maxBytes),
      maxRanges: Math.min(10000, flow.packets.length * 2 + 2), maxProvenance: Math.min(200000, flow.packets.length * 4 + 16), maxWorkBytes: allowance });
    http = await parseHttpStream(stream, { decodeBodies: false, maxMessages: Math.min(state.limits.maxHttpMessagesPerFlow, state.limits.maxHttpMessages - state.httpMessages) });
    state.httpMessages += http.messages.length;
    if (http.truncated || stream.limited) { state.coverage.limited = true; addWarning(flow.warnings, 'HTTP/reassembly resource limits leave some observations unknown.'); }
  } else if (flow.payloadBytes) { state.coverage.limited = true; addWarning(flow.warnings, 'HTTP analysis work/message budget reached.'); }
  let clientEndpoint = clientDirections.size === 1 ? [...clientDirections][0] : null;
  if (!clientEndpoint && !clientDirections.size) {
    const request = http?.messages.find(m => m.type === 'request');
    if (request) clientEndpoint = request.fromA ? flow.a : flow.b;
    else {
      const synacks = new Set(flow.packets.filter(p => (p.d.tcp.flags & 18) === 18).map(p => endpoint(p.d, false)));
      if (synacks.size === 1) clientEndpoint = [...synacks][0];
    }
  }
  if (!clientEndpoint || clientDirections.size > 1) {
    if (state.unidentified.length < state.limits.maxFlows) state.unidentified.push({ reason: 'Client/server direction is not established by an unambiguous SYN, SYN-ACK or parsed HTTP request.', ...metricSources(sourceSet(flow.packets), state.limits) });
    return;
  }
  const clientA = clientEndpoint === flow.a, client = flow.endpoints[clientA ? 0 : 1], server = flow.endpoints[clientA ? 1 : 0];
  const service = serviceFor(state, { transport: 'TCP', clientIp: client.ip, serverIp: server.ip, serverPort: server.port }); if (!service) return;
  const requestDirections = new Set((http?.messages || []).filter(message => message.type === 'request').map(message => message.fromA ? flow.a : flow.b));
  const requestConflict = requestDirections.size > 1 || requestDirections.size === 1 && !requestDirections.has(clientEndpoint);
  const handshakeConflict = synGroups.size > 0 && flow.packets.some(packet => (packet.d.tcp.flags & 18) === 18) && ![...synGroups.values()].some(group => group.answers.length);
  const partial = flow.ambiguous || requestConflict || handshakeConflict || flow.packets.some(damage) || !!stream?.limited || !!stream?.directions.some(d => d.truncated || d.conflicts.length || d.ranges.some(r => r.kind === 'gap'));
  if (partial) service.coverage = 'partial';
  if (requestConflict) addWarning(service.warnings, 'Parsed HTTP request direction conflicts with the observed TCP initiator.');
  if (handshakeConflict) addWarning(service.warnings, 'Observed SYN-ACK acknowledgment does not match the captured SYN.');
  for (const warning of flow.warnings) addWarning(service.warnings, warning);
  const groups = [...synGroups.values()], values = []; let unknown = groups.length ? 0 : 1, matched = 0;
  for (const group of groups) {
    if (group.answers.length) matched++;
    const elapsed = group.packets.length === 1 && group.answers.length === 1 && !partial && !group.payload ? timing(group.packets[0], group.answers[0]) : null;
    if (elapsed == null) unknown++; else values.push(elapsed);
  }
  if (!groups.length || unknown) service.coverage = 'partial';
  service._tcp.push({ attempts: groups.length, matched, missing: groups.length - matched, values, unknown,
    resetCount, resetFrames, duplicateCount, duplicateFrames, startFrames, partial, allFrames: sourceSet(flow.packets) });
  if (flow.packets.some(p => p.d.dns)) addWarning(service.warnings, 'DNS over TCP is not reconstructed by the comparison DNS analyzer.');
  const byFrame = new Map(flow.packets.map(p => [p.no, p]));
  const statuses = new Map(), statusFrames = new Set(), httpFrames = new Set(), durations = [];
  let unknownHttp = 0, incomplete = !!http?.warnings.length;
  for (const warning of (http?.warnings || []).slice(0, 4)) addWarning(service.warnings, bounded(warning));
  for (const message of http?.messages || []) {
    for (const frame of message.frames) httpFrames.add(frame);
    if (!message.complete || message.warnings.length) incomplete = true;
    if (message.type === 'response') { statuses.set(message.status, (statuses.get(message.status) || 0) + 1); for (const frame of message.frames) statusFrames.add(frame); }
  }
  for (const exchange of http?.exchanges || []) {
    if (!exchange.request) continue;
    const elapsed = exchange.request.complete && exchange.response?.complete && !partial
      ? timing(firstMessagePacket(stream, exchange.request, byFrame), firstMessagePacket(stream, exchange.response, byFrame)) : null;
    if (elapsed == null) unknownHttp++; else durations.push(elapsed);
  }
  const encrypted = flow.packets.some(p => p.d.tls || p.d.proto === 'TLS');
  if (incomplete) service.coverage = 'partial';
  service._http.push({ recognized: !!http?.recognized, encrypted, statuses, statusFrames, httpFrames, durations, unknownHttp, incomplete,
    limited: !!http?.truncated || !!stream?.limited, frames: sourceSet(flow.packets) });
}

function finalizeService(state, service) {
  for (const question of service._dns.values()) {
    const suffix = `${question.name || '(unknown name)'} type ${question.qtype} class ${question.qclass ?? 'unknown'}`;
    metric(state, service, 'dns', 'answers: ' + suffix, [...question.answers.values()].sort((a, b) => key(a).localeCompare(key(b))), question.responseFrames,
      question.responses && !question.partial ? 'observed' : 'unknown', question.partial ? 'Reply or decoder coverage is incomplete.' : !question.responses ? 'No response was observed; its absence is not proof of a DNS failure.' : null);
    metric(state, service, 'dns', 'response codes: ' + suffix, [...question.rcodes].sort((a, b) => a[0] - b[0]).map(([code, count]) => ({ code, count })), question.responseFrames,
      question.responses ? 'observed' : 'unknown', question.responses ? null : 'No DNS response code was observed.');
    const unknown = question.unknownTiming + question.pending.size, timeKnown = question.durations.length && !unknown && !question.partial;
    metric(state, service, 'dns', 'observed response time: ' + suffix, durationSummary(question.durations, unknown), question.timingFrames,
      timeKnown ? 'observed' : 'unknown', timeKnown ? null : 'Some query/response timing is missing, ambiguous, incomplete or lacks usable timestamps. Retained samples do not establish complete timing coverage.');
    metric(state, service, 'dns', 'observed transactions: ' + suffix, { queries: question.queries, responses: question.responses, unansweredQueries: question.pending.size }, question.frames);
  }
  if (service._tcp.length) {
    const frames = field => new Set(service._tcp.flatMap(item => [...item[field]]));
    const sum = field => service._tcp.reduce((n, item) => n + item[field], 0), values = service._tcp.flatMap(item => item.values);
    const unknown = sum('unknown'), timeKnown = values.length && !unknown;
    metric(state, service, 'tcp', 'SYN to SYN-ACK setup', { synAttempts: sum('attempts'), matchedSynAcks: sum('matched'), missingSynAcks: sum('missing'), ...durationSummary(values, unknown) }, frames('startFrames'),
      timeKnown ? 'observed' : 'unknown', timeKnown ? null : 'Some SYN/SYN-ACK timing is missing, ambiguous or lacks usable timestamps; missing replies are not proof of failure. Retained samples do not establish complete timing coverage.');
    metric(state, service, 'tcp', 'observed resets', { packets: sum('resetCount'), flows: service._tcp.length }, frames('resetFrames').size ? frames('resetFrames') : frames('allFrames'));
    metric(state, service, 'tcp', 'duplicate sequence candidates', { packets: sum('duplicateCount'), flows: service._tcp.length }, frames('duplicateFrames').size ? frames('duplicateFrames') : frames('allFrames'));
  }
  if (service._http.length) {
    const recognized = service._http.filter(item => item.recognized), status = new Map(), statusFrames = new Set(), httpFrames = new Set();
    for (const item of recognized) { for (const [code, count] of item.statuses) status.set(code, (status.get(code) || 0) + count); for (const frame of item.statusFrames) statusFrames.add(frame); for (const frame of item.httpFrames) httpFrames.add(frame); }
    const unavailable = service._http.some(item => item.encrypted) ? 'Encrypted traffic is present; TLS application content is not decrypted.' : 'No supported plaintext HTTP/1 exchange was recognized.';
    const allFrames = new Set(service._http.flatMap(item => [...item.frames]));
    const statusKnown = status.size && !recognized.some(item => item.incomplete || item.limited);
    metric(state, service, 'http', 'observed status codes', [...status].sort((a, b) => a[0] - b[0]).map(([code, count]) => ({ code, count })), statusFrames.size ? statusFrames : allFrames,
      statusKnown ? 'observed' : 'unknown', statusKnown ? null : !recognized.length ? unavailable : !status.size ? 'No response status was observed.' : 'Incomplete messages or resource limits make status coverage provisional.');
    const values = recognized.flatMap(item => item.durations), unknown = recognized.reduce((n, item) => n + item.unknownHttp, 0);
    const timeKnown = values.length && !unknown && !recognized.some(item => item.incomplete || item.limited);
    metric(state, service, 'http', 'first request byte to first response byte', durationSummary(values, unknown), httpFrames.size ? httpFrames : allFrames,
      timeKnown ? 'observed' : 'unknown', timeKnown ? null : recognized.length ? 'HTTP pairing, source byte boundary, parser coverage or timestamp coverage does not establish complete timing observations.' : unavailable);
  }
  delete service._dns; delete service._tcp; delete service._http;
}

export async function analyzeCaptureSnapshot(packets, options = {}) {
  const state = freshState(options.label, limitsOf(options.limits), options.coverage);
  indexPackets(state, packets); // Own bounded packet bytes before the first await.
  for (const flow of state.allFlows) await inspectTcp(state, flow);
  for (const service of state.services.values()) finalizeService(state, service);
  if (state.coverage.truncatedPackets || state.coverage.malformedPackets || state.coverage.fragmentedPackets) addWarning(state.warnings, 'Truncated, malformed or fragmented packets leave parts of traffic analysis unknown.');
  const result = { schemaVersion: 1, kind: 'capture-snapshot', label: state.label, coverage: state.coverage,
    services: [...state.services.values()], unidentified: state.unidentified, warnings: state.warnings, limitations: [...scope] };
  if (size(result) > state.limits.maxSummaryBytes) throw new Error('Capture summary exceeds its bounded display size');
  return result;
}

export async function compareCaptures(beforePackets, afterPackets, options = {}) {
  const limits = limitsOf(options.limits);
  // Begin both bounded snapshots before awaiting either; later UI capture
  // mutations cannot change one side while the other side is parsing HTTP.
  const beforeWork = analyzeCaptureSnapshot(beforePackets, { label: options.labels?.before || 'Before', limits, coverage: options.coverage?.before });
  const afterWork = analyzeCaptureSnapshot(afterPackets, { label: options.labels?.after || 'After', limits, coverage: options.coverage?.after });
  const [before, after] = await Promise.all([beforeWork, afterWork]);
  const result = { schemaVersion: 1, kind: 'capture-comparison', before, after, services: [], changes: [], warnings: [], limitations: [...scope],
    summary: { matchedServices: 0, unmatchedBefore: 0, unmatchedAfter: 0, changed: 0, same: 0, unknown: 0, unmatched: 0 } };
  const beforeMap = new Map(before.services.map(s => [s.id, s])), afterMap = new Map(after.services.map(s => [s.id, s]));
  const usedBefore = new Set(), usedAfter = new Set(), pairs = [];
  const mappings = options.identityMappings || [];
  if (!Array.isArray(mappings) || mappings.length > limits.maxFlows) throw new Error('Invalid explicit service identity mappings');
  for (const mapping of mappings) {
    const b = beforeMap.get(mapping?.beforeServiceId), a = afterMap.get(mapping?.afterServiceId);
    if (!b || !a || usedBefore.has(b.id) || usedAfter.has(a.id)) throw new Error('Explicit service mappings must select distinct existing services on each side');
    usedBefore.add(b.id); usedAfter.add(a.id); pairs.push({ b, a, manual: true });
  }
  for (const b of before.services) { const a = afterMap.get(b.id); if (!usedBefore.has(b.id) && a && !usedAfter.has(a.id)) { usedBefore.add(b.id); usedAfter.add(a.id); pairs.push({ b, a, manual: false }); } }
  for (const b of before.services) if (!usedBefore.has(b.id)) pairs.push({ b, a: null });
  for (const a of after.services) if (!usedAfter.has(a.id)) pairs.push({ b: null, a });
  let bytes = size(result), limited = false;
  const incomplete = snapshot => snapshot.coverage.limited || snapshot.coverage.sourceTruncated || snapshot.coverage.sourceRecordsComplete !== true || snapshot.coverage.truncatedPackets || snapshot.coverage.malformedPackets || snapshot.coverage.fragmentedPackets;
  const add = row => {
    const count = size(row);
    if (result.changes.length >= limits.maxChanges || bytes + count > limits.maxReportBytes - 256 * 1024) { limited = true; return; }
    bytes += count; result.changes.push(row); result.summary[row.status]++;
  };
  for (const pair of pairs) {
    const { b, a } = pair, id = 'service-' + (result.services.length + 1), status = b && a ? 'matched' : b ? 'unmatched-before' : 'unmatched-after';
    const service = { id, beforeServiceId: b?.id || null, afterServiceId: a?.id || null, identity: (a || b).identity, beforeIdentity: b?.identity || null, afterIdentity: a?.identity || null, status, warnings: [] };
    if (pair.manual && b.id !== a.id) service.warnings.push('Explicitly paired different service identities; this mapping is a caller choice.');
    if (status === 'matched') result.summary.matchedServices++; else if (b) result.summary.unmatchedBefore++; else result.summary.unmatchedAfter++;
    result.services.push(service);
    const bm = new Map((b?.metrics || []).map(m => [key([m.category, m.metric]), m])), am = new Map((a?.metrics || []).map(m => [key([m.category, m.metric]), m]));
    for (const name of new Set([...bm.keys(), ...am.keys()])) {
      const bv = bm.get(name), av = am.get(name), template = av || bv;
      const row = { id: 'change-' + (result.changes.length + 1), serviceId: id, category: template.category, metric: template.metric,
        status: !b || !a ? 'unmatched' : !bv || !av || bv.status === 'unknown' || av.status === 'unknown' || incomplete(before) || incomplete(after) ? 'unknown' : key(bv.value) === key(av.value) ? 'same' : 'changed',
        before: bv?.value ?? null, after: av?.value ?? null, beforeSources: bv?.sources || [], afterSources: av?.sources || [],
        beforeSourceCount: bv?.sourceCount || 0, afterSourceCount: av?.sourceCount || 0, sourcesLimited: !!bv?.sourcesLimited || !!av?.sourcesLimited };
      if (row.status === 'unmatched') row.reason = 'This service identity was observed on one side only; it is not classified as a removal or fault.';
      if (row.status === 'unknown') row.reason = [bv?.reason, av?.reason, !bv || !av ? 'The metric was not observed or retained on both sides.' : null,
        incomplete(before) || incomplete(after) ? 'Source or analysis coverage is incomplete or unknown; retained values are observations only.' : null].filter(Boolean).join(' ');
      add(row);
    }
  }
  if (limited) result.warnings.push('Comparison row/display limit reached; omitted metric comparisons are unknown.');
  if (before.coverage.limited || after.coverage.limited || before.coverage.sourceTruncated || after.coverage.sourceTruncated) result.warnings.push('One or both captures have incomplete source or analysis coverage. Differences describe retained observations only.');
  if (size(result) > limits.maxReportBytes) throw new Error('Capture comparison exceeds its bounded display size');
  return result;
}
