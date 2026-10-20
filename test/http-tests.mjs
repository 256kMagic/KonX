import assert from 'node:assert/strict';
import { gzipSync, deflateSync } from 'node:zlib';
import { parseHttpStream } from '../src/renderer/js/capture/http.mjs';
import { Analyzer } from '../src/renderer/js/capture/analyze.mjs';
import { decode } from '../src/renderer/js/capture/decode.mjs';
import * as P from './lib/packets.mjs';

const enc = new TextEncoder();
const bytes = (value) => typeof value === 'string' ? enc.encode(value) : value;
function direction(fromA, parts, options = {}) {
  let offset = 0;
  return {
    fromA, startKnown: true, closed: true, reset: false, limited: false, truncated: false,
    conflicts: [], warnings: [],
    ranges: parts.map((part, i) => {
      if (typeof part === 'number') {
        const gap = { kind: 'gap', start: offset, end: offset + part, length: part };
        offset += part;
        return gap;
      }
      const data = bytes(part), frame = (fromA ? 1 : 101) + i;
      const range = { kind: 'data', start: offset, end: offset + data.length, data, frames: [frame], sources: [{ frame, start: offset, end: offset + data.length, packetOffset: 54 }] };
      offset += data.length;
      return range;
    }),
    ...options,
  };
}
function stream(request, response, requestOptions = {}, responseOptions = {}) {
  return {
    conv: { proto: 'TCP' }, limited: false, warnings: [],
    directions: [direction(true, request, requestOptions), direction(false, response, responseOptions)],
  };
}
const get = 'GET /example HTTP/1.1\r\nHost: example.test\r\n\r\n';
const response = (body, headers = '', status = '200 OK') => P.concat(
  bytes(`HTTP/1.1 ${status}\r\nContent-Length: ${bytes(body).length}\r\n${headers}\r\n`), bytes(body),
);
const onlyResponse = (result) => result.messages.find((m) => m.type === 'response');

