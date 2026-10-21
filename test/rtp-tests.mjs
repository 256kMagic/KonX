// Staged focused suite. On integration, move to test/rtp-tests.mjs and update
// the three source import paths. Packet builders exercise actual UDP decoding.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { analyzeRtp, parseRtp, parseRtcp, mediaMappings, decodeG711, buildRtpAudio, encodeWav, audioWaveform, RTP_LIMITS } from '../src/renderer/js/capture/rtp.mjs';
import { decode } from '../src/renderer/js/capture/decode.mjs';
import { analyzeSipCalls } from '../src/renderer/js/capture/sip.mjs';
import { parseSdp } from '../src/renderer/js/capture/sdp.mjs';
import { readCapture, writePcapng } from '../src/renderer/js/capture/pcapfile.mjs';
import * as P from './lib/packets.mjs';

const A = '192.0.2.10', B = '192.0.2.20', MA = '00:11:22:33:44:55', MB = '00:11:22:33:44:66';
const enc = new TextEncoder();
function wire({ seq = 1, timestamp = 0, ssrc = 123, pt = 0, marker = false, payload = new Uint8Array(160).fill(255), first = 0x80, extra = [] } = {}) {
  return P.concat([first, pt | (marker ? 128 : 0)], P.u16(seq), P.u32(timestamp), P.u32(ssrc), extra, payload);
}
function packet(bytes, { no = 1, ts = 1, src = A, dst = B, sport = 4000, dport = 5000 } = {}) {
  const data = P.frame.udp(MA, MB, src, dst, { sport, dport }, bytes);
  return { no, ts, data, len: data.length, caplen: data.length, linktype: 1, lt: 1, d: decode(1, data) };
}
const codec = (payloadType = 0, name = 'PCMU', clockRate = 8000, channels = 1) => ({ payloadType, name, clockRate, channels });
const mapping = (extra = {}) => ({ address: B, port: 5000, protocol: 'RTP/AVP', codecs: [codec(), codec(8, 'PCMA')], frames: [100], callId: 'call@example.test', callKey: 'sip-call-1', ...extra });
const analyze = (items, options = {}) => analyzeRtp(items, { mappings: [mapping()], ...options });
function sequence(values, other = {}) { return values.map((seq, i) => packet(wire({ seq, timestamp: i * 160, ...other }), { no: i + 1, ts: 1 + i * 0.02 })); }
function sdp(ip, port, protocol = 'RTP/AVP') { return `v=0\r\no=alice 1 1 IN IP4 ${ip}\r\ns=Test\r\nc=IN IP4 ${ip}\r\nt=0 0\r\nm=audio ${port} ${protocol} 0\r\n`; }
function sip(body, response = false) {
  return enc.encode(`${response ? 'SIP/2.0 200 OK' : 'INVITE sip:bob@example.test SIP/2.0'}\r\nVia: SIP/2.0/UDP ${A}:5060;branch=z9hG4bK-fixture\r\nFrom: <sip:alice@example.test>;tag=a\r\nTo: <sip:bob@example.test>${response ? ';tag=b' : ''}\r\nCall-ID: fixture-call@example.test\r\nCSeq: 1 INVITE\r\nContent-Type: application/sdp\r\nContent-Length: ${enc.encode(body).length}\r\n\r\n${body}`);
}
function rtcpReport({ type = 201, ssrc = 777, reportedSsrc = 123, lost = -2, jitter = 800 } = {}) {
  const block = P.concat(P.u32(reportedSsrc), [128, (lost >> 16) & 255, (lost >> 8) & 255, lost & 255], P.u32(65540), P.u32(jitter), P.u32(1234), P.u32(65536));
  const sender = type === 200 ? P.concat(P.u32(3900000000), P.u32(0x80000000), P.u32(320), P.u32(12), P.u32(1920)) : new Uint8Array();
  const body = P.concat(P.u32(ssrc), sender, block);
  return P.concat([0x81, type], P.u16(body.length / 4), body);
}

