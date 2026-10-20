// Stateful analysis over decoded packets: TCP stream tracking and expert flags,
// DNS timing, conversations, endpoints, neighbors (CDP/LLDP), and plain-English insights.
import { tcpInfoText } from './decode.mjs';
import { reassembleStream } from './reassemble.mjs';

const seqDiff = (a, b) => (a - b) | 0; // wrap-safe 32-bit comparison
const fmtMs = (s) => (s < 0.001 ? `${(s * 1e6).toFixed(0)} µs` : s < 1 ? `${(s * 1000).toFixed(1)} ms` : `${s.toFixed(2)} s`);

export class Analyzer {
  constructor() {
    this.reset();
  }

  reset() {
    this.convs = new Map();
    this.streams = []; // all conversations, for the Conversations view
    this.streamIds = { TCP: 0, UDP: 0 }; // tcp.stream / udp.stream numbering, as in Wireshark
    this.endpoints = new Map();
    this.protocols = new Map();
    this.dnsPending = new Map();
    this.dns = { queries: 0, responses: 0, times: [], failures: new Map(), slow: [] };
    this.names = new Map();
    this.arp = new Map();
    this.gratuitous = 0;
    this.dhcp = { servers: new Map(), discovers: 0, offers: 0, naks: 0, leases: [] };
    this.neighbors = new Map();
    this.stp = { roots: new Map(), tc: 0, tcn: 0 };
    this.fhrp = new Map();
    this.tls = { sni: new Map(), versions: new Map(), alerts: [] };
    this.http = { hosts: new Map(), errors: 0 };
    this.creds = [];
    this.credUser = new Map();
    this.insecure = new Map();
    this.icmpErrors = new Map();
    this.tcp = { conns: 0, handshakes: [], retrans: 0, dupacks: 0, zerowin: 0, resets: 0, refused: 0, synRetrans: 0, dataPkts: 0, lost: 0 };
    this.timeline = [];
    this.firstTs = null;
    this.lastTs = 0;
    this.total = { pkts: 0, bytes: 0, broadcast: 0, malformed: 0 };
  }

  /** Analyze one decoded packet; adds pkt.ann and may rewrite pkt.d.info. */
  ingest(pkt) {
    const d = pkt.d;
    const ts = pkt.ts;
    if (this.firstTs === null) this.firstTs = ts;
    this.lastTs = Math.max(this.lastTs, ts);
    pkt.rel = ts - this.firstTs;
    const ann = (pkt.ann = { expert: [] });
    this.total.pkts++;
    this.total.bytes += pkt.len;
    if (d.malformed) this.total.malformed++;
    if (d.f['eth.dst'] === 'ff:ff:ff:ff:ff:ff') this.total.broadcast++;

    // timeline (per second)
    const sec = Math.max(0, Math.floor(ts - this.firstTs));
    if (sec < 86400) {
      while (this.timeline.length <= sec) this.timeline.push({ pkts: 0, bytes: 0, errors: 0 });
      this.timeline[sec].pkts++;
      this.timeline[sec].bytes += pkt.len;
    }

    // protocol hierarchy
    const pr = this.protocols.get(d.proto) || { pkts: 0, bytes: 0 };
    pr.pkts++;
    pr.bytes += pkt.len;
    this.protocols.set(d.proto, pr);

    // endpoints (IP if present, else MAC)
    const sa = d.f['ip.src'] || d.f['ipv6.src'] || d.f['eth.src'];
    const da = d.f['ip.dst'] || d.f['ipv6.dst'] || d.f['eth.dst'];
    if (sa) this.endpoint(sa, pkt.len, true);
    if (da) this.endpoint(da, pkt.len, false);

    if (d.tcp) this.tcpPacket(pkt, ann);
    else if (d.udp) this.udpPacket(pkt, ann);
    if (d.dns) this.dnsPacket(pkt, ann);
    if (d.arp) this.arpPacket(pkt);
    if (d.dhcp) this.dhcpPacket(pkt);
    if (d.neighbor) this.neighborPacket(pkt);
    if (d.stp) this.stpPacket(pkt);
    if (d.fhrp) this.fhrpPacket(pkt);
    if (d.tls) this.tlsPacket(pkt);
    if (d.http) this.httpPacket(pkt);
    if (d.icmp && d.icmp.orig) this.icmpPacket(pkt);
    this.securityPacket(pkt);
    if (ann.expert.some((e) => e.sev === 'error') && this.timeline[sec]) this.timeline[sec].errors++;
  }

