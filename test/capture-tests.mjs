// Packet capture tests: decoders, display filters, analyzer, file formats, robustness.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { decode } from '../src/renderer/js/capture/decode.mjs';
import { compileFilter } from '../src/renderer/js/capture/filter.mjs';
import { Analyzer } from '../src/renderer/js/capture/analyze.mjs';
import { readCapture, writePcapng } from '../src/renderer/js/capture/pcapfile.mjs';
import * as P from './lib/packets.mjs';
import { buildSample } from './make-sample-capture.mjs';

const require = createRequire(import.meta.url);
const A = 'aa:aa:aa:00:00:01';
const B = 'bb:bb:bb:00:00:02';
const d = (bytes) => decode(1, bytes, { tree: true });

/** Decode + analyze a list of {ts,data} like the capture tab does. */
function run(list) {
  const an = new Analyzer();
  const pkts = list.map((p, i) => {
    const pkt = { no: i + 1, ts: p.ts ?? i * 0.01, caplen: p.data.length, len: p.data.length, data: p.data, lt: p.linktype ?? 1 };
    pkt.d = decode(pkt.lt, pkt.data);
    an.ingest(pkt);
    return pkt;
  });
  return { an, pkts };
}

export async function runCaptureTests(test) {
  console.log('packet capture: decoders');
  await test('Ethernet + VLAN + IPv4 + TCP SYN with options', () => {
    const r = d(P.frame.tcp(A, B, '10.0.0.5', '93.184.215.14', { sport: 51000, dport: 443, seq: 1000, flags: 'S', mss: 1460, ws: 8 }, [], { vlan: 20 }));
    assert.strictEqual(r.proto, 'TCP');
    assert.match(r.info, /^51000 → 443 \[SYN\] Seq=1000 Win=64240 Len=0 MSS=1460 WS=256$/);
    assert.strictEqual(r.f['vlan.id'], 20);
    assert.strictEqual(r.f['ip.src'], '10.0.0.5');
    assert.strictEqual(r.f['tcp.flags.syn'], true);
    assert.strictEqual(r.f['ip.checksum_bad'], false);
    assert.match(r.explain.join(' '), /opening a TCP connection to 93\.184\.215\.14 on port 443 \(HTTPS\)/);
    assert.ok(r.nodes.some((n) => /802\.1Q Virtual LAN.*ID: 20/.test(n.label)));
  });
  await test('ARP request, reply and gratuitous', () => {
    assert.strictEqual(d(P.eth('ff:ff:ff:ff:ff:ff', A, 0x0806, P.arp(1, A, '10.0.0.5', '00:00:00:00:00:00', '10.0.0.1'))).info, 'Who has 10.0.0.1? Tell 10.0.0.5');
    assert.strictEqual(d(P.eth(A, B, 0x0806, P.arp(2, B, '10.0.0.1', A, '10.0.0.5'))).info, `10.0.0.1 is at ${B}`);
    assert.match(d(P.eth('ff:ff:ff:ff:ff:ff', A, 0x0806, P.arp(1, A, '10.0.0.5', '00:00:00:00:00:00', '10.0.0.5'))).info, /Gratuitous ARP/);
  });
  await test('DNS query, answer and NXDOMAIN', () => {
    const q = d(P.frame.udp(A, B, '10.0.0.5', '8.8.8.8', { sport: 5555, dport: 53 }, P.dns({ id: 0xbeef, name: 'www.example.com' })));
    assert.strictEqual(q.proto, 'DNS');
    assert.strictEqual(q.info, 'Standard query 0xbeef A www.example.com');
    const a = d(P.frame.udp(B, A, '8.8.8.8', '10.0.0.5', { sport: 53, dport: 5555 }, P.dns({ id: 0xbeef, name: 'www.example.com', response: true, answers: [{ type: 'CNAME', data: 'edge.example.net' }, { type: 'A', data: '93.184.215.14' }] })));
    assert.match(a.info, /response 0xbeef A www\.example\.com CNAME edge\.example\.net A 93\.184\.215\.14/);
    assert.deepStrictEqual(a.f['dns.a'], ['93.184.215.14']);
    const nx = d(P.frame.udp(B, A, '8.8.8.8', '10.0.0.5', { sport: 53, dport: 5555 }, P.dns({ id: 1, name: 'nope.invalid', response: true, rcode: 3 })));
    assert.match(nx.info, /No such name/);
    assert.strictEqual(nx.cls, 'bad');
  });
  await test('DHCP offer with options', () => {
    const r = d(P.frame.udp(B, 'ff:ff:ff:ff:ff:ff', '10.0.0.1', '255.255.255.255', { sport: 67, dport: 68 }, P.dhcp({ op: 2, type: 2, xid: 0x1234abcd, chaddr: A, yiaddr: '10.0.0.50', server: '10.0.0.1', router: '10.0.0.1', dnsServers: ['10.0.0.2', '10.0.0.3'], lease: 7200 })));
    assert.strictEqual(r.info, 'DHCP Offer - Transaction ID 0x1234abcd 10.0.0.50');
    assert.deepStrictEqual([r.dhcp.server, r.dhcp.dns.join(','), r.dhcp.lease], ['10.0.0.1', '10.0.0.2,10.0.0.3', 7200]);
  });
  await test('TLS Client Hello SNI/ALPN and Server Hello TLS 1.3', () => {
    const ch = d(P.frame.tcp(A, B, '10.0.0.5', '1.2.3.4', { sport: 50000, dport: 443, flags: 'PA' }, P.tlsClientHello('api.example.com')));
    assert.strictEqual(ch.proto, 'TLSv1.3');
    assert.strictEqual(ch.info, 'Client Hello (SNI=api.example.com)');
    assert.deepStrictEqual(ch.tls.alpn, ['h2', 'http/1.1']);
    assert.strictEqual(ch.f['tls.handshake.extensions_server_name'], 'api.example.com');
    const sh = d(P.frame.tcp(B, A, '1.2.3.4', '10.0.0.5', { sport: 443, dport: 50000, flags: 'PA' }, P.tlsServerHello(0x1302)));
    assert.match(sh.info, /^Server Hello, TLS 1\.3, TLS_AES_256_GCM_SHA384, Change Cipher Spec, Application Data$/);
    const al = d(P.frame.tcp(B, A, '1.2.3.4', '10.0.0.5', { sport: 443, dport: 50000, flags: 'PA' }, P.tlsAlert(40)));
    assert.match(al.info, /Alert \(Fatal, Handshake failure\)/);
  });
  await test('HTTP request with Basic credentials and response', () => {
    const req = d(P.frame.tcp(A, B, '10.0.0.5', '10.0.0.9', { sport: 50001, dport: 80, flags: 'PA' }, P.str(`GET /x HTTP/1.1\r\nHost: box.lan\r\nAuthorization: Basic ${btoa('root:toor')}\r\n\r\n`)));
    assert.strictEqual(req.info, 'GET /x HTTP/1.1');
    assert.deepStrictEqual([req.cred.user, req.f['http.host']], ['root', 'box.lan']);
    assert.ok(req.nodes.some((n) => (n.children || []).some((c) => (c.children || []).some((g) => /password "toor"/.test(g.label)))));
    const res = d(P.frame.tcp(B, A, '10.0.0.9', '10.0.0.5', { sport: 80, dport: 50001, flags: 'PA' }, P.str('HTTP/1.1 404 Not Found\r\nContent-Type: text/html; charset=utf-8\r\n\r\n')));
    assert.strictEqual(res.info, 'HTTP/1.1 404 Not Found (text/html)');
    assert.strictEqual(res.cls, 'bad');
  });
  await test('SNMP v2c get and response with OID names', () => {
    const r = d(P.frame.udp(A, B, '10.0.0.5', '10.0.0.1', { sport: 40000, dport: 161 }, P.snmpGet('public', '1.3.6.1.2.1.1.5.0')));
    assert.strictEqual(r.info, 'get-request sysName.0 = NULL');
    assert.strictEqual(r.snmp.community, 'public');
    const resp = d(P.frame.udp(B, A, '10.0.0.1', '10.0.0.5', { sport: 161, dport: 40000 }, P.snmpGet('public', '1.3.6.1.2.1.1.5.0', 7, 0xa2, [0x04, 5, ...P.str('core1')])));
    assert.strictEqual(resp.info, 'get-response sysName.0 = "core1"');
  });
  await test('LLDP and CDP neighbor discovery', () => {
    const l = d(P.eth('01:80:c2:00:00:0e', B, 0x88cc, P.lldp({ chassisMac: B, port: 'Gi1/0/7', sysName: 'sw1', sysDesc: 'Arista EOS', mgmt: '10.1.1.1', vlan: 30 })));
    assert.strictEqual(l.proto, 'LLDP');
    assert.deepStrictEqual([l.neighbor.device, l.neighbor.port, l.neighbor.vlan, l.neighbor.mgmt, l.neighbor.caps.join('+')], ['sw1', 'Gi1/0/7', 30, '10.1.1.1', 'Bridge+Router']);
    const c = d(P.dot3('01:00:0c:cc:cc:cc', B, [0xaa, 0xaa, 0x03, 0, 0, 0x0c, 0x20, 0], P.cdp({ device: 'dist1', port: 'Gi0/1', platform: 'cisco WS-C3850', software: 'IOS 16.12', address: '10.2.2.2', nativeVlan: 99 })));
    assert.strictEqual(c.proto, 'CDP');
    assert.deepStrictEqual([c.neighbor.device, c.neighbor.port, c.neighbor.platform, c.neighbor.vlan, c.neighbor.mgmt, c.neighbor.duplex], ['dist1', 'Gi0/1', 'cisco WS-C3850', 99, '10.2.2.2', 'Full']);
  });
  await test('RSTP BPDU and topology change', () => {
    const s = d(P.dot3('01:80:c2:00:00:00', B, [0x42, 0x42, 0x03], P.rstpBpdu({ rootPrio: 4096, rootMac: '00:00:00:00:00:01', cost: 19, bridgeMac: B, tc: true })));
    assert.strictEqual(s.proto, 'RSTP');
    assert.match(s.info, /Root = 4096\/0\/00:00:00:00:00:01 {2}Cost = 19 .*Topology Change/);
  });
  await test('ICMP echo and port unreachable with the original packet', () => {
    const e = d(P.eth(B, A, 0x0800, P.ipv4({ src: '10.0.0.5', dst: '8.8.8.8', proto: 1 }, P.icmpEcho(8, 7, 3))));
    assert.match(e.info, /Echo \(ping\) request id=0x0007, seq=3, ttl=64/);
    const orig = P.ipv4({ src: '10.0.0.5', dst: '10.0.0.60', proto: 17 }, P.udp({ sport: 999, dport: 161 }, [1, 2, 3]));
    const u = d(P.eth(A, B, 0x0800, P.ipv4({ src: '10.0.0.60', dst: '10.0.0.5', proto: 1 }, P.icmpUnreachable(3, orig))));
    assert.strictEqual(u.info, 'Destination unreachable (Port unreachable) for UDP 10.0.0.5:999 → 10.0.0.60:161');
  });
  await test('OSPF hello, HSRP, NTP', () => {
    const o = d(P.eth('01:00:5e:00:00:05', B, 0x0800, P.ipv4({ src: '10.0.0.1', dst: '224.0.0.5', proto: 89 }, P.ospfHello({ rid: '1.1.1.1', dr: '10.0.0.1', neighbors: ['2.2.2.2'] }))));
    assert.match(o.info, /Hello Packet, Router 1\.1\.1\.1, Area 0\.0\.0\.0, Hello 10s\/Dead 40s/);
    assert.deepStrictEqual(o.ospf.neighbors, ['2.2.2.2']);
    const hs = d(P.frame.udp(B, '01:00:5e:00:00:02', '10.0.0.2', '224.0.0.2', { sport: 1985, dport: 1985 }, P.hsrpHello({ vip: '10.0.0.1' })));
    assert.match(hs.info, /Hello \(state Active\) group 1 prio 110 VIP 10\.0\.0\.1/);
    assert.strictEqual(hs.fhrp.auth, 'cisco');
    assert.match(d(P.frame.udp(B, A, '10.0.0.1', '10.0.0.5', { sport: 123, dport: 123 }, P.ntp(4, 2))).info, /NTP Version 4, server, stratum 2/);
  });
  await test('truncated and garbage packets never throw', () => {
    const full = P.frame.tcp(A, B, '10.0.0.5', '1.2.3.4', { sport: 1, dport: 443, flags: 'PA' }, P.tlsClientHello('x.com'));
    for (let n = 0; n < full.length; n += 3) decode(1, full.slice(0, n), { tree: true });
    const r = decode(1, full.slice(0, 30));
    assert.ok(r.malformed);
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(rnd() * 200);
      const b = new Uint8Array(len).map(() => Math.floor(rnd() * 256));
      if (len > 14 && i % 3 === 0) {
        b[12] = 0x08;
        b[13] = 0;
        b[14] = 0x45;
      }
      decode([0, 1, 101, 113, 229][i % 5], b, { tree: i % 2 === 0 });
    }
  });

  console.log('packet capture: display filters');
  await test('display filter language', () => {
    const sample = run(buildSample());
    const count = (f) => sample.pkts.filter((p) => compileFilter(f).test(p)).length;
    assert.ok(count('dns') >= 6);
    assert.strictEqual(count('dns.qry.name contains "printer"'), 2);
    assert.strictEqual(count('host 93.184.215.14'), sample.pkts.filter((p) => p.d.f.hosts.includes('93.184.215.14')).length);
    assert.ok(count('port 443 and not tls') > 3);
    assert.strictEqual(count('tcp.flags.syn == 1 && tcp.flags.ack == 0'), count('syn and not tcp.flags.ack'));
    assert.strictEqual(count('net 10.20.0.0/24 and tcp.dstport == 3389'), 2);
    assert.strictEqual(count('vlan 20'), 0);
    assert.strictEqual(count('"Who has"'), 3);
    assert.strictEqual(count('(arp or dhcp) and eth.src == 50:c7:bf:11:22:33'), 1);
    assert.strictEqual(count('ip.ttl > 100'), 3);
    assert.ok(count('retrans') >= 2);
    assert.ok(count('errors') >= 3);
    assert.strictEqual(count('tcp.stream == 0'), 15);
    assert.throws(() => compileFilter('tcp.port =='), /Expected a value/);
    assert.throws(() => compileFilter('banana'), /Unknown protocol/);
    assert.throws(() => compileFilter('(tcp'), /Missing \)/);
    assert.strictEqual(compileFilter('   '), null);
  });

  console.log('packet capture: analyzer');
  await test('analyzer finds the planted problems in the sample capture', () => {
    const { an, pkts } = run(buildSample());
    const ins = an.insights();
    const titles = ins.map((i) => i.title).join('\n');
    assert.match(titles, /Connected to access-sw3\.branch\.lab port (Gi1\/0\/12|GigabitEthernet1\/0\/12)/);
    assert.match(titles, /2 DHCP servers are answering/);
    assert.match(titles, /IP address conflict on 192\.168\.10\.40/);
    assert.match(titles, /Clear-text HTTP Basic login for "admin"/);
    assert.match(titles, /Clear-text FTP login for "backup"/);
    assert.match(titles, /connection refused/);
    assert.match(titles, /Connection attempts with no answer/);
    assert.match(titles, /TCP retransmissions/);
    assert.match(titles, /duplicate ACKs/);
    assert.match(titles, /zero-window/);
    assert.match(titles, /not found \(NXDOMAIN\)/);
    assert.match(titles, /slow DNS answers/);
    assert.match(titles, /reports 10\.20\.0\.60:161 unreachable/);
    assert.match(titles, /TLS handshake failures/);
    assert.match(titles, /Insecure protocol in use: SNMP v2c/);
    assert.match(titles, /Spanning-tree topology changes/);
    assert.match(titles, /HSRP group 1/);
    // every insight filter must compile
    for (const i of ins) if (i.filter) compileFilter(i.filter);
    // relative sequence numbers + expert info text
    const synack = pkts.find((p) => p.d.tcp && p.d.tcp.flags === 0x12 && p.d.tcp.sport === 443);
    assert.match(synack.d.info, /Seq=0 Ack=1 /);
    assert.ok(pkts.some((p) => /^\[TCP Retransmission\]/.test(p.d.info)));
    assert.ok(pkts.some((p) => /\[TCP Dup ACK \d+#2\]/.test(p.d.info)));
    assert.ok(pkts.some((p) => /\[TCP Previous segment not captured\]/.test(p.d.info)));
    // DNS timing and name resolution
    const slow = pkts.find((p) => p.d.dns && p.d.dns.qname === 'www.example.com' && p.d.dns.qr);
    assert.ok(Math.abs(slow.ann.dnsTime - 0.452) < 1e-6);
    assert.strictEqual(an.names.get('93.184.215.14'), 'www.example.com');
    const hs = an.tcp.handshakes.find((x) => x.server.startsWith('93.184.215.14'));
    assert.ok(Math.abs(hs.rtt - 0.038) < 1e-6);
  });
  await test('follow TCP stream reassembles payload without retransmissions', () => {
    const { an, pkts } = run(buildSample());
    const http = pkts.find((p) => p.d.http && p.d.http.method);
    const f = an.followStream(pkts, http.ann.stream, 'TCP');
    const text = f.directions.map((direction) => new TextDecoder().decode(P.concat(direction.ranges.filter((range) => range.kind === 'data').map((range) => range.data)))).join('');
    assert.match(text, /^GET \/api\/status HTTP\/1\.1[\s\S]*HTTP\/1\.1 200 OK[\s\S]*\{"status":"ok"\}$/);
    const tlsStream = pkts.find((p) => p.d.tls && p.d.tls.sni === 'www.example.com').ann.stream;
    const tf = an.followStream(pkts, tlsStream, 'TCP');
    const serverBytes = tf.directions.find((direction) => !direction.fromA).ranges.filter((range) => range.kind === 'data').reduce((n, range) => n + range.data.length, 0);
    // The lost segment's retransmission is its only copy, so it is kept and put back in order.
    assert.strictEqual(serverBytes, P.tlsServerHello().length + 3 * 1200);
  });

  console.log('packet capture: files');
  await test('pcapng round trip and classic pcap reader', () => {
    const pkts = buildSample();
    const bytes = writePcapng(pkts);
    const back = readCapture(bytes);
    assert.strictEqual(back.format, 'pcapng');
    assert.strictEqual(back.packets.length, pkts.length);
    assert.ok(back.packets.every((p, i) => p.caplen === pkts[i].data.length && Math.abs(p.ts - pkts[i].ts) < 1e-6 && p.data.every((b, j) => b === pkts[i].data[j])));
    // classic little-endian microsecond pcap
    const hdr = new Uint8Array(24);
    const dv = new DataView(hdr.buffer);
    dv.setUint32(0, 0xa1b2c3d4, true);
    dv.setUint16(4, 2, true);
    dv.setUint16(6, 4, true);
    dv.setUint32(16, 65535, true);
    dv.setUint32(20, 1, true);
    const recs = pkts.slice(0, 5).map((p) => {
      const r = new Uint8Array(16 + p.data.length);
      const v = new DataView(r.buffer);
      v.setUint32(0, Math.floor(p.ts), true);
      v.setUint32(4, Math.round((p.ts % 1) * 1e6), true);
      v.setUint32(8, p.data.length, true);
      v.setUint32(12, p.data.length, true);
      r.set(p.data, 16);
      return r;
    });
    const pc = readCapture(P.concat(hdr, ...recs));
    assert.strictEqual(pc.format, 'pcap');
    assert.strictEqual(pc.packets.length, 5);
    assert.strictEqual(decode(1, pc.packets[0].data).proto, 'LLDP');
    assert.throws(() => readCapture(new Uint8Array(40)), /Unrecognized/);
  });
  await test('decode + analyze throughput', () => {
    const base = buildSample();
    const list = [];
    for (let i = 0; i < 400; i++) for (const p of base) list.push({ ts: p.ts + i * 11, data: p.data });
    const t0 = performance.now();
    run(list);
    const ms = performance.now() - t0;
    const rate = list.length / (ms / 1000);
    console.log(`       ${list.length} packets in ${ms.toFixed(0)} ms (${Math.round(rate).toLocaleString()} packets/s)`);
    assert.ok(rate > 20000, `too slow: ${rate} pps`);
  });

  console.log('packet capture: live capture plumbing');
  await test('Npcap status is reported without crashing', () => {
    const npcap = require('../src/main/capture/npcap.js');
    const s = npcap.status();
    assert.strictEqual(typeof s.available, 'boolean');
    if (!s.available) assert.match(s.error, /Npcap/);
    else assert.match(s.version, /Npcap|libpcap/i);
  });
  await test('koffi works inside a worker thread (capture thread model)', async () => {
    const code = `
      const { parentPort } = require('worker_threads');
      const koffi = require(${JSON.stringify(require.resolve('koffi'))});
      const k32 = koffi.load('kernel32.dll');
      const GetCurrentProcessId = k32.func('uint32_t __stdcall GetCurrentProcessId()');
      parentPort.postMessage(GetCurrentProcessId());`;
    const pid = await new Promise((res, rej) => {
      const w = new Worker(code, { eval: true });
      w.once('message', res);
      w.once('error', rej);
    });
    assert.strictEqual(pid, process.pid);
  });
  await test('capture manager reports a clear error when Npcap is missing', async () => {
    const npcap = require('../src/main/capture/npcap.js');
    if (npcap.status().available) return; // real capture path is exercised manually
    const { CaptureManager } = require('../src/main/capture/index.js');
    const cm = new CaptureManager({ emit: () => {} });
    await assert.rejects(cm.start('t1', { device: '\\Device\\NPF_Loopback' }), /Npcap is not installed/);
  });
}
