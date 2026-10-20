'use strict';
// Network tools: ping monitor, ping sweep, TCP port scanner, traceroute, DNS,
// whois, Wake-on-LAN, interface and ARP listing. No Electron dependencies.
const { spawn, execFile } = require('child_process');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const dgram = require('dgram');
const os = require('os');
const readline = require('readline');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ---------------------------------------------------------------- addresses

function ipToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function maskBits(mask) {
  const n = ipToInt(mask);
  if (n === null) return null;
  let bits = 0;
  for (let i = 31; i >= 0; i--) if (n & (2 ** i)) bits++;
  return bits;
}

/**
 * Expand a target expression into a host list. Accepts, comma/space separated:
 * 10.0.0.0/24, 10.0.0.1-50, 10.0.0.1-10.0.1.20, 10.0.0.*, single IPs and hostnames.
 */
function parseTargets(input, max = 65536) {
  const out = [];
  const push = (h) => {
    if (out.length >= max) throw new Error(`Too many targets (limit ${max})`);
    out.push(h);
  };
  for (const tok of String(input).split(/[\s,;]+/).filter(Boolean)) {
    let m;
    if ((m = tok.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/))) {
      const base = ipToInt(m[1]);
      const bits = Number(m[2]);
      if (base === null || bits > 32) throw new Error(`Bad CIDR ${tok}`);
      const size = 2 ** (32 - bits);
      if (size > max) throw new Error(`${tok} has ${size} addresses (limit ${max})`);
      const network = Math.floor(base / size) * size;
      const first = bits >= 31 ? network : network + 1;
      const last = bits >= 31 ? network + size - 1 : network + size - 2;
      for (let i = first; i <= last; i++) push(intToIp(i));
    } else if ((m = tok.match(/^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$/))) {
      const a = ipToInt(m[1]);
      const b = ipToInt(m[2]);
      if (a === null || b === null || b < a) throw new Error(`Bad range ${tok}`);
      if (b - a + 1 > max) throw new Error(`Range ${tok} is too large`);
      for (let i = a; i <= b; i++) push(intToIp(i));
    } else if ((m = tok.match(/^(\d+\.\d+\.\d+)\.(\d{1,3})-(\d{1,3})$/))) {
      const a = Number(m[2]);
      const b = Number(m[3]);
      if (a > 255 || b > 255 || b < a) throw new Error(`Bad range ${tok}`);
      for (let i = a; i <= b; i++) push(`${m[1]}.${i}`);
    } else if ((m = tok.match(/^(\d+\.\d+\.\d+)\.\*$/))) {
      for (let i = 1; i <= 254; i++) push(`${m[1]}.${i}`);
    } else if (ipToInt(tok) !== null || net.isIPv6(tok)) {
      push(tok);
    } else if (/^[\d.]+$/.test(tok)) {
      throw new Error(`Invalid IP address "${tok}"`);
    } else if (/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(tok)) {
      push(tok);
    } else {
      throw new Error(`Cannot parse target "${tok}"`);
    }
  }
  return out;
}

const TOP_PORTS = [
  7, 9, 13, 21, 22, 23, 25, 26, 37, 53, 79, 80, 81, 88, 106, 110, 111, 113, 119, 135, 139, 143, 144, 179, 199, 389,
  427, 443, 444, 445, 465, 513, 514, 515, 543, 544, 548, 554, 587, 631, 646, 873, 990, 993, 995, 1025, 1026, 1027,
  1028, 1029, 1110, 1433, 1720, 1723, 1755, 1900, 2000, 2001, 2049, 2121, 2717, 3000, 3128, 3306, 3389, 3986, 4899,
  5000, 5009, 5051, 5060, 5101, 5190, 5357, 5432, 5631, 5666, 5800, 5900, 6000, 6001, 6646, 7070, 8000, 8008, 8009,
  8080, 8081, 8443, 8888, 9100, 9999, 10000, 32768, 49152, 49153, 49154, 49155, 49156, 49157,
];