  endpoint(addr, len, isSrc) {
    let e = this.endpoints.get(addr);
    if (!e) this.endpoints.set(addr, (e = { addr, pktsTx: 0, pktsRx: 0, bytesTx: 0, bytesRx: 0 }));
    if (isSrc) {
      e.pktsTx++;
      e.bytesTx += len;
    } else {
      e.pktsRx++;
      e.bytesRx += len;
    }
  }

  conv(proto, aKey, bKey, ts) {
    const key = aKey < bKey ? `${proto}|${aKey}|${bKey}` : `${proto}|${bKey}|${aKey}`;
    let c = this.convs.get(key);
    if (!c) {
      c = { id: this.streamIds[proto]++, proto, a: aKey, b: bKey, pktsAB: 0, pktsBA: 0, bytesAB: 0, bytesBA: 0, start: ts, end: ts, dir: {}, key };
      this.convs.set(key, c);
      this.streams.push(c);
    }
    return c;
  }

  tcpPacket(pkt, ann) {
    const d = pkt.d;
    const t = d.tcp;
    const sKey = `${d.src}:${t.sport}`;
    const dKey = `${d.dst}:${t.dport}`;
    const syn = t.flags & 2;
    const ack = t.flags & 0x10;
    const fin = t.flags & 1;
    const rst = t.flags & 4;
    let c = this.conv('TCP', sKey, dKey, pkt.ts);
    // A fresh SYN on a finished 4-tuple starts a new stream.
    if (syn && !ack && (c.closed || c.reset) && c.lastSyn !== t.seq) {
      this.convs.delete(c.key);
      c = this.conv('TCP', sKey, dKey, pkt.ts);
    }
    ann.stream = c.id;
    c.end = pkt.ts;
    if (sKey === c.a) {
      c.pktsAB++;
      c.bytesAB += pkt.len;
    } else {
      c.pktsBA++;
      c.bytesBA += pkt.len;
    }
    const me = c.dir[sKey] || (c.dir[sKey] = { isn: null, maxEnd: null, lastAck: null, lastWin: null, dupCount: 0, lastAckNo: 0 });
    const peer = c.dir[dKey];
    if (me.isn === null) me.isn = syn ? t.seq : (t.seq - 1) >>> 0;
    const relSeq = (t.seq - me.isn) >>> 0;
    const relAck = peer && peer.isn !== null ? (t.ack - peer.isn) >>> 0 : t.ack;
    ann.relSeq = relSeq;
    ann.relAck = relAck;
    const flags = [];
    const seqEnd = (t.seq + t.plen + (syn ? 1 : 0) + (fin ? 1 : 0)) >>> 0;
    const consumes = t.plen > 0 || syn || fin;

    if (syn && !ack) {
      if (c.lastSyn === t.seq) {
        flags.push('retrans');
        this.tcp.synRetrans++;
        ann.expert.push({ sev: 'warn', text: 'SYN retransmitted: the server has not answered (filtered, down, or slow).' });
      } else this.tcp.conns++;
      c.lastSyn = t.seq;
      c.synTs = c.synTs || pkt.ts;
      c.client = sKey;
    } else if (syn && ack) {
      if (c.synTs && !c.rtt) {
        c.rtt = pkt.ts - c.synTs;
        ann.handshakeRtt = c.rtt;
        this.tcp.handshakes.push({ rtt: c.rtt, stream: c.id, server: sKey });
        ann.expert.push({ sev: 'info', text: `Server answered the handshake in ${fmtMs(c.rtt)}.` });
      }
      c.server = sKey;
    }

    if (me.maxEnd !== null && consumes && !syn) {
      const keepAlive = t.plen <= 1 && !fin && seqDiff(t.seq, me.maxEnd) === -1;
      if (keepAlive) flags.push('keepalive');
      else if (seqDiff(seqEnd, me.maxEnd) <= 0) {
        flags.push('retrans');
        this.tcp.retrans++;
        ann.expert.push({ sev: 'warn', text: 'Retransmission: this data was already sent. The original or its ACK was lost or delayed.' });
      } else if (seqDiff(t.seq, me.maxEnd) > 0) {
        flags.push('lost');
        this.tcp.lost++;
        ann.expert.push({ sev: 'warn', text: 'Previous segment not captured: there is a gap in the sequence numbers (packet loss, or the capture missed it).' });
      } else if (seqDiff(t.seq, me.maxEnd) < 0) {
        flags.push('retrans');
        this.tcp.retrans++;
        ann.expert.push({ sev: 'warn', text: 'Partial retransmission of already-sent data.' });
      }
    }
    if (t.plen > 0) this.tcp.dataPkts++;

    // Duplicate ACKs: same ACK and window, no data, while the peer has data outstanding.
    if (!consumes && ack && !rst) {
      if (me.lastAck === t.ack && me.lastWin === t.win && peer && peer.maxEnd !== null && seqDiff(peer.maxEnd, t.ack) > 0) {
        me.dupCount++;
        flags.push('dupack');
        this.tcp.dupacks++;
        ann.dupOf = me.lastAckNo;
        ann.expert.push({ sev: 'warn', text: `Duplicate ACK #${me.dupCount}: the receiver is still waiting for missing data.` });
      } else {
        me.dupCount = 0;
        me.lastAckNo = pkt.no;
      }
    }
    if (ack) {
      me.lastAck = t.ack;
      me.lastWin = t.win;
    }
    if (t.win === 0 && !rst && !syn) {
      flags.push('zerowin');
      this.tcp.zerowin++;
      ann.expert.push({ sev: 'warn', text: `Zero window: ${d.src} cannot accept more data right now (its application is not reading fast enough).` });
    }
    if (rst) {
      c.reset = true;
      this.tcp.resets++;
      if (!c.rtt && c.client && c.client !== sKey) {
        this.tcp.refused++;
        c.refused = true;
        ann.expert.push({ sev: 'error', text: `Connection refused: ${d.src} rejected the connection to port ${t.sport} (nothing listening, or blocked).` });
      } else ann.expert.push({ sev: 'warn', text: `Connection reset by ${d.src}.` });
    }
    if (fin) c.closed = true;
    if (consumes && (me.maxEnd === null || seqDiff(seqEnd, me.maxEnd) > 0)) me.maxEnd = seqEnd;

    ann.flags = flags;
    // Wireshark-style info with relative sequence numbers and expert tags.
    const tags = [];
    if (flags.includes('retrans')) tags.push(syn ? '[TCP Retransmission]' : '[TCP Retransmission]');
    if (flags.includes('lost')) tags.push('[TCP Previous segment not captured]');
    if (flags.includes('dupack')) tags.push(`[TCP Dup ACK ${ann.dupOf}#${me.dupCount}]`);
    if (flags.includes('zerowin')) tags.push('[TCP ZeroWindow]');
    if (flags.includes('keepalive')) tags.push('[TCP Keep-Alive]');
    if (d.proto === 'TCP') d.info = (tags.length ? tags.join(' ') + ' ' : '') + tcpInfoText(t, { seq: relSeq, ack: relAck });
    else if (tags.length) d.info = tags.join(' ') + ' ' + d.info;
    if (flags.includes('retrans') || flags.includes('dupack') || flags.includes('zerowin') || flags.includes('lost')) d.cls = 'expert';
  }

