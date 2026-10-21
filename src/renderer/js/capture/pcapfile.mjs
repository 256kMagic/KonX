// Read classic pcap and pcapng files; write pcapng (opens in Wireshark and tcpdump).

export const CAPTURE_READ_LIMITS = Object.freeze({ maxPackets: 1000000, maxBytes: 256 * 1024 * 1024 });

/** Captured records are bounded before allocation; coverage never proves that
 * the source capture observed every packet on the network. */
export function readCapture(bytes, options = {}) {
  const limits = { ...CAPTURE_READ_LIMITS };
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw new RangeError(`Invalid capture read limit: ${key}`);
    limits[key] = value;
  }
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 24) throw new Error('File is too short to be a capture');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = dv.getUint32(0, false);
  const state = { limits, bytes: 0, coverage: { examinedAllRecords: true, limited: false, truncated: false, missingTimestamps: 0, warnings: [] } };
  if (magic === 0x0a0d0d0a) return readPcapng(u8, dv, state);
  const le = dv.getUint32(0, true);
  if ([0xa1b2c3d4, 0xa1b23c4d].includes(magic) || [0xa1b2c3d4, 0xa1b23c4d].includes(le)) return readPcap(u8, dv, state);
  throw new Error('Unrecognized file format (expected .pcap or .pcapng)');
}

function allowRecord(state, packets, caplen) {
  if (packets.length >= state.limits.maxPackets || state.bytes + caplen > state.limits.maxBytes) {
    state.coverage.limited = true; state.coverage.examinedAllRecords = false;
    state.coverage.warnings.push('Capture packet/byte read limit reached; remaining records were not read.'); return false;
  }
  state.bytes += caplen; return true;
}
function finished(format, packets, state) {
  return { format, packets, coverage: { ...state.coverage, packetsRead: packets.length, capturedBytes: state.bytes } };
}
function readPcap(u8, dv, state) {
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
    if (caplen > 0x4000000 || off + caplen > u8.length) {
      state.coverage.examinedAllRecords = false;
      state.coverage.truncated = off + caplen > u8.length;
      state.coverage.limited = caplen > 0x4000000;
      state.coverage.warnings.push('Classic pcap record is truncated or exceeds the 64 MiB record limit.'); break;
    }
    if (!allowRecord(state, packets, caplen)) break;
    const timestampKnown = frac < (nano ? 1e9 : 1e6);
    if (!timestampKnown) state.coverage.missingTimestamps++;
    if (caplen > len && !state.coverage.warnings.includes('A captured record exceeds its declared original length.')) state.coverage.warnings.push('A captured record exceeds its declared original length.');
    packets.push({ ts: sec + frac / (nano ? 1e9 : 1e6), timestampKnown, caplen, len, linktype, data: u8.slice(off, off + caplen) });
    off += caplen;
  }
  if (off < u8.length && state.coverage.examinedAllRecords) { state.coverage.truncated = true; state.coverage.examinedAllRecords = false; state.coverage.warnings.push('Classic pcap ends with a partial record header.'); }
  return finished(nano ? 'pcap (ns)' : 'pcap', packets, state);
}

function readPcapng(u8, dv, state) {
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
      const iface = { linktype: dv.getUint16(body, little), snaplen: dv.getUint32(body + 4, little), tsdiv: 1e6, tsoffset: 0, timestampValid: true, name: '' };
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
        } else if (code === 14) {
          if (olen !== 8) bad('interface timestamp offset must be eight bytes');
          // PCAPNG if_tsoffset is signed seconds, applied per interface before
          // consumers calculate durations. Unsafe values remain unknown.
          iface.tsoffset = Number(dv.getBigInt64(o + 4, little));
          iface.timestampValid = iface.timestampValid && Number.isSafeInteger(iface.tsoffset);
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
      const ts = (dv.getUint32(body + 4, little) * 2 ** 32 + dv.getUint32(body + 8, little)) / iface.tsdiv + iface.tsoffset;
      const caplen = dv.getUint32(body + 12, little);
      const len = dv.getUint32(body + 16, little);
      if (caplen > len || Math.ceil(caplen / 4) * 4 > blen - 32) bad('captured packet length exceeds its block or original length');
      if (!allowRecord(state, packets, caplen)) break;
      const data = u8.slice(body + 20, body + 20 + caplen);
      const timestampKnown = iface.timestampValid && Number.isFinite(ts) && Math.abs(ts) * 1e6 <= Number.MAX_SAFE_INTEGER;
      if (!timestampKnown) {
        state.coverage.missingTimestamps++;
        if (!state.coverage.warnings.includes('A packet timestamp or interface offset is outside the supported precision range.')) state.coverage.warnings.push('A packet timestamp or interface offset is outside the supported precision range.');
      }
      packets.push({ ts, timestampKnown, caplen, len, linktype: iface.linktype, data });
    } else if (type === 3) {
      if (blen < 16) bad('simple packet block is too short');
      const iface = ifaces[0];
      if (!iface) bad('simple packet references unknown interface 0');
      const len = dv.getUint32(body, little);
      // Simple packets omit caplen; the first interface's snaplen determines it.
      // The bytes added to align the block to four bytes are not packet payload.
      const caplen = iface.snaplen ? Math.min(len, iface.snaplen) : len;
      if (Math.ceil(caplen / 4) * 4 !== blen - 16) bad('simple packet length does not match its block');
      if (!allowRecord(state, packets, caplen)) break;
      state.coverage.missingTimestamps++;
      packets.push({ ts: 0, timestampKnown: false, caplen, len, linktype: iface.linktype, data: u8.slice(body + 4, body + 4 + caplen) });
    }
    off += blen;
  }
  return finished('pcapng', packets, state);
}

