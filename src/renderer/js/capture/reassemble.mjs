// Offline stream reconstruction. Captured bytes and gaps are distinct values;
// annotations must never become bytes that an application decoder might consume.
export const REASSEMBLY_LIMITS = Object.freeze({
  maxScanPackets: 1000000,
  maxPackets: 50000,
  maxBytes: 16 * 1024 * 1024,
  maxSpan: 128 * 1024 * 1024,
  maxRanges: 100000,
  maxProvenance: 200000,
  maxWorkBytes: 64 * 1024 * 1024,
});

const diff = (a, b) => (a - b) | 0;
const note = (list, message) => { if (!list.includes(message)) list.push(message); };
const wrap = (n) => n >>> 0;

/**
 * Reconstruct one already identified conversation without running any payload.
 * TCP coordinates are unwrapped within a bounded (< 2^31) sequence window, then
 * normalized to byte offset zero. First observed bytes win a conflicting overlap;
 * every conflicting interval and its source frames remain explicit.
 *
 * Data ranges retain byte-level source mappings. UDP ranges preserve datagram
 * boundaries; their offsets describe concatenated observed payloads, not TCP.
 * `complete` describes an observed complete TCP lifetime (SYN through FIN), or
 * complete observed UDP datagrams; it never proves capture-wide completeness.
 */
export function reassembleStream(packets, conv, options = {}) {
  const limits = { ...REASSEMBLY_LIMITS };
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) {
      throw new RangeError(`Invalid reassembly limit: ${key}`);
    }
    limits[key] = value;
  }
  const warnings = [];
  const states = [true, false].map((fromA) => ({
    fromA, anchor: null, syn: null, fins: [], segments: [], minimum: 0, maximum: 0,
    startKnown: false, closed: false, reset: false, truncated: false,
    limited: false, warnings: [], datagramOffset: 0,
  }));
  let limited = false;
  let byteCount = 0;
  let packetCount = 0;
  const stop = (message) => {
    limited = true;
    note(warnings, message);
    for (const st of states) st.limited = true;
  };
  for (let order = 0; order < packets.length; order++) {
    if (order >= limits.maxScanPackets) {
      stop('Packet scan limit reached; stream reconstruction is incomplete.');
      break;
    }
    const p = packets[order];
    const d = p.d;
    if (!d || !p.ann || p.ann.stream !== conv.id || (d.tcp ? 'TCP' : d.udp ? 'UDP' : '') !== conv.proto) continue;
    if (++packetCount > limits.maxPackets) {
      stop('Stream packet limit reached; later packets were not reconstructed.');
      break;
    }
    const st = states[`${d.src}:${d.sport}` === conv.a ? 0 : 1];
    const offset = d.payloadOff;
    const length = d.payloadLen || 0;
    const validPayload = Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length >= 0;
    const data = validPayload ? p.data.subarray(offset, Math.min(p.data.length, offset + length)) : new Uint8Array();
    if ((p.caplen != null && p.len != null && p.caplen < p.len) || data.length < length) {
      st.truncated = true;
      note(st.warnings, 'Captured packets were truncated; uncaptured payload bytes remain unknown.');
    }
    if (!validPayload && length) {
      st.truncated = true;
      note(st.warnings, 'A packet has invalid payload bounds.');
    }
    if (d.fragmented) {
      st.truncated = true;
      note(st.warnings, 'IP fragments have not been reassembled into complete transport payloads.');
    }
    if (byteCount + data.length > limits.maxBytes) {
      stop('Captured payload byte limit reached; later packets were not reconstructed.');
      break;
    }
    byteCount += data.length;
    if (conv.proto === 'UDP') {
      // Keep even empty datagrams as distinct records.
      st.segments.push({ start: st.datagramOffset, end: st.datagramOffset + data.length, data, frame: p.no, order, packetOffset: offset || 0 });
      st.datagramOffset += data.length;
      continue;
    }
    const t = d.tcp;
    const rawStart = wrap(t.seq + ((t.flags & 2) ? 1 : 0));
    if (st.anchor === null) st.anchor = rawStart;
    const start = diff(rawStart, st.anchor);
    const end = start + data.length;
    const minimum = Math.min(st.minimum, start);
    const maximum = Math.max(st.maximum, end);
    if (maximum - minimum > limits.maxSpan) {
      stop('TCP sequence span exceeds the supported window; ordering outside it is unknown.');
      break;
    }
    st.minimum = minimum;
    st.maximum = maximum;
    if (t.flags & 2) {
      if (st.syn === null) st.syn = start;
      else if (st.syn !== start) note(st.warnings, 'Conflicting SYN sequence numbers were observed.');
    }
    if (t.flags & 1) st.fins.push(end);
    if (t.flags & 4) st.reset = true;
    if (data.length) st.segments.push({ start, end, data, frame: p.no, order, packetOffset: offset });
  }

  const budget = { ranges: 0, provenance: 0, compared: 0 };
  const directions = states.map((st) => {
    if (conv.proto === 'UDP') return udpDirection(st, budget, limits, stop);
    return tcpDirection(st, budget, limits, stop);
  });
  // A global cap affects certainty in both directions, even if one was built first.
  if (limited) for (const direction of directions) { direction.limited = true; direction.complete = false; }
  for (const direction of directions) for (const message of direction.warnings) note(warnings, message);
  return { conv, directions, warnings, limited };
}