  udpPacket(pkt, ann) {
    const d = pkt.d;
    const c = this.conv('UDP', `${d.src}:${d.udp.sport}`, `${d.dst}:${d.udp.dport}`, pkt.ts);
    ann.stream = c.id;
    c.end = pkt.ts;
    if (`${d.src}:${d.udp.sport}` === c.a) {
      c.pktsAB++;
      c.bytesAB += pkt.len;
    } else {
      c.pktsBA++;
      c.bytesBA += pkt.len;
    }
  }

  dnsPacket(pkt, ann) {
    const d = pkt.d;
    const q = d.dns;
    if (q.kind !== 'DNS') return;
    if (!q.qr) {
      this.dns.queries++;
      this.dnsPending.set(`${d.src}|${d.sport}|${q.id}`, { ts: pkt.ts, no: pkt.no, name: q.qname, server: d.dst });
      return;
    }
    this.dns.responses++;
    const key = `${d.dst}|${d.dport}|${q.id}`;
    const pend = this.dnsPending.get(key);
    if (pend) {
      this.dnsPending.delete(key);
      const dt = pkt.ts - pend.ts;
      ann.dnsTime = dt;
      ann.dnsRequest = pend.no;
      this.dns.times.push(dt);
      if (dt > 0.3) {
        this.dns.slow.push({ name: q.qname, time: dt, server: d.src, no: pkt.no });
        ann.expert.push({ sev: 'warn', text: `Slow DNS answer: ${fmtMs(dt)} for ${q.qname}.` });
      } else ann.expert.push({ sev: 'info', text: `DNS answered in ${fmtMs(dt)} (request in frame ${pend.no}).` });
    }
    if (q.rcode) {
      const f = this.dns.failures.get(q.qname) || { name: q.qname, rcode: q.rcode, count: 0, server: d.src };
      f.count++;
      this.dns.failures.set(q.qname, f);
      ann.expert.push({ sev: q.rcode === 3 ? 'warn' : 'error', text: q.rcode === 3 ? `${q.qname} does not exist (NXDOMAIN).` : `DNS server ${d.src} failed: ${['', 'format error', 'server failure', '', 'not implemented', 'refused'][q.rcode] || 'error ' + q.rcode}.` });
    }
    for (const a of q.answers) if (a.type === 1 || a.type === 28) this.names.set(a.data, q.qname);
  }

