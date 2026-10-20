'use strict';

// Exercise the production CaptureTab.openSipCalls lifecycle without a window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness({ analyze, show, buildCapture, buildReport } = {}) {
  const filename = path.join(__dirname, '../src/renderer/js/capture.js');
  const source = fs.readFileSync(filename, 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class CaptureTab', 'class CaptureTab');
  const module = { exports: {} };
  const events = [], notices = [], invocations = [], scheduled = [], snapshots = [];
  const call = { id: 'call-1', callId: 'example@test', frames: [20, 900], messages: [], dialogs: [], transactions: [], warnings: [] };
  const analysis = { calls: [call], warnings: [], limited: false, scannedPackets: 3 };
  let dialogs = 0;
  let actions;
  vm.runInNewContext(source + '\nmodule.exports = CaptureTab;', {
    module,
    setTimeout: (callback) => { scheduled.push(callback); return scheduled.length; },
    analyzeSipCalls: (snapshot) => { snapshots.push(snapshot); return analyze ? analyze(snapshot) : analysis; },
    showSipCalls: async (value, callbacks) => {
      dialogs++; actions = callbacks;
      assert.equal(value, analysis);
      return show ? show(value, callbacks) : null;
    },
    buildSipCallCapture: (packets, value) => buildCapture(packets, value),
    buildSipCallReport: (value, context) => buildReport(value, context),
    api: { invoke: async (...args) => { invocations.push(args); return 'chosen.' + args[1]; } },
    toast: (...args) => notices.push(args),
    errMsg: (error) => error.message,
  }, { filename });
  const tab = Object.create(module.exports.prototype);
  const packets = [20, 101, 900].map((no, i) => ({ no, ts: i + 0.5, len: 3, caplen: 3, lt: 1, data: new Uint8Array([i, 10, 20]) }));
  Object.assign(tab, {
    packets, view: [0, 1, 2], fileName: 'original.pcapng', sipButton: { disabled: false },
    setAutoScroll: (enabled) => events.push(['auto-scroll', enabled]),
    setFilter: (filter) => { events.push(['filter', filter]); tab.view = tab.packets.map((_packet, i) => i); },
    select: (index) => events.push(['select', index]),
    list: { ensureVisible: (index) => events.push(['visible', index]) },
  });
  return {
    tab, packets, call, analysis, events, notices, invocations, snapshots,
    get actions() { return actions; },
    counts: () => ({ analyses: snapshots.length, dialogs }),
    async paint() { const callback = scheduled.shift(); assert.ok(callback, 'analysis must yield before reading the snapshot'); callback(); await Promise.resolve(); },
  };
}

