// Packet decoder. decode(linktype, bytes, {tree}) returns:
//   proto, src, dst, info  - the packet list columns
//   f                      - flat field map used by display filters (e.g. f['tcp.dstport'])
//   cls                    - row color class
//   explain                - plain-English sentences describing the packet
//   nodes                  - detail tree with byte ranges (only when tree: true)
//   tcp / dns / dhcp / ... - structured facts the analyzer uses
import { l2, routing, misc } from './decode-more.mjs';

export const LINKTYPES = { 0: 'Null/Loopback', 1: 'Ethernet', 12: 'Raw IP', 101: 'Raw IP', 108: 'OpenBSD Loopback', 113: 'Linux cooked', 228: 'Raw IPv4', 229: 'Raw IPv6' };

export const SERVICES = {
  20: 'FTP data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 49: 'TACACS+', 53: 'DNS', 67: 'DHCP server', 68: 'DHCP client', 69: 'TFTP',
  80: 'HTTP', 88: 'Kerberos', 110: 'POP3', 123: 'NTP', 135: 'MS RPC', 137: 'NetBIOS name', 138: 'NetBIOS datagram', 139: 'NetBIOS session',
  143: 'IMAP', 161: 'SNMP', 162: 'SNMP trap', 179: 'BGP', 389: 'LDAP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 500: 'IKE', 514: 'Syslog',
  546: 'DHCPv6 client', 547: 'DHCPv6 server', 587: 'SMTP submission', 636: 'LDAPS', 853: 'DNS over TLS', 993: 'IMAPS', 995: 'POP3S',
  1433: 'SQL Server', 1812: 'RADIUS', 1813: 'RADIUS accounting', 1900: 'SSDP', 1985: 'HSRP', 2055: 'NetFlow', 3306: 'MySQL', 3389: 'RDP',
  3478: 'STUN', 4500: 'IPsec NAT-T', 4789: 'VXLAN', 5060: 'SIP', 5353: 'mDNS', 5355: 'LLMNR', 5432: 'PostgreSQL', 5900: 'VNC',
  6343: 'sFlow', 8080: 'HTTP alt', 8443: 'HTTPS alt', 9995: 'NetFlow', 4739: 'IPFIX',
};

export const IP_PROTOS = { 1: 'ICMP', 2: 'IGMP', 4: 'IPv4-in-IPv4', 6: 'TCP', 17: 'UDP', 41: 'IPv6-in-IPv4', 47: 'GRE', 50: 'ESP', 51: 'AH', 58: 'ICMPv6', 89: 'OSPF', 103: 'PIM', 112: 'VRRP', 132: 'SCTP' };

const ETHERTYPES = { 0x0800: 'IPv4', 0x0806: 'ARP', 0x86dd: 'IPv6', 0x8100: '802.1Q', 0x88a8: '802.1ad', 0x88cc: 'LLDP', 0x8809: 'Slow Protocols', 0x888e: '802.1X', 0x8847: 'MPLS', 0x8848: 'MPLS multicast', 0x8863: 'PPPoE Discovery', 0x8864: 'PPPoE Session', 0x88e5: 'MACsec', 0x88f7: 'PTP', 0x893a: 'IEEE 1905', 0x9000: 'Loopback (CTP)' };

// ---------------------------------------------------------------- tree + context

export class Node {
  constructor(label, start, len) {
    this.label = label;
    this.start = start;
    this.len = len;
    this.children = null;
  }
  add(label, start = this.start, len = 0) {
    const n = new Node(label, start, len);
    (this.children || (this.children = [])).push(n);
    return n;
  }
}
const NOOP = { add: () => NOOP };

class Truncated extends Error {}

export class Ctx {
  constructor(data, tree) {
    this.d = data;
    this.end = data.length;
    this.tree = tree;
    this.r = { proto: '', src: '', dst: '', info: '', cls: '', f: { hosts: [] }, layers: [], explain: [], notes: [], nodes: tree ? [] : null };
  }
  need(o, n) {
    if (o < 0 || o + n > this.d.length) throw new Truncated();
  }
  u8(o) {
    this.need(o, 1);
    return this.d[o];
  }
  u16(o) {
    this.need(o, 2);
    return (this.d[o] << 8) | this.d[o + 1];
  }
  u32(o) {
    this.need(o, 4);
    return this.d[o] * 0x1000000 + ((this.d[o + 1] << 16) | (this.d[o + 2] << 8) | this.d[o + 3]);
  }
  bytes(o, n) {
    this.need(o, n);
    return this.d.subarray(o, o + n);
  }
  mac(o) {
    this.need(o, 6);
    let s = '';
    for (let i = 0; i < 6; i++) s += (i ? ':' : '') + hex2(this.d[o + i]);
    return s;
  }
  ip4(o) {
    this.need(o, 4);
    return `${this.d[o]}.${this.d[o + 1]}.${this.d[o + 2]}.${this.d[o + 3]}`;
  }
  ip6(o) {
    this.need(o, 16);
    return fmtIp6(this.d, o);
  }
  text(o, end, max = 4096) {
    const e = Math.min(end, o + max, this.d.length);
    let s = '';
    for (let i = o; i < e; i++) s += String.fromCharCode(this.d[i]);
    return s;
  }
  /** Start a protocol layer: records it and returns its tree node. */
  layer(name, label, start, len) {
    this.r.layers.push(name);
    this.r.f[name] = true;
    if (!this.tree) return NOOP;
    const n = new Node(label, start, len);
    this.r.nodes.push(n);
    return n;
  }
  top(proto, info, cls) {
    this.r.proto = proto;
    if (info != null) this.r.info = info;
    if (cls) this.r.cls = cls;
  }
  host(...addrs) {
    for (const a of addrs) if (a && !this.r.f.hosts.includes(a)) this.r.f.hosts.push(a);
  }
  explain(s) {
    this.r.explain.push(s);
  }
}

