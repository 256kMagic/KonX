// Offline RTP/RTCP analysis of KonX decoded packet snapshots. RTP/AVP framing,
// sequence fields and interarrival jitter: RFC 3550 §§5,6.4.1 and Appendix A.
// G.711 RTP mappings: RFC 3551 §§4.5.14,6; companding: ITU-T G.711.
// No packet capture, decryption, network access, or automatic audio playback.
export const RTP_LIMITS = Object.freeze({ maxScanPackets: 200000, maxInputBytes: 64 * 1024 * 1024,
  maxPayloadBytes: 32 * 1024 * 1024, maxStreams: 128, maxPackets: 100000,
  maxMappings: 1024, maxRtcpReports: 2048, maxWarnings: 64 });
export const AUDIO_LIMITS = Object.freeze({ maxSamples: 8000 * 600, maxGapSamples: 8000 * 10, maxWaveformBins: 4096 });
const retained = new WeakMap();
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const u16 = (b, p) => b[p] * 256 + b[p + 1];
const u32 = (b, p) => b[p] * 16777216 + b[p + 1] * 65536 + b[p + 2] * 256 + b[p + 3];
const signed32 = (n) => n > 0x7fffffff ? n - 0x100000000 : n;
const delta32 = (a, b) => signed32((a - b + 0x100000000) % 0x100000000);
const endpoint = (ip, port) => `${ip.includes(':') ? '[' + ip + ']' : ip}:${port}`;
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function warning(list, text, max = RTP_LIMITS.maxWarnings) { if (list.length < max && !list.includes(text)) list.push(text); }
function boundedLimits(input = {}) {
  const out = { ...RTP_LIMITS };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(out, key) || !integer(value, 1, out[key])) throw new RangeError('Invalid RTP limit: ' + key);
    out[key] = value;
  }
  return out;
}
function address(value) {
  if (typeof value !== 'string' || value.length > 64 || /[\s/]/.test(value)) return null;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    const parts = value.split('.');
    return parts.every((n) => Number(n) <= 255 && String(Number(n)) === n) ? value : null;
  }
  if (value.includes(':') && /^[a-fA-F\d:]+$/.test(value)) {
    try { return new URL('http://[' + value + ']/').hostname.slice(1, -1).toLowerCase(); } catch { return null; }
  }
  return null;
}

/** Returns bounded wire facts, or an explicit malformed-header reason. Payload
 * is a view of the original bytes; callers must keep snapshot bytes immutable. */
export function parseRtp(bytes) {
  const bad = (reason) => ({ ok: false, reason });
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return bad('RTP fixed header is incomplete.');
  if ((bytes[0] >>> 6) !== 2) return bad('RTP version is not 2.');
  const cc = bytes[0] & 15, extension = !!(bytes[0] & 16), padded = !!(bytes[0] & 32);
  let offset = 12 + cc * 4;
  if (offset > bytes.length) return bad('RTP CSRC list is incomplete.');
  const csrc = Array.from({ length: cc }, (_, i) => u32(bytes, 12 + i * 4));
  let extensionProfile = null, extensionBytes = 0;
  if (extension) {
    if (offset + 4 > bytes.length) return bad('RTP extension header is incomplete.');
    extensionProfile = u16(bytes, offset); extensionBytes = u16(bytes, offset + 2) * 4;
    offset += 4;
    if (extensionBytes > bytes.length - offset) return bad('RTP extension data is incomplete.');
    offset += extensionBytes;
  }
  const paddingBytes = padded ? bytes.at(-1) : 0;
  if (padded && (paddingBytes === 0 || paddingBytes > bytes.length - offset)) return bad('RTP padding length is invalid.');
  return { ok: true, sequence: u16(bytes, 2), timestamp: u32(bytes, 4), ssrc: u32(bytes, 8),
    payloadType: bytes[1] & 127, marker: !!(bytes[1] & 128), csrc, extensionProfile, extensionBytes,
    headerBytes: offset, paddingBytes, payload: bytes.subarray(offset, bytes.length - paddingBytes) };
}

/** Parses SR/RR report fields; other valid RTCP block types remain identified
 * but uninterpreted. Jitter stays in RTP clock units, never mislabeled as ms. */
