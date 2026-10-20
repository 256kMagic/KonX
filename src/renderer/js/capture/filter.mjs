// Display filters. Wireshark-style expressions plus friendlier shorthand:
//   ip.addr == 10.0.0.1 && tcp.port == 443      dns.qry.name contains "google"
//   host 10.0.0.1      src host 10.0.0.1      port 443      port 8000-8100
//   net 10.0.0.0/24    vlan 20                "free text"   tcp and not port 22
//   retrans  errors  syn  rst  broadcast  multicast  (analyzer / convenience keywords)
// compileFilter(text) -> { test(pkt) } or throws Error with a readable message.

const OPS = new Map([
  ['==', 'eq'], ['eq', 'eq'], ['=', 'eq'], ['!=', 'ne'], ['ne', 'ne'], ['>', 'gt'], ['gt', 'gt'], ['<', 'lt'], ['lt', 'lt'],
  ['>=', 'ge'], ['ge', 'ge'], ['<=', 'le'], ['le', 'le'], ['contains', 'contains'], ['matches', 'matches'], ['~', 'matches'],
]);

// Single words accepted as "packet has this protocol / flag".
const PROTOCOLS = new Set([
  'eth', 'vlan', 'llc', 'arp', 'ip', 'ipv6', 'icmp', 'icmpv6', 'igmp', 'tcp', 'udp', 'sctp', 'dns', 'mdns', 'llmnr', 'dhcp', 'bootp', 'dhcpv6',
  'http', 'ssdp', 'tls', 'ssh', 'ntp', 'snmp', 'syslog', 'sip', 'nbns', 'tftp', 'vxlan', 'radius', 'isakmp', 'stun', 'quic', 'smb', 'smb2',
  'ftp', 'telnet', 'smtp', 'pop', 'imap', 'tacplus', 'lldp', 'cdp', 'stp', 'lacp', 'eapol', 'ospf', 'bgp', 'vrrp', 'hsrp', 'pim', 'gre',
  'erspan', 'esp', 'mpls', 'pppoe', 'cflow', 'null', 'sll', 'malformed',
]);
const ALIASES = { ssl: 'tls', icmp6: 'icmpv6', 'tacacs': 'tacplus', 'rstp': 'stp', 'netflow': 'cflow', ip4: 'ip', ipv4: 'ip', vlan: 'vlan.id' };
const KEYWORDS = new Set(['retrans', 'retransmission', 'dupack', 'zerowindow', 'errors', 'error', 'warnings', 'syn', 'rst', 'fin', 'broadcast', 'multicast', 'expert']);

function tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      toks.push({ t: ch });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let v = '';
      while (j < s.length && s[j] !== ch) {
        if (s[j] === '\\' && j + 1 < s.length) j++;
        v += s[j++];
      }
      if (j >= s.length) throw new Error('Unterminated string');
      toks.push({ t: 'str', v });
      i = j + 1;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
      toks.push({ t: two === '&&' ? 'and' : two === '||' ? 'or' : 'op', v: two });
      i += 2;
      continue;
    }
    // A lone boolean operator must fail validation; otherwise the word scanner
    // below stops at this same character forever (including on every input event).
    if (ch === '&' || ch === '|') throw new Error(`Unexpected operator "${ch}"; use "${ch + ch}"`);
    if ('<>=~!'.includes(ch)) {
      toks.push(ch === '!' ? { t: 'not' } : { t: 'op', v: ch });
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && !/[\s()"'=!<>~&|]/.test(s[j])) j++;
    // keep IPv6 "::" and MAC ":" inside words
    const w = s.slice(i, j);
    const lw = w.toLowerCase();
    if (lw === 'and') toks.push({ t: 'and' });
    else if (lw === 'or') toks.push({ t: 'or' });
    else if (lw === 'not') toks.push({ t: 'not' });
    else if (OPS.has(lw)) toks.push({ t: 'op', v: lw });
    else toks.push({ t: 'word', v: w });
    i = j;
  }
  return toks;
}

// ---------------------------------------------------------------- value helpers

function ipToInt(s) {
  const p = String(s).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || +x > 255) return null;
    n = n * 256 + +x;
  }
  return n;
}

function cidrMatcher(cidr) {
  const match = /^([^/]+)\/(\d{1,2})$/.exec(cidr);
  if (!match) return null;
  const [, base, bitsS] = match;
  const bits = Number(bitsS);
  const b = ipToInt(base);
  if (b === null || !Number.isInteger(bits) || !(bits >= 0 && bits <= 32)) return null;
  const size = 2 ** (32 - bits);
  const net = Math.floor(b / size);
  return (v) => {
    const n = ipToInt(v);
    return n !== null && Math.floor(n / size) === net;
  };
}

const normMac = (s) => String(s).toLowerCase().replace(/-/g, ':');

function eqValue(actual, want) {
  if (actual == null) return false;
  if (typeof actual === 'boolean') return actual === (want === 'true' || want === '1' || want === 'yes');
  if (typeof actual === 'number') {
    const n = parseNum(want);
    return n !== null && actual === n;
  }
  const a = String(actual).toLowerCase();
  const w = String(want).toLowerCase();
  if (a === w) return true;
  if (/^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i.test(w)) return normMac(a) === normMac(w);
  return false;
}

