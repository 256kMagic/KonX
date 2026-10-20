'use strict';

// Exercise the real CaptureTab.follow method without an Electron window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ showTraffic, reconstruct } = {}) {
  const filename = path.join(__dirname, '../src/renderer/js/capture.js');
  const source = fs.readFileSync(filename, 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export class CaptureTab', 'class CaptureTab');
  const module = { exports: {} };
  const events = [];
  const notices = [];
  const stream = { conv: { id: 7, proto: 'TCP' } };
  let reconstructions = 0;
  let dialogs = 0;
  vm.runInNewContext(source + '\nmodule.exports = CaptureTab;', {
    module,
    showTraffic: async (value) => {
      dialogs++;
      assert.equal(value, stream);
      return showTraffic ? showTraffic(value) : null;
    },
    toast: (...args) => notices.push(args),
    errMsg: (error) => error.message,
  }, { filename });
  const tab = Object.create(module.exports.prototype);
  const packets = [
    { no: 20, ann: { stream: 2 }, d: { tcp: {} } },
    { no: 101, ann: { stream: 7 }, d: { tcp: {} } },
    { no: 900, ann: { stream: 7 }, d: { tcp: {} } },
  ];
  Object.assign(tab, {
    packets,
    view: [0, 1, 2],
    analyzer: {
      followStream: (...args) => {
        reconstructions++;
        assert.equal(args[0], packets);
        assert.equal(args[1], 7);
        assert.equal(args[2], stream.conv.proto);
        return reconstruct ? reconstruct(...args) : stream;
      },
    },
    setFilter: (filter) => {
      events.push(['filter', filter]);
      tab.view = packets.flatMap((packet, index) => packet.ann.stream === 7 ? [index] : []);
    },
    select: (index) => events.push(['select', index]),
    list: { ensureVisible: (index) => events.push(['visible', index]) },
  });
  return { tab, stream, packets, events, notices, counts: () => ({ reconstructions, dialogs }) };
}

async function runTrafficUiTests(test) {
  console.log('packet capture: readable traffic navigation');

  await test('packet evidence navigation uses the exact original packet number and stream', async () => {
    const h = harness({ showTraffic: () => ({ action: 'packet', frame: 900 }) });
    await h.tab.follow(7);
    assert.deepEqual(h.events, [
      ['filter', 'tcp.stream == 7'],
      ['select', 2],
      ['visible', 1],
    ]);
    assert.equal(h.tab.followOpen, false);
  });

  await test('Filter this stream applies the selected transport without changing packet selection', async () => {
    const h = harness({ showTraffic: () => ({ action: 'filter' }) });
    h.stream.conv.proto = 'UDP';
    await h.tab.follow(7, 'UDP');
    assert.deepEqual(h.events, [['filter', 'udp.stream == 7']]);
    assert.equal(h.tab.followOpen, false);
  });

  await test('concurrent follow actions share one reconstruction and dialog until it closes', async () => {
    const view = deferred();
    const h = harness({ showTraffic: () => view.promise });
    const first = h.tab.follow(7);
    await h.tab.follow(7);
    assert.deepEqual(h.counts(), { reconstructions: 1, dialogs: 1 });
    assert.equal(h.tab.followOpen, true);
    view.resolve(null);
    await first;
    assert.equal(h.tab.followOpen, false);
    await h.tab.follow(7);
    assert.deepEqual(h.counts(), { reconstructions: 2, dialogs: 2 });
  });

  await test('late traffic results do not navigate a replaced capture or a disposed tab', async () => {
    for (const action of [{ action: 'packet', frame: 900 }, { action: 'filter' }]) {
      for (const state of ['replaced', 'disposed']) {
        const view = deferred();
        const h = harness({ showTraffic: () => view.promise });
        const pending = h.tab.follow(7);
        if (state === 'replaced') h.tab.packets = h.packets.slice();
        else h.tab.disposed = true;
        view.resolve(action);
        await pending;
        assert.deepEqual(h.events, [], `${state} capture must ignore ${action.action}`);
        assert.equal(h.tab.followOpen, false);
      }
    }
  });

  await test('missing packet evidence and a dismissed dialog leave capture navigation unchanged', async () => {
    for (const result of [null, { action: 'packet', frame: 404 }, { action: 'unknown' }]) {
      const h = harness({ showTraffic: () => result });
      await h.tab.follow(7);
      assert.deepEqual(h.events, []);
      assert.equal(h.tab.followOpen, false);
    }
  });

  await test('a traffic-dialog rejection releases the open guard and allows another attempt', async () => {
    let attempts = 0;
    const h = harness({
      showTraffic: async () => {
        if (!attempts++) throw new Error('Unable to parse or display stream');
        return { action: 'filter' };
      },
    });
    await h.tab.follow(7);
    assert.equal(h.tab.followOpen, false);
    assert.deepEqual(h.notices, [['Unable to parse or display stream', 'err']]);
    await h.tab.follow(7);
    assert.deepEqual(h.counts(), { reconstructions: 2, dialogs: 2 });
    assert.deepEqual(h.events, [['filter', 'tcp.stream == 7']]);
  });

  await test('reassembly failure and absent streams both release the open guard', async () => {
    const missing = harness({ reconstruct: () => null });
    await missing.tab.follow(7);
    assert.deepEqual(missing.counts(), { reconstructions: 1, dialogs: 0 });
    assert.equal(missing.tab.followOpen, false);
    const failed = harness({ reconstruct: () => { throw new Error('Stream analysis failed'); } });
    await failed.tab.follow(7);
    assert.deepEqual(failed.counts(), { reconstructions: 1, dialogs: 0 });
    assert.deepEqual(failed.notices, [['Stream analysis failed', 'err']]);
    assert.equal(failed.tab.followOpen, false);
  });
}

module.exports = { runTrafficUiTests };
