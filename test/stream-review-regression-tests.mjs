import assert from 'node:assert/strict';
import { parseHttpStream } from '../src/renderer/js/capture/http.mjs';
import { Analyzer } from '../src/renderer/js/capture/analyze.mjs';
import { decode } from '../src/renderer/js/capture/decode.mjs';
import * as P from './lib/packets.mjs';

const encoder = new TextEncoder();
function direction(fromA, text) {
  const data = encoder.encode(text);
  return {
    fromA, startKnown: true, closed: true, reset: false, limited: false, truncated: false,
    conflicts: [], warnings: [],
    ranges: [{ kind: 'data', start: 0, end: data.length, data, frames: [fromA ? 1 : 2] }],
  };
}
const stream = (request, response) => ({
  conv: { proto: 'TCP' }, directions: [direction(true, request), direction(false, response)],
});

export async function runStreamReviewRegressionTests(test) {
  await test('HTTP empty Transfer-Encoding cannot bypass conflicting Content-Length framing', async () => {
    for (const value of ['', ' , ']) {
      const result = await parseHttpStream(stream(
        'GET / HTTP/1.1\r\nHost: example.test\r\n\r\n',
        `HTTP/1.1 200 OK\r\nTransfer-Encoding: ${value}\r\nContent-Length: 2\r\n\r\nok`,
      ));
      const response = result.messages.find((message) => message.type === 'response');
      assert.equal(response.complete, false);
      assert.equal(response.exportable, false);
      assert.match(response.warnings.join(' '), /Transfer-Encoding.*Content-Length/);
    }
  });

  await test('HTTP requests with empty Transfer-Encoding cannot become invented bodyless messages', async () => {
    const result = await parseHttpStream(stream(
      'POST /upload HTTP/1.1\r\nTransfer-Encoding:\r\n\r\nGET /fake HTTP/1.1\r\n\r\n', '',
    ));
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].complete, false);
    assert.equal(result.messages[0].exportable, false);
    assert.match(result.messages[0].warnings.join(' '), /Transfer-Encoding/);
  });

  await test('TCP handshake timing retains a SYN at timestamp zero and a zero-duration RTT', () => {
    const analyzer = new Analyzer();
    const frames = [
      { ts: 0, seq: 100, ack: 0, flags: 'S', reverse: false },
      { ts: 0, seq: 900, ack: 101, flags: 'SA', reverse: true },
      { ts: 1, seq: 900, ack: 101, flags: 'SA', reverse: true },
    ];
    for (const [i, item] of frames.entries()) {
      const data = P.frame.tcp('02:00:00:00:00:01', '02:00:00:00:00:02',
        item.reverse ? '192.0.2.2' : '192.0.2.1', item.reverse ? '192.0.2.1' : '192.0.2.2',
        { sport: item.reverse ? 80 : 50000, dport: item.reverse ? 50000 : 80,
          seq: item.seq, ack: item.ack, flags: item.flags }, new Uint8Array());
      analyzer.ingest({ no: i + 1, ts: item.ts, len: data.length, caplen: data.length, data, d: decode(1, data) });
    }
    assert.deepEqual(analyzer.tcp.handshakes.map((handshake) => handshake.rtt), [0]);
    assert.equal(analyzer.streams[0].synTs, 0);
    assert.equal(analyzer.streams[0].rtt, 0);
  });
}