function parseNum(v) {
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return null;
}

function cmp(op, actual, want) {
  const vals = Array.isArray(actual) ? actual : [actual];
  if (op === 'ne') return !vals.some((a) => cmp('eq', a, want));
  return vals.some((a) => {
    if (a == null) return false;
    switch (op) {
      case 'eq': {
        if (String(want).includes('/') && ipToInt(String(want).split('/')[0]) !== null) {
          const m = cidrMatcher(String(want));
          return m ? m(a) : false;
        }
        return eqValue(a, want);
      }
      case 'gt':
      case 'lt':
      case 'ge':
      case 'le': {
        const x = typeof a === 'number' ? a : parseNum(a);
        const y = parseNum(want);
        if (x === null || y === null) return false;
        return op === 'gt' ? x > y : op === 'lt' ? x < y : op === 'ge' ? x >= y : x <= y;
      }
      case 'contains':
        return String(a).toLowerCase().includes(String(want).toLowerCase());
      case 'matches':
        try {
          return new RegExp(want, 'i').test(String(a));
        } catch {
          return false;
        }
      default:
        return false;
    }
  });
}

// ---------------------------------------------------------------- field access

/** Field lookup across decoder fields, analyzer annotations and frame data. */
export function fieldValue(pkt, name) {
  const d = pkt.d;
  const a = pkt.ann || {};
  switch (name) {
    case 'frame.number':
    case 'frame.no':
      return pkt.no;
    case 'frame.len':
      return pkt.len;
    case 'frame.cap_len':
      return pkt.caplen;
    case 'frame.time_relative':
      return pkt.rel;
    case 'proto':
    case 'frame.protocols':
      return d.layers;
    case 'info':
      return d.info;
    case 'src':
      return d.src;
    case 'dst':
      return d.dst;
    case 'addr':
    case 'host':
      return d.f.hosts;
    case 'tcp.stream':
      return d.tcp ? a.stream : undefined;
    case 'udp.stream':
      return d.udp ? a.stream : undefined;
    case 'stream':
      return a.stream;
    case 'tcp.seq':
      return a.relSeq;
    case 'tcp.ack':
      return a.relAck;
    case 'tcp.analysis.retransmission':
      return !!(a.flags && a.flags.includes('retrans'));
    case 'tcp.analysis.duplicate_ack':
      return !!(a.flags && a.flags.includes('dupack'));
    case 'tcp.analysis.zero_window':
      return !!(a.flags && a.flags.includes('zerowin'));
    case 'tcp.analysis.keep_alive':
      return !!(a.flags && a.flags.includes('keepalive'));
    case 'tcp.analysis.out_of_order':
      return !!(a.flags && a.flags.includes('outoforder'));
    case 'tcp.analysis.lost_segment':
      return !!(a.flags && a.flags.includes('lost'));
    case 'tcp.analysis.flags':
      return !!(a.flags && a.flags.length);
    case 'tcp.analysis.initial_rtt':
      return a.handshakeRtt;
    case 'dns.time':
      return a.dnsTime;
    case 'expert':
      return !!(a.expert && a.expert.length);
    default:
      return d.f[name];
  }
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ---------------------------------------------------------------- parser

export function compileFilter(text) {
  const src = String(text || '').trim();
  if (!src) return null;
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const expectValue = (what) => {
    const t = next();
    if (!t || (t.t !== 'word' && t.t !== 'str')) throw new Error(`Expected ${what}`);
    return t.v;
  };

  const parseOr = () => {
    let left = parseAnd();
    while (peek() && peek().t === 'or') {
      next();
      const right = parseAnd();
      const l = left;
      left = (p) => l(p) || right(p);
    }
    return left;
  };
  const parseAnd = () => {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (!t || t.t === 'or' || t.t === ')') break;
      if (t.t === 'and') next();
      const right = parseUnary();
      const l = left;
      left = (p) => l(p) && right(p);
    }
    return left;
  };
  const parseUnary = () => {
    const t = peek();
    if (t && t.t === 'not') {
      next();
      const inner = parseUnary();
      return (p) => !inner(p);
    }
    return parsePrimary();
  };

  const hostTest = (v, which) => {
    const isCidr = v.includes('/');
    const m = isCidr ? cidrMatcher(v) : null;
    if (isCidr && !m) throw new Error(`Bad network "${v}"`);
    const match = (x) => (x == null ? false : m ? m(x) : eqValue(x, v));
    if (which === 'src') return (p) => match(p.d.f['ip.src'] ?? p.d.f['ipv6.src'] ?? p.d.f['arp.src.proto_ipv4']) || match(p.d.f['eth.src']);
    if (which === 'dst') return (p) => match(p.d.f['ip.dst'] ?? p.d.f['ipv6.dst'] ?? p.d.f['arp.dst.proto_ipv4']) || match(p.d.f['eth.dst']);
    return (p) => p.d.f.hosts.some(match);
  };
  const portTest = (v, which) => {
    const m = v.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Bad port "${v}"`);
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    if (lo > 65535 || hi > 65535 || hi < lo) throw new Error(`Bad port "${v}" (use 0–65535 or an ascending range)`);
    const inR = (x) => x != null && x >= lo && x <= hi;
    if (which === 'src') return (p) => inR(p.d.sport);
    if (which === 'dst') return (p) => inR(p.d.dport);
    return (p) => inR(p.d.sport) || inR(p.d.dport);
  };

  const parsePrimary = () => {
    const t = next();
    if (!t) throw new Error('Filter ends too early');
    if (t.t === '(') {
      const e = parseOr();
      const c = next();
      if (!c || c.t !== ')') throw new Error('Missing )');
      return e;
    }
    if (t.t === 'str') {
      const needle = t.v.toLowerCase();
      return (p) => (p.d.info || '').toLowerCase().includes(needle) || (p.d.src || '').toLowerCase().includes(needle) || (p.d.dst || '').toLowerCase().includes(needle) || p.d.proto.toLowerCase() === needle;
    }
    if (t.t !== 'word') throw new Error(`Unexpected "${t.v || t.t}"`);
    const w = t.v;
    const lw = w.toLowerCase();

    // tcpdump-style primitives
    if (lw === 'host') return hostTest(expectValue('an address after "host"'));
    if (lw === 'net') {
      const v = expectValue('a network after "net"');
      if (!v.includes('/')) throw new Error('Use CIDR notation, e.g. net 10.0.0.0/24');
      return hostTest(v);
    }
    if (lw === 'port') return portTest(expectValue('a port after "port"'));
    if (lw === 'vlan' && peek() && peek().t === 'word') {
      const v = Number(expectValue('a VLAN ID'));
      return (p) => p.d.f['vlan.id'] === v || p.d.f['vlan.inner'] === v;
    }
    if (lw === 'src' || lw === 'dst') {
      const t2 = peek();
      if (t2 && t2.t === 'word' && t2.v.toLowerCase() === 'port') {
        next();
        return portTest(expectValue('a port'), lw);
      }
      if (t2 && t2.t === 'word' && t2.v.toLowerCase() === 'host') next();
      if (peek() && peek().t === 'op') {
        // "src == 1.2.3.4" uses the src column
        const op = OPS.get(next().v);
        const v = expectValue('a value');
        return (p) => cmp(op, lw === 'src' ? p.d.src : p.d.dst, v);
      }
      return hostTest(expectValue('an address'), lw);
    }
    // keywords
    if (KEYWORDS.has(lw)) {
      switch (lw) {
        case 'retrans':
        case 'retransmission':
          return (p) => !!(p.ann && p.ann.flags && p.ann.flags.includes('retrans'));
        case 'dupack':
          return (p) => !!(p.ann && p.ann.flags && p.ann.flags.includes('dupack'));
        case 'zerowindow':
          return (p) => !!(p.ann && p.ann.flags && p.ann.flags.includes('zerowin'));
        case 'errors':
        case 'error':
          return (p) => p.d.cls === 'bad' || !!(p.ann && p.ann.expert && p.ann.expert.some((e) => e.sev === 'error'));
        case 'warnings':
          return (p) => ['bad', 'warn'].includes(p.d.cls) || !!(p.ann && p.ann.expert && p.ann.expert.length);
        case 'expert':
          return (p) => !!(p.ann && p.ann.expert && p.ann.expert.length);
        case 'syn':
          return (p) => !!p.d.f['tcp.flags.syn'];
        case 'rst':
          return (p) => !!p.d.f['tcp.flags.reset'];
        case 'fin':
          return (p) => !!p.d.f['tcp.flags.fin'];
        case 'broadcast':
          return (p) => p.d.f['eth.dst'] === 'ff:ff:ff:ff:ff:ff';
        case 'multicast':
          return (p) => !!p.d.f['eth.dst'] && (parseInt(p.d.f['eth.dst'].slice(0, 2), 16) & 1) === 1 && p.d.f['eth.dst'] !== 'ff:ff:ff:ff:ff:ff';
      }
    }
    // bare address / network = host
    if (ipToInt(w) !== null || /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i.test(w) || (w.includes('/') && cidrMatcher(w)) || (w.includes(':') && /^[0-9a-f:]+$/i.test(w))) return hostTest(w);

    const field = ALIASES[lw] || lw;
    const op = peek() && peek().t === 'op' ? OPS.get(next().v) : null;
    if (op) {
      const v = expectValue(`a value after "${w}"`);
      return (p) => cmp(op, fieldValue(p, field), v);
    }
    // "vlan" tests for the layer, including an 802.1p priority tag (VID 0).
    // Keep the vlan.id alias for comparisons such as "vlan == 20".
    if (lw === 'vlan') return (p) => !!p.d.f.vlan;
    if (!field.includes('.') && !PROTOCOLS.has(field)) throw new Error(`Unknown protocol or field "${w}"`);
    return (p) => truthy(fieldValue(p, field));
  };

  const fn = parseOr();
  if (i < toks.length) throw new Error(`Unexpected "${toks[i].v || toks[i].t}"`);
  return { test: fn, text: src };
}
