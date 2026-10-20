// Byte-accurate packet builders for tests and the sample capture.

/** Join byte arrays: Uint8Arrays, plain number arrays, or lists of either. */
export const concat = (...parts) => {
  const arrs = [];
  const add = (p) => {
    if (p instanceof Uint8Array) arrs.push(p);
    else if (Array.isArray(p)) {
      if (p.length && typeof p[0] !== 'number') p.forEach(add);
      else arrs.push(Uint8Array.from(p));
    } else if (typeof p === 'number') arrs.push(Uint8Array.of(p));
  };
  parts.forEach(add);
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
export const u16 = (v) => [(v >> 8) & 255, v & 255];
export const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
export const str = (s) => Array.from(new TextEncoder().encode(s));
export const mac = (s) => s.split(/[:-]/).map((x) => parseInt(x, 16));
export const ip = (s) => s.split('.').map(Number);

function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) | (bytes[i + 1] || 0);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

export function eth(dst, src, type, payload, vlan) {
  const tag = vlan != null ? [0x81, 0x00, ...u16(vlan)] : [];
  return concat(mac(dst), mac(src), tag, u16(type), payload);
}

/** 802.3 frame with LLC header (used by STP and CDP). */
export function dot3(dst, src, llc, payload) {
  const body = concat(llc, payload);
  return concat(mac(dst), mac(src), u16(body.length), body);
}

export function ipv4({ src, dst, proto, ttl = 64, id = 0x1234, df = true }, payload) {
  const tot = 20 + payload.length;
  const h = [0x45, 0, ...u16(tot), ...u16(id), df ? 0x40 : 0, 0, ttl, proto, 0, 0, ...ip(src), ...ip(dst)];
  const c = checksum(h);
  h[10] = c >> 8;
  h[11] = c & 255;
  return concat(h, payload);
}

export function tcp({ sport, dport, seq = 0, ack = 0, flags = 'A', win = 64240, mss, ws }, payload = []) {
  const F = { F: 1, S: 2, R: 4, P: 8, A: 16 };
  let fl = 0;
  for (const ch of flags) fl |= F[ch] || 0;
  const opts = [];
  if (mss) opts.push(2, 4, ...u16(mss));
  if (ws != null) opts.push(1, 3, 3, ws);
  while (opts.length % 4) opts.push(1);
  const hl = 20 + opts.length;
  return concat([...u16(sport), ...u16(dport), ...u32(seq), ...u32(ack), (hl / 4) << 4, fl, ...u16(win), 0, 0, 0, 0], opts, payload);
}

export function udp({ sport, dport }, payload = []) {
  return concat([...u16(sport), ...u16(dport), ...u16(8 + payload.length), 0, 0], payload);
}

const ETH_IP = 0x0800;
export const frame = {
  tcp: (m1, m2, src, dst, t, payload, extra = {}) => eth(m2, m1, ETH_IP, ipv4({ src, dst, proto: 6, ...extra }, tcp(t, payload)), extra.vlan),
  udp: (m1, m2, src, dst, u, payload, extra = {}) => eth(m2, m1, ETH_IP, ipv4({ src, dst, proto: 17, ...extra }, udp(u, payload)), extra.vlan),
};

// ---------------------------------------------------------------- application payloads

function dnsName(name) {
  const out = [];
  for (const l of name.split('.')) out.push(l.length, ...str(l));
  out.push(0);
  return out;
}
const TYPE = { A: 1, NS: 2, CNAME: 5, PTR: 12, MX: 15, TXT: 16, AAAA: 28 };

