'use strict';

// Exercise actual managers and renderer methods with controllable transports.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const pipe = require('../src/main/capture/pipe');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));

function loadMain(file, dependencies) {
  const filename = path.join(__dirname, '../src/main/capture', file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, __dirname: path.dirname(filename), process, Buffer, SharedArrayBuffer,
    Int32Array, Atomics, setTimeout, clearTimeout,
    require: (name) => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, { filename });
  return module.exports;
}

function nativeManager() {
  const workers = [];
  class Worker extends EventEmitter {
    constructor() { super(); workers.push(this); }
    terminate() { this.emit('exit', 1); return Promise.resolve(1); }
  }
  const { CaptureManager } = loadMain('index.js', {
    path, fs: {}, worker_threads: { Worker }, './npcap': {},
    './builtin': { BuiltinCapture: class { stop() {} stopAll() {} } },
  });
  const events = [];
  return { manager: new CaptureManager({ emit: (...event) => events.push(event) }), workers, events };
}

function renderer(api, globals = {}) {
  const filename = path.join(__dirname, '../src/renderer/js/capture.js');
  const source = fs.readFileSync(filename, 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class CaptureTab', 'class CaptureTab');
  const module = { exports: {} };
  vm.runInNewContext(source + '\nmodule.exports = CaptureTab;', {
    module, api, setTimeout, setInterval, clearInterval,
    toast() {}, errMsg: (e) => e.message,
    confirmDialog: async () => true,
    readCapture: (bytes) => ({ packets: [{ data: new Uint8Array(bytes) }], format: 'pcapng' }),
    ...globals,
  }, { filename });
  const tab = Object.create(module.exports.prototype);
  Object.assign(tab, {
    id: 'capture', state: 'running', acceptLivePackets: true, packets: [], view: [],
    app: { setTabTitle() {} }, status: { available: true },
    ifaceSel: { value: 'test' }, bpf: { value: '' }, selectedDevice: () => ({ engine: 'npcap' }),
    statsEl: {}, notice: { classList: { add() {} } },
    list: { setCount() {}, scrollTo() {}, render() {} },
    setState(value) { this.state = value; }, clear() { this.packets = []; this.view = []; },
    ingest(items) { this.packets.push(...items.map((item) => item.data[0])); },
    refreshSide() {}, renderStats() {},
  });
  return tab;
}

const batch = (byte) => ({ buf: new Uint8Array([byte]).buffer, meta: new Float64Array([0, 1, 1, 0]).buffer });

async function runCaptureLifecycleRegressionTests(test) {
  console.log('packet capture: lifecycle regressions');
  await test('Npcap stop drains the final batch and waits for worker exit', async () => {
    const { manager, workers, events } = nativeManager();
    const starting = manager.start('capture', { device: 'test' });
    await turn();
    const worker = workers[0];
    worker.emit('message', { type: 'started', linktype: 1 });
    await starting;
    let stopped = false;
    const stopping = manager.stop('capture').then(() => { stopped = true; });
    worker.emit('message', { type: 'packets', ...batch(99) });
    worker.emit('message', { type: 'stopped' });
    await turn();
    assert.equal(stopped, false, 'the stop reply must wait for exit');
    assert.equal(events.filter(([channel]) => channel === 'cap:packets').length, 1, 'final packets are retained');
    worker.emit('exit', 0);
    await stopping;
    assert.equal(manager.sessions.size, 0);
  });

  await test('restarting a capture waits for the old worker and ignores stale events', async () => {
    const { manager, workers, events } = nativeManager();
    const first = manager.start('capture', { device: 'test' });
    await turn();
    workers[0].emit('message', { type: 'started', linktype: 1 });
    await first;
    const next = manager.start('capture', { device: 'test' });
    await turn();
    assert.equal(workers.length, 1, 'no replacement until old worker exits');
    workers[0].emit('exit', 0);
    await turn();
    assert.equal(workers.length, 2);
    const count = events.length;
    workers[0].emit('message', { type: 'packets', ...batch(99) });
    workers[0].emit('message', { type: 'stopped' });
    assert.equal(events.length, count, 'old worker cannot change the new capture');
    workers[1].emit('message', { type: 'started', linktype: 1 });
    await next;
    const stopping = manager.stop('capture');
    workers[1].emit('exit', 0);
    await stopping;
  });

  await test('cancelling Npcap startup never reports a running capture', async () => {
    const { manager, workers, events } = nativeManager();
    const starting = manager.start('capture', { device: 'test' });
    const rejected = assert.rejects(starting, /cancelled/);
    await turn();
    const stopping = manager.stop('capture');
    workers[0].emit('message', { type: 'started', linktype: 1 });
    workers[0].emit('exit', 0);
    await Promise.all([rejected, stopping]);
    assert.equal(events.some((e) => e[2].state === 'running'), false);
  });

  await test('stop cancels a capture request before its worker has been created', async () => {
    const { manager, workers } = nativeManager();
    const starting = manager.start('capture', { device: 'test' });
    const rejected = assert.rejects(starting, /cancelled/);
    await manager.stop('capture');
    await rejected;
    assert.equal(workers.length, 0);
  });

  await test('stopping all captures cancels requests that have no worker yet', async () => {
    const { manager, workers } = nativeManager();
    const starting = manager.start('capture', { device: 'test' });
    const rejected = assert.rejects(starting, /cancelled/);
    manager.stopAll();
    await rejected;
    assert.equal(workers.length, 0);
  });

  await test('cancelling built-in pipe setup prevents a late helper launch', async () => {
    let listening, launches = 0;
    const { BuiltinCapture } = loadMain('builtin.js', {
      fs: {}, os: {}, path, crypto: require('node:crypto'), child_process: {}, worker_threads: {}, './pipe': pipe,
      net: { createServer() {
        const server = new EventEmitter();
        server.listen = (_name, callback) => { listening = callback; };
        server.close = () => {};
        return server;
      } },
    });
    const capture = new BuiltinCapture({ emit() {}, async launch() { launches++; } });
    const starting = capture.start('capture', { device: 'ndis:all' });
    const rejected = assert.rejects(starting, /cancelled/);
    await turn();
    await capture.stop('capture');
    listening();
    await rejected;
    assert.equal(launches, 0);
    assert.equal(capture.sessions.size, 0);
  });

  await test('built-in capture stop drains its helper and rejects packets after stopped', async () => {
    let server, socket;
    const events = [];
    const { BuiltinCapture } = loadMain('builtin.js', {
      fs: {}, os: {}, path, crypto: require('node:crypto'), child_process: {}, worker_threads: {}, './pipe': pipe,
      net: { createServer() {
        server = new EventEmitter();
        server.listen = (_name, callback) => { queueMicrotask(callback); };
        server.close = () => {};
        return server;
      } },
    });
    const capture = new BuiltinCapture({
      emit: (...event) => events.push(event),
      async launch(args) {
        socket = new EventEmitter();
        socket.destroyed = false;
        socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
        socket.write = (bytes) => {
          const command = JSON.parse(bytes.subarray(5));
          if (command.cmd === 'start') queueMicrotask(() => socket.emit('data', pipe.encodeJson({ type: 'started' })));
        };
        server.emit('connection', socket);
        socket.emit('data', pipe.encodeJson({ type: 'hello', token: args[2] }));
      },
    });
    await capture.start('capture', { device: 'ndis:all' });
    let stopped = false;
    const stopping = capture.stop('capture').then(() => { stopped = true; });
    await turn();
    assert.equal(stopped, false);
    socket.emit('data', pipe.encodeBatch({ ...batch(99), lts: new Uint16Array([1]).buffer }));
    socket.emit('data', pipe.encodeJson({ type: 'stopped' }));
    await stopping;
    const count = events.length;
    socket.emit('data', pipe.encodeBatch({ ...batch(98), lts: new Uint16Array([1]).buffer }));
    assert.equal(events.length, count);
    assert.equal(events.filter(([channel]) => channel === 'cap:packets').length, 1);
    socket.destroy();
  });

  await test('opening an offline file waits for stop and cannot ingest residual live packets', async () => {
    const done = deferred();
    const tab = renderer({ invoke: () => done.promise });
    const loading = tab.loadBytes(new Uint8Array([42]), 'offline.pcapng');
    tab.onLivePackets(batch(99));
    assert.deepEqual(tab.packets, [99], 'drain packets still belong to the live capture');
    done.resolve();
    await loading;
    tab.onLivePackets(batch(98));
    assert.deepEqual(tab.packets, [42]);
    assert.equal(tab.state, 'idle');
  });

  await test('an old startup reply cannot overwrite an offline capture opened during startup', async () => {
    const started = deferred();
    const tab = renderer({ invoke: (channel) => channel === 'cap:start' ? started.promise : Promise.resolve() });
    tab.state = 'idle';
    const starting = tab.start();
    assert.equal(tab.state, 'starting');
    await tab.loadBytes(new Uint8Array([42]), 'offline.pcapng');
    started.resolve({ linktype: 1 });
    await starting;
    assert.equal(tab.fileName, 'offline.pcapng');
    assert.equal(tab.state, 'idle');
    assert.deepEqual(tab.packets, [42]);
    assert.equal(tab.tick, undefined);
  });

  await test('a stopped event cannot allow restart until the stop reply finishes', async () => {
    const stopped = deferred();
    let starts = 0;
    const tab = renderer({ invoke: (channel) => {
      if (channel === 'cap:stop') return stopped.promise;
      starts++;
      return Promise.resolve({ linktype: 1 });
    } });
    const stopping = tab.stop();
    tab.onCapState({ state: 'stopped' });
    assert.equal(tab.state, 'stopping');
    await tab.start();
    assert.equal(starts, 0);
    stopped.resolve();
    await stopping;
    await tab.start();
    assert.equal(starts, 1);
    assert.equal(tab.state, 'running');
    clearInterval(tab.tick);
  });

  await test('starting live capture cancels an offline decode between slices', async () => {
    const timers = [];
    const tab = renderer({ invoke: async () => ({ linktype: 1 }) }, {
      setTimeout: (callback) => timers.push(callback),
      readCapture: () => ({ packets: Array.from({ length: 8001 }, () => ({ data: new Uint8Array([42]) })), format: 'pcapng' }),
    });
    const loading = tab.loadBytes(new Uint8Array(), 'offline.pcapng');
    await turn();
    assert.equal(tab.packets.length, 4000);
    await tab.start();
    timers.shift()();
    await loading;
    tab.onLivePackets(batch(7));
    assert.equal(tab.state, 'running');
    assert.deepEqual(tab.packets, [7]);
    assert.equal(tab.fileName, '');
    clearInterval(tab.tick);
  });

  await test('opening a second offline capture cancels the earlier decode', async () => {
    const timers = [];
    const tab = renderer({ invoke: async () => {} }, {
      setTimeout: (callback) => timers.push(callback),
      readCapture: (bytes) => ({ packets: Array.from({ length: bytes[0] === 42 ? 8001 : 1 }, () => ({ data: bytes })), format: 'pcapng' }),
    });
    const first = tab.loadBytes(new Uint8Array([42]), 'first.pcapng');
    await turn();
    const second = tab.loadBytes(new Uint8Array([7]), 'second.pcapng');
    await turn();
    for (const resume of timers.splice(0)) resume();
    await Promise.all([first, second]);
    assert.deepEqual(tab.packets, [7]);
    assert.equal(tab.fileName, 'second.pcapng');
  });
}

module.exports = { runCaptureLifecycleRegressionTests };

if (require.main === module) {
  let failures = 0;
  runCaptureLifecycleRegressionTests(async (name, fn) => {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failures++; console.error('  FAIL ' + name, e); }
  }).then(() => { process.exitCode = failures ? 1 : 0; });
}