export function parseRtcp(bytes) {
  const bad = (reason) => ({ ok: false, reason, reports: [], types: [] });
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return bad('RTCP header is incomplete.');
  const reports = [], types = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length || bytes[offset] >>> 6 !== 2) return bad('RTCP block header is invalid.');
    const count = bytes[offset] & 31, padded = !!(bytes[offset] & 32), type = bytes[offset + 1];
    if (type < 200 || type > 207) return bad('Unsupported RTCP packet type.');
    const length = (u16(bytes, offset + 2) + 1) * 4;
    if (length < 4 || length > bytes.length - offset) return bad('RTCP block length exceeds the datagram.');
    const padding = padded ? bytes[offset + length - 1] : 0;
    if (padded && (offset + length !== bytes.length || !padding || padding > length - 4)) return bad('RTCP padding is invalid.');
    const bodyLength = length - padding;
    types.push(type);
    if (type === 200 || type === 201) {
      const header = type === 200 ? 28 : 8;
      if (bodyLength < header + count * 24) return bad('RTCP report blocks are incomplete.');
      const report = { type: type === 200 ? 'SR' : 'RR', senderSsrc: u32(bytes, offset + 4), reception: [] };
      if (type === 200) report.sender = { ntpSeconds: u32(bytes, offset + 8), ntpFraction: u32(bytes, offset + 12),
        rtpTimestamp: u32(bytes, offset + 16), packetCount: u32(bytes, offset + 20), octetCount: u32(bytes, offset + 24) };
      for (let n = 0; n < count; n++) {
        const p = offset + header + n * 24;
        const lost = bytes[p + 5] * 65536 + bytes[p + 6] * 256 + bytes[p + 7];
        report.reception.push({ ssrc: u32(bytes, p), fractionLost: bytes[p + 4] / 256,
          cumulativeLost: lost & 0x800000 ? lost - 0x1000000 : lost,
          extendedHighestSequence: u32(bytes, p + 8), jitterTimestampUnits: u32(bytes, p + 12),
          lastSenderReport: u32(bytes, p + 16), delaySinceLastSenderReportUnits65536: u32(bytes, p + 20) });
      }
      if (bodyLength > header + count * 24) report.uninterpretedExtensionBytes = bodyLength - header - count * 24;
      reports.push(report);
    }
    offset += length;
  }
  return { ok: true, reports, types };
}

/** Convert already-parsed SIP/SDP facts into candidate receive endpoints. The
 * SIP parser remains the owner of message framing and SDP interpretation. */
