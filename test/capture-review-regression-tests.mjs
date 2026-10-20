import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { compileFilter } from '../src/renderer/js/capture/filter.mjs';
import { decode } from '../src/renderer/js/capture/decode.mjs';
import { Analyzer } from '../src/renderer/js/capture/analyze.mjs';
import { readCapture, writePcapng } from '../src/renderer/js/capture/pcapfile.mjs';
import * as P from './lib/packets.mjs';

function block(type, body, little = true) {
  const bytes = new Uint8Array(12 + body.length);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, type, little);
  dv.setUint32(4, bytes.length, little);
  bytes.set(body, 8);
  dv.setUint32(bytes.length - 4, bytes.length, little);
  return bytes;
}
function section(little = true) {
  const body = new Uint8Array(16);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 0x1a2b3c4d, little);
  dv.setUint16(4, 1, little);
  dv.setBigInt64(8, -1n, little);
  return block(0x0a0d0d0a, body, little);
}
function iface(snaplen = 65535, little = true, options = []) {
  const body = new Uint8Array(8);
  const dv = new DataView(body.buffer);
  dv.setUint16(0, 1, little);
  dv.setUint32(4, snaplen, little);
  return block(1, P.concat(body, ...options), little);
}
function analyzeFrames(frames) {
  const analyzer = new Analyzer();
  const packets = frames.map(({ ts, data }, i) => ({ no: i + 1, ts, len: data.length, caplen: data.length, data, d: decode(1, data) }));
  for (const pkt of packets) analyzer.ingest(pkt);
  return { analyzer, packets };
}

