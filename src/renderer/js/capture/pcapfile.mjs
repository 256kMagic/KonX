// Read classic pcap and pcapng files; write pcapng (opens in Wireshark and tcpdump).

/** @returns {{format:string, packets:{ts:number, caplen:number, len:number, linktype:number, data:Uint8Array}[]}} */
export function readCapture(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 24) throw new Error('File is too short to be a capture');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = dv.getUint32(0, false);
  if (magic === 0x0a0d0d0a) return readPcapng(u8, dv);
  const le = dv.getUint32(0, true);
  if ([0xa1b2c3d4, 0xa1b23c4d].includes(magic) || [0xa1b2c3d4, 0xa1b23c4d].includes(le)) return readPcap(u8, dv);
  throw new Error('Unrecognized file format (expected .pcap or .pcapng)');
}

function readPcap(u8, dv) {
  const big = [0xa1b2c3d4, 0xa1b23c4d].includes(dv.getUint32(0, false));
  const little = !big;
  const nano = dv.getUint32(0, little) === 0xa1b23c4d;
  const linktype = dv.getUint32(20, little) & 0x0fffffff;
  const packets = [];
  let off = 24;
  while (off + 16 <= u8.length) {
    const sec = dv.getUint32(off, little);
    const frac = dv.getUint32(off + 4, little);
    const caplen = dv.getUint32(off + 8, little);
    const len = dv.getUint32(off + 12, little);
    off += 16;
    if (caplen > 0x4000000 || off + caplen > u8.length) break; // truncated file
    packets.push({ ts: sec + frac / (nano ? 1e9 : 1e6), caplen, len, linktype, data: u8.slice(off, off + caplen) });
    off += caplen;
  }
  return { format: nano ? 'pcap (ns)' : 'pcap', packets };
}

function readPcapng(u8, dv) {
  let little = true;
  let ifaces = [];
  const packets = [];
  let off = 0;
  const bad = (message) => { throw new Error(`Malformed pcapng at byte ${off}: ${message}`); };
  while (off < u8.length) {
    if (off + 12 > u8.length) bad('truncated block header');
    const type = dv.getUint32(off, little);
    if (type === 0x0a0d0d0a) {
      // Section header: the byte-order magic decides endianness for the whole section.
      const bom = dv.getUint32(off + 8, true);
      if (bom !== 0x1a2b3c4d && bom !== 0x4d3c2b1a) bad('invalid section byte-order magic');
      little = bom === 0x1a2b3c4d;
      ifaces = [];
    }
    const blen = dv.getUint32(off + 4, little);
    if (blen < 12 || blen % 4 || off + blen > u8.length) bad('invalid or truncated block length');
    if (dv.getUint32(off + blen - 4, little) !== blen) bad('block length trailer does not match');
    const body = off + 8;
    if (type === 0x0a0d0d0a) {
      if (blen < 28) bad('section header is too short');
    } else if (type === 1) {
      // Interface description: link type, snaplen and timestamp resolution option.
      if (blen < 20) bad('interface description is too short');
      const iface = { linktype: dv.getUint16(body, little), snaplen: dv.getUint32(body + 4, little), tsdiv: 1e6, name: '' };
      let o = body + 8;
      const end = off + blen - 4;
      while (o < end) {
        if (o + 4 > end) bad('truncated interface option');
        const code = dv.getUint16(o, little);
        const olen = dv.getUint16(o + 2, little);
        if (o + 4 + ((olen + 3) & ~3) > end) bad('interface option length exceeds its block');
        if (code === 0) break;
        if (code === 9 && olen >= 1) {
          const r = u8[o + 4];
          iface.tsdiv = r & 0x80 ? 2 ** (r & 0x7f) : 10 ** r;
        } else if (code === 2) {
          iface.name = new TextDecoder().decode(u8.subarray(o + 4, o + 4 + olen));
        }
        o += 4 + ((olen + 3) & ~3);
      }
      ifaces.push(iface);
    } else if (type === 6 || type === 2) {
      if (blen < 32) bad('packet block is too short');
      const ifid = type === 6 ? dv.getUint32(body, little) : dv.getUint16(body, little);
      const iface = ifaces[ifid];
      if (!iface) bad(`packet references unknown interface ${ifid}`);
      const ts = (dv.getUint32(body + 4, little) * 2 ** 32 + dv.getUint32(body + 8, little)) / iface.tsdiv;
      const caplen = dv.getUint32(body + 12, little);
      const len = dv.getUint32(body + 16, little);
      if (caplen > len || Math.ceil(caplen / 4) * 4 > blen - 32) bad('captured packet length exceeds its block or original length');
      const data = u8.slice(body + 20, body + 20 + caplen);
      packets.push({ ts, caplen, len, linktype: iface.linktype, data });
    } else if (type === 3) {
      if (blen < 16) bad('simple packet block is too short');
      const iface = ifaces[0];
      if (!iface) bad('simple packet references unknown interface 0');
      const len = dv.getUint32(body, little);
      // Simple packets omit caplen; the first interface's snaplen determines it.
      // The bytes added to align the block to four bytes are not packet payload.
      const caplen = iface.snaplen ? Math.min(len, iface.snaplen) : len;
      if (Math.ceil(caplen / 4) * 4 !== blen - 16) bad('simple packet length does not match its block');
      packets.push({ ts: 0, caplen, len, linktype: iface.linktype, data: u8.slice(body + 4, body + 4 + caplen) });
    }
    off += blen;
  }
  return { format: 'pcapng', packets };
}