export const hex2 = (n) => n.toString(16).padStart(2, '0');
export const hex4 = (n) => n.toString(16).padStart(4, '0');
export const hex8 = (n) => n.toString(16).padStart(8, '0');

export function fmtIp6(d, o) {
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push(((d[o + i] << 8) | d[o + i + 1]).toString(16));
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (g[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === '0') j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (best < 0) return g.join(':');
  return g.slice(0, best).join(':') + '::' + g.slice(best + bestLen).join(':');
}

export function svc(port) {
  return SERVICES[port] ? `${port} (${SERVICES[port]})` : String(port);
}

// ---------------------------------------------------------------- entry point

export function decode(linktype, data, { tree = false } = {}) {
  const c = new Ctx(data, tree);
  try {
    switch (linktype) {
      case 1:
        ethernet(c, 0);
        break;
      case 0:
      case 108:
        nullLoop(c, linktype);
        break;
      case 12:
      case 101:
      case 228:
      case 229:
        rawIp(c, 0);
        break;
      case 113:
        sll(c);
        break;
      default:
        c.top(`DLT ${linktype}`, `Unsupported link type ${linktype}`);
    }
  } catch (e) {
    if (!(e instanceof Truncated)) {
      c.r.notes.push(`Decoder error: ${e.message}`);
    }
    c.r.malformed = true;
    c.r.f.malformed = true;
    c.r.notes.push('Packet is truncated or malformed');
    if (!c.r.info) c.r.info = '[Malformed packet]';
    else c.r.info += ' [Malformed]';
    if (c.tree) c.r.nodes.push(new Node('[Malformed packet: truncated or invalid data]', 0, 0));
  }
  const r = c.r;
  if (!r.proto) r.proto = r.layers.length ? r.layers[r.layers.length - 1].toUpperCase() : 'Unknown';
  r.f.proto = r.proto.toLowerCase();
  r.f.frame_len = data.length;
  return r;
}

function nullLoop(c, lt) {
  // 4-byte address family in host (little-endian) or network order.
  const le = c.d[0] | (c.d[1] << 8) | (c.d[2] << 16) | (c.d[3] << 24);
  const fam = le > 0xffff ? c.u32(0) : le;
  const n = c.layer('null', `Null/Loopback, Family: ${fam === 2 ? 'IPv4' : [23, 24, 28, 30].includes(fam) ? 'IPv6' : fam}`, 0, 4);
  n.add(`Family: ${fam}`, 0, 4);
  if (fam === 2) ipv4(c, 4);
  else if ([23, 24, 28, 30].includes(fam)) ipv6(c, 4);
  else c.top('Loopback', `Unknown family ${fam}`);
}

function rawIp(c, o) {
  const v = c.u8(o) >> 4;
  if (v === 4) ipv4(c, o);
  else if (v === 6) ipv6(c, o);
  else c.top('Raw', 'Not an IP packet');
}

function sll(c) {
  const type = c.u16(0);
  const proto = c.u16(14);
  const n = c.layer('sll', 'Linux cooked capture', 0, 16);
  n.add(`Packet type: ${['Unicast to us', 'Broadcast', 'Multicast', 'Unicast to another host', 'Sent by us'][type] || type}`, 0, 2);
  n.add(`Protocol: ${ETHERTYPES[proto] || '0x' + hex4(proto)}`, 14, 2);
  ethertype(c, proto, 16);
}

// ---------------------------------------------------------------- layer 2

export function ethernet(c, o) {
  const dst = c.mac(o);
  const src = c.mac(o + 6);
  const n = c.layer('eth', `Ethernet II, Src: ${src}, Dst: ${dst}`, o, 14);
  n.add(`Destination: ${dst}${macKind(c.d[o], dst)}`, o, 6);
  n.add(`Source: ${src}`, o + 6, 6);
  const f = c.r.f;
  if (!f['eth.src']) {
    f['eth.src'] = src;
    f['eth.dst'] = dst;
    f['eth.addr'] = [src, dst];
    c.host(src, dst);
  }
  c.r.src = src;
  c.r.dst = dst;
  c.top('Ethernet', '', 'l2');
  let p = o + 12;
  let type = c.u16(p);
  while (type === 0x8100 || type === 0x88a8 || type === 0x9100) {
    const tci = c.u16(p + 2);
    const vid = tci & 0xfff;
    const pcp = tci >> 13;
    const vn = c.layer('vlan', `802.1Q Virtual LAN, PRI: ${pcp}, DEI: ${(tci >> 12) & 1}, ID: ${vid}`, p, 4);
    vn.add(`Priority: ${pcp} (${['Best Effort', 'Background', 'Excellent Effort', 'Critical Applications', 'Video', 'Voice', 'Internetwork Control', 'Network Control'][pcp]})`, p + 2, 2);
    vn.add(`VLAN ID: ${vid}`, p + 2, 2);
    if (f['vlan.id'] == null) f['vlan.id'] = vid;
    else f['vlan.inner'] = vid;
    c.r.vlan = c.r.vlan == null ? vid : c.r.vlan;
    p += 4;
    type = c.u16(p);
  }
  n.add(`Type: ${ETHERTYPES[type] || (type <= 1500 ? `Length ${type} (802.3)` : 'Unknown')} (0x${hex4(type)})`, p, 2);
  f['eth.type'] = type;
  if (type <= 1500) return llc(c, p + 2, Math.min(c.end, p + 2 + type), dst);
  return ethertype(c, type, p + 2);
}

function macKind(first, mac) {
  if (mac === 'ff:ff:ff:ff:ff:ff') return ' (Broadcast)';
  if (first & 1) return ' (Multicast)';
  return '';
}

export function ethertype(c, type, p) {
  switch (type) {
    case 0x0800:
      return ipv4(c, p);
    case 0x86dd:
      return ipv6(c, p);
    case 0x0806:
      return arp(c, p);
    case 0x88cc:
      return l2.lldp(c, p);
    case 0x8809:
      return l2.slow(c, p);
    case 0x888e:
      return l2.eapol(c, p);
    case 0x8847:
    case 0x8848:
      return mpls(c, p);
    case 0x8863:
    case 0x8864:
      return misc.pppoe(c, p, type);
    default:
      c.top(ETHERTYPES[type] || 'Ethernet', ETHERTYPES[type] ? `${ETHERTYPES[type]} frame` : `Ethertype 0x${hex4(type)}`, 'l2');
  }
}

function llc(c, o, end, dst) {
  const dsap = c.u8(o);
  const ssap = c.u8(o + 1);
  const n = c.layer('llc', `Logical-Link Control, DSAP 0x${hex2(dsap)}, SSAP 0x${hex2(ssap)}`, o, 3);
  if (dsap === 0xaa && ssap === 0xaa) {
    const oui = (c.u8(o + 3) << 16) | (c.u8(o + 4) << 8) | c.u8(o + 5);
    const pid = c.u16(o + 6);
    n.add(`SNAP OUI: 0x${oui.toString(16).padStart(6, '0')}${oui === 0x0c ? ' (Cisco)' : ''}, PID: 0x${hex4(pid)}`, o + 3, 5);
    const p = o + 8;
    if (oui === 0x00000c) {
      if (pid === 0x2000) return l2.cdp(c, p, end);
      if (pid === 0x010b) return l2.stp(c, p, end, 'PVST+');
      if (pid === 0x2004) return c.top('DTP', 'Dynamic Trunking Protocol', 'l2');
      if (pid === 0x0111) return c.top('UDLD', 'Unidirectional Link Detection', 'l2');
      if (pid === 0x2003) return c.top('VTP', 'VLAN Trunking Protocol', 'l2');
    }
    if (oui === 0) return ethertype(c, pid, p);
    return c.top('SNAP', `SNAP OUI 0x${oui.toString(16)} PID 0x${hex4(pid)}`, 'l2');
  }
  if (dsap === 0x42 && ssap === 0x42) return l2.stp(c, o + 3, end, 'STP');
  c.top('LLC', `LLC DSAP 0x${hex2(dsap)} SSAP 0x${hex2(ssap)}`, 'l2');
}

function mpls(c, o) {
  let p = o;
  const labels = [];
  for (let i = 0; i < 16; i++) {
    const v = c.u32(p);
    const label = v >>> 12;
    const s = (v >>> 8) & 1;
    labels.push(label);
    const n = c.layer('mpls', `MultiProtocol Label Switching, Label: ${label}, Exp: ${(v >>> 9) & 7}, S: ${s}, TTL: ${v & 255}`, p, 4);
    n.add(`Label: ${label}`, p, 3);
    p += 4;
    if (s) break;
  }
  c.r.f['mpls.label'] = labels;
  const nib = c.u8(p) >> 4;
  if (nib === 4) return ipv4(c, p);
  if (nib === 6) return ipv6(c, p);
  if (nib === 0) return ethernet(c, p + 4); // pseudowire with control word
  return ethernet(c, p);
}

function arp(c, o) {
  const op = c.u16(o + 6);
  const hlen = c.u8(o + 4);
  const plen = c.u8(o + 5);
  if (hlen !== 6 || plen !== 4) return c.top('ARP', `ARP opcode ${op}`, 'arp');
  const sha = c.mac(o + 8);
  const spa = c.ip4(o + 14);
  const tha = c.mac(o + 18);
  const tpa = c.ip4(o + 24);
  const gratuitous = spa === tpa;
  const probe = spa === '0.0.0.0';
  const opName = op === 1 ? 'request' : op === 2 ? 'reply' : `opcode ${op}`;
  const n = c.layer('arp', `Address Resolution Protocol (${opName}${gratuitous ? ', gratuitous' : ''})`, o, 28);
  n.add(`Opcode: ${opName} (${op})`, o + 6, 2);
  n.add(`Sender MAC address: ${sha}`, o + 8, 6);
  n.add(`Sender IP address: ${spa}`, o + 14, 4);
  n.add(`Target MAC address: ${tha}`, o + 18, 6);
  n.add(`Target IP address: ${tpa}`, o + 24, 4);
  const f = c.r.f;
  f['arp.opcode'] = op;
  f['arp.src.hw_mac'] = sha;
  f['arp.src.proto_ipv4'] = spa;
  f['arp.dst.proto_ipv4'] = tpa;
  f['arp.isgratuitous'] = gratuitous;
  c.host(spa, tpa);
  c.r.arp = { op, sha, spa, tha, tpa, gratuitous, probe };
  let info;
  if (op === 1 && gratuitous) {
    info = `Gratuitous ARP for ${spa} (Request)`;
    c.explain(`${sha} is announcing that it owns ${spa} (gratuitous ARP), typically after boot, failover or an IP change.`);
  } else if (op === 1 && probe) {
    info = `Who has ${tpa}? (ARP Probe)`;
    c.explain(`${sha} is checking that nobody else uses ${tpa} before taking it (ARP probe).`);
  } else if (op === 1) {
    info = `Who has ${tpa}? Tell ${spa}`;
    c.explain(`${spa} (${sha}) is asking the local network for the MAC address of ${tpa}.`);
  } else if (op === 2) {
    info = `${spa} is at ${sha}`;
    c.explain(`${spa} answers: its MAC address is ${sha}.`);
  } else info = `ARP opcode ${op}`;
  c.top('ARP', info, 'arp');
}

// ---------------------------------------------------------------- IP

export function ipv4(c, o) {
  const vihl = c.u8(o);
  const ihl = (vihl & 15) * 4;
  if (vihl >> 4 !== 4 || ihl < 20) {
    c.top('IPv4', 'Bogus IPv4 header');
    throw new Truncated();
  }
  c.need(o, ihl);
  const tos = c.u8(o + 1);
  const tot = c.u16(o + 2);
  const id = c.u16(o + 4);
  const ff = c.u16(o + 6);
  const ttl = c.u8(o + 8);
  const proto = c.u8(o + 9);
  const csum = c.u16(o + 10);
  const src = c.ip4(o + 12);
  const dst = c.ip4(o + 16);
  const df = !!(ff & 0x4000);
  const mf = !!(ff & 0x2000);
  const frag = (ff & 0x1fff) * 8;
  if (mf || frag) c.r.fragmented = true;
  // Header checksum
  let sum = 0;
  for (let i = 0; i < ihl; i += 2) if (i !== 10) sum += (c.d[o + i] << 8) | c.d[o + i + 1];
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  const csumOk = ((~sum) & 0xffff) === csum || csum === 0;
  const n = c.layer('ip', `Internet Protocol Version 4, Src: ${src}, Dst: ${dst}`, o, ihl);
  n.add(`Header Length: ${ihl} bytes`, o, 1);
  n.add(`Differentiated Services: DSCP ${tos >> 2}${DSCP[tos >> 2] ? ' (' + DSCP[tos >> 2] + ')' : ''}, ECN ${tos & 3}`, o + 1, 1);
  n.add(`Total Length: ${tot}`, o + 2, 2);
  n.add(`Identification: 0x${hex4(id)} (${id})`, o + 4, 2);
  const fl = n.add(`Flags: ${df ? "Don't fragment" : ''}${df && mf ? ', ' : ''}${mf ? 'More fragments' : ''}${!df && !mf ? 'none' : ''}`, o + 6, 2);
  fl.add(`Don't fragment: ${df ? 'Set' : 'Not set'}`, o + 6, 1);
  fl.add(`More fragments: ${mf ? 'Set' : 'Not set'}`, o + 6, 1);
  n.add(`Fragment Offset: ${frag}`, o + 6, 2);
  n.add(`Time to Live: ${ttl}`, o + 8, 1);
  n.add(`Protocol: ${IP_PROTOS[proto] || 'Unknown'} (${proto})`, o + 9, 1);
  n.add(`Header Checksum: 0x${hex4(csum)} [${csumOk ? 'correct' : 'INCORRECT'}]`, o + 10, 2);
  n.add(`Source Address: ${src}`, o + 12, 4);
  n.add(`Destination Address: ${dst}`, o + 16, 4);
  if (ihl > 20) n.add(`Options: ${ihl - 20} bytes`, o + 20, ihl - 20);
  const f = c.r.f;
  if (!f['ip.src']) {
    f['ip.src'] = src;
    f['ip.dst'] = dst;
    f['ip.addr'] = [src, dst];
    f['ip.ttl'] = ttl;
    f['ip.proto'] = proto;
    f['ip.id'] = id;
    f['ip.len'] = tot;
    f['ip.dscp'] = tos >> 2;
    f['ip.flags.df'] = df;
    f['ip.flags.mf'] = mf;
    f['ip.frag_offset'] = frag;
    f['ip.checksum_bad'] = !csumOk;
  } else {
    f['ip.inner.src'] = src;
    f['ip.inner.dst'] = dst;
  }
  c.host(src, dst);
  c.r.src = src;
  c.r.dst = dst;
  c.r.ttl = ttl;
  if (!csumOk) c.r.notes.push('IPv4 header checksum is incorrect (normal for packets sent by this PC when checksum offload is on)');
  c.top('IPv4', `${IP_PROTOS[proto] || 'Protocol ' + proto}`, '');
  const end = Math.min(c.d.length, o + Math.max(tot, ihl));
  if (tot > c.d.length - o) c.r.notes.push('IP packet is longer than the captured bytes (snap length or TSO)');
  c.end = tot ? end : c.d.length;
  if (frag > 0) {
    c.top('IPv4', `Fragmented IP protocol (proto=${IP_PROTOS[proto] || proto}, off=${frag}, ID=0x${hex4(id)})`, '');
    c.explain(`This is a fragment (offset ${frag}) of a larger ${IP_PROTOS[proto] || ''} packet from ${src} to ${dst}.`);
    return;
  }
  if (mf) c.r.notes.push('First fragment of a fragmented packet');
  ipPayload(c, proto, o + ihl, c.end, src, dst);
}

const DSCP = { 0: 'CS0/Default', 8: 'CS1', 10: 'AF11', 12: 'AF12', 14: 'AF13', 16: 'CS2', 18: 'AF21', 20: 'AF22', 22: 'AF23', 24: 'CS3', 26: 'AF31', 28: 'AF32', 30: 'AF33', 32: 'CS4', 34: 'AF41', 36: 'AF42', 38: 'AF43', 40: 'CS5', 44: 'VOICE-ADMIT', 46: 'EF (voice)', 48: 'CS6 (network control)', 56: 'CS7' };

export function ipv6(c, o) {
  const v = c.u32(o);
  if (v >>> 28 !== 6) {
    c.top('IPv6', 'Bogus IPv6 header');
    throw new Truncated();
  }
  const plen = c.u16(o + 4);
  let nh = c.u8(o + 6);
  const hlim = c.u8(o + 7);
  const src = c.ip6(o + 8);
  const dst = c.ip6(o + 24);
  const n = c.layer('ipv6', `Internet Protocol Version 6, Src: ${src}, Dst: ${dst}`, o, 40);
  n.add(`Traffic Class: 0x${hex2((v >>> 20) & 255)}`, o, 2);
  n.add(`Flow Label: 0x${(v & 0xfffff).toString(16).padStart(5, '0')}`, o + 1, 3);
  n.add(`Payload Length: ${plen}`, o + 4, 2);
  n.add(`Next Header: ${IP_PROTOS[nh] || nh}`, o + 6, 1);
  n.add(`Hop Limit: ${hlim}`, o + 7, 1);
  n.add(`Source Address: ${src}`, o + 8, 16);
  n.add(`Destination Address: ${dst}`, o + 24, 16);
  const f = c.r.f;
  if (!f['ipv6.src']) {
    f['ipv6.src'] = src;
    f['ipv6.dst'] = dst;
    f['ipv6.addr'] = [src, dst];
    f['ipv6.hlim'] = hlim;
  }
  c.host(src, dst);
  c.r.src = src;
  c.r.dst = dst;
  c.r.ttl = hlim;
  c.end = Math.min(c.d.length, o + 40 + plen);
  let p = o + 40;
  // Extension headers
  for (let i = 0; i < 8; i++) {
    if (nh === 0 || nh === 43 || nh === 60) {
      const len = (c.u8(p + 1) + 1) * 8;
      n.add(`${{ 0: 'Hop-by-Hop Options', 43: 'Routing Header', 60: 'Destination Options' }[nh]} (${len} bytes)`, p, len);
      nh = c.u8(p);
      p += len;
    } else if (nh === 44) {
      const offFlags = c.u16(p + 2);
      if ((offFlags & 1) || (offFlags >> 3)) c.r.fragmented = true;
      n.add(`Fragment Header, offset ${(offFlags >> 3) * 8}${offFlags & 1 ? ', more fragments' : ''}`, p, 8);
      nh = c.u8(p);
      p += 8;
      if (offFlags >> 3) {
        c.top('IPv6', `IPv6 fragment (next header ${IP_PROTOS[nh] || nh})`);
        return;
      }
    } else if (nh === 51) {
      const len = (c.u8(p + 1) + 2) * 4;
      n.add('Authentication Header', p, len);
      nh = c.u8(p);
      p += len;
    } else break;
  }
  f['ipv6.nxt'] = nh;
  c.top('IPv6', IP_PROTOS[nh] || `Next header ${nh}`, '');
  ipPayload(c, nh, p, c.end, src, dst);
}

function ipPayload(c, proto, o, end, src, dst) {
  switch (proto) {
    case 6:
      return tcp(c, o, end, src, dst);
    case 17:
      return udp(c, o, end, src, dst);
    case 1:
      return icmp(c, o, end, src, dst);
    case 58:
      return icmp6(c, o, end, src, dst);
    case 2:
      return misc.igmp(c, o, end, src, dst);
    case 89:
      return routing.ospf(c, o, end, src, dst);
    case 112:
      return routing.vrrp(c, o, end, src, dst);
    case 47:
      return misc.gre(c, o, end);
    case 4:
      return ipv4(c, o);
    case 41:
      return ipv6(c, o);
    case 50:
      return misc.esp(c, o);
    case 103:
      return routing.pim(c, o);
    case 132:
      return misc.sctp(c, o, end);
    default:
      c.top(IP_PROTOS[proto] || `IP proto ${proto}`, `${IP_PROTOS[proto] || 'Protocol ' + proto} ${src} → ${dst}`);
  }
}

// ---------------------------------------------------------------- ICMP

const ICMP_TYPES = { 0: 'Echo (ping) reply', 3: 'Destination unreachable', 4: 'Source quench', 5: 'Redirect', 8: 'Echo (ping) request', 9: 'Router advertisement', 10: 'Router solicitation', 11: 'Time-to-live exceeded', 12: 'Parameter problem', 13: 'Timestamp request', 14: 'Timestamp reply' };
const UNREACH = { 0: 'Network unreachable', 1: 'Host unreachable', 2: 'Protocol unreachable', 3: 'Port unreachable', 4: 'Fragmentation needed and DF set', 5: 'Source route failed', 6: 'Destination network unknown', 7: 'Destination host unknown', 9: 'Network administratively prohibited', 10: 'Host administratively prohibited', 13: 'Communication administratively prohibited (filtered)' };

function icmp(c, o, end, src, dst) {
  const type = c.u8(o);
  const code = c.u8(o + 1);
  const name = ICMP_TYPES[type] || `Type ${type}`;
  const n = c.layer('icmp', 'Internet Control Message Protocol', o, end - o);
  n.add(`Type: ${type} (${name})`, o, 1);
  n.add(`Code: ${code}${type === 3 && UNREACH[code] ? ' (' + UNREACH[code] + ')' : ''}`, o + 1, 1);
  n.add(`Checksum: 0x${hex4(c.u16(o + 2))}`, o + 2, 2);
  const f = c.r.f;
  f['icmp.type'] = type;
  f['icmp.code'] = code;
  c.r.icmp = { type, code };
  if (type === 0 || type === 8) {
    const id = c.u16(o + 4);
    const seq = c.u16(o + 6);
    n.add(`Identifier: ${id} (0x${hex4(id)})`, o + 4, 2);
    n.add(`Sequence Number: ${seq}`, o + 6, 2);
    n.add(`Data (${end - o - 8} bytes)`, o + 8, end - o - 8);
    f['icmp.ident'] = id;
    f['icmp.seq'] = seq;
    Object.assign(c.r.icmp, { id, seq });
    c.top('ICMP', `${name} id=0x${hex4(id)}, seq=${seq}, ttl=${c.r.ttl}`, 'icmp');
    c.explain(type === 8 ? `${src} is pinging ${dst} (sequence ${seq}).` : `${src} replied to a ping from ${dst} (sequence ${seq}).`);
    return;
  }
  if (type === 3 || type === 11 || type === 12 || type === 5) {
    // The error carries the start of the packet that caused it.
    const inner = o + 8;
    let what = '';
    try {
      const iv = c.u8(inner);
      if (iv >> 4 === 4) {
        const ihl = (iv & 15) * 4;
        const p = c.u8(inner + 9);
        const isrc = c.ip4(inner + 12);
        const idst = c.ip4(inner + 16);
        let ports = '';
        if (p === 6 || p === 17) ports = `${IP_PROTOS[p]} ${isrc}:${c.u16(inner + ihl)} → ${idst}:${c.u16(inner + ihl + 2)}`;
        else ports = `${IP_PROTOS[p] || p} ${isrc} → ${idst}`;
        what = ports;
        n.add(`Original packet: ${ports}`, inner, Math.min(end, inner + ihl + 8) - inner);
        c.r.icmp.orig = { proto: p, src: isrc, dst: idst, sport: p === 6 || p === 17 ? c.u16(inner + ihl) : null, dport: p === 6 || p === 17 ? c.u16(inner + ihl + 2) : null };
      }
    } catch {}
    const detail = type === 3 ? UNREACH[code] || `code ${code}` : type === 11 ? (code === 0 ? 'TTL expired in transit' : 'Fragment reassembly time exceeded') : '';
    c.top('ICMP', `${name}${detail ? ' (' + detail + ')' : ''}${what ? ' for ' + what : ''}`, type === 11 ? 'warn' : 'bad');
    if (type === 3) c.explain(`${src} reports that ${what || 'a packet'} could not be delivered: ${detail || 'unreachable'}.${code === 3 ? ' Nothing is listening on that port.' : code === 13 || code === 9 || code === 10 ? ' A firewall or ACL is blocking it.' : ''}`);
    else if (type === 11) c.explain(`${src} dropped ${what || 'a packet'} because its TTL ran out. This is what traceroute relies on; in normal traffic it can mean a routing loop.`);
    return;
  }
  c.top('ICMP', name, 'icmp');
}

const ICMP6_TYPES = { 1: 'Destination unreachable', 2: 'Packet too big', 3: 'Time exceeded', 4: 'Parameter problem', 128: 'Echo (ping) request', 129: 'Echo (ping) reply', 130: 'Multicast listener query', 131: 'Multicast listener report', 132: 'Multicast listener done', 133: 'Router solicitation', 134: 'Router advertisement', 135: 'Neighbor solicitation', 136: 'Neighbor advertisement', 137: 'Redirect', 143: 'Multicast listener report v2' };

function icmp6(c, o, end, src, dst) {
  const type = c.u8(o);
  const code = c.u8(o + 1);
  const name = ICMP6_TYPES[type] || `Type ${type}`;
  const n = c.layer('icmpv6', 'Internet Control Message Protocol v6', o, end - o);
  n.add(`Type: ${name} (${type})`, o, 1);
  n.add(`Code: ${code}`, o + 1, 1);
  c.r.f['icmpv6.type'] = type;
  c.r.f['icmpv6.code'] = code;
  let info = name;
  if (type === 128 || type === 129) {
    const id = c.u16(o + 4);
    const seq = c.u16(o + 6);
    info = `${name} id=0x${hex4(id)}, seq=${seq}, hop limit=${c.r.ttl}`;
    c.explain(type === 128 ? `${src} is pinging ${dst} over IPv6.` : `${src} replied to an IPv6 ping.`);
  } else if (type === 135 || type === 136) {
    const target = c.ip6(o + 8);
    n.add(`Target Address: ${target}`, o + 8, 16);
    c.r.f['icmpv6.nd.target'] = target;
    info = type === 135 ? `Neighbor Solicitation for ${target}` : `Neighbor Advertisement ${target}`;
    c.explain(type === 135 ? `${src} is asking for the MAC address of ${target} (IPv6's version of ARP).` : `${src} announces where ${target} can be reached.`);
  } else if (type === 134) {
    info = `Router Advertisement from ${src}`;
    c.explain(`${src} is advertising itself as an IPv6 router and sharing prefix information.`);
  } else if (type === 133) {
    info = 'Router Solicitation';
  }
  c.top('ICMPv6', info, type < 128 ? 'bad' : 'icmp');
}

// ---------------------------------------------------------------- TCP

const TCP_FLAGS = [
  [0x100, 'NS'],
  [0x80, 'CWR'],
  [0x40, 'ECE'],
  [0x20, 'URG'],
  [0x10, 'ACK'],
  [0x08, 'PSH'],
  [0x04, 'RST'],
  [0x02, 'SYN'],
  [0x01, 'FIN'],
];

export function tcpFlagStr(flags) {
  const order = ['FIN', 'SYN', 'RST', 'PSH', 'ACK', 'URG', 'ECE', 'CWR', 'NS'];
  const set = TCP_FLAGS.filter(([b]) => flags & b).map(([, n]) => n);
  return order.filter((x) => set.includes(x)).join(', ');
}

/** Wireshark-style TCP info. rel = {seq, ack} relative numbers when known. */
export function tcpInfoText(t, rel) {
  const seq = rel ? rel.seq : t.seq;
  const ack = rel ? rel.ack : t.ack;
  let s = `${t.sport} → ${t.dport} [${tcpFlagStr(t.flags)}] Seq=${seq}`;
  if (t.flags & 0x10) s += ` Ack=${ack}`;
  s += ` Win=${t.win} Len=${t.plen}`;
  if (t.mss) s += ` MSS=${t.mss}`;
  if (t.wscale != null) s += ` WS=${2 ** t.wscale}`;
  if (t.sackPerm) s += ' SACK_PERM';
  return s;
}

function tcp(c, o, end, src, dst) {
  const sport = c.u16(o);
  const dport = c.u16(o + 2);
  const seq = c.u32(o + 4);
  const ack = c.u32(o + 8);
  const hl = (c.u8(o + 12) >> 4) * 4;
  const flags = c.u16(o + 12) & 0x1ff;
  const win = c.u16(o + 14);
  if (hl < 20) throw new Truncated();
  c.need(o, hl);
  const t = { sport, dport, seq, ack, flags, win, hl, plen: Math.max(0, end - o - hl), mss: null, wscale: null, sackPerm: false, sack: null, ts: null };
  const n = c.layer('tcp', `Transmission Control Protocol, Src Port: ${sport}, Dst Port: ${dport}, Seq: ${seq}, Len: ${t.plen}`, o, hl);
  n.add(`Source Port: ${svc(sport)}`, o, 2);
  n.add(`Destination Port: ${svc(dport)}`, o + 2, 2);
  n.add(`Sequence Number (raw): ${seq}`, o + 4, 4);
  n.add(`Acknowledgment Number (raw): ${ack}`, o + 8, 4);
  n.add(`Header Length: ${hl} bytes`, o + 12, 1);
  const fl = n.add(`Flags: 0x${flags.toString(16).padStart(3, '0')} (${tcpFlagStr(flags) || 'none'})`, o + 12, 2);
  for (const [bit, name] of TCP_FLAGS) fl.add(`${name}: ${flags & bit ? 'Set' : 'Not set'}`, o + 13, 1);
  n.add(`Window: ${win}`, o + 14, 2);
  n.add(`Checksum: 0x${hex4(c.u16(o + 16))}`, o + 16, 2);
  // Options
  if (hl > 20) {
    const on = n.add(`Options: (${hl - 20} bytes)`, o + 20, hl - 20);
    let p = o + 20;
    while (p < o + hl) {
      const kind = c.u8(p);
      if (kind === 0) break;
      if (kind === 1) {
        p++;
        continue;
      }
      const len = c.u8(p + 1);
      if (len < 2) break;
      if (kind === 2) {
        t.mss = c.u16(p + 2);
        on.add(`Maximum segment size: ${t.mss} bytes`, p, len);
      } else if (kind === 3) {
        t.wscale = c.u8(p + 2);
        on.add(`Window scale: ${t.wscale} (multiply by ${2 ** t.wscale})`, p, len);
      } else if (kind === 4) {
        t.sackPerm = true;
        on.add('SACK permitted', p, len);
      } else if (kind === 5) {
        t.sack = [];
        for (let q = p + 2; q + 8 <= p + len; q += 8) t.sack.push([c.u32(q), c.u32(q + 4)]);
        on.add(`SACK: ${t.sack.map(([a, b]) => `${a}-${b}`).join(' ')}`, p, len);
      } else if (kind === 8) {
        t.ts = [c.u32(p + 2), c.u32(p + 6)];
        on.add(`Timestamps: TSval ${t.ts[0]}, TSecr ${t.ts[1]}`, p, len);
      } else on.add(`Option kind ${kind} (${len} bytes)`, p, len);
      p += len;
    }
  }
  if (t.plen > 0) n.add(`TCP payload (${t.plen} bytes)`, o + hl, t.plen);
  const f = c.r.f;
  f['tcp.srcport'] = sport;
  f['tcp.dstport'] = dport;
  f['tcp.port'] = [sport, dport];
  f.port = [sport, dport];
  f['tcp.seq_raw'] = seq;
  f['tcp.ack_raw'] = ack;
  f['tcp.len'] = t.plen;
  f['tcp.window_size_value'] = win;
  f['tcp.flags'] = flags;
  f['tcp.flags.syn'] = !!(flags & 2);
  f['tcp.flags.ack'] = !!(flags & 0x10);
  f['tcp.flags.fin'] = !!(flags & 1);
  f['tcp.flags.reset'] = !!(flags & 4);
  f['tcp.flags.rst'] = !!(flags & 4);
  f['tcp.flags.push'] = !!(flags & 8);
  f['tcp.flags.urg'] = !!(flags & 0x20);
  if (t.mss) f['tcp.options.mss'] = t.mss;
  c.r.tcp = t;
  c.r.sport = sport;
  c.r.dport = dport;
  c.r.payloadOff = o + hl;
  c.r.payloadLen = t.plen;
  const syn = flags & 2;
  const isAck = flags & 0x10;
  const rst = flags & 4;
  const fin = flags & 1;
  c.top('TCP', tcpInfoText(t), rst ? 'bad' : syn || fin ? 'tcpctl' : 'tcp');
  const svcName = SERVICES[dport] || SERVICES[sport];
  if (syn && !isAck) c.explain(`${src} is opening a TCP connection to ${dst} on port ${svc(dport)}.`);
  else if (syn && isAck) c.explain(`${src} accepted the connection from ${dst} (SYN/ACK, step 2 of the handshake).`);
  else if (rst) c.explain(`${src} reset the connection with ${dst}. Usually the port is closed, a firewall rejected it, or an application aborted.`);
  else if (fin) c.explain(`${src} is closing its side of the connection to ${dst}.`);
  else if (t.plen) c.explain(`${src} sent ${t.plen} bytes of ${svcName || 'TCP'} data to ${dst}.`);
  else c.explain(`${src} acknowledged data from ${dst}.`);
  if (t.plen > 0) tcpApp(c, o + hl, end, sport, dport, src, dst);
}

function tcpApp(c, o, end, sp, dp, src, dst) {
  const has = (...ports) => ports.some((p) => p === sp || p === dp);
  const d = c.d;
  const len = end - o;
  const startsWith = (s) => len >= s.length && c.text(o, o + s.length) === s;
  if (has(179) && len >= 19 && d.subarray(o, o + 16).every((b) => b === 0xff)) return routing.bgp(c, o, end);
  if (looksTls(d, o, end)) return misc.tls(c, o, end, src, dst);
  if (startsWith('SSH-') || (has(22) && len >= 6)) return misc.ssh(c, o, end, sp, dp);
  if (/^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE) /.test(c.text(o, end, 10)) || startsWith('HTTP/1.')) return misc.http(c, o, end, src, dst, 'HTTP');
  if (has(53) && len > 14) return misc.dns(c, o + 2, end, 'DNS', src, dst);
  if (has(445, 139) && len >= 8 && ((d[o + 4] === 0xfe && d[o + 5] === 0x53) || (d[o + 4] === 0xff && d[o + 5] === 0x53))) return misc.smb(c, o, end);
  if (has(49)) return misc.tacacs(c, o, end);
  if (has(3389) && d[o] === 3 && d[o + 1] === 0) return c.top('RDP', `RDP (TPKT, ${len} bytes)`, 'tcp');
  if (has(21, 25, 587, 110, 143, 23)) return misc.textProto(c, o, end, sp, dp, src, dst);
  if (has(80, 8080, 8000)) return c.top('HTTP', `Continuation (${len} bytes)`, 'http');
}

