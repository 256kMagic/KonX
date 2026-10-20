'use strict';
// Framing for the named pipe between KonX and its elevated capture helper.
//   frame = u32 length (of what follows) | u8 kind | body
//   kind 1: JSON message (UTF-8)
//   kind 2: packet batch = u32 count | f64 meta[count*4] | u16 linktypes[count] (padded to 8) | bytes
// meta is [ts, caplen, len, offset] per packet, the same layout the capture tab consumes.

const KIND_JSON = 1;
const KIND_BATCH = 2;
const MAX_FRAME = 64 * 1024 * 1024;

function frame(kind, body) {
  const head = Buffer.alloc(5);
  head.writeUInt32LE(body.length + 1, 0);
  head[4] = kind;
  return Buffer.concat([head, body]);
}

const encodeJson = (obj) => frame(KIND_JSON, Buffer.from(JSON.stringify(obj), 'utf8'));

/** batch: {buf: ArrayBuffer|Uint8Array, meta: ArrayBuffer|Float64Array, lts: ArrayBuffer|Uint16Array} */
function encodeBatch({ buf, meta, lts }) {
  const m = new Float64Array(meta instanceof ArrayBuffer ? meta : meta.buffer.slice(meta.byteOffset, meta.byteOffset + meta.byteLength));
  const count = m.length / 4;
  const ltBytes = Math.ceil((count * 2) / 8) * 8;
  const data = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  const body = Buffer.alloc(8 + m.byteLength + ltBytes + data.length);
  body.writeUInt32LE(count, 0);
  Buffer.from(m.buffer, m.byteOffset, m.byteLength).copy(body, 8);
  const l = lts instanceof ArrayBuffer ? new Uint16Array(lts) : lts;
  for (let i = 0; i < count; i++) body.writeUInt16LE(l ? l[i] : 1, 8 + m.byteLength + i * 2);
  body.set(data, 8 + m.byteLength + ltBytes);
  return frame(KIND_BATCH, body);
}

/** -> {buf, meta, lts} as standalone ArrayBuffers (ready to transfer to the renderer). */
function decodeBatch(body) {
  const count = body.readUInt32LE(0);
  const metaLen = count * 4 * 8;
  const ltBytes = Math.ceil((count * 2) / 8) * 8;
  if (8 + metaLen + ltBytes > body.length) throw new Error('Truncated packet batch');
  const copy = (start, end) => {
    const ab = new ArrayBuffer(end - start);
    new Uint8Array(ab).set(body.subarray(start, end));
    return ab;
  };
  const meta = copy(8, 8 + metaLen);
  const lts = copy(8 + metaLen, 8 + metaLen + count * 2);
  const buf = copy(8 + metaLen + ltBytes, body.length);
  // Every packet must lie inside the byte area.
  const m = new Float64Array(meta);
  for (let i = 0; i < m.length; i += 4) {
    if (!(m[i + 3] >= 0 && m[i + 1] >= 0 && m[i + 3] + m[i + 1] <= buf.byteLength)) throw new Error('Packet outside its batch');
  }
  return { buf, meta, lts };
}

/** Collects stream chunks and calls onFrame(kind, body) for each complete frame. */
class FrameReader {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.chunks = [];
    this.size = 0;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size >= 4) {
      const head = this.peek(4);
      const len = head.readUInt32LE(0);
      if (len < 1 || len > MAX_FRAME) throw new Error(`Bad frame length ${len}`);
      if (this.size < 4 + len) return;
      const all = this.take(4 + len);
      this.onFrame(all[4], all.subarray(5));
    }
  }

  peek(n) {
    if (this.chunks[0].length >= n) return this.chunks[0];
    const b = Buffer.concat(this.chunks);
    this.chunks = [b];
    return b;
  }

  take(n) {
    const b = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = b.subarray(0, n);
    const rest = b.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    return out;
  }
}

module.exports = { KIND_JSON, KIND_BATCH, encodeJson, encodeBatch, decodeBatch, FrameReader };