  arpPacket(pkt) {
    const a = pkt.d.arp;
    if (a.gratuitous) this.gratuitous++;
    if (a.spa === '0.0.0.0') return;
    let e = this.arp.get(a.spa);
    if (!e) this.arp.set(a.spa, (e = { ip: a.spa, macs: new Map() }));
    if (!e.macs.has(a.sha)) e.macs.set(a.sha, pkt.no);
    if (e.macs.size > 1) pkt.ann.expert.push({ sev: 'error', text: `IP conflict or ARP spoofing: ${a.spa} is claimed by ${[...e.macs.keys()].join(' and ')}.` });
  }

  dhcpPacket(pkt) {
    const x = pkt.d.dhcp;
    if (x.type === 1) this.dhcp.discovers++;
    if (x.type === 2 || x.type === 5 || x.type === 6) {
      const server = x.server || pkt.d.src;
      const s = this.dhcp.servers.get(server) || { ip: server, mac: pkt.d.f['eth.src'], offers: 0, acks: 0, naks: 0, firstNo: pkt.no, router: x.router, dns: x.dns };
      if (x.type === 2) {
        s.offers++;
        this.dhcp.offers++;
      }
      if (x.type === 5) {
        s.acks++;
        this.dhcp.leases.push({ ip: x.yiaddr || x.ciaddr, mac: x.chaddr, server, lease: x.lease });
      }
      if (x.type === 6) {
        s.naks++;
        this.dhcp.naks++;
      }
      this.dhcp.servers.set(server, s);
      if (this.dhcp.servers.size > 1) pkt.ann.expert.push({ sev: 'error', text: `More than one DHCP server is answering (${[...this.dhcp.servers.keys()].join(', ')}). One may be rogue.` });
    }
  }

  neighborPacket(pkt) {
    const n = pkt.d.neighbor;
    const key = `${n.proto}|${n.device || n.chassis}|${n.port}`;
    const prev = this.neighbors.get(key);
    this.neighbors.set(key, { ...n, count: (prev ? prev.count : 0) + 1, lastNo: pkt.no, firstNo: prev ? prev.firstNo : pkt.no });
  }

  stpPacket(pkt) {
    const s = pkt.d.stp;
    if (s.tcn) {
      this.stp.tcn++;
      return;
    }
    const key = `${s.vlan}|${s.root}`;
    this.stp.roots.set(key, { root: s.root, vlan: s.vlan, rootMac: s.rootMac, prio: s.rootPrio, count: ((this.stp.roots.get(key) || {}).count || 0) + 1, version: s.version });
    if (s.tc) this.stp.tc++;
  }

