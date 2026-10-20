import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readCapture } from '../src/renderer/js/capture/pcapfile.mjs';
import { decode } from '../src/renderer/js/capture/decode.mjs';
import { Analyzer } from '../src/renderer/js/capture/analyze.mjs';
import { analyzeSipCalls } from '../src/renderer/js/capture/sip.mjs';
import { buildSipCallCapture, buildSipCallReport, MAX_SIP_EXPORT_BYTES } from '../src/renderer/js/capture/sip-export.mjs';
import { sipDemoCapture, sipMessage } from './lib/sip-fixtures.mjs';
import { frame, str } from './lib/packets.mjs';
const require = createRequire(import.meta.url);
const { saveSipExport } = require('../src/main/capture/export.js');

function annotate(raw) {
  const analyzer = new Analyzer();
  return raw.map((packet, index) => {
    const p = { ...packet, no: index + 1, lt: packet.linktype };
    p.d = decode(p.lt, p.data);
    analyzer.ingest(p);
    return p;
  });
}

export async function runSipIntegrationTests(test) {
  await test('SIP capture import, cross-leg grouping, SDP and original-frame export round-trip', () => {
    const packets = annotate(readCapture(sipDemoCapture()).packets);
    const analysis = analyzeSipCalls(packets);
    assert.equal(analysis.calls.length, 3);
    assert.equal(analysis.limited, false);
    const call = analysis.calls.find((c) => c.callId === 'demo-call@konx.test');
    assert.equal(call.messages.length, 14);
    assert.match(call.outcome, /Ended/);
    assert.equal(new Set(call.messages.flatMap((m) => [m.src, m.dst])).size, 3);
    assert.equal(call.messages.filter((m) => m.retransmission).length, 1);
    assert.equal(call.messages[0].sdp.media[0].codecs[0].name, 'PCMU');
    const selected = packets.filter((p) => call.frames.includes(p.no));
    const back = readCapture(buildSipCallCapture(packets, call)).packets;
    assert.equal(back.length, selected.length);
    for (const [i, p] of back.entries()) {
      assert.deepEqual(p.data, selected[i].data);
      assert.equal(p.len, selected[i].len);
      assert.ok(Math.abs(p.ts - selected[i].ts) < 0.000002);
    }
    assert.equal(analyzeSipCalls(annotate(back)).calls[0].messages.length, call.messages.length);
    const tcp = analysis.calls.find((c) => c.messages.some((m) => m.transport === 'TCP'));
    assert.ok(tcp.messages.some((m) => m.frames.length === 2), 'split TCP message preserves both frames');
    const tcpBack = analyzeSipCalls(annotate(readCapture(buildSipCallCapture(packets, tcp)).packets));
    assert.equal(tcpBack.calls[0].messages.length, tcp.messages.length);
  });
  await test('SIP call export retains a shared TCP frame once without rewriting another call', () => {
    const one = sipMessage('INVITE sip:bob@konx.test SIP/2.0', { callId: 'one' });
    const two = sipMessage('INVITE sip:bob@konx.test SIP/2.0', { callId: 'two' });
    const data = frame.tcp('02:00:00:00:00:01', '02:00:00:00:00:02', '192.0.2.1', '192.0.2.2', { sport: 5060, dport: 5060, seq: 100, ack: 1, flags: 'PA' }, str(one + two));
    const packets = annotate([{ data, ts: 1, len: data.length, caplen: data.length, linktype: 1 }]);
    const analysis = analyzeSipCalls(packets);
    assert.equal(analysis.calls.length, 2);
    const bytes = buildSipCallCapture(packets, { ...analysis.calls[0], frames: [1, 1] });
    const back = readCapture(bytes).packets;
    assert.equal(back.length, 1);
    assert.deepEqual(back[0].data, data);
    assert.equal(analyzeSipCalls(annotate(back)).calls.length, 2);
    assert.throws(() => buildSipCallCapture(packets, { frames: [999] }), /no longer available/);
    assert.throws(() => buildSipCallCapture(packets, { frames: [] }), /no captured/);
  });
  await test('SIP JSON reports retain source, raw evidence, SDP and explicit coverage limits', () => {
    const packets = annotate(readCapture(sipDemoCapture()).packets);
    const analysis = analyzeSipCalls(packets, { maxScanPackets: 2 });
    const report = JSON.parse(new TextDecoder().decode(buildSipCallReport(analysis.calls[0], { ...analysis, sourceName: 'example.pcapng' })));
    assert.equal(report.format, 'konx-sip-call');
    assert.equal(report.sourceName, 'example.pcapng');
    assert.equal(report.coverage.limited, true);
    assert.equal(report.coverage.scannedPackets, 2);
    assert.ok(report.coverage.warnings.length);
    assert.match(report.coverage.packetExport, /other messages/);
    assert.equal(report.call.duration, null);
    assert.match(report.call.messages[0].rawText, /INVITE/);
    assert.equal(report.call.messages[0].sdp.media[0].port, 4000);
    assert.throws(() => buildSipCallReport({ rawText: '\u0000'.repeat(Math.ceil(MAX_SIP_EXPORT_BYTES / 6)) }), /budget/);
  });
  await test('SIP native export validates inputs before opening a dialog and snapshots selected bytes', async () => {
    const forbid = { chooseFile: async () => assert.fail('invalid input must not open a dialog'), writeFile: async () => assert.fail('invalid input must not write') };
    for (const [format, bytes] of [['exe', new Uint8Array([1])], ['json', []], ['pcapng', new Uint8Array()], ['json', new Uint8Array(MAX_SIP_EXPORT_BYTES + 1)]]) {
      await assert.rejects(saveSipExport(format, bytes, forbid));
    }
    for (const format of ['json', 'pcapng']) {
      const input = new Uint8Array([1, 2, 3]);
      const result = await saveSipExport(format, input, {
        chooseFile: async (options) => {
          assert.equal(options.defaultPath, 'sip-call.' + format);
          assert.deepEqual(options.filters[0].extensions, [format]);
          input.fill(9);
          return { canceled: false, filePath: 'user-selected.' + format };
        },
        writeFile: async (file, bytes) => {
          assert.equal(file, 'user-selected.' + format);
          assert.deepEqual([...bytes], [1, 2, 3]);
        },
      });
      assert.equal(result, 'user-selected.' + format);
    }
  });
  await test('SIP export cancel and failures do not claim a saved call', async () => {
    for (const choice of [{ canceled: true }, { canceled: false }]) {
      assert.equal(await saveSipExport('json', new Uint8Array([1]), {
        chooseFile: async () => choice, writeFile: async () => assert.fail('no destination selected'),
      }), null);
    }
    await assert.rejects(saveSipExport('json', new Uint8Array([1]), {
      chooseFile: async () => { throw new Error('Dialog unavailable'); }, writeFile: async () => assert.fail(),
    }), /Dialog unavailable/);
    await assert.rejects(saveSipExport('pcapng', new Uint8Array([1]), {
      chooseFile: async () => ({ canceled: false, filePath: 'chosen.pcapng' }), writeFile: async () => { throw new Error('Disk full'); },
    }), /Disk full/);
  });
}
