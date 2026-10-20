'use strict';
// Windows' built-in packet capture: the NDIS capture filter (ndiscap.sys) logs frames
// through the "Microsoft-Windows-NDIS-PacketCapture" ETW provider. Same event layout as
// Microsoft's etl2pcapng: event 1001 carries one fragment of a frame; the keyword says
// where a frame starts and ends and what kind of link it came from.

const PROVIDER = '{2ED6006E-4729-4609-B423-3EE7BCD678EF}';
const EVENT_FRAGMENT = 1001;
const KW = {
  WIRELESS_WAN: 0x200n,
  NATIVE_802_11: 0x10000n,
  PACKET_START: 0x40000000n,
  PACKET_END: 0x80000000n,
  SEND: 0x100000000n,
  RECEIVE: 0x200000000n,
};

/** pcap link type for a fragment's keyword. */
function linktypeFor(keyword) {
  if (keyword & KW.WIRELESS_WAN) return 101; // raw IP
  if (keyword & KW.NATIVE_802_11) return 105; // 802.11
  return 1; // Ethernet
}

/**
 * Rebuilds frames from fragment events. Fragments of one frame arrive in order from the
 * same processor, so frames in progress are kept per processor and interface.
 */
class FrameAssembler {
  constructor({ ifIndex = null, snaplen = 262144 } = {}) {
    this.ifIndex = ifIndex;
    this.snaplen = snaplen;
    this.partial = new Map();
    this.stats = { events: 0, frames: 0, skipped: 0, broken: 0 };
  }

  /** Returns {ts, caplen, len, data, linktype, ifIndex, dir} when a frame completes, else null. */
  push(ev) {
    if (ev.id !== EVENT_FRAGMENT || ev.userData.length < 12) return null;
    this.stats.events++;
    const d = ev.userData;
    const ifIndex = d.readUInt32LE(0);
    const size = d.readUInt32LE(8);
    if (this.ifIndex != null && ifIndex !== this.ifIndex) {
      this.stats.skipped++;
      return null;
    }
    const frag = d.subarray(12, 12 + Math.min(size, d.length - 12));
    const kw = ev.keyword;
    const start = !!(kw & KW.PACKET_START);
    const end = !!(kw & KW.PACKET_END);
    const key = `${ev.processor}:${ifIndex}`;
    let p = this.partial.get(key);
    if (start) {
      if (p) this.stats.broken++; // previous frame never ended
      p = { ts: ev.time, parts: [], kw, ifIndex };
      this.partial.set(key, p);
    } else if (!p) {
      // Middle of a frame we never saw the start of (capture began mid-frame).
      this.stats.broken++;
      return null;
    }
    p.parts.push(frag);
    if (!end) return null;
    this.partial.delete(key);
    const full = p.parts.length === 1 ? p.parts[0] : Buffer.concat(p.parts);
    const data = full.length > this.snaplen ? full.subarray(0, this.snaplen) : full;
    this.stats.frames++;
    return {
      ts: p.ts,
      caplen: data.length,
      len: full.length,
      data: new Uint8Array(data),
      linktype: linktypeFor(p.kw),
      ifIndex,
      dir: p.kw & KW.SEND ? 'out' : p.kw & KW.RECEIVE ? 'in' : '',
    };
  }
}

/** Frames ({ts, len, data, linktype, ifIndex}) -> pcapng bytes, one interface per adapter and link type. */
function toPcapng(frames) {
  const parts = [];
  const block = (type, body) => {
    const pad = (4 - (body.length % 4)) % 4;
    const len = 12 + body.length + pad;
    const b = Buffer.alloc(len);
    b.writeUInt32LE(type, 0);
    b.writeUInt32LE(len, 4);
    body.copy(b, 8);
    b.writeUInt32LE(len, len - 4);
    parts.push(b);
  };
  const option = (code, value) => {
    const pad = (4 - (value.length % 4)) % 4;
    const b = Buffer.alloc(4 + value.length + pad);
    b.writeUInt16LE(code, 0);
    b.writeUInt16LE(value.length, 2);
    value.copy(b, 4);
    return b;
  };
  const shb = Buffer.alloc(16);
  shb.writeUInt32LE(0x1a2b3c4d, 0);
  shb.writeUInt16LE(1, 4);
  shb.writeBigInt64LE(-1n, 8);
  block(0x0a0d0d0a, Buffer.concat([shb, option(4, Buffer.from('KonX (Windows NDIS capture)')), Buffer.alloc(4)]));
  const ifaces = new Map();
  for (const f of frames) {
    const key = `${f.ifIndex}:${f.linktype}`;
    let id = ifaces.get(key);
    if (id == null) {
      id = ifaces.size;
      ifaces.set(key, id);
      const idb = Buffer.alloc(8);
      idb.writeUInt16LE(f.linktype, 0);
      idb.writeUInt32LE(0, 4);
      block(1, Buffer.concat([idb, option(2, Buffer.from(`ifIndex ${f.ifIndex}`)), Buffer.alloc(4)]));
    }
    const head = Buffer.alloc(20);
    const us = BigInt(Math.round(f.ts * 1e6));
    head.writeUInt32LE(id, 0);
    head.writeUInt32LE(Number(us >> 32n), 4);
    head.writeUInt32LE(Number(us & 0xffffffffn), 8);
    head.writeUInt32LE(f.data.length, 12);
    head.writeUInt32LE(f.len, 16);
    block(6, Buffer.concat([head, Buffer.from(f.data.buffer, f.data.byteOffset, f.data.length)]));
  }
  return Buffer.concat(parts);
}

module.exports = { PROVIDER, EVENT_FRAGMENT, KW, linktypeFor, FrameAssembler, toPcapng };