export async function runHttpTests(test) {
  console.log('readable traffic: HTTP/1');
  await test('HTTP parses split headers and JSON bodies with all source packets', async () => {
    const r = await parseHttpStream(stream(
      ['POST /api/status HT', 'TP/1.1\r\nHost: box.test\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{"x', '":1}'],
      ['HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":', 'true}'],
    ));
    assert.equal(r.recognized, true);
    assert.equal(r.exchanges.length, 1);
    assert.equal(r.exchanges[0].request.method, 'POST');
    assert.equal(r.exchanges[0].response.status, 201);
    assert.equal(r.exchanges[0].request.text, '{\n  "x": 1\n}');
    assert.equal(r.exchanges[0].response.text, '{\n  "ok": true\n}');
    assert.deepEqual(r.exchanges[0].request.frames, [1, 2, 3]);
    assert.deepEqual(r.exchanges[0].response.frames, [101, 102]);
    assert.equal(r.exchanges[0].response.exportable, true);
  });
  await test('HTTP dechunks bodies and trailers without exporting chunk syntax', async () => {
    const r = await parseHttpStream(stream([get], [
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n4;test=yes\r\nWi',
      'ki\r\n5\r\npedia\r\n0\r\nX-Checksum: known\r\n\r\n',
    ]));
    const m = onlyResponse(r);
    assert.equal(m.text, 'Wikipedia');
    assert.equal(m.framing, 'chunked');
    assert.deepEqual(m.trailers, [{ name: 'X-Checksum', value: 'known' }]);
    assert.equal(m.exportable, true);
    assert.equal(new TextDecoder().decode(m.body), 'Wikipedia');
  });
  await test('HTTP pairs pipelined responses, informational status and HEAD semantics', async () => {
    const r = await parseHttpStream(stream([
      'HEAD /a HTTP/1.1\r\nHost: x\r\n\r\nGET /b HTTP/1.1\r\nHost: x\r\n\r\n',
    ], [
      'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 999\r\nContent-Encoding: gzip\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok',
    ]));
    assert.equal(r.exchanges.length, 2);
    assert.equal(r.exchanges[0].informational[0].status, 100);
    assert.equal(r.exchanges[0].response.body.length, 0);
    assert.equal(r.exchanges[0].response.complete, true);
    assert.equal(r.exchanges[0].response.exportable, true);
    assert.equal(r.exchanges[1].response.text, 'ok');
  });
  await test('HTTP 204 and 304 responses do not consume the next message as body', async () => {
    const r = await parseHttpStream(stream([get + get], [
      'HTTP/1.1 204 No Content\r\n\r\nHTTP/1.1 304 Not Modified\r\nContent-Length: 1000\r\n\r\n',
    ]));
    assert.deepEqual(r.exchanges.map((x) => x.response.status), [204, 304]);
    assert.ok(r.exchanges.every((x) => x.response.complete && x.response.body.length === 0));
  });
  await test('HTTP CONNECT and 101 stop parsing before tunnel or upgraded payload', async () => {
    const connected = await parseHttpStream(stream(
      ['CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n'],
      ['HTTP/1.1 200 Connection Established\r\n\r\n\u0016\u0003\u0003HTTP/1.1 200 fake\r\n\r\n'],
    ));
    assert.equal(connected.messages.length, 2);
    assert.equal(onlyResponse(connected).body.length, 0);
    assert.match(connected.warnings.join(' '), /switches protocol/);
    const upgraded = await parseHttpStream(stream([get], ['HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\nrandom']));
    assert.equal(onlyResponse(upgraded).complete, true);
    assert.match(upgraded.warnings.join(' '), /switches protocol/);
  });
  await test('HTTP bodyless semantics take precedence over contradictory framing fields', async () => {
    const r = await parseHttpStream(stream(['HEAD /a HTTP/1.1\r\n\r\n' + get], [
      'HTTP/1.1 200 OK\r\nContent-Length: invalid\r\nTransfer-Encoding: chunked\r\n\r\n' +
      'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok',
    ]));
    assert.equal(r.exchanges[0].response.complete, true);
    assert.equal(r.exchanges[0].response.body.length, 0);
    assert.match(r.exchanges[0].response.warnings.join(' '), /ignored/);
    assert.equal(r.exchanges[1].response.text, 'ok');
    const tunnel = await parseHttpStream(stream(['CONNECT host:443 HTTP/1.1\r\n\r\n'], [
      'HTTP/1.1 200 OK\r\nContent-Length: invalid\r\nTransfer-Encoding: chunked\r\n\r\nopaque',
    ]));
    assert.equal(onlyResponse(tunnel).complete, true);
    assert.equal(onlyResponse(tunnel).body.length, 0);
  });
  await test('HTTP gaps remain explicit and do not join an incomplete body to later bytes', async () => {
    const r = await parseHttpStream(stream([get], ['HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nab', 2, 'ef']));
    const m = onlyResponse(r);
    assert.equal(m.text, 'ab');
    assert.equal(m.complete, false);
    assert.equal(m.exportable, false);
    assert.match(r.warnings.join(' '), /2 missing TCP bytes/);
  });
  await test('HTTP complete messages before a later gap retain their verified body', async () => {
    const r = await parseHttpStream(stream([get], [response('ok'), 8, 'unknown']));
    assert.equal(onlyResponse(r).exportable, true);
    assert.equal(onlyResponse(r).text, 'ok');
    assert.match(r.warnings.join(' '), /stops/);
  });
  await test('HTTP incomplete headers produce an incomplete message instead of guessed content', async () => {
    const r = await parseHttpStream(stream([get], ['HTTP/1.1 200 OK\r\nContent-Length: 3\r\n']));
    assert.equal(onlyResponse(r).complete, false);
    assert.equal(onlyResponse(r).body.length, 0);
    assert.match(onlyResponse(r).warnings.join(' '), /headers are incomplete/);
  });
  await test('HTTP conflicting overlaps and capture truncation disable body export', async () => {
    const conflicted = await parseHttpStream(stream([get], [response('ok')], {}, { conflicts: [{ start: 20, end: 24, frames: [101, 102] }] }));
    assert.equal(onlyResponse(conflicted).exportable, false);
    assert.match(onlyResponse(conflicted).warnings.join(' '), /Conflicting TCP overlap/);
    const truncated = await parseHttpStream(stream([get], [response('ok')], {}, { truncated: true }));
    assert.equal(onlyResponse(truncated).exportable, false);
    assert.match(onlyResponse(truncated).warnings.join(' '), /Truncated captured packets/);
  });
  await test('HTTP close-delimited bodies require orderly captured FIN', async () => {
    const full = await parseHttpStream(stream([get], ['HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\nhello']));
    assert.equal(onlyResponse(full).exportable, true);
    for (const flags of [{ closed: false }, { reset: true }, { limited: true }]) {
      const r = await parseHttpStream(stream([get], ['HTTP/1.0 200 OK\r\n\r\nhello'], {}, flags));
      assert.equal(onlyResponse(r).exportable, false);
    }
  });
  await test('HTTP capture beginning midstream does not assert request/response pairing', async () => {
    const r = await parseHttpStream(stream([get], [response('ok')], { startKnown: false }, { startKnown: false }));
    assert.equal(r.exchanges.length, 2);
    assert.ok(r.exchanges.every((e) => !(e.request && e.response)));
    assert.equal(onlyResponse(r).exportable, false);
    assert.match(r.warnings.join(' '), /pairing is not asserted/);
  });
  await test('HTTP ambiguous framing, folded headers and unsupported transfer encodings fail closed', async () => {
    const headers = [
      'Content-Length: 2\r\nContent-Length: 3',
      'Content-Length: nope',
      'Content-Length: 2\r\nTransfer-Encoding: chunked',
      'Transfer-Encoding: gzip, chunked',
      'X-Test: one\r\n two',
    ];
    for (const header of headers) {
      const r = await parseHttpStream(stream([get], [`HTTP/1.1 200 OK\r\n${header}\r\n\r\nok`]));
      const m = onlyResponse(r);
      assert.equal(m.complete, false, header);
      assert.equal(m.exportable, false, header);
      assert.ok(m.warnings.length, header);
    }
  });
  await test('HTTP accepts identical Content-Length fields without changing body boundary', async () => {
    const r = await parseHttpStream(stream([get], ['HTTP/1.1 200 OK\r\nContent-Length: 2, 2\r\nContent-Length: 2\r\n\r\nok']));
    assert.equal(onlyResponse(r).text, 'ok');
    assert.equal(onlyResponse(r).complete, true);
  });
  await test('HTTP rejects control bytes before normalizing header whitespace', async () => {
    for (const control of ['\v', '\r', '\f', '\n', '\u0000', '\u001f', '\u007f']) {
      for (const value of [control + '3', '3' + control]) {
        const r = await parseHttpStream(stream([get], [`HTTP/1.1 200 OK\r\nContent-Length: ${value}\r\n\r\nabc`]));
        assert.equal(onlyResponse(r).exportable, false, JSON.stringify(value));
        assert.match(onlyResponse(r).warnings.join(' '), /control byte/);
      }
    }
    const valid = await parseHttpStream(stream([get], ['HTTP/1.1 200 OK\r\nContent-Length:\t 3 \t\r\n\r\nabc']));
    assert.equal(onlyResponse(valid).exportable, true);
    assert.equal(onlyResponse(valid).text, 'abc');
    const trailer = await parseHttpStream(stream([get], ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Info: \vno\r\n\r\n']));
    assert.equal(onlyResponse(trailer).exportable, false);
    assert.match(onlyResponse(trailer).warnings.join(' '), /control byte/);
    const nbsp = await parseHttpStream(stream([get], [P.concat(
      bytes('HTTP/1.1 200 OK\r\nContent-Length: '), Uint8Array.of(0xa0), bytes('3\r\n\r\nabc'),
    )]));
    assert.equal(onlyResponse(nbsp).exportable, false);
    assert.match(onlyResponse(nbsp).warnings.join(' '), /Content-Length/);
  });
  await test('HTTP invalid or unfinished chunks cannot become exportable bodies', async () => {
    for (const payload of ['z\r\nbad\r\n0\r\n\r\n', '4\r\nab', '2\r\nokXX0\r\n\r\n', '2\r\nok\r\n', '0\r\nContent-Length: 0\r\n\r\n']) {
      const r = await parseHttpStream(stream([get], [`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${payload}`]));
      assert.equal(onlyResponse(r).exportable, false, payload);
      assert.ok(onlyResponse(r).warnings.length);
    }
    const legacy = await parseHttpStream(stream([get], ['HTTP/1.0 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n']));
    assert.equal(onlyResponse(legacy).complete, false);
    assert.match(onlyResponse(legacy).warnings.join(' '), /invalid in HTTP\/1.0/);
    for (const sizeLine of ['\v2', '2\v', '2;name=\vbad', '2;name=bad\r']) {
      const r = await parseHttpStream(stream([get], [`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${sizeLine}\r\nok\r\n0\r\n\r\n`]));
      assert.equal(onlyResponse(r).exportable, false, JSON.stringify(sizeLine));
      assert.match(onlyResponse(r).warnings.join(' '), /chunk size/);
    }
  });
  await test('HTTP gzip and deflate decode complete content and retain wire content', async () => {
    for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync]]) {
      const compressed = compress('{"value":42}');
      const r = await parseHttpStream(stream([get], [response(compressed, `Content-Encoding: ${encoding}\r\nContent-Type: application/json\r\n`)]));
      const m = onlyResponse(r);
      assert.equal(m.text, '{\n  "value": 42\n}');
      assert.equal(new TextDecoder().decode(m.decodedBody), '{"value":42}');
      assert.deepEqual(m.body, new Uint8Array(compressed));
      assert.equal(m.exportable, true);
    }
  });
  await test('HTTP invalid, unsupported and oversized compression stays visibly unavailable', async () => {
    for (const [body, encoding, options] of [
      ['badgzip', 'gzip', {}],
      ['payload', 'br', {}],
      [gzipSync('a'.repeat(2000)), 'gzip', { maxBodyBytes: 100 }],
    ]) {
      const r = await parseHttpStream(stream([get], [response(body, `Content-Encoding: ${encoding}\r\n`)]), options);
      const m = onlyResponse(r);
      assert.equal(m.decodedBody, null);
      assert.equal(m.exportable, false);
      assert.ok(m.warnings.length);
    }
  });
  await test('HTTP binary bodies remain bytes and HTML remains inert text', async () => {
    const binary = await parseHttpStream(stream([get], [response(Uint8Array.of(0, 255, 65), 'Content-Type: application/octet-stream\r\n')]));
    assert.equal(onlyResponse(binary).text, null);
    assert.deepEqual(onlyResponse(binary).decodedBody, Uint8Array.of(0, 255, 65));
    const html = await parseHttpStream(stream([get], [response('<script>untrusted()</script>', 'Content-Type: text/html\r\n')]));
    assert.equal(onlyResponse(html).text, '<script>untrusted()</script>');
  });
  await test('HTTP previews are bounded without splitting a UTF-8 character', async () => {
    const r = await parseHttpStream(stream([get], [response('a😀tail', 'Content-Type: text/plain; charset=utf-8\r\n')]), { maxPreviewBytes: 3 });
    assert.equal(onlyResponse(r).text, 'a');
    assert.equal(onlyResponse(r).previewTruncated, true);
    assert.equal(onlyResponse(r).exportable, true);
  });
  await test('HTTP message, body and header budgets report incomplete coverage', async () => {
    const many = await parseHttpStream(stream([get + get + get], []), { maxMessages: 2 });
    assert.equal(many.messages.length, 2);
    assert.equal(many.truncated, true);
    const body = await parseHttpStream(stream([get], [response('123456')]), { maxBodyBytes: 4 });
    assert.equal(onlyResponse(body).body.length, 4);
    assert.equal(onlyResponse(body).exportable, false);
    const header = await parseHttpStream(stream([get], ['HTTP/1.1 200 OK\r\nX-Test: ' + 'x'.repeat(100) + '\r\n\r\n']), { maxHeaderBytes: 64 });
    assert.match(onlyResponse(header).warnings.join(' '), /headers are incomplete/);
    const chunks = await parseHttpStream(stream([get], ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n1\r\nb\r\n0\r\n\r\n']), { maxChunks: 2 });
    assert.equal(onlyResponse(chunks).exportable, false);
    assert.match(onlyResponse(chunks).warnings.join(' '), /chunk count/);
  });
  await test('HTTP does not treat TLS, HTTP/2 or UDP bytes as HTTP/1 exchanges', async () => {
    assert.equal((await parseHttpStream(stream(['\u0016\u0003\u0003random'], []))).recognized, false);
    assert.equal((await parseHttpStream(stream(['PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'], []))).recognized, false);
    const udp = stream([get], []);
    udp.conv.proto = 'UDP';
    assert.equal((await parseHttpStream(udp)).recognized, false);
  });
  await test('HTTP production decode and Analyzer reassembly recover split out-of-order messages', async () => {
    const A = 'aa:aa:aa:00:00:01', B = 'bb:bb:bb:00:00:02';
    const request = bytes(get);
    const compressed = gzipSync('{"ready":true}');
    const reply = P.concat(
      bytes('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Encoding: gzip\r\nContent-Type: application/json\r\n\r\n'),
      bytes(compressed.length.toString(16) + '\r\n'), compressed, bytes('\r\n0\r\nX-Finished: yes\r\n\r\n'),
    );
    const packets = [
      P.frame.tcp(A, B, '10.0.0.1', '10.0.0.2', { sport: 50000, dport: 80, seq: 100, flags: 'S' }, []),
      P.frame.tcp(B, A, '10.0.0.2', '10.0.0.1', { sport: 80, dport: 50000, seq: 500, ack: 101, flags: 'SA' }, []),
      P.frame.tcp(A, B, '10.0.0.1', '10.0.0.2', { sport: 50000, dport: 80, seq: 101 + 12, flags: 'PA' }, request.subarray(12)),
      P.frame.tcp(A, B, '10.0.0.1', '10.0.0.2', { sport: 50000, dport: 80, seq: 101, flags: 'PA' }, request.subarray(0, 12)),
      P.frame.tcp(B, A, '10.0.0.2', '10.0.0.1', { sport: 80, dport: 50000, seq: 501, flags: 'PA' }, reply.subarray(0, 40)),
      P.frame.tcp(B, A, '10.0.0.2', '10.0.0.1', { sport: 80, dport: 50000, seq: 541, flags: 'PA' }, reply.subarray(40)),
    ].map((data, i) => ({ no: i + 1, ts: i / 10, caplen: data.length, len: data.length, data, lt: 1, d: decode(1, data) }));
    const analyzer = new Analyzer();
    for (const p of packets) analyzer.ingest(p);
    const result = await parseHttpStream(analyzer.followStream(packets, packets[0].ann.stream, 'TCP'));
    assert.equal(result.exchanges[0].request.target, '/example');
    assert.equal(result.exchanges[0].response.text, '{\n  "ready": true\n}');
    assert.deepEqual(result.exchanges[0].response.decodedBody, bytes('{"ready":true}'));
    assert.deepEqual(result.exchanges[0].response.body, new Uint8Array(compressed));
    assert.equal(result.exchanges[0].response.trailers[0].value, 'yes');
    assert.deepEqual(result.exchanges[0].request.frames, [3, 4]);
    assert.deepEqual(result.exchanges[0].response.frames, [5, 6]);
    assert.equal(result.exchanges[0].response.exportable, true);
  });
}
