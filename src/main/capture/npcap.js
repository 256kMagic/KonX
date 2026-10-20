'use strict';
// Npcap (wpcap.dll) binding through koffi. Npcap is the capture driver Wireshark uses;
// it is installed separately (https://npcap.com). Loaded lazily so the app runs without it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const NPCAP_DIR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'Npcap');
const AF_INET = 2;
const AF_INET6 = 23; // Windows value

let api = null;
let loadError = null;

class NpcapMissingError extends Error {
  constructor() {
    super('Npcap is not installed. Live capture needs the free Npcap driver from https://npcap.com (the same driver Wireshark uses).');
    this.code = 'NO_NPCAP';
  }
}

function load() {
  if (api) return api;
  if (loadError) throw loadError;
  try {
    if (process.platform !== 'win32') throw new Error('Live capture in this build uses Npcap and is Windows-only');
    const dll = path.join(NPCAP_DIR, 'wpcap.dll');
    if (!fs.existsSync(dll)) throw new NpcapMissingError();
    const koffi = require('koffi');
    // wpcap.dll depends on Packet.dll in the same folder, which is not on the DLL search path.
    const k32 = koffi.load('kernel32.dll');
    k32.func('bool __stdcall SetDllDirectoryW(str16 path)')(NPCAP_DIR);
    const lib = koffi.load(dll);

    const pcap_if = koffi.struct('pcap_if', { next: 'void *', name: 'const char *', description: 'const char *', addresses: 'void *', flags: 'uint32_t' });
    const pcap_addr = koffi.struct('pcap_addr', { next: 'void *', addr: 'void *', netmask: 'void *', broadaddr: 'void *', dstaddr: 'void *' });
    const pkthdr = koffi.struct('pcap_pkthdr', { tv_sec: 'long', tv_usec: 'long', caplen: 'uint32_t', len: 'uint32_t' });
    // Windows pcap_stat has three extra counters after the portable ones.
    const pcap_stat = koffi.struct('pcap_stat', { ps_recv: 'uint32_t', ps_drop: 'uint32_t', ps_ifdrop: 'uint32_t', ps_capt: 'uint32_t', ps_sent: 'uint32_t', ps_netdrop: 'uint32_t' });
    const bpf_program = koffi.struct('bpf_program', { bf_len: 'uint32_t', bf_insns: 'void *' });

    api = {
      koffi,
      pcap_if,
      pcap_addr,
      pkthdr,
      pcap_stat,
      bpf_program,
      findalldevs: lib.func('int pcap_findalldevs(_Out_ void **alldevs, uint8_t *errbuf)'),
      freealldevs: lib.func('void pcap_freealldevs(void *alldevs)'),
      lib_version: lib.func('const char *pcap_lib_version()'),
      create: lib.func('void *pcap_create(const char *source, uint8_t *errbuf)'),
      set_snaplen: lib.func('int pcap_set_snaplen(void *p, int snaplen)'),
      set_promisc: lib.func('int pcap_set_promisc(void *p, int promisc)'),
      set_timeout: lib.func('int pcap_set_timeout(void *p, int ms)'),
      set_immediate_mode: lib.func('int pcap_set_immediate_mode(void *p, int on)'),
      set_buffer_size: lib.func('int pcap_set_buffer_size(void *p, int size)'),
      activate: lib.func('int pcap_activate(void *p)'),
      statustostr: lib.func('const char *pcap_statustostr(int status)'),
      geterr: lib.func('const char *pcap_geterr(void *p)'),
      datalink: lib.func('int pcap_datalink(void *p)'),
      compile: lib.func('int pcap_compile(void *p, void *fp, const char *str, int optimize, uint32_t netmask)'),
      setfilter: lib.func('int pcap_setfilter(void *p, void *fp)'),
      freecode: lib.func('void pcap_freecode(void *fp)'),
      next_ex: lib.func('int pcap_next_ex(void *p, _Out_ void **hdr, _Out_ void **data)'),
      stats: lib.func('int pcap_stats(void *p, _Out_ pcap_stat *ps)'),
      close: lib.func('void pcap_close(void *p)'),
    };
    return api;
  } catch (e) {
    loadError = e;
    throw e;
  }
}

function resetStatus() {
  if (!api) loadError = null;
}

function status() {
  try {
    const a = load();
    return { available: true, version: a.lib_version() };
  } catch (e) {
    return { available: false, missing: e.code === 'NO_NPCAP', error: e.message };
  }
}

function errbufText(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end < 0 ? buf.length : end).toString('latin1');
}