export async function runRtpTests(test) {
  await test('RTP/SDP: actual SIP and UDP packets associate both call directions after PCAPNG round trip', () => {
    const source = [packet(sip(sdp(A, 4000)), { no: 1, ts: 0, sport: 5060, dport: 5060 }), packet(sip(sdp(B, 5000), true), { no: 2, ts: 0.1, src: B, dst: A, sport: 5060, dport: 5060 }),
      packet(wire(), { no: 3, ts: 1 }), packet(wire({ ssrc: 456 }), { no: 4, ts: 1.01, src: B, dst: A, sport: 5000, dport: 4000 })];
    const reopened = readCapture(writePcapng(source)).packets.map((p, i) => ({ ...p, no: i + 1, d: decode(p.linktype, p.data) }));
    const calls = analyzeSipCalls(reopened).calls;
    assert.equal(calls.length, 1);
    const result = analyzeRtp(reopened, { sipCalls: calls });
    assert.equal(result.streams.length, 2);
    assert.ok(result.streams.every((s) => s.identification === 'SDP receive endpoint'));
    assert.ok(result.streams.every((s) => s.associations[0].callId === 'fixture-call@example.test'));
    assert.deepEqual(result.streams.flatMap((s) => s.frames), [3, 4]);
    assert.deepEqual(result.streams.map((s) => s.clockRate), [8000, 8000]);
  });
  await test('RTP header: CSRC, extension and padding boundaries exclude non-media bytes', () => {
    const payload = Uint8Array.of(0xff, 0xfe, 0, 0, 0, 4);
    const parsed = parseRtp(wire({ first: 0xb1, extra: P.concat(P.u32(99), P.u16(0xbede), P.u16(1), [1, 2, 3, 4]), payload }));
    assert.equal(parsed.ok, true); assert.deepEqual(parsed.csrc, [99]); assert.equal(parsed.headerBytes, 24);
    assert.equal(parsed.extensionProfile, 0xbede); assert.equal(parsed.paddingBytes, 4); assert.deepEqual([...parsed.payload], [255, 254]);
    assert.equal(parseRtp(wire({ first: 0x90, extra: [0, 0, 255, 255], payload: [] })).ok, false);
    assert.equal(parseRtp(wire({ first: 0xa0, payload: [0] })).ok, false);
    assert.equal(parseRtp(wire({ first: 0x8f, payload: [] })).ok, false);
    assert.equal(parseRtp(Uint8Array.of(0x80)).ok, false);
  });
  await test('RTP sequences: wrap, late fill, duplicate and out-of-order packets retain source frames', () => {
    const seqs = [65534, 65535, 0, 2, 1, 2], timestamps = [0, 160, 320, 640, 480, 640];
    const s = analyze(seqs.map((seq, i) => packet(wire({ seq, timestamp: timestamps[i] }), { no: i + 1, ts: i * 0.02 }))).streams[0];
    assert.equal(s.uniquePackets, 5); assert.equal(s.sequenceGaps, 0); assert.equal(s.outOfOrderPackets, 1); assert.equal(s.duplicatePackets, 1);
    assert.deepEqual(s.packets.map((p) => p.extendedSequence), [65534, 65535, 65536, 65538, 65537, 65538]);
    assert.equal(buildRtpAudio(s).samples.length, 800);
  });
  await test('RTP sequences: missing observations are gaps, and large discontinuities do not fabricate huge loss', () => {
    const s = analyze(sequence([10, 12])).streams[0];
    assert.equal(s.sequenceGaps, 1); assert.match(s.warnings.join(' '), /do not establish network loss/);
    const restarted = analyze(sequence([10, 6000, 6001])).streams[0];
    assert.equal(restarted.sequenceEpochs, 2); assert.equal(restarted.sequenceGaps, 0); assert.equal(restarted.audioSupported, false);
  });
  await test('RTP jitter: RFC3550 arrival-order estimator uses known RTP clock units', () => {
    const s = analyze([packet(wire({ seq: 1, timestamp: 0 }), { no: 1, ts: 1 }), packet(wire({ seq: 2, timestamp: 160 }), { no: 2, ts: 1.03 }), packet(wire({ seq: 3, timestamp: 320 }), { no: 3, ts: 1.05 })]).streams[0];
    assert.equal(s.packets[0].jitterMs, null);
    assert.ok(Math.abs(s.packets[1].jitterMs - 0.625) < 1e-10);
    assert.ok(Math.abs(s.packets[2].jitterMs - 0.5859375) < 1e-10);
    assert.equal(s.clockRate, 8000);
  });
  await test('RTP time: zero capture time, timestamp wrap and reversed capture clocks stay explicit', () => {
    const s = analyze([packet(wire({ timestamp: 0xfffffff0 }), { no: 1, ts: 0 }), packet(wire({ seq: 2, timestamp: 144 }), { no: 2, ts: 0.02 })]).streams[0];
    assert.equal(s.startTime, 0); assert.equal(s.packets[1].extendedTimestamp - s.packets[0].extendedTimestamp, 160);
    assert.equal(buildRtpAudio(s).samples.length, 320);
    const reversed = analyze([packet(wire(), { no: 1, ts: 2 }), packet(wire({ seq: 2, timestamp: 160 }), { no: 2, ts: 1 })]).streams[0];
    assert.equal(reversed.packets[1].jitterMs, null); assert.ok(reversed.packets[1].flags.includes('capture time reversed'));
  });
  await test('RTP codecs: unknown dynamic mapping never invents sample rate or audio', () => {
    const s = analyze(sequence([1, 2], { pt: 96 }), { mappings: [mapping({ codecs: [codec(96, null, null, null)] })] }).streams[0];
    assert.equal(s.clockRate, null); assert.equal(s.maxJitterMs, null); assert.equal(s.audioSupported, false);
    assert.throws(() => buildRtpAudio(s), /unsupported or ambiguous/);
    const staticUnknown = analyze(sequence([1]), { mappings: [mapping({ codecs: [codec(0, null, null, null)] })] }).streams[0];
    assert.equal(staticUnknown.clockRate, null);
  });
  await test('RTP codecs: conflicting declarations remain unknown and payload changes share sequence space', () => {
    const ambiguous = analyze(sequence([1, 2]), { mappings: [mapping(), mapping({ callId: 'other', codecs: [codec(0, 'OPUS', 48000, 2)] })] }).streams[0];
    assert.equal(ambiguous.audioSupported, false); assert.equal(ambiguous.clockRate, null);
    assert.match(ambiguous.warnings.join(' '), /ambiguous/);
    const s = analyze([packet(wire(), { no: 1 }), packet(wire({ seq: 2, timestamp: 160, pt: 8, payload: new Uint8Array(160).fill(0xd5) }), { no: 2, ts: 1.02 }), packet(wire({ seq: 3, timestamp: 320 }), { no: 3, ts: 1.04 })]).streams[0];
    assert.equal(s.sequenceGaps, 0); assert.equal(s.payloadTypes.length, 2); assert.equal(s.audioSupported, true);
    assert.equal(buildRtpAudio(s).samples[160], 8);
  });
  await test('RTP heuristics: opt-in, sequence probation and explicit audio confirmation', () => {
    const items = sequence([1, 2, 3]);
    assert.equal(analyzeRtp(items).streams.length, 0);
    const s = analyzeRtp(items, { allowHeuristic: true }).streams[0];
    assert.equal(s.identification, 'heuristic candidate');
    assert.throws(() => buildRtpAudio(s), /Confirm the heuristic/);
    assert.equal(buildRtpAudio(s, { allowHeuristic: true }).samples.length, 480);
    assert.equal(analyzeRtp(sequence([1, 3000, 5999]), { allowHeuristic: true }).streams.length, 0);
    assert.equal(analyzeRtp(items.slice(0, 1), { allowHeuristic: true }).excluded.unconfirmedHeuristic, 1);
  });
  await test('RTP encryption: SRTP-advertised endpoints are excluded even with heuristic parsing enabled', () => {
    const calls = [{ id: 'c', callId: 'srtp', messages: [{ complete: true, frames: [99], ts: 0, sdp: parseSdp(sdp(B, 5000, 'RTP/SAVP')) }] }];
    const result = analyzeRtp(sequence([1, 2, 3]), { sipCalls: calls, allowHeuristic: true });
    assert.equal(result.streams.length, 0); assert.equal(result.excluded.encrypted, 3);
    assert.match(result.warnings.join(' '), /no media decryption/);
  });
  await test('RTP boundaries: truncated, fragmented and malformed UDP captures are never treated as complete media', () => {
    const items = sequence([1, 2, 3]); items[0].caplen--; items[1].d.fragmented = true; items[2].d.f['udp.length']++;
    const result = analyze(items); assert.equal(result.streams.length, 0); assert.equal(result.excluded.fragmentedOrTruncated, 3);
  });
  await test('RTP conflicts: same sequence with different payload refuses audio reconstruction', () => {
    const s = analyze([packet(wire(), { no: 1 }), packet(wire({ payload: new Uint8Array(160).fill(0) }), { no: 2 })]).streams[0];
    assert.equal(s.conflictingPackets, 1); assert.equal(s.duplicatePackets, 0); assert.equal(s.audioSupported, false);
    assert.throws(() => buildRtpAudio(s), /ambiguous/);
  });
  await test('RTCP reports: signed cumulative loss, fraction, clock-unit jitter and SR sender counters', () => {
    const rr = parseRtcp(rtcpReport()); assert.equal(rr.ok, true); const reception = rr.reports[0].reception[0];
    assert.equal(reception.cumulativeLost, -2); assert.equal(reception.fractionLost, 0.5); assert.equal(reception.jitterTimestampUnits, 800);
    const sr = parseRtcp(rtcpReport({ type: 200 })); assert.equal(sr.reports[0].sender.packetCount, 12); assert.equal(sr.reports[0].sender.ntpFraction, 0x80000000);
    const combined = parseRtcp(P.concat(rtcpReport({ type: 200 }), rtcpReport())); assert.deepEqual(combined.types, [200, 201]);
    const result = analyzeRtp([packet(rtcpReport(), { dport: 5001 })], { mappings: [mapping({ port: 5001, kind: 'rtcp' })] });
    assert.equal(result.streams.length, 0); assert.equal(result.rtcp[0].frame, 1); assert.equal(result.rtcp[0].identification, 'SDP endpoint');
  });
  await test('RTCP boundaries: malformed report lengths, padding and incomplete compound blocks are rejected', () => {
    const short = rtcpReport().slice(0, -1); assert.equal(parseRtcp(short).ok, false);
    const count = rtcpReport(); count[0] = 0x9f; assert.equal(parseRtcp(count).ok, false);
    const pad = rtcpReport(); pad[0] |= 32; pad[pad.length - 1] = 0; assert.equal(parseRtcp(pad).ok, false);
    assert.equal(parseRtcp(P.concat(rtcpReport(), [0x80])).ok, false);
  });
  await test('G.711: mu-law and A-law reference extrema, silence and signed near-zero values', () => {
    assert.deepEqual([...decodeG711(Uint8Array.of(255, 127, 0, 128, 254, 126), 'PCMU')], [0, 0, -32124, 32124, 8, -8]);
    assert.deepEqual([...decodeG711(Uint8Array.of(0xd5, 0x55, 0xaa, 0x2a, 0xff), 'PCMA')], [8, -8, 32256, -32256, 848]);
    assert.throws(() => decodeG711(Uint8Array.of(1), 'OPUS'), /Unsupported/);
  });
  await test('RTP audio: timestamp gaps insert bounded explicit silence and WAV is PCM16 little-endian', () => {
    const s = analyze([packet(wire({ payload: Uint8Array.of(0, 128) }), { no: 1 }), packet(wire({ seq: 2, timestamp: 4, payload: Uint8Array.of(255, 254) }), { no: 2, ts: 1.0005 })]).streams[0];
    const audio = buildRtpAudio(s); assert.deepEqual([...audio.samples], [-32124, 32124, 0, 0, 0, 8]); assert.equal(audio.insertedSilenceSamples, 2);
    assert.deepEqual(audio.gaps, [{ startSample: 2, endSample: 4, beforeFrame: 1, afterFrame: 2 }]);
    const wav = encodeWav(audio), view = new DataView(wav.buffer); assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
    assert.equal(view.getUint32(4, true), wav.length - 8); assert.equal(view.getUint16(20, true), 1); assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(24, true), 8000); assert.equal(view.getUint16(34, true), 16); assert.equal(view.getUint32(40, true), 12); assert.equal(view.getInt16(44, true), -32124);
    const waveform = audioWaveform(audio, 3); assert.equal(waveform.length, 3); assert.equal(waveform[1].min, 0); assert.equal(waveform[1].max, 0);
  });
  await test('RTP audio bounds: overlapping timestamps, large gaps and giant duration fail before allocation', () => {
    for (const [timestamp, pattern] of [[100, /overlap/], [90000, /gap/], [10000000, /duration/]]) {
      const s = analyze([packet(wire(), { no: 1 }), packet(wire({ seq: 2, timestamp }), { no: 2 })]).streams[0];
      assert.throws(() => buildRtpAudio(s), pattern);
    }
  });
  await test('RTP resource bounds: retained media, scan count and report output expose incomplete coverage', () => {
    const items = sequence([1, 2, 3]);
    const limited = analyze(items, { limits: { maxPayloadBytes: 160 } }); assert.equal(limited.limited, true); assert.equal(limited.streams[0].packetCount, 1); assert.equal(limited.streams[0].incomplete, true);
    const scanned = analyze(items, { limits: { maxScanPackets: 2 } }); assert.equal(scanned.scannedPackets, 2); assert.equal(scanned.limited, true);
    assert.throws(() => analyze(items, { limits: { maxStreams: RTP_LIMITS.maxStreams + 1 } }), /Invalid RTP limit/);
    assert.throws(() => analyzeRtp(items, { madeUp: true }), /Unknown RTP option/);
    const s = analyze(items).streams[0]; assert.equal(JSON.stringify(s).includes('"payload":'), false);
    assert.throws(() => buildRtpAudio(JSON.parse(JSON.stringify(s))), /original analyzed capture/);
  });
  await test('RTP mappings: media port zero and inactive time windows do not create observed calls', () => {
    const calls = [{ id: 'c', callId: 'call', messages: [{ complete: true, ts: 1, frames: [90], sdp: parseSdp(sdp(B, 0)) }] }];
    assert.equal(mediaMappings(calls).mappings.length, 0);
    const result = analyze(sequence([1, 2, 3]), { mappings: [mapping({ from: 4, until: 5 })] }); assert.equal(result.streams.length, 0);
  });
  await test('RTP mapping bounds: repeated SDP declarations coalesce and invalid time windows fail closed', () => {
    const s = analyze(sequence([1, 2, 3]), { mappings: Array.from({ length: 100 }, (_, n) => mapping({ from: n / 1000, frames: [n + 1000] })) }).streams[0];
    assert.equal(s.associations.length, 1); assert.equal(s.associations[0].frames.length, 64);
    assert.throws(() => analyze(sequence([1]), { mappings: [mapping({ from: 'invalid' })] }), /time window/);
    const calls = [{ messages: [{ complete: true, ts: 0, frames: [9], sdp: parseSdp(sdp(B, 5000)) }] }];
    const limited = mediaMappings(calls, 1); assert.equal(limited.mappings.length, 1); assert.equal(limited.limited, true);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let total = 0, failed = 0;
  await runRtpTests(async (name, fn) => { total++; try { await fn(); console.log('ok ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } });
  console.log(`${total - failed}/${total} RTP tests passed`); process.exitCode = failed ? 1 : 0;
}