  fhrpPacket(pkt) {
    const h = pkt.d.fhrp;
    const key = `${h.proto}|${h.group}`;
    const g = this.fhrp.get(key) || { proto: h.proto, group: h.group, vip: h.vip, routers: new Map(), auth: h.auth };
    g.routers.set(h.src, { state: h.state, prio: h.prio });
    this.fhrp.set(key, g);
  }

  tlsPacket(pkt) {
    const t = pkt.d.tls;
    if (t.sni) this.tls.sni.set(t.sni, (this.tls.sni.get(t.sni) || 0) + 1);
    if (t.hello === 2 && t.version) this.tls.versions.set(t.version, (this.tls.versions.get(t.version) || 0) + 1);
    if (t.hello === 2 && t.version && t.version < 0x0303) pkt.ann.expert.push({ sev: 'warn', text: 'Outdated TLS version negotiated (TLS 1.1 or older).' });
    if (t.alert && t.alert.level === 'Fatal') {
      this.tls.alerts.push({ desc: t.alert.desc, src: pkt.d.src, dst: pkt.d.dst, no: pkt.no });
      pkt.ann.expert.push({ sev: 'error', text: `TLS handshake failed: ${t.alert.desc}.` });
    }
  }

  httpPacket(pkt) {
    const h = pkt.d.http;
    if (h.host) this.http.hosts.set(h.host, (this.http.hosts.get(h.host) || 0) + 1);
    if (h.status >= 400) {
      this.http.errors++;
      pkt.ann.expert.push({ sev: h.status >= 500 ? 'error' : 'warn', text: `HTTP error ${h.status}.` });
    }
  }

  icmpPacket(pkt) {
    const i = pkt.d.icmp;
    const o = i.orig;
    const key = `${pkt.d.src}|${i.type}|${i.code}|${o.dst}|${o.dport ?? ''}`;
    const e = this.icmpErrors.get(key) || { reporter: pkt.d.src, type: i.type, code: i.code, target: o.dst, proto: o.proto, port: o.dport, count: 0, firstNo: pkt.no };
    e.count++;
    this.icmpErrors.set(key, e);
  }

  securityPacket(pkt) {
    const d = pkt.d;
    const flag = (name, detail, filter) => {
      const e = this.insecure.get(name) || { name, detail, filter, count: 0, firstNo: pkt.no };
      e.count++;
      this.insecure.set(name, e);
    };
    if (d.snmp && d.snmp.version !== 'v3') flag(`SNMP ${d.snmp.version}`, `community "${d.snmp.community}" sent in clear text`, 'snmp.version < 3');
    if (d.f.telnet) flag('Telnet', 'remote logins without encryption', 'telnet');
    if (d.f.ftp) flag('FTP', 'file transfers and logins without encryption', 'ftp');
    if (d.f.smb1) flag('SMBv1', 'obsolete and exploitable file sharing protocol', 'smb');
    if (d.fhrp && d.fhrp.auth) flag('HSRP clear-text auth', `authentication string "${d.fhrp.auth}"`, 'hsrp');
    if (d.insecure) flag(d.insecure, '', '');
    if (d.http && d.http.method && d.f['http.request']) flag('HTTP (unencrypted web)', 'web traffic readable on the wire', 'http.request');
    // Credentials: FTP/POP send USER and PASS in separate packets on the same stream.
    if (d.credPart) this.credUser.set(pkt.ann.stream, d.credPart.user);
    if (d.cred) {
      const user = d.cred.user || this.credUser.get(pkt.ann.stream) || '?';
      this.creds.push({ proto: d.cred.proto, user, host: d.cred.host, src: d.cred.src, no: pkt.no, hasPassword: !!(d.cred.password || d.cred.proto === 'HTTP Basic') });
      pkt.ann.expert.push({ sev: 'error', text: `Clear-text ${d.cred.proto} credentials for user "${user}".` });
    }
  }

  // ---------------------------------------------------------------- summaries

  dnsStats() {
    const t = this.dns.times;
    const avg = t.length ? t.reduce((a, b) => a + b, 0) / t.length : null;
    const sorted = [...t].sort((a, b) => a - b);
    return { avg, p95: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : null, unanswered: [...this.dnsPending.values()].filter((p) => this.lastTs - p.ts > 2) };
  }