function baseDirection(st) {
  return {
    fromA: st.fromA, startKnown: false, closed: false, reset: st.reset,
    truncated: st.truncated, limited: st.limited, sequenceStart: null,
    ranges: [], conflicts: [], warnings: [...st.warnings], complete: false,
  };
}

function udpDirection(st, budget, limits, stop) {
  const out = baseDirection(st);
  out.startKnown = true; // Each UDP packet supplies its own message boundary.
  for (const s of st.segments) {
    if (++budget.ranges > limits.maxRanges || ++budget.provenance > limits.maxProvenance) {
      stop('Reassembly range/provenance limit reached; later payload is unavailable.');
      out.limited = true;
      break;
    }
    out.ranges.push({
      kind: 'data', start: s.start, end: s.end, data: s.data, frames: [s.frame],
      datagram: true, sources: [{ frame: s.frame, start: s.start, end: s.end, packetOffset: s.packetOffset }],
    });
  }
  out.complete = !out.truncated && !out.limited;
  return out;
}

function tcpDirection(st, budget, limits, stop) {
  const out = baseDirection(st);
  if (st.anchor === null) return out;
  const dataStart = st.segments.reduce((value, s) => Math.min(value, s.start), st.segments[0]?.start ?? st.syn ?? 0);
  const origin = st.syn === null ? dataStart : Math.min(st.syn, dataStart);
  const dataEnd = st.segments.reduce((value, s) => Math.max(value, s.end), origin);
  const finEnd = st.fins.length ? st.fins.reduce((value, end) => Math.max(value, end), st.fins[0]) : null;
  const extent = Math.max(dataEnd, finEnd ?? origin);
  out.sequenceStart = wrap(st.anchor + origin);
  out.startKnown = st.syn !== null && origin === st.syn && !st.warnings.includes('Conflicting SYN sequence numbers were observed.');
  out.closed = finEnd !== null;
  if (finEnd !== null && (finEnd < dataEnd || st.fins.some((end) => end !== finEnd))) {
    out.closed = false;
    note(out.warnings, 'Conflicting FIN/data boundaries prevent establishing the stream end.');
  }
  if (!out.startKnown) note(out.warnings, 'The beginning of this TCP direction was not established by a consistent SYN.');
  const events = [];
  for (const s of st.segments) {
    events.push({ at: s.start, add: s }, { at: s.end, remove: s });
  }
  events.push({ at: origin }, { at: extent });
  events.sort((a, b) => a.at - b.at);
  const active = new Map();
  for (let i = 0; i < events.length;) {
    const at = events[i].at;
    while (i < events.length && events[i].at === at) {
      const event = events[i++];
      if (event.add) active.set(event.add.order, event.add);
      if (event.remove) active.delete(event.remove.order);
    }
    if (i === events.length) break;
    const next = events[i].at;
    if (next <= at) continue;
    if (++budget.ranges > limits.maxRanges || budget.provenance + active.size > limits.maxProvenance) {
      stop('Reassembly range/provenance limit reached; later payload is unavailable.');
      out.limited = true;
      break;
    }
    const start = at - origin;
    const end = next - origin;
    if (!active.size) {
      out.ranges.push({ kind: 'gap', start, end, length: end - start });
      continue;
    }
    budget.provenance += active.size;
    const observed = [...active.values()].sort((a, b) => a.order - b.order);
    const winner = observed[0];
    const data = winner.data.subarray(at - winner.start, next - winner.start);
    const sources = observed.map((s) => ({ frame: s.frame, start, end, packetOffset: s.packetOffset + at - s.start }));
    let comparisonLimited = false;
    for (const other of observed.slice(1)) {
      if (budget.compared + data.length > limits.maxWorkBytes) {
        stop('Overlap comparison limit reached; later overlap consistency is unknown.');
        out.limited = true;
        comparisonLimited = true;
        break;
      }
      budget.compared += data.length;
      const candidate = other.data.subarray(at - other.start, next - other.start);
      if (data.some((value, index) => value !== candidate[index])) {
        out.conflicts.push({ start, end, frames: [winner.frame, other.frame] });
      }
    }
    // Do not publish a range whose overlap consistency could not be examined.
    if (comparisonLimited) break;
    out.ranges.push({ kind: 'data', start, end, data, frames: observed.map((s) => s.frame), sources });
  }
  if (out.conflicts.length) note(out.warnings, 'Conflicting TCP overlap bytes were observed; first captured bytes are shown.');
  if (out.ranges.some((range) => range.kind === 'gap')) note(out.warnings, 'TCP sequence gaps contain missing bytes, not reconstructed content.');
  out.complete = out.startKnown && out.closed && !out.reset && !out.truncated && !out.limited && !out.conflicts.length && !out.ranges.some((r) => r.kind === 'gap');
  return out;
}