export function mediaMappings(sipCalls, max = RTP_LIMITS.maxMappings) {
  if (!Array.isArray(sipCalls)) throw new TypeError('sipCalls must be an array.');
  const mappings = [], warnings = [];
  let examined = 0, examinedMessages = 0;
  for (const call of sipCalls) {
    if (++examined > 2000) { warning(warnings, 'SIP call mapping limit reached.'); break; }
    const sourceMessages = Array.isArray(call?.messages) ? call.messages : [];
    const messages = sourceMessages.slice(0, 2000 - examinedMessages);
    examinedMessages += messages.length;
    if (messages.length < sourceMessages.length) warning(warnings, 'SIP message mapping limit reached; associations are incomplete.');
    // Only an observed completed BYE response supplies an end bound. The last
    // signaling timestamp by itself is not the end of a media session.
    const endings = messages.filter((m) => m.complete && m.method === 'BYE' && m.type === 'response' && m.status >= 200 && m.status < 300 && finite(m.ts)).map((m) => m.ts);
    const until = endings.length ? Math.max(...endings) : null;
    for (const message of messages) {
      if (!message?.complete || !message.sdp || !Array.isArray(message.sdp.media)) continue;
      for (let index = 0; index < Math.min(64, message.sdp.media.length); index++) {
        const media = message.sdp.media[index], ip = address(media?.connection?.address);
        if (!ip || media.disabled || !integer(media.port, 1, 65535) || !/RTP\//.test(media.protocol || '')) continue;
        if (mappings.length >= max) { warning(warnings, 'SDP media mapping limit reached; associations are incomplete.'); return { mappings, warnings, limited: true }; }
        const encrypted = /SAVP|TLS/i.test(media.protocol);
        const frames = (message.frames || []).slice(0, 64).filter((n) => integer(n, 1, Number.MAX_SAFE_INTEGER));
        const codecs = (media.codecs || []).slice(0, 128).map((c) => ({ payloadType: Number(c.payloadType), name: c.name, clockRate: c.clockRate, channels: c.channels }));
        const base = { address: ip, port: media.port, protocol: media.protocol, encrypted, codecs,
          callId: typeof call.callId === 'string' ? call.callId : null, callKey: typeof call.id === 'string' ? call.id : null,
          mediaIndex: index, frames, from: finite(message.ts) ? message.ts : null, until };
        mappings.push(base);
        if (mappings.length >= max) { warning(warnings, 'SDP media mapping limit reached; RTCP association coverage is incomplete.'); continue; }
        const rtcpIp = address(media.rtcp?.connection?.address) || ip;
        const rtcpPort = media.rtcp?.port ?? (media.port < 65535 ? media.port + 1 : null);
        if (integer(rtcpPort, 1, 65535)) mappings.push({ ...base, address: rtcpIp, port: rtcpPort, kind: 'rtcp' });
      }
    }
    if (examinedMessages >= 2000 && examined < sipCalls.length) { warning(warnings, 'SIP message mapping limit reached; associations are incomplete.'); break; }
  }
  return { mappings, warnings, limited: warnings.length > 0 };
}

function indexMappings(input, max) {
  if (!Array.isArray(input) || input.length > max) throw new RangeError('Too many RTP media mappings.');
  const index = new Map();
  for (const m of input) {
    const ip = address(m?.address);
    if (!ip || !integer(m.port, 1, 65535) || typeof m.protocol !== 'string' || m.protocol.length > 64) throw new TypeError('Invalid RTP endpoint mapping.');
    if ((m.from != null && !finite(m.from)) || (m.until != null && !finite(m.until)) || (finite(m.from) && finite(m.until) && m.until < m.from) || (m.kind != null && m.kind !== 'rtcp')) throw new TypeError('Invalid RTP mapping time window or kind.');
    if (m.frames != null && !Array.isArray(m.frames)) throw new TypeError('Invalid RTP signaling frame list.');
    if (!Array.isArray(m.codecs) || m.codecs.length > 128) throw new TypeError('Invalid RTP codec mapping.');
    const codecs = m.codecs.map((c) => {
      if (!integer(c.payloadType, 0, 127) || (c.name != null && (typeof c.name !== 'string' || c.name.length > 64)) || (c.clockRate != null && !integer(c.clockRate, 1, 1000000)) || (c.channels != null && !integer(c.channels, 1, 64))) throw new TypeError('Invalid RTP payload mapping.');
      return { payloadType: c.payloadType, name: c.name?.toUpperCase() ?? null, clockRate: c.clockRate ?? null, channels: c.channels ?? null };
    });
    const entry = { ...m, address: ip, encrypted: !!m.encrypted || /SAVP|TLS/i.test(m.protocol), codecs,
      frames: (m.frames || []).slice(0, 64).filter((n) => integer(n, 1, Number.MAX_SAFE_INTEGER)) };
    const key = endpoint(ip, m.port), group = index.get(key) || [];
    const signature = (x) => JSON.stringify([x.callKey, x.callId, x.mediaIndex, x.protocol, x.kind, x.encrypted, x.codecs, x.until]);
    const same = group.find((x) => signature(x) === signature(entry));
    if (same) {
      same.from = finite(same.from) && finite(entry.from) ? Math.min(same.from, entry.from) : null;
      same.frames = [...new Set([...same.frames, ...entry.frames])].slice(0, 64);
      continue;
    }
    if (group.length >= 64) throw new RangeError('Too many declarations for one media endpoint.');
    group.push(entry); index.set(key, group);
  }
  return index;
}
function activeMappings(index, ip, port, ts) {
  return (index.get(endpoint(ip, port)) || []).filter((m) => !finite(ts) || ((!finite(m.from) || ts >= m.from) && (!finite(m.until) || ts <= m.until)));
}
function codecFor(pt, mappings, heuristic) {
  const choices = mappings.flatMap((m) => m.codecs.filter((c) => c.payloadType === pt));
  const signatures = new Map(choices.map((c) => [JSON.stringify([c.name, c.clockRate, c.channels]), c]));
  if (signatures.size === 1) return { ...signatures.values().next().value, source: 'SDP', ambiguous: false };
  if (signatures.size > 1) return { payloadType: pt, name: null, clockRate: null, channels: null, source: 'conflicting SDP', ambiguous: true };
  if (heuristic && [0, 8].includes(pt)) return { payloadType: pt, name: pt === 0 ? 'PCMU' : 'PCMA', clockRate: 8000, channels: 1, source: 'assumed RTP/AVP static mapping', ambiguous: false };
  return { payloadType: pt, name: null, clockRate: null, channels: null, source: 'unknown', ambiguous: false };
}

/**
 * analyzeRtp(packets,{sipCalls?,mappings?,allowHeuristic?:false,limits?})
 * packets: KonX {no,ts,caplen,len,data:Uint8Array,d:{udp,src,dst,sport,dport,
 * payloadOff,payloadLen,fragmented,f}}. `ts` is capture seconds.
 * Result: {streams,rtcp,scannedPackets,examinedBytes,limited,warnings,excluded}.
 * streams identify one directional UDP tuple + SSRC, retain source packet
 * numbers and per-packet metrics, never raw audio in JSON. Private payload
 * views are retained only while the stream object remains reachable.
 * Default identification needs SDP; heuristic candidates need >=3 unique RTP
 * sequence values and remain explicitly unverified. SRTP endpoints are skipped.
 */
export function analyzeRtp(packets, options = {}) {
  if (!Array.isArray(packets)) throw new TypeError('Expected a decoded packet snapshot.');
  for (const key of Object.keys(options)) if (!['sipCalls', 'mappings', 'allowHeuristic', 'limits'].includes(key)) throw new TypeError('Unknown RTP option: ' + key);
  if (options.allowHeuristic != null && typeof options.allowHeuristic !== 'boolean') throw new TypeError('allowHeuristic must be boolean.');
  const limits = boundedLimits(options.limits), declared = mediaMappings(options.sipCalls || [], limits.maxMappings);
  const mappingList = [...declared.mappings, ...(options.mappings || [])];
  const mappings = indexMappings(mappingList, limits.maxMappings);
  const result = { schemaVersion: 1, kind: 'rtp', streams: [], rtcp: [], scannedPackets: 0, examinedBytes: 0,
    limited: declared.limited, warnings: [...declared.warnings], excluded: { fragmentedOrTruncated: 0, encrypted: 0, unmapped: 0, malformed: 0, unconfirmedHeuristic: 0 } };
  const groups = new Map(), frameNumbers = new Set();
  let retainedBytes = 0, rows = 0;
  const limited = (text) => { result.limited = true; warning(result.warnings, text, limits.maxWarnings); };
  for (const packet of packets) {
    if (result.scannedPackets >= limits.maxScanPackets) { limited('Packet scan limit reached; later packets were not examined.'); break; }
    result.scannedPackets++;
    const d = packet?.d;
    if (!d?.udp) continue;
    const src = address(d.src), dst = address(d.dst), sp = d.sport ?? d.udp.sport, dp = d.dport ?? d.udp.dport;
    if (!src || !dst || !integer(sp, 0, 65535) || !integer(dp, 0, 65535) || !integer(packet.no, 1, Number.MAX_SAFE_INTEGER) || frameNumbers.has(packet.no)) {
      result.excluded.malformed++; warning(result.warnings, 'UDP packets with invalid endpoints or duplicate/missing frame numbers were skipped.'); continue;
    }
    frameNumbers.add(packet.no);
    const off = d.payloadOff, len = d.payloadLen;
    if (!(packet.data instanceof Uint8Array) || !integer(off, 8, packet.data.length) || !integer(len, 0, packet.data.length - off) || d.fragmented || packet.caplen < packet.len || (integer(d.f?.['udp.length'], 8, 65535) && d.f['udp.length'] !== len + 8)) {
      result.excluded.fragmentedOrTruncated++; continue;
    }
    const bytes = packet.data.subarray(off, off + len);
    if (result.examinedBytes + bytes.length > limits.maxInputBytes) { limited('RTP input byte limit reached; later packets were not examined.'); break; }
    result.examinedBytes += bytes.length;
    const destination = activeMappings(mappings, dst, dp, packet.ts), source = activeMappings(mappings, src, sp, packet.ts);
    const all = [...destination, ...source];
    if (all.some((m) => m.encrypted)) { result.excluded.encrypted++; continue; }
    const rtpMappings = (destination.some((m) => m.kind !== 'rtcp') ? destination : source).filter((m) => m.kind !== 'rtcp');
    const rtcpMappings = all.filter((m) => m.kind === 'rtcp');
    const heuristic = rtpMappings.length === 0;
    if (heuristic && !rtcpMappings.length && !options.allowHeuristic) { result.excluded.unmapped++; continue; }
    if (bytes.length >= 4 && bytes[1] >= 200 && bytes[1] <= 207) {
      const control = parseRtcp(bytes);
      if (control.ok) {
        for (const report of control.reports) {
          if (result.rtcp.length >= limits.maxRtcpReports) { limited('RTCP report limit reached.'); break; }
          result.rtcp.push({ ...report, frame: packet.no, time: finite(packet.ts) ? packet.ts : null,
            src: endpoint(src, sp), dst: endpoint(dst, dp), identification: rtcpMappings.length || rtpMappings.length ? 'SDP endpoint' : 'heuristic',
            signalingFrames: [...new Set(all.flatMap((m) => m.frames))].slice(0, 64) });
        }
        continue;
      }
      if (rtcpMappings.length && !rtpMappings.length) { result.excluded.malformed++; warning(result.warnings, `Frame ${packet.no}: ${control.reason}`); continue; }
    }
    if (heuristic && (!options.allowHeuristic || rtcpMappings.length)) { result.excluded.unmapped++; continue; }
    const parsed = parseRtp(bytes);
    if (!parsed.ok) { if (rtpMappings.length) { result.excluded.malformed++; warning(result.warnings, `Frame ${packet.no}: ${parsed.reason}`); } continue; }
    // Marker + reserved AVP payloads can look like RTCP. Never infer these types.
    if (heuristic && parsed.payloadType >= 64 && parsed.payloadType <= 95) continue;
    const key = JSON.stringify([src, sp, dst, dp, parsed.ssrc]);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= limits.maxStreams) { limited('RTP stream limit reached; additional streams were omitted.'); continue; }
      const stream = { id: 'rtp-' + (groups.size + 1), src: endpoint(src, sp), dst: endpoint(dst, dp), ssrc: parsed.ssrc,
        identification: heuristic ? 'heuristic candidate' : destination.some((m) => m.kind !== 'rtcp') ? 'SDP receive endpoint' : 'SDP source endpoint candidate',
        associations: [], packets: [], payloadTypes: [], warnings: [], incomplete: false };
      group = { stream, records: [], seen: new Map(), high: null, epoch: 0, timestampHigh: null, jitter: 0, previous: null, codecs: new Map(), epochRanges: new Map(), unique: 0,
        lastUniqueSequence: null, sequentialRun: 0, heuristicConfirmed: false };
      groups.set(key, group);
    }
    if (rows >= limits.maxPackets || retainedBytes + parsed.payload.length > limits.maxPayloadBytes) {
      group.stream.incomplete = true; limited('RTP packet or retained payload limit reached; later media was not retained.'); break;
    }
    const codec = codecFor(parsed.payloadType, rtpMappings, heuristic);
    const stream = group.stream;
    for (const m of rtpMappings) {
      const association = { callId: m.callId ?? null, callKey: m.callKey ?? null, mediaIndex: m.mediaIndex ?? null, frames: m.frames, protocol: m.protocol };
      if (stream.associations.length < 32 && !stream.associations.some((a) => JSON.stringify(a) === JSON.stringify(association))) stream.associations.push(association);
    }
    const flags = [];
    let extSeq = parsed.sequence;
    if (group.high != null) {
      const delta = ((parsed.sequence - ((group.high % 65536 + 65536) % 65536) + 98304) % 65536) - 32768;
      if (delta > 3000 || delta < -100) {
        group.epoch++; group.high = null; group.timestampHigh = null; group.previous = null; group.jitter = 0;
        flags.push('sequence discontinuity'); warning(stream.warnings, 'A large sequence discontinuity was observed. Missing counts across that boundary are unknown.');
      } else extSeq = group.high + delta;
    }
    const sequenceKey = group.epoch + ':' + extSeq;
    const prior = group.seen.get(sequenceKey);
    if (prior) {
      flags.push(prior.timestamp === parsed.timestamp && prior.payloadType === parsed.payloadType && sameBytes(prior.payload, parsed.payload) ? 'duplicate' : 'conflicting sequence');
      if (flags.includes('conflicting sequence')) warning(stream.warnings, 'Different media bytes or timestamps share a sequence number; audio reconstruction is unavailable.');
    } else {
      if (group.high != null && extSeq < group.high) flags.push('out of order');
      group.unique++;
      group.sequentialRun = group.lastUniqueSequence != null && parsed.sequence === (group.lastUniqueSequence + 1) % 65536 ? group.sequentialRun + 1 : 1;
      group.lastUniqueSequence = parsed.sequence; group.heuristicConfirmed ||= group.sequentialRun >= 3;
      const range = group.epochRanges.get(group.epoch) || { min: extSeq, max: extSeq, count: 0 };
      range.min = Math.min(range.min, extSeq); range.max = Math.max(range.max, extSeq); range.count++;
      group.epochRanges.set(group.epoch, range);
    }
    group.high = group.high == null ? extSeq : Math.max(group.high, extSeq);
    const extTime = group.timestampHigh == null ? parsed.timestamp : group.timestampHigh + delta32(parsed.timestamp, ((group.timestampHigh % 0x100000000) + 0x100000000) % 0x100000000);
    if (!prior && !flags.includes('out of order')) group.timestampHigh = extTime;
    const time = finite(packet.ts) ? packet.ts : null;
    let jitterMs = null, deltaMs = null;
    if (group.previous && time != null && group.previous.time != null) {
      deltaMs = (time - group.previous.time) * 1000;
      if (deltaMs < 0) { flags.push('capture time reversed'); warning(stream.warnings, 'Capture timestamps moved backwards; affected jitter intervals are unavailable.'); group.jitter = 0; }
      else if (codec.clockRate != null && codec.clockRate === group.previous.clockRate) {
        const difference = (time - group.previous.time) * codec.clockRate - delta32(parsed.timestamp, group.previous.timestamp);
        group.jitter += (Math.abs(difference) - group.jitter) / 16;
        jitterMs = group.jitter * 1000 / codec.clockRate;
      } else group.jitter = 0;
    }
    group.previous = { time, timestamp: parsed.timestamp, clockRate: codec.clockRate };
    const record = { frame: packet.no, time, sequence: parsed.sequence, extendedSequence: extSeq, epoch: group.epoch,
      timestamp: parsed.timestamp, extendedTimestamp: extTime, payloadType: parsed.payloadType, marker: parsed.marker,
      payloadBytes: parsed.payload.length, headerBytes: parsed.headerBytes, codec, deltaMs, jitterMs, flags };
    stream.packets.push(record); group.records.push({ ...record, payload: parsed.payload });
    if (!prior) group.seen.set(sequenceKey, { ...record, payload: parsed.payload });
    const signature = JSON.stringify(codec); group.codecs.set(signature, codec);
    retainedBytes += parsed.payload.length; rows++;
  }
  for (const group of groups.values()) {
    const s = group.stream;
    if (s.identification === 'heuristic candidate' && !group.heuristicConfirmed) { result.excluded.unconfirmedHeuristic += s.packets.length; continue; }
    s.payloadTypes = [...group.codecs.values()];
    s.startTime = null; s.endTime = null;
    for (const p of s.packets) if (finite(p.time)) { s.startTime = s.startTime == null ? p.time : Math.min(s.startTime, p.time); s.endTime = s.endTime == null ? p.time : Math.max(s.endTime, p.time); }
    s.durationSeconds = s.startTime != null ? s.endTime - s.startTime : null;
    s.packetCount = s.packets.length; s.uniquePackets = group.unique;
    s.duplicatePackets = s.packets.filter((p) => p.flags.includes('duplicate')).length;
    s.conflictingPackets = s.packets.filter((p) => p.flags.includes('conflicting sequence')).length;
    s.outOfOrderPackets = s.packets.filter((p) => p.flags.includes('out of order')).length;
    s.sequenceEpochs = group.epochRanges.size;
    s.sequenceGaps = [...group.epochRanges.values()].reduce((sum, r) => sum + r.max - r.min + 1 - r.count, 0);
    const rates = new Set(s.payloadTypes.map((c) => c.clockRate));
    s.clockRate = rates.size === 1 && !rates.has(null) ? [...rates][0] : null;
    s.maxJitterMs = null;
    if (s.clockRate != null) for (const p of s.packets) if (finite(p.jitterMs)) s.maxJitterMs = Math.max(s.maxJitterMs ?? 0, p.jitterMs);
    s.lastJitterMs = s.clockRate != null ? s.packets.at(-1)?.jitterMs ?? null : null;
    s.frames = s.packets.map((p) => p.frame);
    if (s.sequenceGaps) warning(s.warnings, 'Sequence gaps are missing packets in this capture; they do not establish network loss or receiver experience.');
    if (s.identification === 'heuristic candidate') warning(s.warnings, 'RTP identification is heuristic; a valid-looking header does not prove this is an RTP/AVP flow.');
    if (s.associations.length) warning(s.warnings, 'SDP associations are captured declarations, not proof of negotiation or successful media delivery.');
    if (new Set(s.associations.map((a) => a.callId)).size > 1) warning(s.warnings, 'Multiple SIP calls advertise this media endpoint; call association is ambiguous.');
    if (s.payloadTypes.some((c) => c.ambiguous)) warning(s.warnings, 'Conflicting SDP codec declarations leave the payload mapping unknown.');
    if (s.payloadTypes.some((c) => !['PCMU', 'PCMA'].includes(c.name) || c.clockRate !== 8000 || c.channels !== 1)) warning(s.warnings, 'Audio playback/export supports only unencrypted mono PCMU/PCMA at 8000 Hz.');
    s.audioSupported = !s.conflictingPackets && s.sequenceEpochs === 1 && s.payloadTypes.length > 0 && s.payloadTypes.every((c) => ['PCMU', 'PCMA'].includes(c.name) && c.clockRate === 8000 && c.channels === 1);
    s.incomplete ||= result.limited;
    retained.set(s, group.records); result.streams.push(s);
  }
  warning(result.warnings, 'One captured media direction does not prove one-way audio. Capture loss, location, and incomplete signaling can hide traffic.');
  if (result.excluded.encrypted) warning(result.warnings, 'Media endpoints advertised as SRTP/TLS were excluded; no media decryption is performed.');
  return result;
}