  health() {
    const tcpData = Math.max(1, this.tcp.dataPkts);
    const hs = this.tcp.handshakes.map((h) => h.rtt);
    const dns = this.dnsStats();
    return {
      retransPct: (this.tcp.retrans / tcpData) * 100,
      handshakeAvg: hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : null,
      dnsAvg: dns.avg,
      dnsFailPct: this.dns.responses ? ([...this.dns.failures.values()].reduce((a, f) => a + f.count, 0) / this.dns.responses) * 100 : 0,
      broadcastPct: this.total.pkts ? (this.total.broadcast / this.total.pkts) * 100 : 0,
    };
  }

  /** Plain-English findings, most severe first. Each carries a display filter to drill in. */
  insights() {
    const out = [];
    const add = (sev, cat, title, detail, filter, count) => out.push({ sev, cat, title, detail, filter, count });
    const h = this.health();

    // Where am I plugged in?
    for (const n of this.neighbors.values()) {
      add('info', 'Neighbors', `Connected to ${n.device || n.chassis} port ${n.port}`, [n.platform, n.vlan ? `native VLAN ${n.vlan}` : '', n.voiceVlan ? `voice VLAN ${n.voiceVlan}` : '', n.mgmt ? `mgmt ${n.mgmt}` : '', `via ${n.proto}`].filter(Boolean).join(' · '), n.proto.toLowerCase(), n.count);
    }
    // Security
    for (const c of this.creds) add('error', 'Security', `Clear-text ${c.proto} login for "${c.user}"`, `${c.src} → ${c.host} (frame ${c.no}). Anyone on the path can read this password.`, `frame.number == ${c.no}`, 1);
    for (const e of this.insecure.values()) add('warn', 'Security', `Insecure protocol in use: ${e.name}`, e.detail || 'consider an encrypted alternative', e.filter, e.count);
    // Addressing
    for (const e of this.arp.values()) if (e.macs.size > 1) add('error', 'ARP', `IP address conflict on ${e.ip}`, `Claimed by ${[...e.macs.keys()].join(' and ')}. Two devices share an IP, or someone is ARP-spoofing.`, `arp.src.proto_ipv4 == ${e.ip}`, e.macs.size);
    if (this.dhcp.servers.size > 1) add('error', 'DHCP', `${this.dhcp.servers.size} DHCP servers are answering`, `${[...this.dhcp.servers.values()].map((s) => `${s.ip} (${s.mac})`).join(', ')}. One of them may be a rogue DHCP server handing out wrong addresses.`, 'dhcp.type == 2 or dhcp.type == 5', this.dhcp.servers.size);
    if (this.dhcp.discovers && !this.dhcp.offers && this.lastTs - this.firstTs > 3) add('error', 'DHCP', 'DHCP requests are not being answered', `${this.dhcp.discovers} Discover messages with no Offer. Check the DHCP server, scope, or ip helper-address on the router.`, 'dhcp.type == 1', this.dhcp.discovers);
    if (this.dhcp.naks) add('warn', 'DHCP', 'DHCP server refused requests (NAK)', 'Clients asked for an address the server will not give (wrong subnet or expired lease).', 'dhcp.type == 6', this.dhcp.naks);
    // TCP
    if (this.tcp.refused) add('error', 'TCP', `${this.tcp.refused} connection${this.tcp.refused > 1 ? 's' : ''} refused`, 'The server answered SYN with RST: nothing is listening on that port, or a firewall rejects it.', 'tcp.flags.reset', this.tcp.refused);
    if (this.tcp.synRetrans) add('warn', 'TCP', 'Connection attempts with no answer', `${this.tcp.synRetrans} SYN retransmissions: the server is down, filtered by a firewall, or unreachable.`, 'tcp.flags.syn and retrans', this.tcp.synRetrans);
    if (this.tcp.retrans) add(h.retransPct > 2 ? 'error' : 'warn', 'TCP', `${this.tcp.retrans} TCP retransmissions (${h.retransPct.toFixed(1)}% of data packets)`, h.retransPct > 2 ? 'High packet loss: check duplex mismatches, interface errors, congestion or Wi-Fi quality.' : 'Some packet loss or delay on the path.', 'tcp.analysis.retransmission', this.tcp.retrans);
    if (this.tcp.dupacks) add('warn', 'TCP', `${this.tcp.dupacks} duplicate ACKs`, 'Receivers are signalling missing segments (packet loss).', 'tcp.analysis.duplicate_ack', this.tcp.dupacks);
    if (this.tcp.zerowin) add('warn', 'TCP', `${this.tcp.zerowin} zero-window events`, 'A receiver could not keep up and paused the sender: the problem is the application or host, not the network.', 'tcp.analysis.zero_window', this.tcp.zerowin);
    if (this.tcp.lost) add('warn', 'TCP', `${this.tcp.lost} gaps in TCP sequence numbers`, 'Packets were lost before reaching the capture point (or the capture dropped them).', 'tcp.analysis.lost_segment', this.tcp.lost);
    if (this.tcp.resets - this.tcp.refused > 0) add('info', 'TCP', `${this.tcp.resets - this.tcp.refused} connections reset`, 'Established connections were aborted with RST (application closes, timeouts or middleboxes).', 'tcp.flags.reset', this.tcp.resets - this.tcp.refused);
    const slowHs = this.tcp.handshakes.filter((x) => x.rtt > 0.2);
    if (slowHs.length) add('warn', 'TCP', `${slowHs.length} slow TCP handshakes (> 200 ms)`, `Slowest: ${slowHs.sort((a, b) => b.rtt - a.rtt).slice(0, 3).map((x) => `${x.server} ${fmtMs(x.rtt)}`).join(', ')}.`, 'tcp.analysis.initial_rtt > 0.2', slowHs.length);
    // DNS
    const dns = this.dnsStats();
    const servFail = [...this.dns.failures.values()].filter((f) => f.rcode !== 3);
    const nx = [...this.dns.failures.values()].filter((f) => f.rcode === 3);
    if (servFail.length) add('error', 'DNS', `DNS server errors for ${servFail.length} name${servFail.length > 1 ? 's' : ''}`, servFail.slice(0, 4).map((f) => `${f.name} (${f.server})`).join(', '), 'dns.flags.rcode > 0 and dns.flags.rcode != 3', servFail.reduce((a, f) => a + f.count, 0));
    if (nx.length) add('warn', 'DNS', `${nx.length} name${nx.length > 1 ? 's' : ''} not found (NXDOMAIN)`, nx.slice(0, 5).map((f) => f.name).join(', '), 'dns.flags.rcode == 3', nx.reduce((a, f) => a + f.count, 0));
    if (dns.unanswered.length) add('error', 'DNS', `${dns.unanswered.length} DNS queries got no answer`, `Server${new Set(dns.unanswered.map((u) => u.server)).size > 1 ? 's' : ''} ${[...new Set(dns.unanswered.map((u) => u.server))].join(', ')} did not reply. Names: ${dns.unanswered.slice(0, 4).map((u) => u.name).join(', ')}.`, 'dns and not dns.flags.response', dns.unanswered.length);
    if (this.dns.slow.length) add('warn', 'DNS', `${this.dns.slow.length} slow DNS answers (> 300 ms)`, this.dns.slow.slice(0, 4).map((s) => `${s.name} ${fmtMs(s.time)}`).join(', '), 'dns.time > 0.3', this.dns.slow.length);
    // ICMP
    for (const e of this.icmpErrors.values()) {
      if (e.type === 3) add('warn', 'ICMP', `${e.reporter} reports ${e.target}${e.port ? ':' + e.port : ''} unreachable`, { 0: 'network unreachable', 1: 'host unreachable', 3: 'port unreachable (nothing listening)', 4: 'needs fragmentation but DF set (MTU problem!)', 13: 'administratively prohibited (ACL/firewall)', 9: 'administratively prohibited', 10: 'administratively prohibited' }[e.code] || `code ${e.code}`, `icmp.type == 3 and icmp.code == ${e.code}`, e.count);
      else if (e.type === 11 && e.count > 20) add('warn', 'ICMP', `Many TTL-exceeded messages from ${e.reporter}`, 'Unless a traceroute is running, this points to a routing loop.', 'icmp.type == 11', e.count);
    }
    // Switching / routing
    const rootsByVlan = new Map();
    for (const r of this.stp.roots.values()) rootsByVlan.set(r.vlan, [...(rootsByVlan.get(r.vlan) || []), r]);
    for (const [vlan, roots] of rootsByVlan) {
      if (roots.length > 1) add('error', 'Spanning Tree', `${roots.length} different root bridges${vlan ? ' on VLAN ' + vlan : ''}`, `${roots.map((r) => r.root).join(' vs ')}: the spanning tree is unstable or misconfigured.`, 'stp', roots.length);
      else add('info', 'Spanning Tree', `Root bridge${vlan ? ' (VLAN ' + vlan + ')' : ''}: ${roots[0].rootMac}`, `Priority ${roots[0].prio}, ${roots[0].version}`, 'stp', roots[0].count);
    }
    if (this.stp.tc || this.stp.tcn) add('warn', 'Spanning Tree', 'Spanning-tree topology changes', `${this.stp.tc + this.stp.tcn} BPDUs with topology change: a port is flapping or edge ports lack portfast.`, 'stp.flags.tc or stp.tcn', this.stp.tc + this.stp.tcn);
    for (const g of this.fhrp.values()) {
      const active = [...g.routers].filter(([, r]) => r.state === 'Active' || r.state === 'Master');
      if (active.length > 1) add('error', 'Redundancy', `${g.proto} group ${g.group}: ${active.length} routers think they are active`, `${active.map(([ip]) => ip).join(', ')} both own ${g.vip}. Split-brain: they cannot hear each other.`, g.proto.toLowerCase(), active.length);
      else add('info', 'Redundancy', `${g.proto} group ${g.group} → ${g.vip}`, [...g.routers].map(([ip, r]) => `${ip} ${r.state} prio ${r.prio}`).join(', '), g.proto.toLowerCase(), g.routers.size);
    }
    // TLS / HTTP
    if (this.tls.alerts.length) add('error', 'TLS', `${this.tls.alerts.length} TLS handshake failures`, this.tls.alerts.slice(0, 3).map((a) => `${a.desc} (${a.src})`).join(', '), 'tls.alert', this.tls.alerts.length);
    const oldTls = [...this.tls.versions].filter(([v]) => v < 0x0303);
    if (oldTls.length) add('warn', 'TLS', 'Outdated TLS versions negotiated', 'TLS 1.0/1.1 are deprecated and insecure.', 'tls.handshake.version < 0x0303', oldTls.reduce((a, [, n]) => a + n, 0));
    if (this.http.errors) add('warn', 'HTTP', `${this.http.errors} HTTP error responses`, 'Responses with status 4xx/5xx.', 'http.response.code >= 400', this.http.errors);
    if (h.broadcastPct > 20 && this.total.pkts > 200) add('warn', 'Traffic', `High broadcast traffic (${h.broadcastPct.toFixed(0)}%)`, 'Broadcast storms or chatty devices; check for loops or misbehaving hosts.', 'broadcast', this.total.broadcast);
    if (this.total.malformed) add('info', 'Capture', `${this.total.malformed} truncated or malformed packets`, 'Often caused by a small snap length or packets the decoder does not understand.', 'malformed', this.total.malformed);
    // Good news
    if (this.tcp.conns && !this.tcp.retrans && !this.tcp.refused && !this.tcp.synRetrans) add('good', 'TCP', 'No TCP loss detected', `${this.tcp.conns} connections${h.handshakeAvg != null ? `, average handshake ${fmtMs(h.handshakeAvg)}` : ''}.`, 'tcp', this.tcp.conns);
    if (this.dns.responses && !this.dns.failures.size && !dns.unanswered.length) add('good', 'DNS', 'DNS is healthy', `${this.dns.responses} answers, average ${dns.avg != null ? fmtMs(dns.avg) : 'n/a'}.`, 'dns', this.dns.responses);

    const rank = { error: 0, warn: 1, info: 2, good: 3 };
    return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
  }

  /** Sequence ranges, typed gaps and frame provenance for one conversation. */
  followStream(packets, streamId, proto = 'TCP') {
    const conv = this.streams.find((c) => c.proto === proto && c.id === streamId);
    if (!conv) return null;
    return reassembleStream(packets, conv);
  }
}
