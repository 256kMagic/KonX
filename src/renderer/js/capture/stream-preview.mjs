// Display grouping belongs here rather than in packet-level decoding. A TCP
// character or search term may span many packets, but never an unknown gap.
const LIMITS = Object.freeze({ maxBytes: 256 * 1024, maxBlocks: 200 });

export function buildStreamPreview(stream, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Invalid stream preview options.');
  const limits = { ...LIMITS };
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) {
      throw new RangeError(`Invalid stream preview limit: ${key}`);
    }
    limits[key] = value;
  }
  const blocks = [];
  let remaining = limits.maxBytes;
  // This view presents each direction in sequence order, not an inferred
  // cross-direction message chronology.
  const directions = [true, false].map((fromA) => stream.directions.find((direction) => direction.fromA === fromA));
  for (const direction of directions) {
    if (!direction) continue;
    const ranges = direction.ranges;
    for (let i = 0; i < ranges.length;) {
      if (blocks.length >= limits.maxBlocks) return { blocks, truncated: true };
      const first = ranges[i];
      if (first.kind === 'gap') {
        blocks.push({ kind: 'gap', fromA: direction.fromA, length: first.length });
        i++;
        continue;
      }
      let next = i + 1;
      let available = first.data.length;
      if (stream.conv.proto === 'TCP') {
        while (next < ranges.length && ranges[next].kind === 'data' && ranges[next - 1].end === ranges[next].start) {
          available += ranges[next].data.length;
          next++;
        }
      }
      if (available && !remaining) return { blocks, truncated: true };
      const length = Math.min(available, remaining);
      const data = new Uint8Array(length);
      const frames = new Set();
      let offset = 0;
      for (let r = i; r < next; r++) {
        const range = ranges[r];
        const count = Math.min(range.data.length, length - offset);
        if (count || !available) {
          data.set(range.data.subarray(0, count), offset);
          for (const frame of range.frames) frames.add(frame);
        }
        offset += count;
        if (offset === length && available) break;
      }
      blocks.push({
        kind: 'data', fromA: direction.fromA, data, frames: [...frames],
        start: first.start, end: first.start + length,
      });
      remaining -= length;
      if (length < available) return { blocks, truncated: true };
      i = next;
    }
  }
  return { blocks, truncated: false };
}
