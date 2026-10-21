import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { analyzeCaptureSnapshot, compareCaptures, COMPARE_LIMITS } from '../src/renderer/js/capture/capture-compare.mjs';
import { readCapture, writePcapng } from '../src/renderer/js/capture/pcapfile.mjs';
import { decode } from '../src/renderer/js/capture/decode.mjs';
import { parseHttpStream } from '../src/renderer/js/capture/http.mjs';
import { demoPackets } from './make-compare-fixtures.mjs';
import { createComparisonDemo } from '../src/renderer/js/capture/sample-compare.mjs';
import * as P from './lib/packets.mjs';
import { buildSipCallCapture } from '../src/renderer/js/capture/sip-export.mjs';

const metric = (snapshot, category, name) => snapshot.services.flatMap(s => s.metrics).find(m => m.category === category && m.metric.startsWith(name));
const change = (report, category, name) => report.changes.find(m => m.category === category && m.metric.startsWith(name));
const parse = packets => readCapture(writePcapng(packets));
const snapshot = async packets => { const read = parse(packets); return analyzeCaptureSnapshot(read.packets, { coverage: read.coverage }); };
const comparison = async (before, after, options = {}) => {
  const b = parse(before), a = parse(after);
  return compareCaptures(b.packets, a.packets, { coverage: { before: b.coverage, after: a.coverage }, ...options });
};
const copy = packets => packets.map(packet => ({ ...packet, data: new Uint8Array(packet.data) }));
const tcpView = packet => new DataView(packet.data.buffer, packet.data.byteOffset + 34, packet.data.length - 34);
const decodedTcp = packet => decode(packet.linktype ?? 1, packet.data).tcp;
const tcpFrames = packets => packets.filter(packet => decodedTcp(packet));
const no = packets => packets.map((packet, index) => ({ ...packet, no: index + 1 }));
const le16 = value => [value & 255, value >>> 8 & 255];
const le32 = value => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
const block = (type, body) => { const padded = [...body]; while (padded.length % 4) padded.push(0); const length = padded.length + 12; return P.concat(le32(type), le32(length), padded, le32(length)); };
const section = () => block(0x0a0d0d0a, P.concat(le32(0x1a2b3c4d), le16(1), le16(0), new Array(8).fill(255)));
const iface = () => block(1, P.concat(le16(1), le16(0), le32(65535)));
const classic = records => P.concat([0xd4, 0xc3, 0xb2, 0xa1], le16(2), le16(4), le32(0), le32(0), le32(65535), le32(1),
  records.map(packet => P.concat(le32(Math.floor(packet.ts)), le32(Math.round((packet.ts % 1) * 1e6)), le32(packet.data.length), le32(packet.len ?? packet.data.length), packet.data)));