export function looksTls(d, o, end) {
  return end - o >= 5 && d[o] >= 20 && d[o] <= 23 && d[o + 1] === 3 && d[o + 2] <= 4;
}

// ---------------------------------------------------------------- UDP

function udp(c, o, end, src, dst) {
  const sport = c.u16(o);
  const dport = c.u16(o + 2);
  const ulen = c.u16(o + 4);
  const pend = Math.min(end, o + Math.max(8, ulen));
  const plen = Math.max(0, pend - o - 8);
  const n = c.layer('udp', `User Datagram Protocol, Src Port: ${sport}, Dst Port: ${dport}`, o, 8);
  n.add(`Source Port: ${svc(sport)}`, o, 2);
  n.add(`Destination Port: ${svc(dport)}`, o + 2, 2);
  n.add(`Length: ${ulen}`, o + 4, 2);
  n.add(`Checksum: 0x${hex4(c.u16(o + 6))}`, o + 6, 2);
  if (plen) n.add(`UDP payload (${plen} bytes)`, o + 8, plen);
  const f = c.r.f;
  f['udp.srcport'] = sport;
  f['udp.dstport'] = dport;
  f['udp.port'] = [sport, dport];
  f.port = [sport, dport];
  f['udp.length'] = ulen;
  c.r.udp = { sport, dport, plen };
  c.r.sport = sport;
  c.r.dport = dport;
  c.r.payloadOff = o + 8;
  c.r.payloadLen = plen;
  c.top('UDP', `${sport} → ${dport} Len=${plen}`, 'udp');
  c.explain(`${src} sent a ${plen}-byte UDP datagram to ${dst} port ${svc(dport)}.`);
  if (plen > 0) udpApp(c, o + 8, pend, sport, dport, src, dst);
}

