'use strict';

// Exercise the real capture controls and packet-list event handlers with a small
// DOM stand-in; no live capture, renderer window, or source-pattern assertions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(selector, ...args) {
  const handlers = new Map();
  let top = 0;
  const node = {
    selector, children: [], style: {}, checked: false, value: '',
    clientHeight: 0, scrollHeight: 0,
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    addEventListener(type, fn) { handlers.set(type, fn); },
    dispatch(type, fields = {}) {
      const event = { target: this, preventDefault() {}, ...fields };
      if (handlers.has(type)) handlers.get(type)(event);
      else if (this['on' + type]) this['on' + type](event);
    },
    replaceChildren(...children) { this.children = children.flat(); },
    focus() {},
  };
  if (args[0] && !Array.isArray(args[0]) && typeof args[0] === 'object' && !args[0].selector) Object.assign(node, args.shift());
  node.children = args.flat();
  return node;
}

function harness({ running = true, following = true } = {}) {
  const filename = path.join(__dirname, '../src/renderer/js/capture.js');
  const source = fs.readFileSync(filename, 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export class CaptureTab', 'class CaptureTab');
  const module = { exports: {} };
  vm.runInNewContext(source + '\nmodule.exports = CaptureTab;', { module, h: element, icon: () => element('svg') }, { filename });
  const tab = Object.create(module.exports.prototype);
  Object.assign(tab, {
    id: 'test-capture', state: running ? 'running' : 'idle', autoScroll: following,
    packets: [], view: [], selected: -1,
    dragSplit() {}, renderSideTabs() {}, setupDrop() {},
    select(index) { this.selected = index; },
  });
  tab.build({});
  const scroller = tab.list.scroller;
  scroller.clientHeight = 220;
  scroller.scrollHeight = 2200;
  return { tab, scroller, checkbox: tab.autoScrollCheckbox };
}

async function runCaptureAutoScrollTests(test) {
  console.log('packet capture: auto-scroll controls');
  await test('manual upward packet scrolling updates both following state and checkbox', () => {
    const { tab, scroller, checkbox } = harness();
    tab.list.scrollToEnd();
    assert.equal(checkbox.checked, true);
    scroller.scrollTop = 1000;
    scroller.dispatch('scroll');
    assert.equal(tab.autoScroll, false);
    assert.equal(checkbox.checked, false);
    assert.equal(scroller.scrollTop, 1000, 'pausing must keep the inspected position');
  });
  await test('checking Auto-scroll resumes following and immediately jumps to newest packets', () => {
    const { tab, scroller, checkbox } = harness({ following: false });
    assert.equal(checkbox.checked, false, 'the initial control reflects the saved state');
    scroller.scrollTop = 440;
    checkbox.checked = true;
    checkbox.dispatch('change');
    assert.equal(tab.autoScroll, true);
    assert.equal(checkbox.checked, true);
    assert.equal(scroller.scrollTop, 1980);
    scroller.dispatch('scroll');
    assert.equal(tab.autoScroll, true, 'the programmatic jump must not pause following');
    checkbox.checked = false;
    checkbox.dispatch('change');
    assert.equal(tab.autoScroll, false);
    assert.equal(scroller.scrollTop, 1980, 'unchecking must not reposition the list');
  });
  await test('packet navigation keys pause following and visibly uncheck Auto-scroll', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']) {
      const { tab, scroller, checkbox } = harness();
      tab.view = Array.from({ length: 100 }, (_, index) => index);
      tab.selected = 50;
      scroller.scrollTop = 1100;
      scroller.dispatch('keydown', { key });
      assert.equal(tab.autoScroll, false, key);
      assert.equal(checkbox.checked, false, key);
      assert.notEqual(tab.selected, 50, key);
    }
  });
  await test('unrelated keys and empty packet-list navigation leave following enabled', () => {
    const { tab, scroller, checkbox } = harness();
    scroller.dispatch('keydown', { key: 'ArrowUp' });
    assert.equal(tab.autoScroll, true);
    tab.view = [0, 1];
    tab.selected = 0;
    scroller.dispatch('keydown', { key: 'a' });
    assert.equal(tab.autoScroll, true);
    assert.equal(checkbox.checked, true);
    assert.equal(tab.selected, 0);
  });
  await test('scrolling toward the bottom does not disable following or undo a manual pause', () => {
    const { tab, scroller, checkbox } = harness();
    tab.list.lastTop = 0;
    scroller.scrollTop = 500;
    scroller.dispatch('scroll');
    assert.equal(tab.autoScroll, true);
    assert.equal(checkbox.checked, true);
    checkbox.checked = false;
    checkbox.dispatch('change');
    scroller.scrollTop = 1980;
    scroller.dispatch('scroll');
    assert.equal(tab.autoScroll, false);
    assert.equal(checkbox.checked, false);
  });
}

module.exports = { runCaptureAutoScrollTests };
