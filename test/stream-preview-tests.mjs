import assert from 'node:assert/strict';
import { Analyzer } from '../src/renderer/js/capture/analyze.mjs';
import { decode } from '../src/renderer/js/capture/decode.mjs';
import { buildStreamPreview } from '../src/renderer/js/capture/stream-preview.mjs';
import * as P from './lib/packets.mjs';

const A = 'aa:aa:aa:00:00:01';
const B = 'bb:bb:bb:00:00:02';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function packet(proto, seq, payload, reverse = false) {
  const data = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const endpoints = [
    reverse ? B : A, reverse ? A : B,
    reverse ? '10.0.0.2' : '10.0.0.1', reverse ? '10.0.0.1' : '10.0.0.2',
  ];
  const transport = { sport: reverse ? 9000 : 50000, dport: reverse ? 50000 : 9000, seq, flags: 'PA' };
  return proto === 'TCP' ? P.frame.tcp(...endpoints, transport, data) : P.frame.udp(...endpoints, transport, data);
}
function streamFrom(frames, proto = 'TCP') {
  const analyzer = new Analyzer();
  const packets = frames.map((data, i) => {
    const packet = { no: i + 1, ts: i * 0.001, caplen: data.length, len: data.length, data, lt: 1 };
    packet.d = decode(1, data);
    analyzer.ingest(packet);
    return packet;
  });
  return analyzer.followStream(packets, 0, proto);
}

