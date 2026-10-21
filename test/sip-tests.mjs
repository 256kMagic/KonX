import assert from 'node:assert/strict';
import { analyzeSipCalls } from '../src/renderer/js/capture/sip.mjs';
import { Analyzer } from '../src/renderer/js/capture/analyze.mjs';
import { decode } from '../src/renderer/js/capture/decode.mjs';
import { readCapture, writePcapng } from '../src/renderer/js/capture/pcapfile.mjs';
import * as P from './lib/packets.mjs';

const encode = (text) => new TextEncoder().encode(text);
const A = 'aa:aa:aa:00:00:01', B = 'bb:bb:bb:00:00:02';
const CLIENT = '192.0.2.10', SERVER = '192.0.2.20';
const sdp = 'v=0\r\no=alice 1 1 IN IP4 192.0.2.10\r\ns=Test call\r\nt=0 0\r\nc=IN IP4 192.0.2.10\r\nm=audio 4000 RTP/AVP 0 96\r\na=rtpmap:96 opus/48000/2\r\n';

function sip({ method = 'INVITE', status = null, reason = 'OK', callId = 'call-1@example.test', cseq = 1, branch = 'z9hG4bK-1', fromTag = 'caller', toTag = null, body = '', headers = [], compact = false, length = true } = {}) {
  const n = (full, short) => compact ? short : full;
  return encode([
    status == null ? `${method} sip:bob@example.test SIP/2.0` : `SIP/2.0 ${status} ${reason}`,
    `${n('Via', 'v')}: SIP/2.0/UDP 192.0.2.10:5060;branch=${branch}`,
    `${n('From', 'f')}: Alice <sip:alice@example.test>${fromTag == null ? '' : ';tag=' + fromTag}`,
    `${n('To', 't')}: Bob <sip:bob@example.test>${toTag == null ? '' : ';tag=' + toTag}`,
    ...(callId == null ? [] : [`${n('Call-ID', 'i')}: ${callId}`]),
    `CSeq: ${cseq} ${method}`,
    ...headers,
    ...(length ? [`${n('Content-Length', 'l')}: ${encode(body).length}`] : []),
    '', body,
  ].join('\r\n'));
}
function datagram(data, options = {}) {
  const { reverse = false, src = reverse ? SERVER : CLIENT, dst = reverse ? CLIENT : SERVER, sport = 5060, dport = 5060, ts = 0 } = options;
  return { ts, linktype: 1, data: P.frame.udp(reverse ? B : A, reverse ? A : B, src, dst, { sport, dport }, data) };
}
function segment(data, options = {}) {
  const { reverse = false, seq = 101, flags = 'PA', ts = 0 } = options;
  return { ts, linktype: 1, data: P.frame.tcp(reverse ? B : A, reverse ? A : B, reverse ? SERVER : CLIENT, reverse ? CLIENT : SERVER, { sport: reverse ? 5070 : 51000, dport: reverse ? 51000 : 5070, seq, flags }, data) };
}
function packets(items, roundtrip = false) {
  const source = roundtrip ? readCapture(writePcapng(items.map((item) => ({ ...item, len: item.data.length, caplen: item.data.length })))).packets : items;
  const analyzer = new Analyzer();
  return source.map((item, index) => {
    const packet = { ...item, no: index + 1, caplen: item.caplen ?? item.data.length, len: item.len ?? item.data.length, lt: item.linktype, d: decode(item.linktype, item.data) };
    analyzer.ingest(packet);
    return packet;
  });
}
const analyze = (items, options) => analyzeSipCalls(packets(items), options);