export function dns({ id, name, type = 'A', response = false, rcode = 0, answers = [] }) {
  const flags = response ? 0x8180 | rcode : 0x0100;
  const q = [...dnsName(name), ...u16(TYPE[type]), 0, 1];
  const ans = [];
  for (const a of answers) {
    let rdata;
    if (a.type === 'A') rdata = ip(a.data);
    else if (a.type === 'CNAME') rdata = dnsName(a.data);
    else rdata = str(a.data);
    ans.push(0xc0, 0x0c, ...u16(TYPE[a.type]), 0, 1, ...u32(a.ttl ?? 300), ...u16(rdata.length), ...rdata);
  }
  return concat([...u16(id), ...u16(flags), 0, 1, ...u16(answers.length), 0, 0, 0, 0], q, ans);
}

export function arp(op, sha, spa, tha, tpa) {
  return concat([0, 1, 8, 0, 6, 4, ...u16(op)], mac(sha), ip(spa), mac(tha), ip(tpa));
}

export function dhcp({ op = 1, type, xid, chaddr, ciaddr = '0.0.0.0', yiaddr = '0.0.0.0', server, requested, router, dnsServers, hostname, lease, mask }) {
  const fixed = new Uint8Array(236);
  fixed[0] = op;
  fixed[1] = 1;
  fixed[2] = 6;
  fixed.set(u32(xid), 4);
  fixed.set(ip(ciaddr), 12);
  fixed.set(ip(yiaddr), 16);
  fixed.set(mac(chaddr), 28);
  const opts = [0x63, 0x82, 0x53, 0x63, 53, 1, type];
  if (server) opts.push(54, 4, ...ip(server));
  if (requested) opts.push(50, 4, ...ip(requested));
  if (lease) opts.push(51, 4, ...u32(lease));
  if (mask) opts.push(1, 4, ...ip(mask));
  if (router) opts.push(3, 4, ...ip(router));
  if (dnsServers) opts.push(6, 4 * dnsServers.length, ...dnsServers.flatMap(ip));
  if (hostname) opts.push(12, hostname.length, ...str(hostname));
  opts.push(255);
  return concat(fixed, opts);
}

export function tlsClientHello(sni, alpn = ['h2', 'http/1.1']) {
  const sniExt = [...u16(0), ...u16(sni.length + 5), ...u16(sni.length + 3), 0, ...u16(sni.length), ...str(sni)];
  const alpnList = alpn.flatMap((p) => [p.length, ...str(p)]);
  const alpnExt = [...u16(16), ...u16(alpnList.length + 2), ...u16(alpnList.length), ...alpnList];
  const svExt = [...u16(43), ...u16(5), 4, 0x03, 0x04, 0x03, 0x03];
  const exts = [...sniExt, ...alpnExt, ...svExt];
  const body = [0x03, 0x03, ...new Array(32).fill(7), 0, ...u16(6), 0x13, 0x01, 0x13, 0x02, 0xc0, 0x2f, 1, 0, ...u16(exts.length), ...exts];
  const hs = [1, 0, ...u16(body.length), ...body];
  return concat([22, 3, 1, ...u16(hs.length)], hs);
}

export function tlsServerHello(cipher = 0x1301) {
  const exts = [...u16(43), ...u16(2), 0x03, 0x04];
  const body = [0x03, 0x03, ...new Array(32).fill(9), 0, ...u16(cipher), 0, ...u16(exts.length), ...exts];
  const hs = [2, 0, ...u16(body.length), ...body];
  return concat([22, 3, 3, ...u16(hs.length)], hs, [20, 3, 3, 0, 1, 1], [23, 3, 3, 0, 20], new Array(20).fill(0xaa));
}

export const tlsAppData = (n) => concat([23, 3, 3, ...u16(n)], new Array(n).fill(0x5c));
export const tlsAlert = (desc) => concat([21, 3, 3, 0, 2, 2, desc]);

