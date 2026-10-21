import assert from 'node:assert/strict';
import { Analyzer } from '../src/renderer/js/capture/analyze.mjs';
import { decode } from '../src/renderer/js/capture/decode.mjs';
import { analyzeSipCalls } from '../src/renderer/js/capture/sip.mjs';
import { frame, str } from './lib/packets.mjs';
import { sipMessage } from './lib/sip-fixtures.mjs';

function packet(text, ts, reverse = false, tcp = null) {
  const src = reverse ? '192.0.2.20' : '192.0.2.10';
  const dst = reverse ? '192.0.2.10' : '192.0.2.20';
  const endpoints = ['02:00:00:00:00:01', '02:00:00:00:00:02', src, dst];
  const data = tcp ? frame.tcp(...endpoints, { sport: 5060, dport: 5060, ...tcp }, str(text))
    : frame.udp(...endpoints, { sport: 5060, dport: 5060 }, str(text));
  return { ts, linktype: 1, lt: 1, caplen: data.length, len: data.length, data, d: decode(1, data) };
}
function analyze(items) {
  const analyzer = new Analyzer();
  items.forEach((item, index) => { item.no = index + 1; analyzer.ingest(item); });
  return analyzeSipCalls(items);
}

export async function runSipReviewRegressionTests(test) {
  await test('SIP recognizes case-insensitive version tokens in requests and responses', () => {
    const request = sipMessage('INVITE sip:bob@konx.test sip/2.0');
    const response = sipMessage('sIp/2.0 200 OK', { toTag: 'bob' });
    const result = analyze([packet(request, 1), packet(response, 2, true)]);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].messages.length, 2);
    assert.ok(result.calls[0].messages.every((message) => message.complete));
    assert.match(result.calls[0].outcome, /^Answered/);
  });

  await test('SIP call setup time follows its sole answered dialog when tags change across legs', () => {
    const from = '<sip:relay@konx.test>;tag=relay';
    const result = analyze([
      packet(sipMessage('INVITE sip:bob@konx.test SIP/2.0'), 1),
      packet(sipMessage('INVITE sip:bob@konx.test SIP/2.0', { from, branch: 'z9hG4bK-relay' }), 10),
      packet(sipMessage('SIP/2.0 200 OK', { from, branch: 'z9hG4bK-relay', toTag: 'bob' }), 11, true),
    ]);
    const call = result.calls[0];
    assert.equal(call.dialogs.length, 1);
    assert.equal(call.dialogs[0].setupTime, 1);
    assert.equal(call.setupTime, 1, 'the unrelated earlier leg cannot supply the answered dialog setup time');
  });

  await test('SIP accepts the largest valid CSeq but leaves invalid and missing values incomplete', () => {
    const good = analyze([packet(sipMessage('INVITE sip:bob@konx.test SIP/2.0', { cseq: 0x7fffffff }), 1)]);
    assert.equal(good.calls[0].messages[0].cseq.number, 0x7fffffff);
    assert.equal(good.calls[0].messages[0].complete, true);
    for (const value of [0x80000000, 0xffffffff, '999999999999999999999']) {
      const message = analyze([packet(sipMessage('INVITE sip:bob@konx.test SIP/2.0', { cseq: value }), 1)]).calls[0].messages[0];
      assert.equal(message.cseq, null);
      assert.equal(message.transactionId, null);
      assert.equal(message.complete, false);
      assert.match(message.warnings.join(' '), /CSeq is missing, invalid or ambiguous/);
    }
    const wire = sipMessage('INVITE sip:bob@konx.test SIP/2.0').replace('CSeq: 1 INVITE\r\n', '');
    assert.equal(analyze([packet(wire, 1)]).calls[0].messages[0].complete, false);
  });

  await test('SIP malformed CSeq does not hide a following correctly framed TCP message', () => {
    const first = sipMessage('INVITE sip:bob@konx.test SIP/2.0', { cseq: 0x80000000 });
    const second = sipMessage('OPTIONS sip:bob@konx.test SIP/2.0', { method: 'OPTIONS', cseq: 2, branch: 'z9hG4bK-options' });
    const result = analyze([packet(first + second, 1, false, { seq: 101, flags: 'PA' })]);
    assert.equal(result.calls.length, 1);
    const messages = result.calls[0].messages;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].complete, false);
    assert.equal(messages[1].method, 'OPTIONS');
    assert.equal(messages[1].complete, true);
  });
}