function udpApp(c, o, end, sp, dp, src, dst) {
  const has = (...ports) => ports.some((p) => p === sp || p === dp);
  const len = end - o;
  if (has(53)) return misc.dns(c, o, end, 'DNS', src, dst);
  if (has(5353)) return misc.dns(c, o, end, 'mDNS', src, dst);
  if (has(5355)) return misc.dns(c, o, end, 'LLMNR', src, dst);
  if (has(67, 68) && len >= 240) return misc.dhcp(c, o, end, src, dst);
  if (has(546, 547)) return misc.dhcpv6(c, o, end);
  if (has(123) && len >= 48) return misc.ntp(c, o, end, src, dst);
  if (has(161, 162)) return misc.snmp(c, o, end, src, dst, sp, dp);
  if (has(514)) return misc.syslog(c, o, end, src);
  if (has(1900)) return misc.http(c, o, end, src, dst, 'SSDP');
  if (has(5060)) return misc.sip(c, o, end);
  if (has(137)) return misc.nbns(c, o, end);
  if (has(69)) return misc.tftp(c, o, end);
  if (has(4789) && len >= 8) return misc.vxlan(c, o, end);
  if (has(1985, 2029)) return routing.hsrp(c, o, end, src);
  if (has(1812, 1813, 1645, 1646)) return misc.radius(c, o, end);
  if (has(500, 4500)) return misc.isakmp(c, o, end, has(4500));
  if (has(3478, 19302)) return misc.stun(c, o, end);
  if (has(2055, 9995, 9996, 4739)) return misc.netflow(c, o, end);
  if (has(6343)) return c.top('sFlow', `sFlow v${c.u32(o)}`, 'udp');
  if (has(443, 8443) && len > 5) return misc.quic(c, o, end);
}