export async function runStreamPreviewTests(test) {
  console.log('packet capture: bounded directional stream preview');

  await test('TCP preview decodes split UTF-8 and searches text across packet boundaries', () => {
    const text = 'prefix café 🦊 tail';
    const bytes = encoder.encode(text);
    const slices = [bytes.subarray(0, 11), bytes.subarray(11, 14), bytes.subarray(14)];
    let seq = 100;
    const stream = streamFrom(slices.map((slice) => {
      const result = packet('TCP', seq, slice);
      seq += slice.length;
      return result;
    }));
    const preview = buildStreamPreview(stream);
    assert.equal(preview.blocks.length, 1);
    assert.equal(decoder.decode(preview.blocks[0].data), text);
    assert.ok(decoder.decode(preview.blocks[0].data).includes('café 🦊'));
    assert.deepEqual(preview.blocks[0].frames, [1, 2, 3]);
    assert.deepEqual([preview.blocks[0].start, preview.blocks[0].end], [0, bytes.length]);
    assert.equal(preview.truncated, false);
  });

  await test('directional preview never joins opposite endpoints or bytes across gaps', () => {
    const stream = streamFrom([
      packet('TCP', 100, 'client'),
      packet('TCP', 400, 'server', true),
      packet('TCP', 110, 'tail'),
    ]);
    // Preview order is defined by endpoint direction even if callers store the
    // canonical directions in a different order.
    stream.directions.reverse();
    const preview = buildStreamPreview(stream);
    assert.deepEqual(preview.blocks.map((block) => block.kind === 'data'
      ? [block.kind, block.fromA, decoder.decode(block.data)]
      : [block.kind, block.fromA, block.length]), [
      ['data', true, 'client'],
      ['gap', true, 4],
      ['data', true, 'tail'],
      ['data', false, 'server'],
    ]);
    assert.equal(preview.truncated, false);
  });

  await test('UDP preview keeps every datagram distinct including empty payloads', () => {
    const stream = streamFrom([
      packet('UDP', 0, 'one'),
      packet('UDP', 0, ''),
      packet('UDP', 0, 'two'),
      packet('UDP', 0, 'reply', true),
    ], 'UDP');
    const preview = buildStreamPreview(stream);
    assert.deepEqual(preview.blocks.map((block) => [block.fromA, decoder.decode(block.data), block.frames]), [
      [true, 'one', [1]], [true, '', [2]], [true, 'two', [3]], [false, 'reply', [4]],
    ]);
    assert.deepEqual(preview.blocks.map((block) => [block.start, block.end]), [[0, 3], [3, 3], [3, 6], [0, 5]]);
    assert.equal(preview.truncated, false);
  });

  await test('50,000 contiguous TCP packet segments form one bounded directional block', () => {
    const count = 50000;
    const stream = streamFrom(Array.from({ length: count }, (_, i) => packet('TCP', 100 + i, 'x')));
    assert.equal(stream.limited, false);
    assert.equal(stream.directions[0].ranges.length, count);
    const preview = buildStreamPreview(stream);
    assert.equal(preview.blocks.length, 1);
    assert.equal(preview.blocks[0].data.length, count);
    assert.equal(preview.blocks[0].frames.length, count);
    assert.equal(preview.blocks[0].data.every((value) => value === 120), true);
    assert.equal(preview.truncated, false);
  });

  await test('byte budget clips only captured bytes and provenance and reports remaining directions', () => {
    const stream = streamFrom([
      packet('TCP', 100, 'abc'),
      packet('TCP', 103, 'def'),
      packet('TCP', 400, 'reply', true),
    ]);
    const clipped = buildStreamPreview(stream, { maxBytes: 4 });
    assert.deepEqual(clipped.blocks.map((block) => decoder.decode(block.data)), ['abcd']);
    assert.deepEqual(clipped.blocks[0].frames, [1, 2]);
    assert.equal(clipped.blocks[0].end, 4);
    assert.equal(clipped.truncated, true);
    const firstOnly = buildStreamPreview(stream, { maxBytes: 3 });
    assert.deepEqual(firstOnly.blocks[0].frames, [1]);
    const exactlyOneDirection = buildStreamPreview(stream, { maxBytes: 6 });
    assert.equal(exactlyOneDirection.blocks.length, 1);
    assert.equal(exactlyOneDirection.truncated, true);
    const all = buildStreamPreview(stream, { maxBytes: 11 });
    assert.equal(all.truncated, false);
    assert.equal(all.blocks.reduce((n, block) => n + block.data.length, 0), 11);
  });

  await test('block budget counts gaps and empty datagrams and never silently omits them', () => {
    const tcp = streamFrom([packet('TCP', 100, 'a'), packet('TCP', 104, 'b')]);
    const gapLimited = buildStreamPreview(tcp, { maxBlocks: 2 });
    assert.deepEqual(gapLimited.blocks.map((block) => block.kind), ['data', 'gap']);
    assert.equal(gapLimited.truncated, true);
    const bytesLimited = buildStreamPreview(tcp, { maxBytes: 1 });
    assert.deepEqual(bytesLimited.blocks.map((block) => block.kind), ['data', 'gap']);
    assert.equal(bytesLimited.truncated, true);
    const udp = streamFrom([packet('UDP', 0, ''), packet('UDP', 0, ''), packet('UDP', 0, '')], 'UDP');
    const emptyLimited = buildStreamPreview(udp, { maxBlocks: 2 });
    assert.equal(emptyLimited.blocks.length, 2);
    assert.equal(emptyLimited.truncated, true);
    assert.equal(buildStreamPreview(udp, { maxBlocks: 3, maxBytes: 1 }).truncated, false);
    const one = streamFrom([packet('UDP', 0, 'a')], 'UDP');
    assert.equal(buildStreamPreview(one, { maxBytes: 1, maxBlocks: 1 }).truncated, false);
  });

  await test('preview limits can only be lowered to positive integer bounds', () => {
    const stream = streamFrom([packet('TCP', 100, 'data')]);
    for (const options of [
      { maxBytes: 256 * 1024 + 1 }, { maxBlocks: 201 }, { maxBytes: 0 },
      { maxBlocks: -1 }, { maxBytes: 1.5 }, { maxBlocks: Infinity }, { unknown: 1 },
    ]) assert.throws(() => buildStreamPreview(stream, options), /Invalid stream preview limit/);
    for (const options of [null, [], 'small']) assert.throws(() => buildStreamPreview(stream, options), /Invalid stream preview options/);
  });
}