const PORT_PRESETS = {
  top100: TOP_PORTS,
  network: [22, 23, 80, 443, 179, 646, 830, 2000, 4786, 8291, 8728, 8729, 8443, 9443, 50000, 5000, 3389, 445, 135, 139],
  web: [80, 81, 443, 591, 3000, 4443, 5000, 5601, 8000, 8008, 8080, 8081, 8088, 8443, 8888, 9000, 9090, 9443, 10443],
  windows: [53, 88, 135, 139, 389, 445, 464, 593, 636, 3268, 3269, 3389, 5985, 5986, 9389],
  database: [1433, 1521, 3306, 5432, 5984, 6379, 7000, 7001, 8086, 9042, 9200, 11211, 27017, 28015],
  iot: [21, 22, 23, 80, 102, 443, 502, 554, 1883, 1911, 2404, 4840, 5683, 8883, 20000, 44818, 47808],
};

const SERVICES = {
  7: 'echo', 9: 'discard', 13: 'daytime', 20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 26: 'rsftp',
  37: 'time', 53: 'dns', 67: 'dhcp', 69: 'tftp', 79: 'finger', 80: 'http', 81: 'http-alt', 88: 'kerberos',
  102: 'iso-tsap/s7', 106: 'pop3pw', 110: 'pop3', 111: 'rpcbind', 113: 'ident', 119: 'nntp', 123: 'ntp',
  135: 'msrpc', 137: 'netbios-ns', 139: 'netbios-ssn', 143: 'imap', 144: 'news', 161: 'snmp', 179: 'bgp',
  199: 'smux', 389: 'ldap', 427: 'svrloc', 443: 'https', 444: 'snpp', 445: 'microsoft-ds', 464: 'kpasswd',
  465: 'smtps', 502: 'modbus', 513: 'rlogin', 514: 'rsh/syslog', 515: 'printer', 543: 'klogin', 544: 'kshell',
  548: 'afp', 554: 'rtsp', 587: 'submission', 591: 'http-alt', 593: 'http-rpc', 631: 'ipp', 636: 'ldaps',
  646: 'ldp', 830: 'netconf-ssh', 873: 'rsync', 990: 'ftps', 993: 'imaps', 995: 'pop3s', 1025: 'msrpc',
  1110: 'nfsd', 1433: 'mssql', 1521: 'oracle', 1720: 'h323', 1723: 'pptp', 1755: 'wms', 1883: 'mqtt',
  1900: 'upnp', 1911: 'fox', 2000: 'cisco-sccp', 2001: 'dc', 2049: 'nfs', 2121: 'ftp-alt', 2404: 'iec-104',
  2717: 'pn-requester', 3000: 'http-alt', 3128: 'squid', 3268: 'globalcat', 3269: 'globalcat-ssl',
  3306: 'mysql', 3389: 'rdp', 3986: 'mapper-ws', 4443: 'https-alt', 4786: 'cisco-smi', 4840: 'opc-ua',
  4899: 'radmin', 5000: 'upnp/http', 5009: 'airport-admin', 5051: 'ida-agent', 5060: 'sip', 5101: 'admdog',
  5190: 'aol', 5357: 'wsdapi', 5432: 'postgresql', 5601: 'kibana', 5631: 'pcanywhere', 5666: 'nrpe',
  5683: 'coap', 5800: 'vnc-http', 5900: 'vnc', 5984: 'couchdb', 5985: 'winrm', 5986: 'winrm-https',
  6000: 'x11', 6001: 'x11', 6379: 'redis', 6443: 'kube-api', 6646: 'unknown', 7000: 'cassandra',
  7001: 'weblogic', 7070: 'realserver', 8000: 'http-alt', 8006: 'proxmox', 8008: 'http-alt', 8009: 'ajp13',
  8080: 'http-proxy', 8081: 'http-alt', 8086: 'influxdb', 8088: 'http-alt', 8291: 'mikrotik-winbox',
  8443: 'https-alt', 8728: 'mikrotik-api', 8729: 'mikrotik-api-ssl', 8883: 'mqtt-tls', 8888: 'http-alt',
  9000: 'http-alt', 9042: 'cassandra', 9090: 'http-alt', 9100: 'jetdirect', 9200: 'elasticsearch',
  9389: 'adws', 9443: 'https-alt', 9999: 'abyss', 10000: 'webmin', 10443: 'https-alt', 11211: 'memcached',
  20000: 'dnp3', 27017: 'mongodb', 28015: 'rethinkdb', 32768: 'filenet', 44818: 'ethernet-ip',
  47808: 'bacnet', 49152: 'msrpc', 49153: 'msrpc', 49154: 'msrpc', 49155: 'msrpc', 49156: 'msrpc',
  49157: 'msrpc', 50000: 'sap/ibm-db2',
};

