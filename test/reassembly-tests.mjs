import assert from 'node:assert/strict';
import { Analyzer } from '../src/renderer/js/capture/analyze.mjs';
import { decode } from '../src/renderer/js/capture/decode.mjs';
import { reassembleStream } from '../src/renderer/js/capture/reassemble.mjs';
import * as P from './lib/packets.mjs';

const A = 'aa:aa:aa:00:00:01';
const B = 'bb:bb:bb:00:00:02';
function tcp(seq, text = '', flags = 'PA', reverse = false) {
  return { data: P.frame.tcp(
    reverse ? B : A, reverse ? A : B, reverse ? '10.0.0.2' : '10.0.0.1', reverse ? '10.0.0.1' : '10.0.0.2',
    { sport: reverse ? 80 : 50000, dport: reverse ? 50000 : 80, seq, flags }, P.str(text),
  ) };
}
function udp(text, reverse = false) {
  return { data: P.frame.udp(
    reverse ? B : A, reverse ? A : B, reverse ? '10.0.0.2' : '10.0.0.1', reverse ? '10.0.0.1' : '10.0.0.2',
    { sport: reverse ? 9000 : 50000, dport: reverse ? 50000 : 9000 }, P.str(text),
  ) };
}
function tcp6(seq, text = '', flags = 'PA', fragment = null) {
  const transport = P.tcp({ sport: 50000, dport: 80, seq, flags }, P.str(text));
  const payload = fragment === null ? transport : P.concat([6, 0], P.u16(fragment), P.u32(1234), transport);
  const src = new Uint8Array(16); src[15] = 1;
  const dst = new Uint8Array(16); dst[15] = 2;
  const packet = P.concat([0x60, 0, 0, 0], P.u16(payload.length), [fragment === null ? 6 : 44, 64], src, dst, payload);
  return { data: P.eth(B, A, 0x86dd, packet) };
}
function analyze(items, proto = 'TCP', limits) {
  const analyzer = new Analyzer();
  const packets = items.map((item, i) => {
    const packet = { no: i + 1, ts: i * 0.01, caplen: item.data.length, len: item.len ?? item.data.length, data: item.data, lt: 1 };
    packet.d = decode(1, packet.data);
    analyzer.ingest(packet);
    return packet;
  });
  const conv = analyzer.streams.find((stream) => stream.proto === proto);
  assert.ok(conv, 'decoded packets should create a conversation');
  const result = limits ? reassembleStream(packets, conv, limits) : analyzer.followStream(packets, conv.id, proto);
  return { result, packets, analyzer, direction: result.directions[0] };
}
const textOf = (direction) => new TextDecoder().decode(P.concat(direction.ranges.filter((r) => r.kind === 'data').map((r) => r.data)));
const gapsOf = (direction) => direction.ranges.filter((r) => r.kind === 'gap');