export function decodeG711(bytes, codec) {
  if (!(bytes instanceof Uint8Array) || bytes.length > AUDIO_LIMITS.maxSamples) throw new RangeError('Invalid or oversized G.711 payload.');
  if (!['PCMU', 'PCMA'].includes(codec)) throw new TypeError('Unsupported G.711 codec.');
  const samples = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    if (codec === 'PCMU') {
      const word = bytes[i] ^ 255, exponent = (word >>> 4) & 7;
      const magnitude = (((word & 15) * 8 + 132) * (2 ** exponent)) - 132;
      samples[i] = word & 128 ? -magnitude : magnitude;
    } else {
      const word = bytes[i] ^ 85, exponent = (word >>> 4) & 7;
      let magnitude = (word & 15) * 16 + (exponent === 0 ? 8 : 264);
      if (exponent > 1) magnitude *= 2 ** (exponent - 1);
      samples[i] = word & 128 ? magnitude : -magnitude;
    }
  }
  return samples;
}

/** Timestamp-ordered G.711 reconstruction. Inserted gaps are explicit silence,
 * not recovered speech or a simulated receiver jitter buffer. No overlap,
 * unknown codec, sequence restart or oversized gap is silently repaired. */
export function buildRtpAudio(stream, { allowHeuristic = false, maxSamples = AUDIO_LIMITS.maxSamples, maxGapSamples = AUDIO_LIMITS.maxGapSamples } = {}) {
  if (!integer(maxSamples, 1, AUDIO_LIMITS.maxSamples) || !integer(maxGapSamples, 0, AUDIO_LIMITS.maxGapSamples)) throw new RangeError('Invalid audio reconstruction limits.');
  const stored = retained.get(stream);
  if (!stored) throw new Error('Audio requires the original analyzed capture snapshot.');
  if (!stream.audioSupported) throw new Error('This stream has unsupported or ambiguous codec, sequence, or payload data.');
  if (stream.identification === 'heuristic candidate' && !allowHeuristic) throw new Error('Confirm the heuristic RTP/AVP interpretation before decoding audio.');
  const records = stored.filter((p) => !p.flags.includes('duplicate')).sort((a, b) => a.extendedSequence - b.extendedSequence);
  if (!records.length) throw new Error('No captured audio payload.');
  const origin = records[0].extendedTimestamp;
  const segments = [], gaps = [];
  let end = 0;
  for (const record of records) {
    const start = record.extendedTimestamp - origin;
    if (!integer(start, 0, maxSamples) || record.payload.length > maxSamples - start) throw new RangeError('Audio duration or timestamp discontinuity exceeds the reconstruction limit.');
    if (start < end) throw new Error('RTP audio timestamps overlap or move backwards; reconstruction is ambiguous.');
    if (start - end > maxGapSamples) throw new RangeError('A media gap exceeds the silence insertion limit.');
    if (start > end) gaps.push({ startSample: end, endSample: start, beforeFrame: segments.at(-1)?.record.frame ?? null, afterFrame: record.frame });
    segments.push({ start, record }); end = start + record.payload.length;
  }
  const samples = new Int16Array(end);
  for (const { start, record } of segments) samples.set(decodeG711(record.payload, record.codec.name), start);
  return { sampleRate: 8000, channels: 1, samples, durationSeconds: end / 8000,
    startCaptureTime: records[0].time, frames: records.map((r) => r.frame), gaps,
    insertedSilenceSamples: gaps.reduce((sum, gap) => sum + gap.endSample - gap.startSample, 0),
    warnings: [...stream.warnings, ...(gaps.length ? ['Missing timestamp intervals contain inserted silence, not recovered audio.'] : []), ...(stream.incomplete ? ['Analysis limits reduced media coverage; this audio is incomplete.'] : [])] };
}