// SNMP v2c get-request: community + one OID with NULL value
export function snmpGet(community, oid, reqId = 4242, pduTag = 0xa0, value = [0x05, 0x00]) {
  const tlv = (tag, bytes) => {
    const b = Array.from(bytes);
    return b.length < 128 ? [tag, b.length, ...b] : [tag, 0x81, b.length, ...b];
  };
  const parts = oid.split('.').map(Number);
  const enc = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = p >> 7;
    while (v) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    enc.push(...stack);
  }
  const vb = tlv(0x30, [...tlv(0x06, enc), ...value]);
  const pdu = tlv(pduTag, [...tlv(0x02, u32(reqId).slice(2)), ...tlv(0x02, [0]), ...tlv(0x02, [0]), ...tlv(0x30, vb)]);
  return concat(tlv(0x30, [...tlv(0x02, [1]), ...tlv(0x04, str(community)), ...pdu]));
}

export function lldp({ chassisMac, port, sysName, sysDesc, mgmt, vlan, portDesc }) {
  const tlv = (type, val) => [((type << 1) | (val.length >> 8)) & 0xff, val.length & 0xff, ...val];
  return concat(
    tlv(1, [4, ...mac(chassisMac)]),
    tlv(2, [5, ...str(port)]),
    tlv(3, u16(120)),
    portDesc ? tlv(4, str(portDesc)) : [],
    tlv(5, str(sysName)),
    tlv(6, str(sysDesc)),
    tlv(7, [0, 0x14, 0, 0x14]),
    mgmt ? tlv(8, [5, 1, ...ip(mgmt), 2, 0, 0, 0, 1, 0]) : [],
    vlan ? tlv(127, [0x00, 0x80, 0xc2, 1, ...u16(vlan)]) : [],
    [0, 0]
  );
}

export function cdp({ device, port, platform, software, address, nativeVlan }) {
  const tlv = (type, val) => [...u16(type), ...u16(val.length + 4), ...val];
  const addr = [...u32(1), 1, 1, 0xcc, ...u16(4), ...ip(address)];
  return concat([2, 180, 0, 0], tlv(1, str(device)), tlv(2, addr), tlv(3, str(port)), tlv(4, u32(0x28)), tlv(5, str(software)), tlv(6, str(platform)), tlv(0x0a, u16(nativeVlan)), tlv(0x0b, [1]));
}

export function rstpBpdu({ rootPrio = 24576, rootMac, cost = 4, bridgePrio = 32768, bridgeMac, tc = false }) {
  return concat([0, 0, 2, 2, (tc ? 1 : 0) | 0x3c], u16(rootPrio), mac(rootMac), u32(cost), u16(bridgePrio), mac(bridgeMac), u16(0x8001), u16(256), u16(20 * 256), u16(2 * 256), u16(15 * 256), [0]);
}

export function icmpEcho(type, id, seq) {
  const data = new Array(32).fill(0x61);
  const b = [type, 0, 0, 0, ...u16(id), ...u16(seq), ...data];
  const c = checksum(b);
  b[2] = c >> 8;
  b[3] = c & 255;
  return concat(b);
}

export function icmpUnreachable(code, origIpPacket) {
  return concat([3, code, 0, 0, 0, 0, 0, 0], origIpPacket.slice(0, 28));
}

export function ospfHello({ rid, area = '0.0.0.0', mask = '255.255.255.0', dr, neighbors = [] }) {
  const body = [...ip(mask), ...u16(10), 0x02, 1, ...u32(40), ...ip(dr), ...ip('0.0.0.0'), ...neighbors.flatMap(ip)];
  const len = 24 + body.length;
  return concat([2, 1, ...u16(len), ...ip(rid), ...ip(area), 0, 0, 0, 0, ...new Array(8).fill(0)], body);
}

export function hsrpHello({ state = 16, prio = 110, group = 1, vip, auth = 'cisco' }) {
  const a = str(auth).concat(new Array(8).fill(0)).slice(0, 8);
  return concat([0, 0, state, 3, 10, prio, group, 0], a, ip(vip));
}

export function ntp(mode, stratum = 2) {
  const b = new Uint8Array(48);
  b[0] = (0 << 6) | (4 << 3) | mode;
  b[1] = stratum;
  b.set(ip('10.0.0.1'), 12);
  b.set(u32(3999999999), 40);
  return b;
}
