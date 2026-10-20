'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function captureHarness(result, globals = {}) {
  const filename = path.join(__dirname, '../src/renderer/js/capture.js');
  const source = fs.readFileSync(filename, 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class CaptureTab', 'class CaptureTab');
  const module = { exports: {} };
  const frames = [];
  vm.runInNewContext(source + '\nmodule.exports = CaptureTab;', {
    module, requestAnimationFrame: (callback) => frames.push(callback),
    showTraffic: async () => result,
    toast: (message) => assert.fail(message), errMsg: (error) => error.message,
    ...globals,
  }, { filename });
  const tab = Object.create(module.exports.prototype);
  const packets = [{ no: 1 }, { no: 2 }, { no: 3 }];
  let scrollsToEnd = 0;
  Object.assign(tab, {
    packets, view: [0, 1, 2], state: 'running', autoScroll: true,
    autoScrollCheckbox: { checked: true },
    analyzer: { followStream: () => ({ conv: { proto: 'TCP', id: 7 } }) },
    setFilter() { this.view = [1, 2]; },
    select(index) { this.selected = index; },
    list: {
      setCount() {}, render() {}, ensureVisible(index) { this.visible = index; },
      scrollToEnd() { scrollsToEnd++; },
    },
    notice: { classList: { contains: () => true } },
    renderStats() {}, refreshSide() {},
  });
  return { tab, frames, scrollsToEnd: () => scrollsToEnd };
}

async function runUiV020ReviewRegressionTests(test) {
  await test('Follow Stream evidence stays visible when the next live packet batch renders', async () => {
    const { tab, frames, scrollsToEnd } = captureHarness({ action: 'packet', frame: 2 });
    await tab.follow(7);
    assert.equal(tab.selected, 1);
    assert.equal(tab.list.visible, 0);
    assert.equal(tab.autoScroll, false, 'evidence navigation must pause live following explicitly');
    assert.equal(tab.autoScrollCheckbox.checked, false);
    tab.packets.push({ no: 4 });
    tab.view.push(3);
    tab.scheduleRender();
    frames.shift()();
    assert.equal(scrollsToEnd(), 0, 'a later live render must retain the inspected evidence');
  });

  await test('dismissing Follow Stream or filtering alone preserves the Auto-scroll preference', async () => {
    for (const result of [null, { action: 'filter' }, { action: 'packet', frame: 404 }]) {
      const { tab } = captureHarness(result);
      await tab.follow(7);
      assert.equal(tab.autoScroll, true);
      assert.equal(tab.autoScrollCheckbox.checked, true);
    }
  });

  await test('whole-capture save reports the exact snapshot count while live packets arrive', async () => {
    const { writePcapng, readCapture } = await import('../src/renderer/js/capture/pcapfile.mjs');
    const notices = [];
    let savedBytes;
    const packet = (value) => ({ ts: value, len: 1, lt: 1, data: new Uint8Array([value]) });
    const packets = [packet(1), packet(2)];
    const { tab } = captureHarness(null, {
      writePcapng, toast: (...args) => notices.push(args),
      api: { invoke: async (_channel, _name, bytes) => {
        savedBytes = bytes;
        packets.push(packet(3));
        return 'selected.pcapng';
      } },
    });
    await tab.save(packets);
    assert.equal(readCapture(savedBytes).packets.length, 2);
    assert.deepEqual(notices, [['Saved 2 packets to selected.pcapng', 'ok']]);
  });

  await test('whole-capture save shows native-dialog or disk errors without an unhandled rejection', async () => {
    const { writePcapng } = await import('../src/renderer/js/capture/pcapfile.mjs');
    const notices = [];
    const { tab } = captureHarness(null, {
      writePcapng, toast: (...args) => notices.push(args),
      api: { invoke: async () => { throw new Error('Disk full'); } },
    });
    await tab.save([{ ts: 1, len: 1, lt: 1, data: new Uint8Array([1]) }]);
    assert.deepEqual(notices, [['Disk full', 'err']]);
  });
}

module.exports = { runUiV020ReviewRegressionTests };