export function encodeWav(audio) {
  if (audio?.sampleRate !== 8000 || audio?.channels !== 1 || !(audio.samples instanceof Int16Array) || audio.samples.length > AUDIO_LIMITS.maxSamples) throw new TypeError('Expected bounded mono 8000 Hz PCM16 audio.');
  const bytes = new Uint8Array(44 + audio.samples.length * 2), view = new DataView(bytes.buffer);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, audio.samples.length * 2, true);
  for (let i = 0; i < audio.samples.length; i++) view.setInt16(44 + i * 2, audio.samples[i], true);
  return bytes;
}

export function audioWaveform(audio, bins = 1024) {
  if (!(audio?.samples instanceof Int16Array) || audio.samples.length > AUDIO_LIMITS.maxSamples || audio.sampleRate !== 8000 || !integer(bins, 1, AUDIO_LIMITS.maxWaveformBins)) throw new TypeError('Invalid waveform input.');
  const count = Math.min(bins, audio.samples.length), result = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * audio.samples.length / count), end = Math.floor((i + 1) * audio.samples.length / count);
    let min = 32767, max = -32768;
    for (let n = start; n < end; n++) { min = Math.min(min, audio.samples[n]); max = Math.max(max, audio.samples[n]); }
    result.push({ startSeconds: start / 8000, endSeconds: end / 8000, min: min / 32768, max: max / 32768 });
  }
  return result;
}