export async function runCaptureCompareTests(test) {
  await test('comparison fixture roundtrip links original DNS/TCP/HTTP frames and reports changes', async () => {
    const demo = createComparisonDemo(), b = readCapture(demo.before.bytes), a = readCapture(demo.after.bytes);
    const report = await compareCaptures(b.packets, a.packets, { labels: { before: 'Working', after: 'Failing' }, coverage: { before: b.coverage, after: a.coverage } });
    assert.equal(report.before.label, 'Working'); assert.equal(report.after.label, 'Failing');
    assert.deepEqual(report.summary, { matchedServices: 2, unmatchedBefore: 0, unmatchedAfter: 0, changed: 8, same: 1, unknown: 0, unmatched: 0 });
    assert.equal(change(report, 'dns', 'observed response time').before.meanMs, 5);
    assert.equal(change(report, 'dns', 'observed response time').after.meanMs, 200);
    assert.deepEqual(change(report, 'dns', 'response codes').after, [{ code: 2, count: 1 }]);
    assert.equal(change(report, 'tcp', 'SYN').before.meanMs, 10); assert.equal(change(report, 'tcp', 'SYN').after.meanMs, 250);
    assert.deepEqual(change(report, 'http', 'observed status').before, [{ code: 200, count: 1 }]);
    assert.deepEqual(change(report, 'http', 'observed status').after, [{ code: 503, count: 1 }]);
    assert.equal(change(report, 'http', 'first request').before.meanMs, 40); assert.equal(change(report, 'http', 'first request').after.meanMs, 900);
    for (const row of report.changes) { assert.ok(row.beforeSources.length); assert.ok(row.afterSources.length); for (const source of row.beforeSources) assert.ok(source.frame >= 1 && source.frame <= b.packets.length); }
    const json = JSON.stringify(report); assert.equal(json.includes('temporarily unavailable'), false); assert.equal(json.includes('Content-Length'), false); assert.equal(json.includes('"data":{'), false);
  });

  await test('automatic service identity ignores ephemeral client ports but preserves client and server IPs', async () => {
    const before = demoPackets(false), after = demoPackets(false, { port: 60000, base: 1900000000 });
    const same = await comparison(before, after); assert.equal(same.summary.matchedServices, 2); assert.equal(same.summary.changed, 0);
    const moved = await comparison(before, demoPackets(false, { client: '192.0.2.11' }));
    assert.equal(moved.summary.matchedServices, 0); assert.equal(moved.summary.unmatchedBefore, 2); assert.equal(moved.summary.unmatchedAfter, 2);
    assert.ok(moved.changes.every(row => row.status === 'unmatched' && !/removed/i.test(row.status)));
  });

  await test('partial explicit service mappings pair only the chosen identities and auto-match remaining services', async () => {
    const before = demoPackets(false), after = demoPackets(false, { server: '198.51.100.21' });
    const original = await comparison(before, after);
    const b = original.before.services.find(s => s.identity.transport === 'TCP'), a = original.after.services.find(s => s.identity.transport === 'TCP');
    const paired = await comparison(before, after, { identityMappings: [{ beforeServiceId: b.id, afterServiceId: a.id }] });
    assert.equal(paired.summary.matchedServices, 2); assert.equal(paired.summary.unmatchedAfter, 0);
    assert.ok(paired.services.find(s => s.identity.transport === 'TCP').warnings.some(w => /caller choice/.test(w)));
    await assert.rejects(comparison(before, after, { identityMappings: [{ beforeServiceId: 'missing', afterServiceId: a.id }] }), /existing services/);
    await assert.rejects(comparison(before, after, { identityMappings: [{ beforeServiceId: b.id, afterServiceId: a.id }, { beforeServiceId: b.id, afterServiceId: a.id }] }), /distinct/);
  });

  await test('TCP setup requires a SYN-ACK with the matching reverse tuple and acknowledgment', async () => {
    const packets = copy(demoPackets(false)), synack = packets.find(p => decodedTcp(p)?.flags === 18); tcpView(synack).setUint32(8, 123456, false);
    const result = await snapshot(packets), setup = metric(result, 'tcp', 'SYN');
    assert.equal(setup.status, 'unknown'); assert.equal(setup.value.matchedSynAcks, 0); assert.equal(setup.value.samples, 0);
    assert.equal(metric(result, 'http', 'first request').status, 'unknown');
    assert.ok(result.services.some(s => s.warnings.some(w => /acknowledgment/.test(w))));
  });

  await test('repeated SYNs and repeated request-start bytes leave timing ambiguous', async () => {
    const packets = copy(demoPackets(false)), synIndex = packets.findIndex(p => decodedTcp(p)?.flags === 2), originalSyn = packets[synIndex];
    packets.splice(synIndex + 1, 0, { ...originalSyn, ts: originalSyn.ts + .001, data: new Uint8Array(originalSyn.data) });
    const requestIndex = packets.findIndex(p => decodedTcp(p)?.plen > 0 && decodedTcp(p)?.dport === 80), request = packets[requestIndex];
    packets.splice(requestIndex + 1, 0, { ...request, ts: request.ts + .0005, data: new Uint8Array(request.data) });
    const result = await snapshot(packets);
    assert.equal(metric(result, 'tcp', 'SYN').value.matchedSynAcks, 1); assert.equal(metric(result, 'tcp', 'SYN').status, 'unknown');
    assert.equal(metric(result, 'http', 'first request').status, 'unknown');
    assert.equal(metric(result, 'tcp', 'duplicate sequence').value.packets, 2);
  });

  await test('mixed valid and unresolved DNS, TCP and HTTP timings retain samples but aggregate as unknown', async () => {
    const first = demoPackets(false), second = copy(demoPackets(false, { port: 55000, base: 1700000010 }));
    const query = second[0]; second.splice(1, 0, { ...query, ts: query.ts + .001, data: new Uint8Array(query.data) });
    const synIndex = second.findIndex(p => decodedTcp(p)?.flags === 2), syn = second[synIndex];
    second.splice(synIndex + 1, 0, { ...syn, ts: syn.ts + .001, data: new Uint8Array(syn.data) });
    const requestIndex = second.findIndex(p => decodedTcp(p)?.plen > 0 && decodedTcp(p)?.dport === 80), request = second[requestIndex];
    second.splice(requestIndex + 1, 0, { ...request, ts: request.ts + .0005, data: new Uint8Array(request.data) });
    const result = await snapshot(first.concat(second));
    for (const [category, name] of [['dns', 'observed response time'], ['tcp', 'SYN'], ['http', 'first request']]) {
      const item = metric(result, category, name); assert.equal(item.status, 'unknown'); assert.equal(item.value.samples, 1); assert.equal(item.value.unknown, 1);
    }
    const compared = await comparison(first.concat(demoPackets(false, { port: 55000, base: 1700000010 })), first.concat(second));
    for (const [category, name] of [['dns', 'observed response time'], ['tcp', 'SYN'], ['http', 'first request']]) assert.equal(change(compared, category, name).status, 'unknown');
  });

  await test('TCP tuple reuse after a close creates separate observed connections', async () => {
    const first = demoPackets(false), second = copy(demoPackets(false, { base: 1700000010 }));
    for (const packet of tcpFrames(second)) { const view = tcpView(packet); view.setUint32(4, (view.getUint32(4, false) + 1000) >>> 0, false); if (decodedTcp(packet).flags & 16) view.setUint32(8, (view.getUint32(8, false) + 1000) >>> 0, false); }
    const result = await snapshot(first.concat(second));
    assert.equal(result.coverage.flowCount, 2); assert.equal(metric(result, 'tcp', 'SYN').value.samples, 2);
    assert.equal(metric(result, 'tcp', 'observed resets').value.flows, 2);
    assert.deepEqual(metric(result, 'http', 'observed status').value, [{ code: 200, count: 2 }]);
  });

  await test('missing SYNs or a sequence gap do not fabricate HTTP pairing or durations', async () => {
    const packets = demoPackets(false);
    const noStarts = packets.filter(p => !(decodedTcp(p)?.flags & 2));
    const midstream = await snapshot(noStarts);
    assert.equal(metric(midstream, 'http', 'first request').status, 'unknown'); assert.equal(metric(midstream, 'tcp', 'SYN').status, 'unknown');
    const gap = packets.filter(p => !(decodedTcp(p)?.dport === 80 && decodedTcp(p)?.seq === 118));
    const missing = await snapshot(gap); assert.equal(metric(missing, 'http', 'first request').value.samples, 0);
  });

  await test('unknown flow direction remains unidentified rather than guessing a service from port numbers', async () => {
    const packets = demoPackets(false).filter(p => decodedTcp(p)?.flags === 16);
    const result = await snapshot(packets); assert.equal(result.services.length, 0); assert.equal(result.unidentified.length, 1); assert.ok(result.unidentified[0].sources.length);
  });

  await test('conflicting simultaneous SYN directions remain ambiguous', async () => {
    const packets = tcpFrames(copy(demoPackets(false))).slice(0, 2);
    const reverse = packets[1]; reverse.data[47] = 2; tcpView(reverse).setUint32(8, 0, false);
    const result = await snapshot(packets); assert.equal(result.services.length, 0); assert.equal(result.unidentified.length, 1);
  });

  await test('unparsed HTTP bytes after a valid response leave message coverage unknown', async () => {
    const packets = copy(demoPackets(false)), lastData = [...packets].reverse().find(p => decodedTcp(p)?.sport === 80 && decodedTcp(p)?.plen > 0);
    const t = decodedTcp(lastData), junk = P.frame.tcp('02:00:00:00:00:02', '02:00:00:00:00:01', '198.51.100.20', '192.0.2.10',
      { sport: 80, dport: t.dport, seq: t.seq + t.plen, ack: t.ack, flags: 'PA' }, P.str('unsupported trailing bytes'));
    packets.splice(packets.indexOf(lastData) + 1, 0, { ts: lastData.ts + .001, data: junk, len: junk.length, linktype: 1 });
    const result = await snapshot(packets); assert.equal(metric(result, 'http', 'observed status').status, 'unknown'); assert.equal(metric(result, 'http', 'first request').status, 'unknown');
  });

  await test('encrypted TLS traffic has explicit HTTP unavailability with original frame sources', async () => {
    const packets = [], m1 = '02:00:00:00:00:01', m2 = '02:00:00:00:00:02';
    const add = (ts, reverse, fields, payload = []) => { const data = P.frame.tcp(m1, m2, reverse ? '198.51.100.20' : '192.0.2.10', reverse ? '192.0.2.10' : '198.51.100.20', { sport: reverse ? 443 : 50000, dport: reverse ? 50000 : 443, ...fields }, payload); packets.push({ ts, data, len: data.length }); };
    add(1, false, { seq: 100, flags: 'S' }); add(1.01, true, { seq: 500, ack: 101, flags: 'SA' }); add(1.02, false, { seq: 101, ack: 501, flags: 'PA' }, P.tlsClientHello('app.example.test'));
    const result = await snapshot(packets), http = metric(result, 'http', 'observed status');
    assert.equal(http.status, 'unknown'); assert.match(http.reason, /Encrypted/); assert.ok(http.sources.length); assert.equal(metric(result, 'tcp', 'SYN').value.meanMs, 10);
  });

  await test('DNS ID matching is scoped to client/server transport tuple and complete question', async () => {
    const m1 = '02:00:00:00:00:01', m2 = '02:00:00:00:00:02';
    const make = (ts, resolver, response, name = 'app.example.test') => { const data = P.frame.udp(m1, m2, response ? resolver : '192.0.2.10', response ? '192.0.2.10' : resolver,
      { sport: response ? 53 : 51000, dport: response ? 51000 : 53 }, P.dns({ id: 9, name, response, answers: response ? [{ type: 'A', data: '198.51.100.20' }] : [] })); return { ts, data, len: data.length }; };
    const result = await snapshot([make(1, '192.0.2.53', false), make(2, '192.0.2.54', false), make(3, '192.0.2.53', true), make(5, '192.0.2.54', true)]);
    assert.equal(result.services.length, 2); assert.deepEqual(result.services.map(s => s.metrics.find(m => m.metric.startsWith('observed response time')).value.meanMs), [2000, 3000]);
    const wrongName = await snapshot([make(1, '192.0.2.53', false), make(3, '192.0.2.53', true, 'different.example.test')]);
    assert.ok(wrongName.services.flatMap(s => s.metrics).filter(m => m.metric.startsWith('observed response time')).every(m => m.status === 'unknown'));
  });

  await test('DNS question and answer class remain distinct in source facts and comparison identity', async () => {
    const normal = demoPackets(false).slice(0, 2), other = copy(normal);
    const nameLength = 'app.example.test'.length + 2, questionClass = 42 + 12 + nameLength + 2;
    for (const packet of other) { packet.data[questionClass] = 0; packet.data[questionClass + 1] = 3; }
    const answerClass = questionClass + 2 + 4; other[1].data[answerClass] = 0; other[1].data[answerClass + 1] = 3;
    assert.equal(decode(1, other[1].data).dns.answers[0].class, 3);
    const result = await snapshot(normal.concat(other));
    const answers = result.services[0].metrics.filter(m => m.metric.startsWith('answers:'));
    assert.equal(answers.length, 2); assert.ok(answers.some(m => /class 1$/.test(m.metric))); assert.ok(answers.some(m => /class 3$/.test(m.metric)));
    assert.deepEqual(answers.map(m => m.value[0].class).sort(), [1, 3]);
    const compared = await comparison(normal, other); assert.ok(compared.changes.every(row => row.status === 'unknown')); assert.equal(compared.summary.same, 0);
  });

  await test('DNS retries, missing replies and truncated responses preserve uncertainty', async () => {
    const packets = copy(demoPackets(false).slice(0, 2));
    const retried = await snapshot([packets[0], { ...packets[0], ts: packets[0].ts + .001 }, packets[1]]);
    assert.equal(metric(retried, 'dns', 'observed response time').status, 'unknown');
    const missing = await snapshot(packets.slice(0, 1)); assert.equal(metric(missing, 'dns', 'answers').status, 'unknown');
    assert.match(metric(missing, 'dns', 'answers').reason, /not proof/);
    packets[1].data[44] |= 2; // DNS TC flag belongs to the owning DNS decoder.
    const truncated = await snapshot(packets); assert.equal(metric(truncated, 'dns', 'answers').status, 'unknown');
    assert.equal(decode(1, packets[1].data).dns.truncated, true);
  });

  await test('unsupported DNS record previews are not compared as complete answer values', async () => {
    const data = P.frame.udp('02:00:00:00:00:01', '02:00:00:00:00:02', '192.0.2.53', '192.0.2.10', { sport: 53, dport: 51000 },
      P.dns({ id: 9, name: 'app.example.test', type: 'TXT', response: true, answers: [{ type: 'TXT', data: '\u0003one\u0003two' }] }));
    const decoded = decode(1, data); assert.equal(decoded.dns.answers[0].decoded, false);
    const result = await snapshot([{ ts: 1, data, len: data.length }]); assert.equal(metric(result, 'dns', 'answers').status, 'unknown');
  });

  await test('unknown and negative source timestamps do not become zero or negative latency', async () => {
    const read = parse(demoPackets(false));
    const unknown = await analyzeCaptureSnapshot(read.packets.map(p => ({ ...p, ts: 0, timestampKnown: false })), { coverage: read.coverage });
    for (const m of unknown.services.flatMap(s => s.metrics).filter(m => /time|SYN|first request/.test(m.metric))) { assert.equal(m.status, 'unknown'); assert.equal(m.value.samples, 0); }
    const backwards = copy(demoPackets(false)); backwards[1].ts = backwards[0].ts - 1;
    assert.equal(metric(await snapshot(backwards), 'dns', 'observed response time').status, 'unknown');
  });

  await test('packet truncation and source-file truncation make comparisons unknown', async () => {
    const before = demoPackets(false), after = copy(demoPackets(true)); after[0].len += 20;
    const result = await comparison(before, after); assert.ok(result.changes.every(row => row.status === 'unknown')); assert.equal(result.after.coverage.truncatedPackets, 1);
    const b = parse(before), a = parse(demoPackets(true));
    const tail = await compareCaptures(b.packets, a.packets, { coverage: { before: b.coverage, after: { ...a.coverage, truncated: true, examinedAllRecords: false, warnings: ['Source tail missing'] } } });
    assert.ok(tail.changes.every(row => row.status === 'unknown')); assert.ok(tail.after.warnings.includes('Source tail missing'));
    const invalid = demoPackets(true); invalid[0].len = 1;
    const invalidRead = readCapture(classic(invalid));
    const invalidCompared = await compareCaptures(b.packets, invalidRead.packets, { coverage: { before: b.coverage, after: invalidRead.coverage } });
    assert.equal(invalidCompared.after.coverage.malformedPackets, 1); assert.ok(invalidCompared.changes.every(row => row.status === 'unknown'));
  });

  await test('source completeness preserves unknown separately from incomplete and keeps comparisons provisional', async () => {
    const b = parse(demoPackets(false)), a = parse(demoPackets(true));
    for (const unknown of [undefined, { examinedAllRecords: null }, {}]) {
      const report = await compareCaptures(b.packets, a.packets, { coverage: { before: b.coverage, after: unknown } });
      assert.equal(report.before.coverage.sourceRecordsComplete, true); assert.equal(report.after.coverage.sourceRecordsComplete, null);
      assert.ok(report.changes.every(row => row.status === 'unknown')); assert.ok(report.after.warnings.some(w => /coverage is unknown/.test(w)));
      assert.deepEqual(change(report, 'http', 'observed status').after, [{ code: 503, count: 1 }]);
    }
    const incomplete = await analyzeCaptureSnapshot(a.packets, { coverage: { examinedAllRecords: false } });
    assert.equal(incomplete.coverage.sourceRecordsComplete, false);
  });

  await test('comparison packet, byte, flow, source and work budgets are explicit', async () => {
    const packets = no(demoPackets(true));
    const scan = await analyzeCaptureSnapshot(packets, { limits: { maxPackets: 1 } }); assert.equal(scan.coverage.examinedPackets, 1); assert.equal(scan.coverage.limited, true);
    const bytes = await analyzeCaptureSnapshot(packets, { limits: { maxBytes: packets[0].data.length } }); assert.equal(bytes.coverage.examinedPackets, 1); assert.equal(bytes.coverage.limited, true);
    const sources = await analyzeCaptureSnapshot(packets, { limits: { maxSources: 1 } }); assert.ok(sources.services.flatMap(s => s.metrics).some(m => m.sourcesLimited)); assert.ok(sources.services.flatMap(s => s.metrics).every(m => m.sources.length <= 1));
    const work = await analyzeCaptureSnapshot(packets, { limits: { maxWorkBytes: 1 } }); assert.equal(work.coverage.limited, true); assert.equal(metric(work, 'http', 'first request').status, 'unknown');
    const flows = await analyzeCaptureSnapshot(packets.concat(no(demoPackets(false, { port: 60000 })).map(p => ({ ...p, no: p.no + 100 }))), { limits: { maxFlows: 1 } });
    assert.equal(flows.coverage.flowCount, 1); assert.equal(flows.coverage.limited, true);
    await assert.rejects(analyzeCaptureSnapshot(packets, { limits: { maxPackets: COMPARE_LIMITS.maxPackets + 1 } }), /limit/);
  });

  await test('original sparse frame numbers are preserved and packet bytes are owned before awaits', async () => {
    const packets = demoPackets(false).map((packet, index) => ({ ...packet, no: 100 + index * 3 }));
    const pending = analyzeCaptureSnapshot(packets); packets.forEach(packet => packet.data.fill(0));
    const result = await pending; assert.deepEqual(metric(result, 'http', 'observed status').value, [{ code: 200, count: 1 }]);
    assert.ok(result.services.flatMap(s => s.metrics).flatMap(m => m.sources).every(source => source.frame >= 100 && (source.frame - 100) % 3 === 0));
    await assert.rejects(analyzeCaptureSnapshot([{ no: 1, data: new Uint8Array() }, { no: 1, data: new Uint8Array() }]), /distinct/);
    await assert.rejects(analyzeCaptureSnapshot([{ data: 'not bytes' }]), /byte array/);
  });

  await test('empty and malformed captures return bounded explicit coverage without invented services', async () => {
    const empty = await compareCaptures([], []); assert.equal(empty.services.length, 0); assert.equal(empty.summary.changed, 0);
    const bad = await analyzeCaptureSnapshot([{ ts: 1, data: Uint8Array.of(0), linktype: 1 }]); assert.equal(bad.coverage.malformedPackets, 1); assert.equal(bad.services.length, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(empty)) < COMPARE_LIMITS.maxReportBytes);
  });

  await test('comparison row limits return explicit omitted coverage rather than silent complete reports', async () => {
    const result = await comparison(demoPackets(false), demoPackets(true), { limits: { maxChanges: 1 } });
    assert.equal(result.changes.length, 1); assert.ok(result.warnings.some(w => /row\/display limit/.test(w)));
    const result2 = await analyzeCaptureSnapshot(demoPackets(false), { limits: { maxMetrics: 1 } });
    assert.equal(result2.services.flatMap(s => s.metrics).length, 1); assert.equal(result2.coverage.limited, true);
  });

  await test('capture reader bounds records before allocation and exposes classic truncated tails', () => {
    const demo = createComparisonDemo(), read = readCapture(demo.before.bytes, { maxPackets: 1 });
    assert.equal(read.packets.length, 1); assert.equal(read.coverage.limited, true); assert.equal(read.coverage.examinedAllRecords, false);
    const original = classic(demoPackets(false).slice(0, 2));
    const truncated = readCapture(original.subarray(0, original.length - 1)); assert.equal(truncated.packets.length, 1); assert.equal(truncated.coverage.truncated, true);
    const tail = readCapture(P.concat(classic(demoPackets(false).slice(0, 1)), [1, 2, 3])); assert.equal(tail.coverage.truncated, true); assert.match(tail.coverage.warnings[0], /partial record header/);
    const bytes = readCapture(demo.before.bytes, { maxBytes: 1 }); assert.equal(bytes.packets.length, 0); assert.equal(bytes.coverage.limited, true);
    assert.throws(() => readCapture(demo.before.bytes, { maxPackets: 0 }), /limit/);
  });

  await test('simple pcapng packets preserve absent timestamp identity while real epoch timestamps stay known', () => {
    const data = demoPackets(false)[0].data, bytes = P.concat(section(), iface(), block(3, P.concat(le32(data.length), data)));
    const simple = readCapture(bytes); assert.equal(simple.packets[0].ts, 0); assert.equal(simple.packets[0].timestampKnown, false); assert.equal(simple.coverage.missingTimestamps, 1);
    const epoch = readCapture(writePcapng([{ ts: 0, data, len: data.length }])); assert.equal(epoch.packets[0].ts, 0); assert.equal(epoch.packets[0].timestampKnown, true);
    const broken = new Uint8Array(bytes); broken[broken.length - 4] ^= 4; assert.throws(() => readCapture(broken), /length trailer/);
  });

  await test('pcapng signed per-interface timestamp offsets affect durations and unsupported precision stays unknown', async () => {
    const offsetInterface = seconds => {
      const offset = new Uint8Array(8); new DataView(offset.buffer).setBigInt64(0, BigInt(seconds), true);
      return block(1, P.concat(le16(1), le16(0), le32(65535), le16(14), le16(8), offset, le16(0), le16(0)));
    };
    const records = demoPackets(false).slice(0, 2);
    const enhanced = (index, micros) => block(6, P.concat(le32(index), le32(0), le32(micros), le32(records[index].data.length), le32(records[index].data.length), records[index].data));
    const read = readCapture(P.concat(section(), offsetInterface(0), offsetInterface(10), enhanced(0, 1000000), enhanced(1, 1005000)));
    assert.equal(read.packets[0].ts, 1); assert.ok(Math.abs(read.packets[1].ts - 11.005) < 1e-9); assert.ok(read.packets.every(p => p.timestampKnown));
    const result = await analyzeCaptureSnapshot(read.packets, { coverage: read.coverage }); assert.equal(metric(result, 'dns', 'observed response time').value.meanMs, 10005);
    const negative = readCapture(P.concat(section(), offsetInterface(-2), enhanced(0, 1000000)));
    assert.equal(negative.packets[0].ts, -1); assert.equal(negative.packets[0].timestampKnown, true);
    assert.throws(() => writePcapng(negative.packets), /timestamp/);
    const unsafe = readCapture(P.concat(section(), offsetInterface(0), offsetInterface(9007199254740992n), enhanced(0, 1000000), enhanced(1, 1005000)));
    assert.equal(unsafe.packets[1].timestampKnown, false); assert.equal(unsafe.coverage.missingTimestamps, 1);
    const unknown = await analyzeCaptureSnapshot(unsafe.packets, { coverage: unsafe.coverage }); assert.equal(metric(unknown, 'dns', 'observed response time').status, 'unknown');
  });

  await test('pcapng exports preserve unknown timestamps, mixed interfaces, truncation and known epoch values', () => {
    const packets = [
      { ts: 0, timestampKnown: false, data: Uint8Array.of(11, 22, 33), len: 100, linktype: 101 },
      { ts: 0, timestampKnown: true, data: Uint8Array.of(44, 55), len: 2, linktype: 1 },
      { ts: 123, timestampKnown: false, data: Uint8Array.of(66), len: 20, linktype: 1 },
      { ts: 456, timestampKnown: true, data: Uint8Array.of(77, 88), len: 2, linktype: 101 },
      { timestampKnown: false, data: new Uint8Array(), len: 0, linktype: 1 },
    ];
    const exported = writePcapng(packets), imported = readCapture(exported);
    assert.deepEqual(imported.packets.map(p => [p.timestampKnown, p.ts, p.len, p.linktype, [...p.data]]), [
      [false, 0, 100, 101, [11, 22, 33]], [true, 0, 2, 1, [44, 55]], [false, 0, 20, 1, [66]], [true, 456, 2, 101, [77, 88]], [false, 0, 0, 1, []],
    ]);
    assert.equal(imported.coverage.missingTimestamps, 3);
    assert.throws(() => writePcapng(packets, { maxBytes: exported.length - 1 }), /serialized byte limit/);
    assert.equal(writePcapng(packets, { maxBytes: exported.length }).length, exported.length);
    assert.throws(() => writePcapng([{ timestampKnown: false, data: new Uint8Array(), len: 5 }]), /cannot be represented/);
    assert.throws(() => writePcapng([{ ts: -1, data: Uint8Array.of(1) }]), /timestamp/);
  });

  await test('SIP signaling packet export preserves unknown timestamp metadata through the format owner', () => {
    const original = { no: 7, ts: 0, timestampKnown: false, data: Uint8Array.of(11, 22, 33), len: 100, lt: 101 };
    const imported = readCapture(buildSipCallCapture([original], { frames: [7] }));
    assert.equal(imported.packets[0].timestampKnown, false); assert.equal(imported.packets[0].len, 100); assert.equal(imported.packets[0].linktype, 101);
  });

  await test('HTTP framing summary mode preserves parsing while skipping body decoding', async () => {
    const request = new TextEncoder().encode('GET / HTTP/1.1\r\nHost: x\r\n\r\n'), response = new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    const direction = (fromA, data) => ({ fromA, startKnown: true, conflicts: [], warnings: [], ranges: [{ kind: 'data', start: 0, end: data.length, data, frames: [fromA ? 1 : 2] }] });
    const result = await parseHttpStream({ conv: { proto: 'TCP' }, directions: [direction(true, request), direction(false, response)] }, { decodeBodies: false });
    assert.equal(result.exchanges[0].response.status, 200); assert.equal(result.exchanges[0].response.complete, true); assert.equal(result.exchanges[0].response.decodedBody, null); assert.equal(result.truncated, false);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let passed = 0, failed = 0;
  await runCaptureCompareTests(async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } });
  console.log(`${passed}/${passed + failed} capture comparison tests passed`); process.exitCode = failed ? 1 : 0;
}