export async function runReassemblyTests(test) {
  await test('TCP unresolved gap and overlapping later segments preserve only captured bytes', () => {
    const { result, direction } = analyze([tcp(100, '', 'S'), tcp(105, 'ABC'), tcp(107, 'CDE')]);
    assert.equal(textOf(direction), 'ABCDE');
    assert.deepEqual(gapsOf(direction), [{ kind: 'gap', start: 0, end: 4, length: 4 }]);
    assert.equal(direction.conflicts.length, 0);
    assert.equal(direction.complete, false);
    const gap = direction.ranges.find((range) => range.kind === 'gap');
    assert.equal(gap.length, 4);
    assert.equal(Object.hasOwn(gap, 'data'), false);
    assert.equal(result.directions.map(textOf).join(''), 'ABCDE');
    assert.ok(direction.ranges.every((r) => r.end >= r.start));
  });

  await test('TCP conflicting overlaps retain first observations and identify both frames', () => {
    const { direction } = analyze([tcp(100, '', 'S'), tcp(101, 'ABCDE'), tcp(103, 'XYZZ')]);
    assert.equal(textOf(direction), 'ABCDEZ');
    assert.deepEqual(direction.conflicts, [{ start: 2, end: 5, frames: [2, 3] }]);
    assert.equal(direction.complete, false);
    const overlap = direction.ranges.find((r) => r.start === 2);
    assert.deepEqual(overlap.frames, [2, 3]);
    assert.deepEqual(overlap.sources.map((s) => [s.frame, s.start, s.end, s.packetOffset]), [[2, 2, 5, 56], [3, 2, 5, 54]]);
  });

  await test('TCP preserves earlier out-of-order data when capture begins midstream', () => {
    const { direction } = analyze([tcp(105, 'EFGH'), tcp(101, 'ABCD')]);
    assert.equal(textOf(direction), 'ABCDEFGH');
    assert.equal(direction.sequenceStart, 101);
    assert.equal(direction.startKnown, false);
    assert.deepEqual(gapsOf(direction), []);
    assert.equal(direction.ranges[0].frames[0], 2);
  });

  await test('TCP sequence wrap and out-of-order arrival produce a complete direction', () => {
    const { direction } = analyze([
      tcp(0xfffffffd, '', 'S'), tcp(2, 'EF'), tcp(0xfffffffe, 'ABCD'), tcp(4, '', 'FA'),
    ]);
    assert.equal(textOf(direction), 'ABCDEF');
    assert.equal(direction.sequenceStart, 0xfffffffe);
    assert.equal(direction.startKnown, true);
    assert.equal(direction.closed, true);
    assert.equal(direction.complete, true);
  });

  await test('TCP SYN payload consumes its sequence byte and retains its application data', () => {
    const { direction } = analyze([tcp(100, 'ABC', 'S'), tcp(104, 'D'), tcp(105, '', 'FA')]);
    assert.equal(textOf(direction), 'ABCD');
    assert.equal(direction.sequenceStart, 101);
    assert.equal(direction.complete, true);
  });

  await test('TCP retransmission deduplicates data while retaining retransmission provenance', () => {
    const { direction } = analyze([
      tcp(100, '', 'S'), tcp(101, 'ABC'), tcp(104, 'D'), tcp(101, 'ABC'), tcp(105, '', 'FA'),
    ]);
    assert.equal(textOf(direction), 'ABCD');
    assert.deepEqual(direction.ranges[0].frames, [2, 4]);
    assert.equal(direction.complete, true);
    assert.equal(direction.conflicts.length, 0);
  });

  await test('TCP observed FIN exposes missing tail bytes and reset remains distinct from close', () => {
    const { direction } = analyze([tcp(100, '', 'S'), tcp(101, 'AB'), tcp(106, '', 'FA')]);
    assert.deepEqual(gapsOf(direction), [{ kind: 'gap', start: 2, end: 5, length: 3 }]);
    assert.equal(direction.closed, true);
    assert.equal(direction.complete, false);
    const reset = analyze([tcp(100, '', 'S'), tcp(101, 'AB', 'RA')]).direction;
    assert.equal(reset.reset, true);
    assert.equal(reset.closed, false);
    assert.equal(reset.complete, false);
  });

  await test('TCP capture truncation stays explicit even if the truncated packet carries FIN', () => {
    const full = tcp(101, 'abcdef', 'FA');
    const clipped = { data: full.data.slice(0, -3), len: full.data.length };
    const { direction } = analyze([tcp(100, '', 'S'), clipped]);
    assert.equal(textOf(direction), 'abc');
    assert.equal(direction.closed, true);
    assert.equal(direction.truncated, true);
    assert.equal(direction.complete, false);
    assert.ok(direction.warnings.some((w) => /truncated/.test(w)));
  });

  await test('IPv4 first fragments preserve bytes but cannot establish complete transport content', () => {
    const fragment = tcp(101, 'ABCD');
    fragment.data.set([0x20, 0], 14 + 6); // More fragments, offset zero.
    fragment.data.set([0, 0], 14 + 10); // Checksum omitted by the synthetic capture.
    const { packets, direction } = analyze([tcp(100, '', 'S'), fragment, tcp(105, '', 'FA')]);
    assert.equal(packets[1].d.fragmented, true);
    assert.equal(textOf(direction), 'ABCD');
    assert.equal(direction.startKnown, true);
    assert.equal(direction.closed, true);
    assert.equal(direction.truncated, true);
    assert.equal(direction.complete, false);
    assert.ok(direction.warnings.some((w) => /IP fragments/.test(w)));
    fragment.data.set([0, 1], 14 + 6); // A later fragment has no transport header.
    assert.equal(decode(1, fragment.data).fragmented, true);
  });

  await test('IPv6 first fragments mark incomplete transport while atomic fragments remain complete', () => {
    for (const fragment of [1, 0, null]) {
      const { packets, direction } = analyze([tcp6(100, '', 'S'), tcp6(101, 'ABCD', 'PA', fragment), tcp6(105, '', 'FA')]);
      assert.equal(!!packets[1].d.fragmented, fragment === 1);
      assert.equal(textOf(direction), 'ABCD');
      assert.equal(direction.startKnown, true);
      assert.equal(direction.closed, true);
      assert.equal(direction.truncated, fragment === 1);
      assert.equal(direction.complete, fragment !== 1);
      assert.equal(direction.warnings.some((w) => /IP fragments/.test(w)), fragment === 1);
    }
    assert.equal(decode(1, tcp6(101, 'ABCD', 'PA', 8).data).fragmented, true);
  });

  await test('TCP directions retain separate sequence spaces and frame provenance', () => {
    const { result } = analyze([
      tcp(100, '', 'S'), tcp(700, '', 'SA', true), tcp(101, 'request'), tcp(701, 'response', 'PA', true),
    ]);
    assert.equal(textOf(result.directions[0]), 'request');
    assert.equal(textOf(result.directions[1]), 'response');
    assert.deepEqual(result.directions.map((direction) => direction.fromA), [true, false]);
    assert.deepEqual(result.directions.map((direction) => direction.sequenceStart), [101, 701]);
    assert.deepEqual(result.directions.map((direction) => direction.ranges[0].frames), [[3], [4]]);
  });

  await test('UDP reconstruction preserves datagram boundaries, empty messages and directions', () => {
    const { result, direction } = analyze([udp('first'), udp(''), udp('reply', true), udp('last')], 'UDP');
    assert.deepEqual(direction.ranges.map((r) => new TextDecoder().decode(r.data)), ['first', '', 'last']);
    assert.ok(direction.ranges.every((r) => r.datagram));
    assert.equal(textOf(result.directions[1]), 'reply');
    assert.equal(direction.complete, true);
    assert.equal(direction.sequenceStart, null);
  });

  await test('TCP interval reconstruction agrees with an independent byte oracle across mixed overlaps', () => {
    let seed = 0x24681357;
    const random = (max) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    for (let sample = 0; sample < 40; sample++) {
      const base = sample % 2 ? 0xfffffff0 : 100;
      const expected = new Array(40);
      const conflicts = new Set();
      const items = [tcp((base - 1) >>> 0, '', 'S')];
      for (let n = 0; n < 20; n++) {
        const start = random(38);
        const length = 1 + random(Math.min(8, 40 - start));
        const text = Array.from({ length }, () => String.fromCharCode(65 + random(5))).join('');
        items.push(tcp((base + start) >>> 0, text));
        for (let b = 0; b < length; b++) {
          if (expected[start + b] === undefined) expected[start + b] = text.charCodeAt(b);
          else if (expected[start + b] !== text.charCodeAt(b)) conflicts.add(start + b);
        }
      }
      items.push(tcp((base + 40) >>> 0, '', 'FA'));
      const { direction } = analyze(items);
      const actual = new Array(40);
      for (const range of direction.ranges) {
        if (range.kind === 'data') for (let i = 0; i < range.data.length; i++) actual[range.start + i] = range.data[i];
        else for (let i = range.start; i < range.end; i++) assert.equal(expected[i], undefined);
      }
      assert.deepEqual(actual, expected);
      for (const position of conflicts) assert.ok(direction.conflicts.some((c) => c.start <= position && position < c.end));
      assert.ok(direction.conflicts.every((c) => [...conflicts].some((position) => c.start <= position && position < c.end)));
    }
  });

  await test('Reassembly caps return explicit partial state instead of fabricated completeness', () => {
    const items = [tcp(100, '', 'S'), tcp(101, 'ABC'), tcp(104, 'DEF'), tcp(107, '', 'FA')];
    for (const limits of [{ maxBytes: 3 }, { maxPackets: 2 }, { maxScanPackets: 2 }, { maxRanges: 1 }, { maxProvenance: 1 }]) {
      const { result } = analyze(items, 'TCP', limits);
      assert.equal(result.limited, true, JSON.stringify(limits));
      assert.ok(result.directions.every((d) => d.limited && !d.complete));
      assert.ok(result.warnings.length);
    }
    const span = analyze([tcp(100, '', 'S'), tcp(1000, 'x')], 'TCP', { maxSpan: 100 });
    assert.equal(span.result.limited, true);
    const compare = analyze([tcp(100, '', 'S'), tcp(101, 'ABC'), tcp(101, 'ABC')], 'TCP', { maxWorkBytes: 1 });
    assert.equal(compare.result.limited, true);
    assert.equal(compare.direction.ranges.length, 0, 'unexamined overlaps must not be published as validated data');
  });

  await test('Reassembly rejects unbounded or unknown limit overrides', () => {
    const { result, packets } = analyze([tcp(100, '', 'S')]);
    for (const limits of [{ maxBytes: Infinity }, { maxBytes: 0 }, { maxBytes: 1e12 }, { unknown: 1 }]) {
      assert.throws(() => reassembleStream(packets, result.conv, limits), RangeError);
    }
  });
}