/** Write packets ({ts, len, linktype, data}) as pcapng with microsecond timestamps. */
export function writePcapng(packets, { app = 'KonX', maxBytes = 256 * 1024 * 1024 } = {}) {
  if (!Array.isArray(packets) || packets.length > CAPTURE_READ_LIMITS.maxPackets) throw new Error('Capture export exceeds its packet limit');
  if (typeof app !== 'string' || app.length > 1024 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) throw new Error('Invalid capture export options');
  const linktypes = [...new Set(packets.map((p) => p.linktype ?? 1))];
  for (const linktype of linktypes) if (!Number.isInteger(linktype) || linktype < 0 || linktype > 65535) throw new Error('Invalid capture link type');
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
  const section = block(0x0a0d0d0a, concat([shb, option(4, enc.encode(app)), new Uint8Array(4)]));
  // SPBs have no timestamp or interface selector. A dedicated section with an
  // exact interface-0 snaplen preserves unknown times and captured truncation
  // across mixed link types using standard pcapng semantics.
  function* plan() {
    yield { kind: 'section', bytes: section.length };
    for (const linktype of linktypes) yield { kind: 'interface', linktype, snaplen: 0, bytes: 32 };
    let simple = null;
    for (const packet of packets) {
      const data = packet.data, len = packet.len ?? data?.length, linktype = packet.linktype ?? 1;
      if (!(data instanceof Uint8Array) || !Number.isInteger(len) || len < data.length || len > 0xffffffff) throw new Error('Invalid captured packet bytes or original length');
      const known = packet.timestampKnown !== false && Number.isFinite(packet.ts);
      const us = known ? Math.round(packet.ts * 1e6) : null;
      if (known && (!Number.isSafeInteger(us) || us < 0)) throw new Error('Capture timestamp is outside the supported microsecond range');
      if (!known) {
        if (!data.length && len > 0) throw new Error('A timestamp-free packet with zero captured bytes and a nonzero original length cannot be represented by a simple pcapng block');
        if (!simple || simple.linktype !== linktype || simple.snaplen !== data.length) {
          yield { kind: 'section', bytes: section.length };
          yield { kind: 'interface', linktype, snaplen: data.length, bytes: 32 };
          simple = { linktype, snaplen: data.length };
        }
        yield { kind: 'simple', packet, len, bytes: 16 + pad4(data.length) };
      } else {
        if (simple) {
          yield { kind: 'section', bytes: section.length };
          for (const linktype of linktypes) yield { kind: 'interface', linktype, snaplen: 0, bytes: 32 };
          simple = null;
        }
        yield { kind: 'enhanced', packet, len, us, bytes: 32 + pad4(data.length) };
      }
    }
  }
  // One owner accounts for packet padding, sections and interface options
  // before allocating any packet-sized output buffers.
  let total = 0;
  for (const entry of plan()) { total += entry.bytes; if (total > maxBytes) throw new Error('Capture export exceeds its serialized byte limit'); }
  for (const entry of plan()) {
    if (entry.kind === 'section') parts.push(section);
    else if (entry.kind === 'interface') {
      const idb = new Uint8Array(8), dv = new DataView(idb.buffer);
      dv.setUint16(0, entry.linktype, true); dv.setUint32(4, entry.snaplen, true);
      parts.push(block(1, concat([idb, option(9, new Uint8Array([6])), new Uint8Array(4)])));
    } else {
      const data = entry.packet.data, simple = entry.kind === 'simple';
      const body = new Uint8Array((simple ? 4 : 20) + pad4(data.length)), dv = new DataView(body.buffer);
      if (simple) dv.setUint32(0, entry.len, true);
      else {
        dv.setUint32(0, ifIndex.get(entry.packet.linktype ?? 1), true);
        dv.setUint32(4, Math.floor(entry.us / 2 ** 32), true); dv.setUint32(8, entry.us % 2 ** 32, true);
        dv.setUint32(12, data.length, true); dv.setUint32(16, entry.len, true);
      }
      body.set(data, simple ? 4 : 20); parts.push(block(simple ? 3 : 6, body));
    }
  }
  return concat(parts);
}