async function runSipNavigationTests(test) {
  await test('SIP source packet navigation pauses scrolling and clears only an excluding display filter', async () => {
    for (const visible of [true, false]) {
      const h = harness({ show: () => ({ action: 'packet', frame: 900 }) });
      h.tab.view = visible ? [2] : [0, 1];
      const pending = h.tab.openSipCalls();
      await h.paint(); await pending;
      assert.deepEqual(h.events, visible
        ? [['auto-scroll', false], ['select', 2], ['visible', 0]]
        : [['auto-scroll', false], ['filter', ''], ['select', 2], ['visible', 2]]);
      assert.equal(h.tab.sipOpen, false);
      assert.equal(h.tab.sipButton.disabled, false);
    }
  });

  await test('Concurrent SIP actions share one capture snapshot and dialog', async () => {
    const dialog = deferred();
    const h = harness({ show: () => dialog.promise });
    const first = h.tab.openSipCalls();
    await h.tab.openSipCalls();
    assert.deepEqual(h.counts(), { analyses: 0, dialogs: 0 });
    assert.equal(h.tab.sipButton.disabled, true);
    await h.paint();
    await h.tab.openSipCalls();
    assert.deepEqual(h.counts(), { analyses: 1, dialogs: 1 });
    assert.notEqual(h.snapshots[0], h.packets);
    dialog.resolve(null); await first;
    assert.equal(h.tab.sipOpen, false);
    const next = h.tab.openSipCalls(); await h.paint(); await next;
    assert.deepEqual(h.counts(), { analyses: 2, dialogs: 2 });
  });

  await test('Capture replacement or disposal before the SIP paint yield cancels analysis', async () => {
    for (const change of ['replaced', 'disposed']) {
      const h = harness();
      const pending = h.tab.openSipCalls();
      if (change === 'replaced') h.tab.packets = h.packets.slice();
      else h.tab.disposed = true;
      await h.paint(); await pending;
      assert.deepEqual(h.counts(), { analyses: 0, dialogs: 0 });
      assert.deepEqual(h.events, []);
      assert.equal(h.tab.sipOpen, false);
      assert.equal(h.tab.sipButton.disabled, false);
    }
  });

  await test('Late SIP packet results cannot navigate a replaced capture or disposed tab', async () => {
    for (const change of ['replaced', 'disposed']) {
      const dialog = deferred();
      const h = harness({ show: () => dialog.promise });
      const pending = h.tab.openSipCalls(); await h.paint();
      if (change === 'replaced') h.tab.packets = h.packets.slice();
      else h.tab.disposed = true;
      dialog.resolve({ action: 'packet', frame: 900 }); await pending;
      assert.deepEqual(h.events, []);
      assert.equal(h.tab.sipOpen, false);
      assert.equal(h.tab.sipButton.disabled, false);
    }
  });

  await test('Dismissed, missing and unknown SIP navigation results leave selection unchanged', async () => {
    for (const value of [null, { action: 'packet', frame: 404 }, { action: 'unknown' }]) {
      const h = harness({ show: () => value });
      const pending = h.tab.openSipCalls(); await h.paint(); await pending;
      assert.deepEqual(h.events, []);
      assert.equal(h.tab.sipOpen, false);
      assert.equal(h.tab.sipButton.disabled, false);
    }
  });

  await test('SIP analysis and view failures release the guard and allow another attempt', async () => {
    for (const failure of ['analyze', 'show']) {
      let attempts = 0;
      const failFirst = () => { if (!attempts++) throw new Error('SIP test failure'); };
      const h = harness({
        analyze: failure === 'analyze' ? () => { failFirst(); return h.analysis; } : undefined,
        show: failure === 'show' ? () => { failFirst(); return null; } : undefined,
      });
      const first = h.tab.openSipCalls(); await h.paint(); await first;
      assert.deepEqual(h.notices, [['SIP test failure', 'err']]);
      assert.equal(h.tab.sipOpen, false);
      assert.equal(h.tab.sipButton.disabled, false);
      const second = h.tab.openSipCalls(); await h.paint(); await second;
      assert.deepEqual(h.counts(), { analyses: 2, dialogs: failure === 'analyze' ? 1 : 2 });
    }
  });

  await test('SIP analysis and exports retain the opening snapshot when live packets arrive later', async () => {
    const { buildSipCallCapture, buildSipCallReport } = await import('../src/renderer/js/capture/sip-export.mjs');
    const { readCapture } = await import('../src/renderer/js/capture/pcapfile.mjs');
    const dialog = deferred();
    const h = harness({ show: () => dialog.promise, buildCapture: buildSipCallCapture, buildReport: buildSipCallReport });
    const pending = h.tab.openSipCalls();
    h.packets.push({ no: 1001, ts: 100, len: 1, caplen: 1, lt: 1, data: new Uint8Array([99]) });
    h.tab.fileName = 'later.pcapng';
    await h.paint();
    assert.deepEqual(h.snapshots[0].map((packet) => packet.no), [20, 101, 900]);
    await h.actions.onExportCall(h.call);
    await h.actions.onExportReport(h.call);
    assert.deepEqual(h.invocations.map((args) => args.slice(0, 2)), [['cap:saveSip', 'pcapng'], ['cap:saveSip', 'json']]);
    const captured = readCapture(h.invocations[0][2]).packets;
    assert.equal(captured.length, 2);
    assert.deepEqual(captured.map((packet) => [...packet.data]), [[0, 10, 20], [2, 10, 20]]);
    const report = JSON.parse(new TextDecoder().decode(h.invocations[1][2]));
    assert.equal(report.sourceName, 'original.pcapng');
    assert.equal(report.coverage.scannedPackets, 3);
    assert.throws(() => h.actions.onExportCall({ ...h.call, frames: [1001] }), /no longer available/);
    dialog.resolve(null); await pending;
    assert.equal(h.tab.sipButton.disabled, false);
  });
}

module.exports = { runSipNavigationTests };