export async function runCaptureReviewRegressionTests(test) {
  console.log('packet capture: review regressions');
  await test('invalid display-filter operators return an error without freezing the renderer', () => {
    const url = new URL('../src/renderer/js/capture/filter.mjs', import.meta.url).href;
    const script = `import assert from 'node:assert/strict'; import { compileFilter } from ${JSON.stringify(url)}; for (const filter of ['tcp & udp', 'tcp | udp', '&', '|']) assert.throws(() => compileFilter(filter), /Unexpected|operator/);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 3000, encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
  await test('bare VLAN filter includes priority-tagged VLAN zero packets', () => {
    const data = P.frame.udp('02:00:00:00:00:01', '02:00:00:00:00:02', '192.0.2.1', '192.0.2.2', { sport: 12345, dport: 12346 }, [], { vlan: 0 });
    const pkt = { d: decode(1, data) };
    assert.equal(compileFilter('vlan').test(pkt), true);
    assert.equal(compileFilter('vlan == 0').test(pkt), true);
    assert.equal(compileFilter('vlan 0').test(pkt), true);
    assert.equal(compileFilter('vlan').test({ d: decode(101, data.subarray(18)) }), false);
  });
  await test('invalid CIDR prefixes and port ranges are rejected when compiling filters', () => {
    for (const text of ['net 192.0.2.0/24.5', 'net 192.0.2.0/', 'net 192.0.2.0/24/4', 'port 65536', 'port 100-10']) assert.throws(() => compileFilter(text), /Bad network|Bad port/, text);
    assert.equal(compileFilter('net 0.0.0.0/0').test({ d: { f: { hosts: ['192.0.2.5'] } } }), true);
  });
  await test('pcapng rejects short block bodies, inconsistent lengths and invalid interfaces', () => {
    const tiny = block(1, new Uint8Array());
    assert.throws(() => readCapture(P.concat(section(), tiny)), /pcapng.*(short|length|truncated|Malformed)/i);
    const shortPacket = block(6, new Uint8Array(4));
    assert.throws(() => readCapture(P.concat(section(), iface(), shortPacket, iface())), /pcapng.*(short|length|truncated|Malformed)/i);
    const mismatch = writePcapng([{ ts: 1, data: new Uint8Array([1]), len: 1 }]);
    mismatch[mismatch.length - 4] ^= 4;
    assert.throws(() => readCapture(mismatch), /pcapng.*length/i);
    const packet = new Uint8Array(24);
    const dv = new DataView(packet.buffer);
    dv.setUint32(0, 2, true);
    dv.setUint32(12, 1, true);
    dv.setUint32(16, 1, true);
    assert.throws(() => readCapture(P.concat(section(), iface(), block(6, packet))), /pcapng.*interface/i);
  });
  await test('pcapng simple packets exclude alignment padding after snaplen truncation', () => {
    const packet = new Uint8Array(8);
    new DataView(packet.buffer).setUint32(0, 100, true);
    packet.set([11, 22, 33], 4);
    const result = readCapture(P.concat(section(), iface(3), block(3, packet)));
    assert.equal(result.packets[0].caplen, 3);
    assert.deepEqual([...result.packets[0].data], [11, 22, 33]);
    assert.equal(result.packets[0].len, 100);
  });
  await test('pcapng handles consecutive sections with different byte orders', () => {
    const packet = new Uint8Array(24);
    const dv = new DataView(packet.buffer);
    dv.setUint32(8, 2000000, false);
    dv.setUint32(12, 1, false);
    dv.setUint32(16, 1, false);
    packet[20] = 42;
    const bytes = P.concat(writePcapng([{ ts: 1, data: new Uint8Array([7]), len: 1 }]), section(false), iface(65535, false), block(6, packet, false));
    const result = readCapture(bytes);
    assert.deepEqual(result.packets.map((p) => [p.ts, ...p.data]), [[1, 7], [2, 42]]);
  });
  await test('IP payload decoders do not parse Ethernet padding as transport headers', () => {
    const ip = P.ipv4({ src: '192.0.2.1', dst: '192.0.2.2', proto: 6 }, []);
    const padding = P.tcp({ sport: 21, dport: 4321 });
    const decoded = decode(1, P.eth('02:00:00:00:00:02', '02:00:00:00:00:01', 0x0800, P.concat(ip, padding)), { tree: true });
    assert.equal(decoded.malformed, true);
    assert.equal(decoded.tcp, undefined);
    assert.equal(decoded.f.tcp, undefined);
  });
  await test('DNS timing matches each resolver independently when transaction IDs are reused', () => {
    const query = (ts, server, response = false) => ({ ts, data: P.frame.udp('02:00:00:00:00:01', '02:00:00:00:00:02', response ? server : '192.0.2.1', response ? '192.0.2.1' : server, { sport: response ? 53 : 12345, dport: response ? 12345 : 53 }, P.dns({ id: 42, name: 'example.test', response })) });
    const { analyzer, packets } = analyzeFrames([query(1, '192.0.2.53'), query(2, '192.0.2.54'), query(3, '192.0.2.53', true), query(4, '192.0.2.54', true)]);
    assert.equal(packets[2].ann.dnsRequest, 1);
    assert.equal(packets[3].ann.dnsRequest, 2);
    assert.deepEqual(analyzer.dns.times, [2, 2]);
    assert.equal(analyzer.dnsPending.size, 0);
  });
  await test('TCP stream recovery trims overlapping segments beyond an unfilled gap', () => {
    const frame = (seq, payload = '', flags = 'A') => ({ ts: seq / 100, data: P.frame.tcp('02:00:00:00:00:01', '02:00:00:00:00:02', '192.0.2.1', '192.0.2.2', { sport: 12345, dport: 12346, seq, flags }, P.str(payload)) });
    const { analyzer, packets } = analyzeFrames([frame(100, '', 'S'), frame(111, 'abcdefghij'), frame(116, 'fghijklmno')]);
    const stream = analyzer.followStream(packets, 0, 'TCP');
    const text = stream.chunks.map((c) => new TextDecoder().decode(P.concat(c.parts))).join('');
    assert.equal(text, '[10 bytes missing]abcdefghijklmno');
  });
}