function parsePorts(input) {
  const s = String(input).trim();
  if (PORT_PRESETS[s]) return [...PORT_PRESETS[s]];
  const set = new Set();
  for (const tok of s.split(/[\s,;]+/).filter(Boolean)) {
    if (PORT_PRESETS[tok]) {
      PORT_PRESETS[tok].forEach((x) => set.add(x));
      continue;
    }
    const m = tok.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Bad port "${tok}"`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || b < a) throw new Error(`Bad port range "${tok}"`);
    for (let i = a; i <= b; i++) set.add(i);
  }
  return [...set].sort((x, y) => x - y);
}

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run fn over items with at most `limit` in flight; stops early when signal.stopped. */
async function pool(items, limit, fn, signal) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && !signal.stopped) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, sleep(ms).then(() => fallback)]);
}

async function resolveHost(host) {
  if (net.isIP(host)) return host;
  const r = await dns.promises.lookup(host, { family: 0 });
  return r.address;
}

// ---------------------------------------------------------------- ping

/** One ICMP echo using the system ping binary. Resolves {ok, ms, ttl, error}. */
function pingOnce(host, { timeout = 1000, size = 32 } = {}) {
  return new Promise((resolve) => {
    let args;
    if (IS_WIN) args = ['-n', '1', '-w', String(timeout), '-l', String(size), host];
    else if (IS_MAC) args = ['-c', '1', '-W', String(timeout), '-s', String(size), host];
    else args = ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeout / 1000))), '-s', String(size), host];
    const started = process.hrtime.bigint();
    let out = '';
    let done = false;
    const child = spawn('ping', args, { windowsHide: true });
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      resolve(r);
    };
    const killer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: 'timeout' });
    }, timeout + 3000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', () => {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      // A reply line has a round-trip time (IPv6 replies on Windows carry no TTL).
      const line = out.split(/\r?\n/).find((l) => /(time|zeit|tiempo|temps|tempo)?\s*[=<]\s*\d+(?:[.,]\d+)?\s*ms/i.test(l) && !/unreachable|expired|nicht erreichbar/i.test(l));
      if (!line) {
        const reason = out.split(/\r?\n/).map((l) => l.trim()).find((l) => /unreachable|timed out|expired|failure|could not|unknown|not find/i.test(l));
        return finish({ ok: false, error: reason || 'timeout' });
      }
      const t = line.match(/[=<]\s*(\d+(?:[.,]\d+)?)\s*ms/i);
      const ttl = line.match(/ttl[=:]\s*(\d+)/i);
      let ms = t ? parseFloat(t[1].replace(',', '.')) : elapsed;
      if (t && /<\s*1\s*ms/i.test(line)) ms = 0.5;
      finish({ ok: true, ms, ttl: ttl ? Number(ttl[1]) : null });
    });
  });
}

/**
 * Continuous multi-host ping. emit('resolved'|'reply'|'done', data)
 * opts: count (0 = until stopped), interval ms, timeout ms, size bytes
 */
async function pingMonitor({ hosts, count = 0, interval = 1000, timeout = 1000, size = 32 }, emit, signal) {
  const list = String(hosts).split(/[\s,;]+/).filter(Boolean);
  if (!list.length) throw new Error('Enter at least one host');
  await Promise.all(
    list.map(async (host) => {
      let ip;
      try {
        ip = await resolveHost(host);
        emit('resolved', { host, ip });
      } catch (e) {
        emit('reply', { host, seq: 0, ok: false, error: 'DNS: ' + e.code });
        return;
      }
      for (let seq = 1; (count === 0 || seq <= count) && !signal.stopped; seq++) {
        const t0 = Date.now();
        const r = await pingOnce(ip, { timeout, size });
        if (signal.stopped) break;
        emit('reply', { host, ip, seq, ...r });
        const wait = interval - (Date.now() - t0);
        if (wait > 0 && (count === 0 || seq < count)) await sleepUnlessStopped(wait, signal);
      }
    })
  );
}

async function sleepUnlessStopped(ms, signal) {
  const end = Date.now() + ms;
  while (Date.now() < end && !signal.stopped) await sleep(Math.min(100, end - Date.now()));
}

// ---------------------------------------------------------------- TCP probe / port scan

const HTTP_PORTS = new Set([80, 81, 591, 3000, 5000, 8000, 8008, 8080, 8081, 8088, 8888, 9000, 9090]);
const TLS_PORTS = new Set([443, 465, 636, 853, 990, 993, 995, 4443, 5986, 6443, 8443, 8883, 9443, 10443]);

/** TCP connect probe. state: open | closed | filtered | unreachable */
function probePort(host, port, { timeout = 1000, banner = false } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ms: Date.now() - started, ...r });
    };
    sock.setTimeout(timeout);
    sock.once('timeout', () => done({ state: 'filtered' }));
    sock.once('error', (e) => {
      if (e.code === 'ECONNREFUSED') done({ state: 'closed' });
      else if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') done({ state: 'unreachable' });
      else done({ state: 'filtered', error: e.code });
    });
    sock.connect(port, host, async () => {
      const ms = Date.now() - started;
      if (!banner) return done({ state: 'open', ms });
      sock.setTimeout(0);
      if (TLS_PORTS.has(port)) {
        settled = true;
        sock.destroy();
        const info = await tlsInfo(host, port, timeout + 1500);
        return resolve({ state: 'open', ms, banner: info });
      }
      let data = '';
      const finish = () => {
        const text = data.replace(/[^\x20-\x7e\r\n]/g, '').trim();
        let b = text.split(/\r?\n/)[0] || '';
        const server = text.match(/^server:\s*(.+)$/im);
        if (/^HTTP\//.test(b) && server) b += ' | ' + server[1].trim();
        done({ state: 'open', ms, banner: b.slice(0, 200) });
      };
      const t = setTimeout(finish, 1500);
      sock.on('data', (d) => {
        data += d.toString('latin1');
        if (data.length > 1024 || /\n/.test(data)) {
          clearTimeout(t);
          setTimeout(finish, HTTP_PORTS.has(port) ? 150 : 0);
        }
      });
      if (HTTP_PORTS.has(port)) sock.write(`HEAD / HTTP/1.0\r\nHost: ${host}\r\n\r\n`);
    });
  });
}

function tlsInfo(host, port, timeout) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, timeout });
    const end = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once('secureConnect', () => {
      const c = s.getPeerCertificate();
      const cn = c && c.subject ? c.subject.CN : '';
      const issuer = c && c.issuer ? c.issuer.O || c.issuer.CN : '';
      end(`TLS ${s.getProtocol() || ''} CN=${cn || '?'}${issuer ? ' (issuer: ' + issuer + ')' : ''}${c && c.valid_to ? ' exp ' + c.valid_to : ''}`);
    });
    s.once('timeout', () => end('TLS: no handshake'));
    s.once('error', (e) => end('TLS error: ' + e.code));
  });
}

/** emit('progress', {done,total}), emit('result', {...}) */
async function portScan({ targets, ports, timeout = 1000, concurrency = 200, banner = false, showAll = false }, emit, signal) {
  const hosts = parseTargets(targets, 4096);
  const portList = parsePorts(ports);
  if (!hosts.length) throw new Error('No targets');
  if (!portList.length) throw new Error('No ports');
  const work = [];
  for (const h of hosts) for (const pt of portList) work.push([h, pt]);
  const total = work.length;
  let done = 0;
  const resolved = new Map();
  for (const h of hosts) {
    try {
      resolved.set(h, await resolveHost(h));
    } catch (e) {
      emit('result', { host: h, port: 0, state: 'error', banner: 'DNS: ' + e.code });
    }
  }
  let lastProgress = 0;
  const counts = { open: 0, closed: 0, filtered: 0 };
  await pool(work, concurrency, async ([h, pt]) => {
    const ip = resolved.get(h);
    if (ip) {
      const r = await probePort(ip, pt, { timeout, banner });
      if (r.state === 'open') counts.open++;
      else if (r.state === 'closed') counts.closed++;
      else counts.filtered++;
      if (r.state === 'open' || showAll) emit('result', { host: h, ip, port: pt, service: SERVICES[pt] || '', ...r });
    }
    done++;
    const now = Date.now();
    if (now - lastProgress > 100 || done === total) {
      lastProgress = now;
      emit('progress', { done, total, ...counts });
    }
  }, signal);
  emit('progress', { done, total, ...counts });
}

// ---------------------------------------------------------------- sweep

function arpTable() {
  return new Promise((resolve) => {
    const [cmd, args] = IS_WIN ? ['arp', ['-a']] : ['arp', ['-an']];
    execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const map = new Map();
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const ip = line.match(/(\d+\.\d+\.\d+\.\d+)/);
        const mac = line.match(/([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}/i);
        if (ip && mac) {
          const m = mac[0].replace(/-/g, ':').toLowerCase().split(':').map((x) => x.padStart(2, '0')).join(':');
          if (m !== 'ff:ff:ff:ff:ff:ff') map.set(ip[1], m);
        }
      }
      resolve(map);
    });
  });
}

async function reverseName(ip) {
  try {
    const names = await withTimeout(dns.promises.reverse(ip), 2000, []);
    return names[0] || '';
  } catch {
    return '';
  }
}

/**
 * Ping sweep with optional TCP fallback for hosts that drop ICMP.
 * emit('result', {ip, alive, ms, method, name}), emit('progress'), emit('mac', {ip, mac})
 */
async function sweep({ targets, timeout = 800, concurrency = 64, resolveNames = true, tcpFallback = true, macs = true, showDead = false }, emit, signal) {
  const hosts = parseTargets(targets, 65536);
  const total = hosts.length;
  let done = 0;
  let alive = 0;
  let lastProgress = 0;
  const fallbackPorts = [80, 443, 22, 445, 3389, 23];
  await pool(hosts, concurrency, async (h) => {
    let r = await pingOnce(h, { timeout });
    let method = 'ICMP';
    if (!r.ok && tcpFallback && !signal.stopped) {
      for (const pt of fallbackPorts) {
        const pr = await probePort(h, pt, { timeout: Math.min(timeout, 600) });
        if (pr.state === 'open' || pr.state === 'closed') {
          r = { ok: true, ms: pr.ms };
          method = `TCP/${pt}${pr.state === 'closed' ? ' (RST)' : ''}`;
          break;
        }
        if (signal.stopped) break;
      }
    }
    done++;
    if (r.ok) {
      alive++;
      const name = resolveNames ? await reverseName(h) : '';
      emit('result', { ip: h, alive: true, ms: r.ms, ttl: r.ttl, method, name });
    } else if (showDead) {
      emit('result', { ip: h, alive: false, error: r.error });
    }
    const now = Date.now();
    if (now - lastProgress > 100) {
      lastProgress = now;
      emit('progress', { done, total, alive });
    }
  }, signal);
  emit('progress', { done, total, alive });
  if (macs && !signal.stopped) {
    const table = await arpTable();
    for (const [ip, mac] of table) emit('mac', { ip, mac });
  }
}

// ---------------------------------------------------------------- traceroute

function parseTraceLine(line) {
  const m = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!m) return null;
  const hop = Number(m[1]);
  let rest = m[2];
  const rtts = [];
  if (IS_WIN) {
    // "  1    <1 ms    <1 ms    <1 ms  192.168.1.1" / "  2     *        *        *     Request timed out."
    const re = /^\s*(<?\d+\s*ms|\*)\s*/;
    for (let i = 0; i < 3; i++) {
      const r = rest.match(re);
      if (!r) break;
      rtts.push(r[1] === '*' ? null : r[1].startsWith('<') ? 0.5 : parseFloat(r[1]));
      rest = rest.slice(r[0].length);
    }
    const host = rest.trim();
    const ipm = host.match(/\[([^\]]+)\]/) || host.match(/^(\d+\.\d+\.\d+\.\d+|[0-9a-f:]+:[0-9a-f:]+)$/i);
    return { hop, rtts, host: ipm ? host.replace(/\s*\[.*\]/, '') : host, ip: ipm ? ipm[1] : '' };
  }
  // unix: "1  192.168.1.1  0.345 ms  0.301 ms  *"
  const ipMatch = rest.match(/^(\S+)(?:\s+\(([^)]+)\))?/);
  let host = '';
  let ip = '';
  if (ipMatch && ipMatch[1] !== '*') {
    host = ipMatch[1];
    ip = ipMatch[2] || ipMatch[1];
  }
  for (const r of rest.matchAll(/(\d+(?:\.\d+)?)\s*ms|\*/g)) rtts.push(r[1] ? parseFloat(r[1]) : null);
  return { hop, rtts: rtts.slice(0, 3), host, ip };
}

function traceroute({ host, maxHops = 30, timeout = 1000, resolveNames = false }, emit, signal) {
  return new Promise((resolve, reject) => {
    let cmd;
    let args;
    if (IS_WIN) {
      cmd = 'tracert';
      args = ['-h', String(maxHops), '-w', String(timeout)];
      if (!resolveNames) args.push('-d');
      args.push(host);
    } else {
      cmd = 'traceroute';
      args = ['-m', String(maxHops), '-w', String(Math.max(1, Math.round(timeout / 1000)))];
      if (!resolveNames) args.push('-n');
      args.push(host);
    }
    const child = spawn(cmd, args, { windowsHide: true });
    signal.onStop = () => child.kill();
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const hop = parseTraceLine(line);
      if (hop && hop.hop >= 1 && hop.hop <= 255) emit('hop', hop);
      else if (line.trim()) emit('line', line.trim());
    });
    child.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
    child.on('close', () => resolve());
  });
}

// ---------------------------------------------------------------- DNS

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'SRV', 'CAA', 'PTR'];

function fmtRecord(type, r) {
  switch (type) {
    case 'A':
    case 'AAAA':
      return { value: r.address, ttl: r.ttl };
    case 'MX':
      return { value: `${r.priority} ${r.exchange}` };
    case 'TXT':
      return { value: r.join('') };
    case 'SOA':
      return { value: `${r.nsname} ${r.hostmaster} serial=${r.serial} refresh=${r.refresh} retry=${r.retry} expire=${r.expire} min=${r.minttl}` };
    case 'SRV':
      return { value: `${r.priority} ${r.weight} ${r.port} ${r.name}` };
    case 'CAA':
      return { value: `${r.critical} ${Object.keys(r).filter((k) => k !== 'critical').map((k) => `${k} "${r[k]}"`).join(' ')}` };
    default:
      return { value: String(r) };
  }
}

async function dnsLookup({ name, type = 'A', server = '' }) {
  const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  if (server) resolver.setServers([server]);
  const q = String(name).trim();
  const records = [];
  const started = Date.now();
  if (net.isIP(q)) {
    const names = await resolver.reverse(q).catch((e) => {
      throw new Error(`${e.code || e.message}`);
    });
    for (const n of names) records.push({ type: 'PTR', name: q, value: n });
    return { records, ms: Date.now() - started, server: server || resolver.getServers()[0] };
  }
  if (type === 'SYSTEM') {
    const all = await dns.promises.lookup(q, { all: true });
    for (const a of all) records.push({ type: a.family === 6 ? 'AAAA' : 'A', name: q, value: a.address });
    return { records, ms: Date.now() - started, server: 'OS resolver (hosts file + DNS)' };
  }
  const types = type === 'ALL' ? DNS_TYPES.filter((t) => t !== 'PTR') : [type];
  const errors = [];
  await Promise.all(
    types.map(async (t) => {
      try {
        let res;
        if (t === 'A') res = await resolver.resolve4(q, { ttl: true });
        else if (t === 'AAAA') res = await resolver.resolve6(q, { ttl: true });
        else if (t === 'SOA') res = [await resolver.resolveSoa(q)];
        else res = await resolver.resolve(q, t);
        for (const r of res) records.push({ type: t, name: q, ...fmtRecord(t, r) });
      } catch (e) {
        if (e.code !== 'ENODATA' && e.code !== 'ENOTFOUND') errors.push(`${t}: ${e.code || e.message}`);
        else if (type !== 'ALL') errors.push(`${t}: ${e.code}`);
      }
    })
  );
  records.sort((a, b) => DNS_TYPES.indexOf(a.type) - DNS_TYPES.indexOf(b.type));
  return { records, errors, ms: Date.now() - started, server: server || resolver.getServers()[0] };
}

// ---------------------------------------------------------------- whois

function whoisQuery(server, query, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let data = '';
    const sock = net.connect(43, server);
    sock.setTimeout(timeout);
    sock.on('connect', () => sock.write(query + '\r\n'));
    sock.on('data', (d) => {
      data += d.toString('utf8');
      if (data.length > 200000) sock.destroy();
    });
    sock.on('timeout', () => sock.destroy(new Error('timeout')));
    sock.on('error', reject);
    sock.on('close', () => resolve(data));
  });
}

async function whois({ query }) {
  const q = String(query).trim();
  if (!q) throw new Error('Enter a domain, IP or ASN');
  const parts = [];
  let server = 'whois.iana.org';
  const seen = new Set();
  for (let i = 0; i < 3 && server && !seen.has(server); i++) {
    seen.add(server);
    const text = await whoisQuery(server, q);
    parts.push(`% ---- ${server} ----\n${text.trim()}`);
    const m = text.match(/^\s*(?:refer|whois|Registrar WHOIS Server|ReferralServer):\s*(?:whois:\/\/)?(\S+)/im);
    server = m ? m[1].replace(/^rwhois:\/\//, '').replace(/:\d+$/, '') : null;
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- Wake-on-LAN

function wakeOnLan({ mac, broadcast = '255.255.255.255', port = 9 }) {
  const hex = String(mac).replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error('MAC address must have 12 hex digits');
  const macBuf = Buffer.from(hex, 'hex');
  const pkt = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) macBuf.copy(pkt, 6 + i * 6);
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(pkt, Number(port) || 9, broadcast, (err) => {
        sock.close();
        err ? reject(err) : resolve({ bytes: pkt.length });
      });
    });
  });
}

// ---------------------------------------------------------------- interfaces

function interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      let cidr = a.cidr;
      let network = '';
      if (a.family === 'IPv4' || a.family === 4) {
        const bits = maskBits(a.netmask);
        const size = 2 ** (32 - bits);
        network = intToIp(Math.floor(ipToInt(a.address) / size) * size) + '/' + bits;
      }
      out.push({ name, family: a.family === 4 ? 'IPv4' : a.family === 6 ? 'IPv6' : a.family, address: a.address, netmask: a.netmask, cidr, network, mac: a.mac, internal: a.internal });
    }
  }
  return out;
}

/** The first non-internal IPv4 network, e.g. "192.168.1.0/24", to prefill the sweep. */
function defaultSweepTarget() {
  const i = interfaces().find((x) => x.family === 'IPv4' && !x.internal && !x.address.startsWith('169.254.'));
  if (!i) return '192.168.1.0/24';
  const bits = Number(i.network.split('/')[1]);
  return bits < 22 ? i.address.replace(/\.\d+$/, '.0/24') : i.network;
}

module.exports = {
  parseTargets,
  parsePorts,
  PORT_PRESETS,
  SERVICES,
  pingOnce,
  pingMonitor,
  probePort,
  portScan,
  sweep,
  arpTable,
  traceroute,
  parseTraceLine,
  dnsLookup,
  whois,
  wakeOnLan,
  interfaces,
  defaultSweepTarget,
  ipToInt,
  intToIp,
};
