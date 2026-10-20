'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const mainRoot = path.join(__dirname, '..', 'src', 'main');

function loadMain(name, dependencies, globals = {}) {
  const filename = path.join(mainRoot, name);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer, TextDecoder, setTimeout, clearTimeout, setImmediate,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
    ...globals,
  }, { filename });
  return module.exports;
}

// Small DOM/event model for the real modal implementation. Timers and mutation
// deliveries are explicit so focus races can be checked without Electron.
function modalHarness() {
  const keyListeners = new Set();
  const timers = new Map();
  const observers = new Set();
  let nextTimer = 0;
  const document = { activeElement: null };
  class Element {
    constructor(tag = 'div', classes = '') {
      this.tagName = tag.toUpperCase();
      this.className = classes;
      this.children = [];
      this.parentNode = null;
      this.listeners = new Map();
    }
    get isConnected() { return this === document.body || !!this.parentNode?.isConnected; }
    append(...children) {
      for (const child of children.flat(Infinity)) {
        if (!(child instanceof Element)) continue;
        child.parentNode = this;
        this.children.push(child);
      }
    }
    contains(child) { return this === child || this.children.some((n) => n.contains(child)); }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    click() { this.listeners.get('click')?.({ target: this }); }
    focus() {
      assert.ok(this.isConnected, 'must never focus a removed control');
      document.activeElement = this;
    }
    querySelector(selector) {
      for (const child of this.children) {
        const matches = selector === '.btn.primary'
          ? child.className.split(' ').includes('btn') && child.className.split(' ').includes('primary')
          : ['INPUT', 'SELECT', 'TEXTAREA'].includes(child.tagName) && child.type !== 'checkbox';
        if (matches) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
  }
  document.body = new Element('body');
  const outside = new Element('input');
  document.body.append(outside);
  outside.focus();
  function h(spec, attrs, ...children) {
    if (attrs == null || typeof attrs !== 'object' || attrs instanceof Element || Array.isArray(attrs)) {
      children.unshift(attrs);
      attrs = {};
    }
    const [tag, ...classes] = spec.split('.');
    const el = new Element(tag, classes.join(' '));
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className += ' ' + value;
      else el[key] = value;
    }
    el.append(...children);
    return el;
  }
  class MutationObserver {
    constructor(fn) { this.fn = fn; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const filename = path.join(__dirname, '..', 'src', 'renderer', 'js', 'ui.js');
  const source = fs.readFileSync(filename, 'utf8');
  const code = source.slice(source.indexOf('const modalStack ='), source.indexOf('export async function confirmDialog'))
    .replace('export function modal', 'function modal');
  const context = { document, h, icon: () => h('span'), MutationObserver,
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { assert.equal(name, 'keydown'); keyListeners.add(fn); },
    removeEventListener(name, fn) { assert.equal(name, 'keydown'); keyListeners.delete(fn); },
  };
  vm.runInNewContext(code + ';this.modal = modal;', context, { filename });
  return {
    modal: context.modal, h, document, outside,
    overlays: () => document.body.children.filter((n) => n.className === 'modal-back'),
    listeners: () => keyListeners.size,
    timers: () => timers.size,
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const fn of callbacks) fn();
    },
    mutations() { for (const observer of [...observers]) observer.fn(); },
    key(key, target = document.activeElement) {
      const event = { key, target, shiftKey: false, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() {},
        stopImmediatePropagation() { this.stopped = true; },
      };
      for (const fn of [...keyListeners]) {
        if (keyListeners.has(fn)) fn(event);
        if (event.stopped) break;
      }
      return event;
    },
  };
}

function transportHarness() {
  const sockets = [];
  const timers = new Set();
  class Socket extends EventEmitter {
    setNoDelay() {}
    setKeepAlive() {}
    write() {}
    destroy(error) {
      if (this.destroyed) return;
      this.destroyed = true;
      if (error) this.emit('error', error);
      this.emit('close');
    }
  }
  const { TelnetConnection } = loadMain('telnet.js', {
    net: { connect() { const socket = new Socket(); sockets.push(socket); return socket; } },
    events: { EventEmitter },
  }, {
    setTimeout(fn) { timers.add(fn); return fn; },
    clearTimeout(fn) { timers.delete(fn); },
  });
  return { TelnetConnection, sockets, timers };
}

function connectionHarness(TelnetConnection, SerialConnection = class {}) {
  const events = [];
  const { ConnectionManager } = loadMain('connections.js', {
    fs: {}, path, './ssh': {}, './telnet': { TelnetConnection }, './serial': { SerialConnection },
  });
  const manager = new ConnectionManager({ emit: (...args) => events.push(args), store: {}, defaultLogDir() {} });
  return { manager, events };
}

async function runPromptConnectionRegressionTests(test) {
  await test('Enter submits only the top prompt and cannot accept a covered SSH host key', async () => {
    const dom = modalHarness();
    let trustSettled = false;
    const trust = dom.modal({ title: 'New host key', body: dom.h('div'),
      buttons: [{ label: 'Accept & save', value: 'save', primary: true }],
    }).then((value) => { trustSettled = true; return value; });
    const passwordInput = dom.h('input', { type: 'password' });
    const password = dom.modal({ title: 'SSH password', body: passwordInput,
      buttons: [{ label: 'OK', value: 'ok', primary: true }],
    });
    dom.overlays()[0].querySelector('.btn.primary').click();
    dom.runTimers();
    assert.equal(dom.document.activeElement, passwordInput);
    assert.equal(dom.key('Enter', passwordInput).prevented, true);
    assert.equal(await password, 'ok');
    assert.equal(trustSettled, false);
    assert.equal(dom.overlays().length, 1);
    dom.key('Escape');
    assert.equal(await trust, null);
    assert.equal(dom.listeners(), 0);
    assert.equal(dom.timers(), 0);
  });

  await test('Escape closes only the top modal and restores nested focus', async () => {
    const dom = modalHarness();
    const lowerInput = dom.h('input');
    const lower = dom.modal({ title: 'Lower', body: lowerInput });
    dom.runTimers();
    const upper = dom.modal({ title: 'Upper', body: dom.h('input') });
    dom.runTimers();
    dom.key('Escape');
    assert.equal(await upper, null);
    assert.equal(dom.document.activeElement, lowerInput);
    assert.equal(dom.listeners(), 1);
    dom.key('Escape');
    assert.equal(await lower, null);
    assert.equal(dom.document.activeElement, dom.outside);
    assert.equal(dom.listeners(), 0);
  });

  await test('Removing a covered dialog cleans up and preserves the final focus destination', async () => {
    const dom = modalHarness();
    const lower = dom.modal({ title: 'Lower', body: dom.h('input') });
    dom.runTimers();
    const upper = dom.modal({ title: 'Upper', body: dom.h('input') });
    dom.overlays()[0].remove();
    dom.mutations();
    assert.equal(await lower, null);
    assert.equal(dom.listeners(), 1);
    dom.key('Escape');
    assert.equal(await upper, null);
    dom.runTimers();
    assert.equal(dom.document.activeElement, dom.outside);
    assert.equal(dom.listeners(), 0);
  });

  await test('Failed validation stays in the top modal and removed dialogs cannot steal focus', async () => {
    const dom = modalHarness();
    let submits = 0;
    const lower = dom.modal({ title: 'Lower', body: dom.h('input') });
    const upperInput = dom.h('input');
    const upper = dom.modal({ title: 'Upper', body: upperInput, onSubmit() { submits++; return false; } });
    dom.runTimers();
    dom.key('Enter', upperInput);
    assert.equal(submits, 1);
    assert.equal(dom.overlays().length, 2);
    dom.overlays()[1].remove();
    dom.mutations();
    assert.equal(await upper, null);
    dom.key('Escape');
    assert.equal(await lower, null);
    dom.runTimers();
    assert.equal(dom.document.activeElement, dom.outside);
  });

  await test('Telnet and raw initial DNS/refused errors reject without an unhandled error event', async () => {
    for (const raw of [false, true]) {
      for (const code of ['ENOTFOUND', 'ECONNREFUSED']) {
        const harness = transportHarness();
        const connection = new harness.TelnetConnection({ host: 'test.invalid', raw });
        const attempt = connection.connect();
        const error = Object.assign(new Error(code), { code });
        assert.doesNotThrow(() => harness.sockets[0].emit('error', error));
        await assert.rejects(attempt, (caught) => caught === error);
        assert.equal(harness.timers.size, 0);
        harness.sockets[0].destroy();
      }
    }
  });

  await test('Telnet timeout and close before connect reject and clear their timers', async () => {
    for (const timedOut of [true, false]) {
      const harness = transportHarness();
      const connection = new harness.TelnetConnection({ host: 'test.invalid' });
      const attempt = connection.connect();
      assert.doesNotThrow(() => {
        if (timedOut) [...harness.timers][0]();
        else connection.close();
      });
      await assert.rejects(attempt, timedOut ? /timed out/ : /closed before/);
      assert.equal(harness.timers.size, 0);
    }
  });

  await test('ConnectionManager captures data and errors emitted before connect resumes', async () => {
    for (const protocol of ['telnet', 'raw']) {
      const transport = transportHarness();
      const { manager, events } = connectionHarness(transport.TelnetConnection);
      const attempt = manager.open('early', { protocol, host: 'test.invalid' });
      const socket = transport.sockets[0];
      socket.emit('connect');
      socket.emit('data', Buffer.from('early banner'));
      assert.doesNotThrow(() => socket.emit('error', new Error('early runtime error')));
      assert.equal((await attempt).ok, true);
      await new Promise(setImmediate);
      assert.ok(events.some(([channel, , data]) => channel === 'conn:data' && data.toString() === 'early banner'));
      assert.ok(events.some(([channel, , data]) => channel === 'conn:data' && data.toString().includes('Socket error: early runtime error')));
      manager.closeAll();
    }
  });

  await test('Failed and cancelled TCP opens never report a connected session', async () => {
    for (const failure of ['error', 'cancel', 'connect-then-close']) {
      const transport = transportHarness();
      const { manager, events } = connectionHarness(transport.TelnetConnection);
      const attempt = manager.open('pending', { protocol: 'raw', host: 'test.invalid' });
      const socket = transport.sockets[0];
      if (failure === 'error') socket.emit('error', new Error('ECONNREFUSED'));
      else {
        if (failure === 'connect-then-close') socket.emit('connect');
        manager.close('pending');
      }
      const result = await attempt;
      assert.equal(result.ok, false);
      assert.equal(manager.conns.size, 0);
      assert.equal(transport.timers.size, 0);
      assert.equal(events.some(([channel, , status]) => channel === 'conn:status' && status.state === 'connected'), false);
    }
  });

  await test('Serial lifecycle handlers are installed before opening the port', async () => {
    class Serial extends EventEmitter {
      connect() {
        assert.ok(this.listenerCount('data'));
        assert.ok(this.listenerCount('close'));
        assert.ok(this.listenerCount('error'));
        this.emit('data', Buffer.from('serial banner'));
        this.emit('error', new Error('serial open failed'));
        return Promise.reject(new Error('serial open failed'));
      }
      write() {}
      close() { this.emit('close'); }
    }
    const { manager, events } = connectionHarness(class {}, Serial);
    const result = await manager.open('serial', { protocol: 'serial', serialPort: 'COM-test' });
    assert.equal(result.ok, false);
    assert.match(result.error, /serial open failed/);
    assert.equal(manager.conns.size, 0);
    assert.equal(events.some(([channel, , status]) => channel === 'conn:status' && status.state === 'connected'), false);
  });
}

module.exports = { runPromptConnectionRegressionTests };
