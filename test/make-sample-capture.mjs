// Builds test/fixtures/sample.pcapng: a realistic branch-office capture with real
// problems in it (rogue DHCP, IP conflict, retransmissions, refused connections,
// slow and failed DNS, clear-text logins) for demos and tests.
//   node test/make-sample-capture.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePcapng } from '../src/renderer/js/capture/pcapfile.mjs';
import * as P from './lib/packets.mjs';

const { frame, concat, str, u16, u32 } = P;

export function buildSample() {
  const T0 = 1792310400; // a Monday morning
  const pkts = [];
  const at = (t, data) => pkts.push({ ts: T0 + t, len: data.length, linktype: 1, data });

  const LAPTOP = '192.168.10.23';
  const LAPTOP_MAC = '3c:22:fb:10:20:23';
  const GW = '192.168.10.1';
  const GW_MAC = '00:1b:54:aa:01:01';
  const SW_MAC = '00:1b:54:aa:bb:0c';
  const ROGUE = '192.168.10.250';
  const ROGUE_MAC = '50:c7:bf:11:22:33';
  const BCAST = 'ff:ff:ff:ff:ff:ff';
  const DNS = '192.168.10.5';
  const WEB = '93.184.215.14';
  const APP = '10.20.0.15';

  // Neighbor discovery from the access switch
  at(0.0, P.eth('01:80:c2:00:00:0e', SW_MAC, 0x88cc, P.lldp({ chassisMac: SW_MAC, port: 'Gi1/0/12', portDesc: 'Desk 4.12 - Engineering', sysName: 'access-sw3.branch.lab', sysDesc: 'Cisco IOS XE Software, Version 17.12.4', mgmt: '10.10.10.13', vlan: 20 })));
  at(0.04, P.dot3('01:00:0c:cc:cc:cc', SW_MAC, [0xaa, 0xaa, 0x03, 0x00, 0x00, 0x0c, 0x20, 0x00], P.cdp({ device: 'access-sw3.branch.lab', port: 'GigabitEthernet1/0/12', platform: 'cisco C9200L-48P-4G', software: 'Cisco IOS Software [Dublin], Catalyst L3 Switch Software, Version 17.12.4', address: '10.10.10.13', nativeVlan: 20 })));
  at(0.1, P.dot3('01:80:c2:00:00:00', SW_MAC, [0x42, 0x42, 0x03], P.rstpBpdu({ rootPrio: 24576, rootMac: '00:1b:54:00:00:01', cost: 4, bridgeMac: SW_MAC })));

  // DHCP: the real server and a rogue home router both answer
  const xid = 0x5a17c0de;
  at(0.5, frame.udp(LAPTOP_MAC, BCAST, '0.0.0.0', '255.255.255.255', { sport: 68, dport: 67 }, P.dhcp({ type: 1, xid, chaddr: LAPTOP_MAC, hostname: 'LAB-LAPTOP-07' })));
  at(0.512, frame.udp(GW_MAC, BCAST, GW, '255.255.255.255', { sport: 67, dport: 68 }, P.dhcp({ op: 2, type: 2, xid, chaddr: LAPTOP_MAC, yiaddr: LAPTOP, server: GW, lease: 86400, mask: '255.255.255.0', router: GW, dnsServers: [DNS] })));
  at(0.514, frame.udp(ROGUE_MAC, BCAST, ROGUE, '255.255.255.255', { sport: 67, dport: 68 }, P.dhcp({ op: 2, type: 2, xid, chaddr: LAPTOP_MAC, yiaddr: '192.168.0.100', server: ROGUE, lease: 3600, mask: '255.255.255.0', router: '192.168.0.1', dnsServers: ['192.168.0.1'] })));
  at(0.6, frame.udp(LAPTOP_MAC, BCAST, '0.0.0.0', '255.255.255.255', { sport: 68, dport: 67 }, P.dhcp({ type: 3, xid, chaddr: LAPTOP_MAC, requested: LAPTOP, server: GW, hostname: 'LAB-LAPTOP-07' })));
  at(0.612, frame.udp(GW_MAC, BCAST, GW, '255.255.255.255', { sport: 67, dport: 68 }, P.dhcp({ op: 2, type: 5, xid, chaddr: LAPTOP_MAC, yiaddr: LAPTOP, server: GW, lease: 86400, mask: '255.255.255.0', router: GW, dnsServers: [DNS] })));

  // ARP: gratuitous, normal resolution, and a duplicate IP
  at(0.7, P.eth(BCAST, LAPTOP_MAC, 0x0806, P.arp(1, LAPTOP_MAC, LAPTOP, '00:00:00:00:00:00', LAPTOP)));
  at(0.8, P.eth(BCAST, LAPTOP_MAC, 0x0806, P.arp(1, LAPTOP_MAC, LAPTOP, '00:00:00:00:00:00', GW)));
  at(0.801, P.eth(LAPTOP_MAC, GW_MAC, 0x0806, P.arp(2, GW_MAC, GW, LAPTOP_MAC, LAPTOP)));
  at(1.0, P.eth(BCAST, '00:50:56:9a:40:01', 0x0806, P.arp(1, '00:50:56:9a:40:01', '192.168.10.40', '00:00:00:00:00:00', GW)));
  at(1.55, P.eth(BCAST, 'b8:27:eb:6e:40:40', 0x0806, P.arp(1, 'b8:27:eb:6e:40:40', '192.168.10.40', '00:00:00:00:00:00', GW)));

  // DNS: fast, slow, and a name that does not exist
  const dnsPair = (t, id, name, sport, rt, answers, rcode = 0) => {
    at(t, frame.udp(LAPTOP_MAC, GW_MAC, LAPTOP, DNS, { sport, dport: 53 }, P.dns({ id, name })));
    at(t + rt, frame.udp(GW_MAC, LAPTOP_MAC, DNS, LAPTOP, { sport: 53, dport: sport }, P.dns({ id, name, response: true, rcode, answers })));
  };
  dnsPair(1.1, 0x1a2b, 'intranet.branch.lab', 51001, 0.012, [{ type: 'A', data: APP, ttl: 300 }]);
  dnsPair(1.2, 0x2b3c, 'www.example.com', 51002, 0.452, [{ type: 'A', data: WEB, ttl: 1800 }]);
  dnsPair(1.3, 0x3c4d, 'printer-02.branch.lab', 51003, 0.009, [], 3);

  // HTTPS to example.com with loss + retransmission
  const C = { sport: 52144, dport: 443 };
  const S = { sport: 443, dport: 52144 };
  const cs = 1000;
  const ss = 5000;
  const cT = (t, o, payload = [], extra) => at(t, frame.tcp(LAPTOP_MAC, GW_MAC, LAPTOP, WEB, { ...C, ...o }, payload, extra));
  const sT = (t, o, payload = []) => at(t, frame.tcp(GW_MAC, LAPTOP_MAC, WEB, LAPTOP, { ...S, ...o }, payload, { ttl: 54 }));
  cT(2.0, { seq: cs, flags: 'S', win: 64240, mss: 1460, ws: 8 });
  sT(2.038, { seq: ss, ack: cs + 1, flags: 'SA', win: 65535, mss: 1400, ws: 7 });
  cT(2.039, { seq: cs + 1, ack: ss + 1, flags: 'A', win: 1026 });
  const hello = P.tlsClientHello('www.example.com');
  cT(2.040, { seq: cs + 1, ack: ss + 1, flags: 'PA', win: 1026 }, hello);
  const sh = P.tlsServerHello();
  sT(2.079, { seq: ss + 1, ack: cs + 1 + hello.length, flags: 'PA' }, sh);
  const sBase = ss + 1 + sh.length;
  const seg = P.tlsAppData(1195);
  cT(2.080, { seq: cs + 1 + hello.length, ack: sBase, flags: 'A', win: 1026 });
  sT(2.120, { seq: sBase, ack: cs + 1 + hello.length, flags: 'A' }, seg);
  // segment sBase+1200 lost on the way...
  sT(2.121, { seq: sBase + 2400, ack: cs + 1 + hello.length, flags: 'A' }, seg);
  cT(2.122, { seq: cs + 1 + hello.length, ack: sBase + 1200, flags: 'A', win: 1026 });
  cT(2.123, { seq: cs + 1 + hello.length, ack: sBase + 1200, flags: 'A', win: 1026 });
  cT(2.124, { seq: cs + 1 + hello.length, ack: sBase + 1200, flags: 'A', win: 1026 });
  sT(2.361, { seq: sBase + 1200, ack: cs + 1 + hello.length, flags: 'A' }, seg);
  cT(2.362, { seq: cs + 1 + hello.length, ack: sBase + 3600, flags: 'A', win: 1026 });
  cT(2.9, { seq: cs + 1 + hello.length, ack: sBase + 3600, flags: 'FA', win: 1026 });
  sT(2.938, { seq: sBase + 3600, ack: cs + 2 + hello.length, flags: 'FA' });

  // Refused and unanswered connections
  at(3.0, frame.tcp(LAPTOP_MAC, GW_MAC, LAPTOP, APP, { sport: 52150, dport: 8443, seq: 777, flags: 'S', mss: 1460 }));
  at(3.002, frame.tcp(GW_MAC, LAPTOP_MAC, APP, LAPTOP, { sport: 8443, dport: 52150, seq: 0, ack: 778, flags: 'RA', win: 0 }));
  at(3.5, frame.tcp(LAPTOP_MAC, GW_MAC, LAPTOP, '10.20.0.99', { sport: 52151, dport: 3389, seq: 4242, flags: 'S', mss: 1460 }));
  at(4.5, frame.tcp(LAPTOP_MAC, GW_MAC, LAPTOP, '10.20.0.99', { sport: 52151, dport: 3389, seq: 4242, flags: 'S', mss: 1460 }));

  // Plain HTTP with Basic auth
  const H = { sport: 52160, dport: 80 };
  at(4.0, frame.tcp(LAPTOP_MAC, GW_MAC, LAPTOP, APP, { ...H, seq: 100, flags: 'S', mss: 1460 }));
  at(4.002, frame.tcp(GW_MAC, LAPTOP_MAC, APP, LAPTOP, { sport: 80, dport: 52160, seq: 900, ack: 101, flags: 'SA', mss: 1460 }));
  at(4.003, frame.tcp(LAPTOP_MAC, GW_MAC, LAPTOP, APP, { ...H, seq: 101, ack: 901, flags: 'A' }));
  const get = str(`GET /api/status HTTP/1.1\r\nHost: intranet.branch.lab\r\nUser-Agent: curl/8.9\r\nAuthorization: Basic ${btoa('admin:Summer2026!')}\r\n\r\n`);
  at(4.004, frame.tcp(LAPTOP_MAC, GW_MAC, LAPTOP, APP, { ...H, seq: 101, ack: 901, flags: 'PA' }, get));
  const resp = str('HTTP/1.1 200 OK\r\nServer: nginx/1.27\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{"status":"ok"}');
  at(4.011, frame.tcp(GW_MAC, LAPTOP_MAC, APP, LAPTOP, { sport: 80, dport: 52160, seq: 901, ack: 101 + get.length, flags: 'PA' }, resp));

  // FTP login in clear text
  const F = { sport: 52170, dport: 21 };
  const ftp = (t, fromClient, seq, ack, text) =>
    at(t, fromClient ? frame.tcp(LAPTOP_MAC, GW_MAC, LAPTOP, '10.20.0.30', { ...F, seq, ack, flags: 'PA' }, str(text)) : frame.tcp(GW_MAC, LAPTOP_MAC, '10.20.0.30', LAPTOP, { sport: 21, dport: 52170, seq, ack, flags: 'PA' }, str(text)));
  ftp(5.0, false, 1, 1, '220 Backup FTP ready\r\n');
  ftp(5.1, true, 1, 23, 'USER backup\r\n');
  ftp(5.11, false, 23, 14, '331 Password required\r\n');
  ftp(5.2, true, 14, 46, 'PASS hunter2\r\n');
  ftp(5.21, false, 46, 28, '230 Login successful\r\n');

  // SNMP with the default community
  at(5.5, frame.udp(LAPTOP_MAC, GW_MAC, LAPTOP, '10.10.10.13', { sport: 50161, dport: 161 }, P.snmpGet('public', '1.3.6.1.2.1.1.5.0')));
  at(5.503, frame.udp(GW_MAC, LAPTOP_MAC, '10.10.10.13', LAPTOP, { sport: 161, dport: 50161 }, P.snmpGet('public', '1.3.6.1.2.1.1.5.0', 4242, 0xa2, [0x04, 21, ...str('access-sw3.branch.lab')])));
  // SNMP to a host with nothing listening -> ICMP port unreachable
  const probe = P.ipv4({ src: LAPTOP, dst: '10.20.0.60', proto: 17 }, P.udp({ sport: 50162, dport: 161 }, P.snmpGet('public', '1.3.6.1.2.1.1.1.0')));
  at(5.6, P.eth(GW_MAC, LAPTOP_MAC, 0x0800, probe));
  at(5.602, P.eth(LAPTOP_MAC, GW_MAC, 0x0800, P.ipv4({ src: '10.20.0.60', dst: LAPTOP, proto: 1 }, P.icmpUnreachable(3, probe))));

  // Ping the internet
  for (let i = 0; i < 3; i++) {
    at(6 + i, P.eth(GW_MAC, LAPTOP_MAC, 0x0800, P.ipv4({ src: LAPTOP, dst: '8.8.8.8', proto: 1 }, P.icmpEcho(8, 1, i + 1))));
    at(6.018 + i, P.eth(LAPTOP_MAC, GW_MAC, 0x0800, P.ipv4({ src: '8.8.8.8', dst: LAPTOP, proto: 1, ttl: 117 }, P.icmpEcho(0, 1, i + 1))));
  }

  // Routing protocols on the LAN
  at(7.0, P.eth('01:00:5e:00:00:05', GW_MAC, 0x0800, P.ipv4({ src: GW, dst: '224.0.0.5', proto: 89, ttl: 1 }, P.ospfHello({ rid: '10.255.0.1', dr: GW, neighbors: ['10.255.0.2'] }))));
  at(7.2, frame.udp('00:00:0c:07:ac:01', '01:00:5e:00:00:02', '192.168.10.2', '224.0.0.2', { sport: 1985, dport: 1985 }, P.hsrpHello({ state: 16, prio: 110, vip: GW })));
  at(7.25, frame.udp('00:1b:54:aa:03:03', '01:00:5e:00:00:02', '192.168.10.3', '224.0.0.2', { sport: 1985, dport: 1985 }, P.hsrpHello({ state: 8, prio: 100, vip: GW })));

  // NTP
  at(7.5, frame.udp(LAPTOP_MAC, GW_MAC, LAPTOP, '10.10.10.1', { sport: 123, dport: 123 }, P.ntp(3, 0)));
  at(7.504, frame.udp(GW_MAC, LAPTOP_MAC, '10.10.10.1', LAPTOP, { sport: 123, dport: 123 }, P.ntp(4, 2)));

  // TLS handshake that fails (old server)
  const L = { sport: 52180, dport: 443 };
  at(8.0, frame.tcp(LAPTOP_MAC, GW_MAC, LAPTOP, '172.16.5.5', { ...L, seq: 10, flags: 'S', mss: 1460 }));
  at(8.004, frame.tcp(GW_MAC, LAPTOP_MAC, '172.16.5.5', LAPTOP, { sport: 443, dport: 52180, seq: 70, ack: 11, flags: 'SA', mss: 1460 }));
  at(8.005, frame.tcp(LAPTOP_MAC, GW_MAC, LAPTOP, '172.16.5.5', { ...L, seq: 11, ack: 71, flags: 'A' }));
  const h2 = P.tlsClientHello('legacy-erp.branch.lab', ['http/1.1']);
  at(8.006, frame.tcp(LAPTOP_MAC, GW_MAC, LAPTOP, '172.16.5.5', { ...L, seq: 11, ack: 71, flags: 'PA' }, h2));
  at(8.011, frame.tcp(GW_MAC, LAPTOP_MAC, '172.16.5.5', LAPTOP, { sport: 443, dport: 52180, seq: 71, ack: 11 + h2.length, flags: 'PA' }, P.tlsAlert(40)));
  at(8.012, frame.tcp(GW_MAC, LAPTOP_MAC, '172.16.5.5', LAPTOP, { sport: 443, dport: 52180, seq: 78, ack: 11 + h2.length, flags: 'RA', win: 0 }));

  // A receiver that cannot keep up (zero window) on a file copy
  const Z = { sport: 52190, dport: 445 };
  at(8.5, frame.tcp(LAPTOP_MAC, GW_MAC, LAPTOP, '10.20.0.40', { ...Z, seq: 1, ack: 1, flags: 'A', win: 0 }));

  // Spanning-tree topology change and a Telnet login prompt
  at(9.0, P.dot3('01:80:c2:00:00:00', SW_MAC, [0x42, 0x42, 0x03], P.rstpBpdu({ rootPrio: 24576, rootMac: '00:1b:54:00:00:01', cost: 4, bridgeMac: SW_MAC, tc: true })));
  at(9.5, frame.tcp(GW_MAC, LAPTOP_MAC, '10.10.10.1', LAPTOP, { sport: 23, dport: 52199, seq: 1, ack: 1, flags: 'PA' }, str('\r\nUser Access Verification\r\n\r\nUsername: ')));
  at(10.0, P.eth('01:80:c2:00:00:0e', SW_MAC, 0x88cc, P.lldp({ chassisMac: SW_MAC, port: 'Gi1/0/12', portDesc: 'Desk 4.12 - Engineering', sysName: 'access-sw3.branch.lab', sysDesc: 'Cisco IOS XE Software, Version 17.12.4', mgmt: '10.10.10.13', vlan: 20 })));

  pkts.sort((a, b) => a.ts - b.ts);
  return pkts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample.pcapng');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const pkts = buildSample();
  const bytes = writePcapng(pkts);
  fs.writeFileSync(out, bytes);
  // Shipped with the app as the "Open sample" capture.
  const shipped = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'samples', 'branch-office.pcapng');
  fs.mkdirSync(path.dirname(shipped), { recursive: true });
  fs.writeFileSync(shipped, bytes);
  console.log(`wrote ${pkts.length} packets to ${out} and ${shipped}`);
}