/** Write packets ({ts, len, linktype, data}) as pcapng with microsecond timestamps. */
export function writePcapng(packets, { app = 'KonX' } = {}) {
  const linktypes = [...new Set(packets.map((p) => p.linktype ?? 1))];
  const ifIndex = new Map(linktypes.map((lt, i) => [lt, i]));
  const enc = new TextEncoder();
  const parts = [];
  const pad4 = (n) => (n + 3) & ~3;

  const option = (code, valueBytes) => {
    const b = new Uint8Array(4 + pad4(valueBytes.length));
    const dv = new DataView(b.buffer);
    dv.setUint16(0, code, true);
    dv.setUint16(2, valueBytes.length, true);
    b.set(valueBytes, 4);
    return b;
  };
  const block = (type, body) => {
    const len = 12 + body.length;
    const b = new Uint8Array(len);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, type, true);
    dv.setUint32(4, len, true);
    b.set(body, 8);
    dv.setUint32(len - 4, len, true);
    return b;
  };
  const concat = (arrs) => {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrs) {
      out.set(a, o);
      o += a.length;
    }
    return out;
  };

  // Section header with the user application option.
  const shb = new Uint8Array(16);
  const sdv = new DataView(shb.buffer);
  sdv.setUint32(0, 0x1a2b3c4d, true);
  sdv.setUint16(4, 1, true);
  sdv.setUint16(6, 0, true);
  sdv.setInt32(8, -1, true);
  sdv.setInt32(12, -1, true);
  parts.push(block(0x0a0d0d0a, concat([shb, option(4, enc.encode(app)), new Uint8Array(4)])));

  for (const lt of linktypes) {
    const idb = new Uint8Array(8);
    const dv = new DataView(idb.buffer);
    dv.setUint16(0, lt, true);
    dv.setUint32(4, 262144, true);
    parts.push(block(1, concat([idb, option(9, new Uint8Array([6])), new Uint8Array(4)])));
  }

  for (const p of packets) {
    const data = p.data;
    const body = new Uint8Array(20 + pad4(data.length));
    const dv = new DataView(body.buffer);
    const us = Math.round((p.ts || 0) * 1e6);
    dv.setUint32(0, ifIndex.get(p.linktype ?? 1), true);
    dv.setUint32(4, Math.floor(us / 2 ** 32), true);
    dv.setUint32(8, us % 2 ** 32, true);
    dv.setUint32(12, data.length, true);
    dv.setUint32(16, p.len || data.length, true);
    body.set(data, 20);
    parts.push(block(6, body));
  }
  return concat(parts);
}