export async function runSipTests(test) {
  console.log('packet capture: SIP calls and ladders');
  await test('SIP source-PCAPNG unknown timestamps remain unknown for UDP and mixed-time TCP messages', () => {
    const request = { ...datagram(sip(), { ts: 42 }), timestampKnown: false };
    const response = datagram(sip({ status: 200, toTag: 'callee' }), { reverse: true, ts: 43 });
    const call = analyzeSipCalls(packets([request, response], true)).calls[0];
    assert.equal(call.messages.find(m => m.type === 'request').ts, null); assert.equal(call.setupTime, null);
    assert.ok(call.transactions.every(t => t.elapsed === null));
    const wire = sip(), split = 90;
    const tcp = packets([segment([], { seq: 100, flags: 'S', ts: 40 }), segment(wire.subarray(0, split), { seq: 101, ts: 41 }),
      { ...segment(wire.subarray(split), { seq: 101 + split, ts: 42 }), timestampKnown: false }], true);
    const message = analyzeSipCalls(tcp).calls[0].messages[0];
    assert.equal(message.complete, true); assert.deepEqual(message.frames, [2, 3]); assert.equal(message.ts, null);
    assert.match(message.warnings.join(' '), /timestamp.*unavailable/);
  });
  await test('SIP groups an any-port call across proxy legs after a PCAP round trip', () => {
    const result = analyzeSipCalls(packets([
      datagram(sip(), { sport: 55000, dport: 5099, ts: 1 }),
      datagram(sip({ branch: 'z9hG4bK-proxy' }), { src: SERVER, dst: '192.0.2.30', dport: 5098, ts: 1.1 }),
      datagram(sip({ status: 180, reason: 'Ringing', toTag: 'callee', branch: 'z9hG4bK-proxy' }), { src: '192.0.2.30', dst: SERVER, sport: 5098, ts: 1.2 }),
      datagram(sip({ status: 200, toTag: 'callee' }), { reverse: true, sport: 5099, dport: 55000, ts: 2 }),
    ], true));
    assert.equal(result.calls.length, 1);
    const call = result.calls[0];
    assert.equal(call.messages.length, 4);
    assert.equal(call.messages[0].src, '192.0.2.10:55000');
    assert.equal(call.transactions.length, 2);
    assert.match(call.outcome, /Answered/);
    assert.equal(call.setupTime, 1);
    assert.deepEqual(call.frames, [1, 2, 3, 4]);
    assert.equal(result.scannedPackets, 4);
  });
  await test('SIP compact aliases and folded fields retain identity, parameters and SDP', () => {
    const body = sdp;
    const wire = new TextDecoder().decode(sip({ compact: true, body, headers: ['c: application/sdp'] }))
      .replace('f: Alice <sip:alice@example.test>;tag=caller', 'f: "Alice;tag=not-a-tag"\r\n\t<sip:alice@example.test;tag=uri-tag>;tag=caller');
    const message = analyze([datagram(encode(wire))]).calls[0].messages[0];
    assert.equal(message.callId, 'call-1@example.test');
    assert.equal(message.fromTag, 'caller');
    assert.equal(message.branch, 'z9hG4bK-1');
    assert.equal(message.complete, true);
    assert.equal(message.sdp.media[0].port, 4000);
    assert.equal(message.sdp.media[0].codecs.find((c) => c.payloadType === '96').name, 'opus');
    assert.ok(message.headers.some((h) => h.name === 'content-type'));
  });
  await test('SIP uses byte Content-Length for UTF-8 and preserves separate TCP messages', () => {
    const first = sip({ method: 'MESSAGE', body: 'héllo 😀', headers: ['Content-Type: text/plain'] });
    const second = sip({ method: 'OPTIONS', cseq: 2, branch: 'z9hG4bK-2' });
    const whole = P.concat(encode('\r\n\r\n'), first, second);
    const split = 90;
    const result = analyze([
      segment([], { seq: 100, flags: 'S' }),
      segment(whole.subarray(split), { seq: 101 + split, ts: 0.1 }),
      segment(whole.subarray(0, split), { seq: 101, ts: 0.2 }),
    ]);
    const messages = result.calls[0].messages;
    assert.equal(messages.length, 2);
    assert.equal(messages.find((m) => m.method === 'MESSAGE').bodyText, 'héllo 😀');
    assert.equal(messages.find((m) => m.method === 'OPTIONS').complete, true);
    assert.deepEqual(messages.find((m) => m.method === 'MESSAGE').frames, [2, 3]);
  });
  await test('SIP preserves UDP retransmissions as separate marked events', () => {
    const request = sip();
    const result = analyze([datagram(request), datagram(request, { ts: 0.5 }), datagram(sip({ cseq: 2, branch: 'z9hG4bK-2' }), { ts: 1 })]);
    const messages = result.calls[0].messages;
    assert.deepEqual(messages.map((m) => m.retransmission), [false, true, false]);
    assert.deepEqual(messages.map((m) => m.frames), [[1], [2], [3]]);
    assert.equal(result.calls[0].transactions.length, 2);
  });
  await test('SIP-level repeated messages on TCP survive while byte retransmits retain provenance', () => {
    const request = sip();
    const result = analyze([
      segment([], { seq: 100, flags: 'S' }),
      segment(request, { seq: 101, ts: 1 }),
      segment(request, { seq: 101, ts: 1.2 }),
      segment(request, { seq: 101 + request.length, ts: 2 }),
    ]);
    assert.equal(result.calls[0].messages.length, 2);
    assert.deepEqual(result.calls[0].messages[0].frames, [2, 3]);
    assert.equal(result.calls[0].messages[1].retransmission, true);
  });
  await test('SIP authentication challenges do not override a later successful INVITE', () => {
    const result = analyze([
      datagram(sip(), { ts: 1 }),
      datagram(sip({ status: 401, reason: 'Unauthorized', toTag: 'auth' }), { reverse: true, ts: 1.1 }),
      datagram(sip({ cseq: 2, branch: 'z9hG4bK-auth' }), { ts: 1.2 }),
      datagram(sip({ status: 200, cseq: 2, branch: 'z9hG4bK-auth', toTag: 'callee' }), { reverse: true, ts: 2 }),
    ]);
    assert.match(result.calls[0].outcome, /Answered/);
    assert.equal(result.calls[0].messages[1].status, 401);
    const challenge = analyze([datagram(sip()), datagram(sip({ status: 407, reason: 'Proxy Authentication Required', toTag: 'auth' }), { reverse: true, ts: 1 })]);
    assert.equal(challenge.calls[0].outcome, 'Authentication challenge observed');
  });
  await test('SIP dialog forks stay separate and reverse BYE uses the matching tag pair', () => {
    const result = analyze([
      datagram(sip(), { ts: 0 }),
      datagram(sip({ status: 200, toTag: 'fork-a' }), { reverse: true, ts: 1 }),
      datagram(sip({ status: 200, toTag: 'fork-b' }), { reverse: true, ts: 2 }),
      datagram(sip({ method: 'BYE', cseq: 3, fromTag: 'fork-a', toTag: 'caller', branch: 'z9hG4bK-bye' }), { reverse: true, ts: 5 }),
      datagram(sip({ method: 'BYE', status: 200, cseq: 3, fromTag: 'fork-a', toTag: 'caller', branch: 'z9hG4bK-bye' }), { ts: 5.1 }),
    ]);
    const call = result.calls[0];
    assert.equal(call.dialogs.length, 2);
    assert.equal(call.messages[0].dialogId, null);
    assert.equal(call.messages[1].dialogId, call.messages[3].dialogId);
    assert.notEqual(call.messages[1].dialogId, call.messages[2].dialogId);
    const ended = call.dialogs.find((d) => d.toTag === 'fork-a');
    assert.match(ended.outcome, /Ended/);
    assert.ok(Math.abs(ended.duration - 4.1) < 0.000001);
    assert.match(call.outcome, /Answered \(2 dialogs/);
    assert.equal(call.duration, null);
  });
  await test('SIP Call-ID values are case-sensitive and missing identifiers stay isolated', () => {
    const result = analyze([datagram(sip({ callId: 'Case@host' })), datagram(sip({ callId: 'case@host' })), datagram(sip({ callId: null })), datagram(sip({ callId: null }))]);
    assert.equal(result.calls.length, 4);
    assert.equal(result.calls.filter((c) => c.callId === null).length, 2);
  });
  await test('SIP duplicate singleton fields remain ambiguous including compact aliases', () => {
    for (const header of ['i: different@host', 'CSeq: 9 BYE', 'f: <sip:other@host>;tag=other', 'l: 0', 'Content-Type: text/plain\r\nc: application/sdp']) {
      const result = analyze([datagram(sip({ headers: [header] }))]);
      const message = result.calls[0].messages[0];
      assert.equal(message.complete, false, header);
      assert.match(message.warnings.join(' '), /Duplicate/);
      if (header.startsWith('i:')) assert.equal(message.callId, null);
    }
  });
  await test('SIP top Via controls transaction association without collapsing repeated Via fields', () => {
    const wire = new TextDecoder().decode(sip({ headers: ['v: SIP/2.0/UDP previous;branch=z9hG4bK-other'] }));
    const message = analyze([datagram(encode(wire))]).calls[0].messages[0];
    assert.equal(message.branch, 'z9hG4bK-1');
    assert.equal(message.headers.filter((h) => h.name === 'via').length, 2);
  });
  await test('SIP incomplete headers use only terminated fields for attribution', () => {
    const known = encode('INVITE sip:bob@host SIP/2.0\r\nCall-ID: known@host\r\nFrom: <sip:a@host>;tag=a\r\nTo: unfinished');
    const unknown = encode('INVITE sip:bob@host SIP/2.0\r\nCall-ID: unfinished');
    const result = analyze([datagram(known), datagram(unknown)]);
    assert.equal(result.calls[0].callId, 'known@host');
    assert.equal(result.calls[0].messages[0].complete, false);
    assert.equal(result.calls[1].callId, null);
  });
  await test('SIP does not bridge missing TCP bytes and retains attributable partial messages', () => {
    const request = sip({ body: sdp, headers: ['Content-Type: application/sdp'] });
    const cut = request.length - 20;
    const result = analyze([
      segment([], { seq: 100, flags: 'S' }), segment(request.subarray(0, cut), { seq: 101, ts: 1 }),
      segment(request.subarray(cut + 10), { seq: 101 + cut + 10, ts: 2 }),
    ]);
    const message = result.calls[0].messages[0];
    assert.equal(message.callId, 'call-1@example.test');
    assert.equal(message.complete, false);
    assert.equal(message.sdp, null);
    assert.equal(message.frames.length, 1);
    assert.match(message.warnings.join(' '), /missing TCP|incomplete/);
    assert.match(result.warnings.join(' '), /missing bytes/);
  });
  await test('SIP header conflicts do not assert a call identity or complete body', () => {
    const request = sip(), changed = sip({ callId: 'call-2@example.test' });
    const result = analyze([segment([], { seq: 100, flags: 'S' }), segment(request, { seq: 101 }), segment(changed, { seq: 101, ts: 1 })]);
    const message = result.calls[0].messages[0];
    assert.equal(message.complete, false);
    assert.equal(message.callId, null);
    assert.match(message.warnings.join(' '), /Conflicting/);
  });
  await test('SIP truncated UDP datagrams remain partial and are not definite retransmissions', () => {
    const item = datagram(sip());
    item.len = item.data.length + 20;
    const result = analyze([item, { ...item, ts: 1 }]);
    assert.ok(result.calls[0].messages.every((m) => !m.complete && !m.retransmission));
  });
  await test('SIP datagrams allow omitted length while TCP requires a reliable length field', () => {
    const request = sip({ method: 'MESSAGE', body: 'hello', length: false });
    const udp = analyze([datagram(request)]).calls[0].messages[0];
    assert.equal(udp.complete, true);
    assert.equal(udp.bodyText, 'hello');
    const tcp = analyze([segment(request)]).calls[0].messages[0];
    assert.equal(tcp.complete, false);
    assert.match(tcp.warnings.join(' '), /requires an unambiguous Content-Length/);
  });
  await test('SIP invalid lengths, control characters and CSeq mismatches fail explicitly', () => {
    const base = new TextDecoder().decode(sip());
    for (const wire of [base.replace('Content-Length: 0', 'Content-Length: -1'), base.replace('Content-Length: 0', 'Content-Length: \v0'), base.replace('CSeq: 1 INVITE', 'CSeq: 1 BYE')]) {
      const message = analyze([datagram(encode(wire))]).calls[0].messages[0];
      assert.equal(message.complete, false);
      assert.ok(message.warnings.length);
    }
  });
  await test('SIP invalid UTF-8 header identity is not grouped under a replacement value', () => {
    const wire = sip({ callId: 'cafx@host' });
    const start = new TextDecoder().decode(wire).indexOf('cafx@host');
    wire[start + 3] = 0xe9;
    const result = analyze([datagram(wire), datagram(sip({ callId: 'café@host' }), { ts: 1 })]);
    const message = result.calls[0].messages[0];
    assert.equal(message.callId, null);
    assert.equal(message.complete, false);
    assert.equal(message.fromTag, null);
    assert.equal(message.branch, null);
    assert.equal(message.cseq, null);
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[1].callId, 'café@host');
    assert.match(message.warnings.join(' '), /Invalid UTF-8/);
  });
  await test('SIP custom and encrypted payloads are not mistaken for SIP signaling', () => {
    const result = analyze([datagram(encode('not SIP\r\nCall-ID: fake\r\n\r\n')), segment(Uint8Array.of(22, 3, 3, 0, 10, 1, 2, 3))]);
    assert.equal(result.calls.length, 0);
  });
  await test('SIP scan, message, body, header and call limits expose partial coverage', () => {
    const items = [datagram(sip()), datagram(sip({ callId: 'two@host' }), { ts: 1 })];
    const scan = analyze(items, { maxScanPackets: 1 });
    assert.equal(scan.scannedPackets, 1); assert.equal(scan.limited, true);
    const messages = analyze(items, { maxMessages: 1 });
    assert.equal(messages.calls.length, 1); assert.equal(messages.limited, true);
    const calls = analyze(items, { maxCalls: 1 });
    assert.equal(calls.calls.length, 1); assert.equal(calls.limited, true);
    const body = analyze([datagram(sip({ body: 'x'.repeat(20) }))], { maxBodyBytes: 5 });
    assert.equal(body.calls[0].messages[0].complete, false); assert.equal(body.limited, true);
    const header = analyze(items, { maxHeaderBytes: 64 });
    assert.equal(header.calls[0].messages[0].complete, false); assert.equal(header.limited, true);
  });
  await test('SIP stream partition limits do not fabricate unexamined messages', () => {
    const list = packets([segment(sip())]);
    const clone = { ...list[0], no: 2, ann: { ...list[0].ann, stream: 99 } };
    const result = analyzeSipCalls([...list, clone], { maxTcpStreams: 1 });
    assert.equal(result.calls[0].messages.length, 1);
    assert.equal(result.limited, true);
    assert.match(result.warnings.join(' '), /conversation limit/);
  });
  await test('SIP duplicate-comparison limits explicitly leave retransmission status unknown', () => {
    const request = sip();
    const result = analyze([datagram(request), datagram(request, { ts: 1 })], { maxRetransmissionWorkBytes: 1 });
    assert.equal(result.limited, true);
    assert.equal(result.calls[0].messages[1].retransmission, false);
    assert.equal(result.calls[0].messages[1].retransmissionUnknown, true);
    assert.match(result.calls[0].messages[1].warnings.join(' '), /classification is unknown/);
  });
}
