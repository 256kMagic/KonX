import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readCapture, writePcapng } from '../src/renderer/js/capture/pcapfile.mjs';
import { decode } from '../src/renderer/js/capture/decode.mjs';
import { Analyzer } from '../src/renderer/js/capture/analyze.mjs';
import { TrafficEvidenceOwner } from '../src/renderer/js/copilot-traffic.mjs';

function captureHarness() {
  const module = { exports: {} }, saved = [], notices = [];
  const source = fs.readFileSync(new URL('../src/renderer/js/capture.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class CaptureTab', 'class CaptureTab');
  vm.runInNewContext(source + '\nmodule.exports = CaptureTab;', { module, Uint8Array, setTimeout, readCapture, writePcapng, decode,
    toast: (...args) => notices.push(args), errMsg: error => error.message,
    api: { invoke: async (...args) => { saved.push(args); return 'chosen-capture.pcapng'; } } });
  const tab = Object.create(module.exports.prototype);
  Object.assign(tab, { id: 'capture-metadata-fixture', kind: 'capture', packets: [], view: [], analyzer: new Analyzer(), state: 'idle', filter: null, disposed: false,
    stop: async () => {}, clear() { this.packets = []; this.view = []; this.analyzer.reset(); this.captureCoverage = null; },
    app: { setTabTitle() {} }, statsEl: {}, notice: { classList: { add() {} } },
    list: { setCount() {}, scrollTo() {}, render() {} }, refreshSide() {}, renderStats() {}, scheduleRender() {} });
  tab.copilot = new TrafficEvidenceOwner(tab);
  return { tab, saved, notices };
}
function incidentHelper() {
  const module = { exports: {} };
  const source = fs.readFileSync(new URL('../src/renderer/js/incident-evidence.mjs', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function incidentEvidence', 'function incidentEvidence');
  vm.runInNewContext(source + '\nmodule.exports = incidentEvidence;', { module, TextEncoder, Uint8Array, writePcapng });
  return module.exports;
}

export async function runCaptureMetadataTests(test) {
  await test('capture byte loading retains reader warnings and unknown packet timestamp identity', async () => {
    const { tab, notices } = captureHarness();
    const bytes = writePcapng([{ ts: 0, timestampKnown: false, data: Uint8Array.of(1, 2, 3), len: 10, linktype: 101 }]);
    const originalIngest = tab.ingest; let loadingCoverage = null;
    tab.ingest = function (packets) { loadingCoverage = this.captureCoverage.examinedAllRecords; return originalIngest.call(this, packets); };
    await tab.loadBytes(bytes, 'unknown-time.pcapng');
    assert.equal(loadingCoverage, false); assert.equal(tab.captureCoverage.examinedAllRecords, true);
    assert.equal(tab.captureCoverage.missingTimestamps, 1); assert.equal(tab.packets[0].timestampKnown, false); assert.equal(tab.packets[0].rel, null);
    assert.equal(tab.fileName, 'unknown-time.pcapng'); assert.ok(notices[0][0].includes('Loaded 1 packets'));
    const retainedCoverage = { examinedAllRecords: false, truncated: true, warnings: ['Original tail was incomplete'] };
    await tab.loadPacketSnapshot(tab.packets, 'retained', retainedCoverage);
    assert.equal(tab.captureCoverage.examinedAllRecords, false); assert.equal(tab.captureCoverage.warnings[0], 'Original tail was incomplete');
    assert.ok(notices.at(-1)[0].includes('Original tail was incomplete'));
  });

  await test('retained capture navigation owns bytes and coverage before the first await', async () => {
    const { tab } = captureHarness(); let release;
    tab.stop = () => new Promise(resolve => { release = resolve; });
    const packets = [{ no: 99, ts: 0, timestampKnown: false, data: Uint8Array.of(11, 22, 33), len: 20, lt: 101 }];
    const coverage = { examinedAllRecords: true, warnings: ['Preserved warning'] };
    const loading = tab.loadPacketSnapshot(packets, 'Retained original', coverage);
    packets[0].data.fill(0); coverage.warnings[0] = 'changed externally'; release(); await loading;
    assert.deepEqual([...tab.packets[0].data], [11, 22, 33]); assert.equal(tab.packets[0].no, 1);
    assert.equal(tab.packets[0].timestampKnown, false); assert.equal(tab.packets[0].lt, 101); assert.equal(tab.captureCoverage.warnings[0], 'Preserved warning');
  });

  await test('capture saves and incident evidence preserve unknown time instead of creating epoch0', async () => {
    const { tab, saved } = captureHarness(); const helper = incidentHelper();
    const packet = { no: 1, ts: 0, timestampKnown: false, data: Uint8Array.of(11, 22, 33), len: 20, lt: 101 };
    await tab.save([packet]); assert.equal(saved[0][0], 'cap:save');
    const exported = readCapture(saved[0][2]); assert.equal(exported.packets[0].timestampKnown, false); assert.equal(exported.packets[0].len, 20);
    const evidence = helper({ kind: 'capture', packets: [packet], title: 'Retained' });
    const imported = readCapture(evidence.bytes); assert.equal(imported.packets[0].timestampKnown, false); assert.equal(imported.packets[0].len, 20); assert.deepEqual([...imported.packets[0].data], [11, 22, 33]);
  });

  await test('retained capture loading remains cancelled when a newer file load supersedes it', async () => {
    const { tab } = captureHarness(); let release, first = true;
    tab.stop = () => first ? (first = false, new Promise(resolve => { release = resolve; })) : Promise.resolve();
    const older = tab.loadPacketSnapshot([{ ts: 1, data: Uint8Array.of(1), len: 1, linktype: 1 }], 'Old', { examinedAllRecords: true });
    await tab.loadPacketSnapshot([{ ts: 2, data: Uint8Array.of(2), len: 1, linktype: 1 }], 'New', { examinedAllRecords: false, warnings: ['New source'] });
    release(); await older;
    assert.equal(tab.fileName, 'New'); assert.deepEqual([...tab.packets[0].data], [2]); assert.equal(tab.captureCoverage.examinedAllRecords, false);
  });

  await test('clearing a sliced import abandons its destination instead of restoring complete coverage on a suffix', async () => {
    const { tab } = captureHarness(); const originalIngest = tab.ingest; let batches = 0;
    tab.ingest = function (packets) { batches++; originalIngest.call(this, packets); this.clear(false); };
    const packets = Array.from({ length: 4001 }, () => ({ ts: 1, data: Uint8Array.of(1), len: 1, linktype: 1 }));
    await tab.loadPacketSnapshot(packets, 'Clear during import', { examinedAllRecords: true });
    assert.equal(batches, 1); assert.equal(tab.packets.length, 0); assert.equal(tab.captureCoverage, null);
  });

  await test('incident serialization delegates all section expansion bounds to the packet-format owner', () => {
    const helper = incidentHelper(), packet = { data: new Uint8Array(1024 * 1024), ts: 0, timestampKnown: false, lt: 1 };
    assert.throws(() => helper({ kind: 'capture', packets: new Array(128).fill(packet), title: 'Too much' }), /serialized byte limit/);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let passed = 0, failed = 0;
  await runCaptureMetadataTests(async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } });
  console.log(`${passed}/${passed + failed} capture metadata tests passed`); process.exitCode = failed ? 1 : 0;
}