function sockaddrToIp(a, ptr) {
  if (!ptr) return null;
  // Read the family first: an IPv4 sockaddr is only 16 bytes long.
  const family = a.koffi.decode(ptr, 'uint16_t');
  if (family !== AF_INET && family !== AF_INET6) return null;
  // decode copies; koffi.view would abort Electron (V8 memory cage).
  const bytes = a.koffi.decode(ptr, 'uint8_t', family === AF_INET6 ? 28 : 16);
  if (family === AF_INET) return { family: 4, ip: Array.from(bytes.subarray(4, 8)).join('.') };
  if (family === AF_INET6) {
    const parts = [];
    for (let i = 8; i < 24; i += 2) parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
    return { family: 6, ip: parts.join(':').replace(/(^|:)0(:0)+(:|$)/, '::') };
  }
  return null;
}

/** Capture devices with their addresses and the Windows friendly name ("Wi-Fi", "Ethernet"). */
function listDevices() {
  const a = load();
  const out = [null];
  const err = Buffer.alloc(512);
  if (a.findalldevs(out, err) !== 0) throw new Error(errbufText(err));
  const devices = [];
  try {
    let ptr = out[0];
    while (ptr) {
      const d = a.koffi.decode(ptr, a.pcap_if);
      const addrs = [];
      let ap = d.addresses;
      while (ap) {
        const pa = a.koffi.decode(ap, a.pcap_addr);
        const ip = sockaddrToIp(a, pa.addr);
        if (ip) addrs.push(ip);
        ap = pa.next;
      }
      devices.push({ name: d.name, description: d.description || '', addresses: addrs, flags: d.flags });
      ptr = d.next;
    }
  } finally {
    if (out[0]) a.freealldevs(out[0]);
  }
  // Match adapters to Windows interface names by address.
  const ifs = os.networkInterfaces();
  for (const dev of devices) {
    dev.loopback = /loopback/i.test(dev.name) || !!(dev.flags & 1);
    dev.up = !!(dev.flags & 2);
    dev.wireless = !!(dev.flags & 8);
    for (const [friendly, list] of Object.entries(ifs)) {
      if ((list || []).some((x) => dev.addresses.some((d) => d.ip === x.address))) {
        dev.friendly = friendly;
        break;
      }
    }
    if (dev.loopback) dev.friendly = dev.friendly || 'Loopback';
  }
  // Adapters with an IPv4 address first; they are the ones people want.
  devices.sort((x, y) => (y.addresses.some((d) => d.family === 4) ? 1 : 0) - (x.addresses.some((d) => d.family === 4) ? 1 : 0));
  return devices;
}

/**
 * Open a live capture. Returns a handle with next() / stats() / close().
 * opts: snaplen, promisc, timeoutMs, bufferMB, filter (BPF)
 */
function open(device, opts = {}) {
  const a = load();
  const err = Buffer.alloc(512);
  const p = a.create(device, err);
  if (!p) throw new Error(errbufText(err) || 'pcap_create failed');
  const check = (rc, what) => {
    if (rc < 0) {
      const msg = a.geterr(p) || a.statustostr(rc);
      a.close(p);
      throw new Error(`${what}: ${msg}`);
    }
  };
  a.set_snaplen(p, opts.snaplen || 262144);
  a.set_promisc(p, opts.promisc === false ? 0 : 1);
  a.set_timeout(p, opts.timeoutMs || 100);
  a.set_immediate_mode(p, 1);
  a.set_buffer_size(p, (opts.bufferMB || 16) * 1024 * 1024);
  check(a.activate(p), 'Could not start capture');
  if (opts.filter && opts.filter.trim()) {
    const prog = a.koffi.alloc(a.bpf_program, 1);
    try {
      check(a.compile(p, prog, opts.filter.trim(), 1, 0xffffffff), 'Capture filter');
      check(a.setfilter(p, prog), 'Capture filter');
      a.freecode(prog);
    } finally {
      a.koffi.free(prog);
    }
  }
  const linktype = a.datalink(p);
  const hdrOut = [null];
  const dataOut = [null];
  let closed = false;
  return {
    linktype,
    /** undefined at end, null on timeout, else a packet with a private copy of the bytes */
    next() {
      const rc = a.next_ex(p, hdrOut, dataOut);
      if (rc === 1) {
        const h = a.koffi.decode(hdrOut[0], a.pkthdr);
        const data = a.koffi.decode(dataOut[0], 'uint8_t', h.caplen);
        return { ts: h.tv_sec + h.tv_usec / 1e6, caplen: h.caplen, len: h.len, data };
      }
      if (rc === 0) return null;
      if (rc === -2) return undefined;
      throw new Error(a.geterr(p) || 'Capture error');
    },
    stats() {
      const s = {};
      if (a.stats(p, s) !== 0) return null;
      return { received: s.ps_recv, dropped: s.ps_drop, ifdropped: s.ps_ifdrop };
    },
    close() {
      if (!closed) a.close(p);
      closed = true;
    },
  };
}

module.exports = { status, resetStatus, listDevices, open, NPCAP_DIR };
