'use strict';

const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const { EventConsole } = require('../src/main/events');
const { registerEvents } = require('../src/main/events-ipc');
const { fixtures: { v5424 } } = require('./events-tests.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const settled = task => task.then(() => ({ ok: true }), error => ({ ok: false, error }));
async function until(check, description) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (check()) return; await pause(5); }
  throw new Error('Timed out waiting for ' + description);
}
async function portFor() {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
    return socket.address().port;
  } finally { await new Promise(resolve => socket.close(resolve)); }
}
const send = (socket, text, port) => new Promise((resolve, reject) => {
  socket.send(v5424(text), port, '127.0.0.1', error => error ? reject(error) : resolve());
});
function harness(events, options = {}) {
  const handlers = new Map(), state = { closing: false };
  registerEvents((name, handler) => {
    assert.equal(handlers.has(name), false, 'each IPC channel is registered once'); handlers.set(name, handler);
  }, { events, isClosing: () => state.closing, ...options });
  const invoke = (name, ...args) => handlers.get('tools:events' + name)(...args);
  return { handlers, state, invoke };
}
async function listening(events, id, emit = () => {}) {
  const port = await portFor();
  const task = settled(events.run({ listenerId: id, protocol: 'syslog', bindAddress: '127.0.0.1', port }, emit));
  await until(() => events.snapshot(id).state === 'listening', 'owned loopback listener ' + id);
  return { port, task };
}
async function fixture(fn) {
  const events = new EventConsole(), sender = dgram.createSocket('udp4');
  try { await fn(events, sender); }
  finally { try { await events.close(); } finally { await new Promise(resolve => sender.close(resolve)); } }
}

async function runEventsIpcTests(test) {
  await test('Events IPC lists and pages real UDP history, clears without stopping, and removes only released listeners', () => fixture(async (events, sender) => {
    const { handlers, invoke } = harness(events, { isClosing: undefined }), emitted = [];
    assert.deepEqual([...handlers.keys()].sort(), ['tools:eventsClear', 'tools:eventsList', 'tools:eventsRemove', 'tools:eventsSnapshot', 'tools:eventsStop']);
    const first = await listening(events, 'ipc-first', (type, data) => emitted.push({ type, data }));
    const other = await listening(events, 'ipc-other');
    await send(sender, 'first packet', first.port); await send(sender, 'second packet', first.port);
    await until(() => invoke('Snapshot', 'ipc-first').retainedRecords === 2, 'both UDP records');
    const listing = invoke('List'); assert.equal(listing.listeners.length, 2);
    assert.ok(listing.listeners.every(item => item.state === 'listening' && item.hasOwnership));
    const page = invoke('Snapshot', 'ipc-first', { limit: 1 });
    assert.equal(page.records[0].message, 'first packet'); assert.equal(page.records[0].source.address, '127.0.0.1');
    assert.equal(page.nextSequence, 1); assert.equal(page.hasMore, true);
    const next = invoke('Snapshot', 'ipc-first', { afterSequence: page.nextSequence, limit: 1 });
    assert.equal(next.records[0].message, 'second packet'); assert.equal(next.hasMore, false);
    page.records[0].message = 'modified IPC result'; listing.listeners[0].settings.port = 1;
    assert.equal(invoke('Snapshot', 'ipc-first').records[0].message, 'first packet');
    assert.equal(invoke('Snapshot', 'ipc-first').settings.port, first.port);
    assert.throws(() => invoke('Remove', 'ipc-first'), { code: 'EVENTS_BUSY' });
    const cleared = invoke('Clear', 'ipc-first'), afterClear = emitted.length;
    assert.equal(cleared.retainedRecords, 0); assert.equal(cleared.lastSequence, 2); assert.equal(cleared.counters.accepted, 2);
    assert.equal(cleared.state, 'listening'); assert.equal(cleared.hasOwnership, true);
    await send(sender, 'after clear', first.port);
    await until(() => invoke('Snapshot', 'ipc-first').lastSequence === 3, 'post-clear UDP record');
    const stopped = await invoke('Stop', 'ipc-first'); assert.equal(stopped.hasOwnership, false); assert.equal(stopped.state, 'stopped');
    assert.equal((await first.task).ok, true);
    assert.deepEqual(emitted.slice(afterClear).filter(item => item.type === 'events').flatMap(item => item.data.records.map(record => record.sequence)), [3]);
    assert.equal(invoke('Snapshot', 'ipc-other').state, 'listening');
    await send(sender, 'other stays live', other.port);
    await until(() => invoke('Snapshot', 'ipc-other').retainedRecords === 1, 'independent listener after first stop');
    assert.deepEqual(invoke('Remove', 'ipc-first'), { removed: 'ipc-first' });
    assert.throws(() => invoke('Snapshot', 'ipc-first'), { code: 'EVENTS_NOT_FOUND' });
    await invoke('Stop', 'ipc-other'); assert.equal((await other.task).ok, true);
    invoke('Remove', 'ipc-other'); assert.deepEqual(invoke('List').listeners, []);
  }));

  await test('Events IPC preserves owner validation and allows inspection/cleanup, but no history mutation, during shutdown', () => fixture(async (events, sender) => {
    const { state, invoke } = harness(events), run = await listening(events, 'closing');
    await send(sender, 'retained during shutdown', run.port);
    await until(() => invoke('Snapshot', 'closing').retainedRecords === 1, 'shutdown history');
    for (const options of [null, [], { limit: 0 }, { limit: 1001 }, { afterSequence: -1 }, { afterSequence: '1' }, { extra: true }]) {
      assert.throws(() => invoke('Snapshot', 'closing', options), { code: 'EVENTS_INVALID' });
    }
    for (const id of [undefined, {}, '../closing', '']) {
      assert.throws(() => invoke('Snapshot', id), { code: 'EVENTS_INVALID' });
      assert.throws(() => invoke('Clear', id), { code: 'EVENTS_INVALID' });
      assert.throws(() => invoke('Remove', id), { code: 'EVENTS_INVALID' });
      await assert.rejects(invoke('Stop', id), { code: 'EVENTS_INVALID' });
    }
    state.closing = true;
    assert.throws(() => invoke('Clear', 'closing'), /KonX is closing/);
    assert.throws(() => invoke('Remove', 'closing'), /KonX is closing/);
    assert.equal(invoke('List').listeners[0].hasOwnership, true);
    assert.equal(invoke('Snapshot', 'closing').records[0].message, 'retained during shutdown');
    const result = await invoke('Stop', 'closing'); assert.equal(result.state, 'stopped'); assert.equal(result.hasOwnership, false);
    assert.equal((await run.task).ok, true);
    assert.equal(invoke('Snapshot', 'closing').retainedRecords, 1);
    assert.throws(() => invoke('Remove', 'closing'), /KonX is closing/);
    state.closing = false;
    assert.equal(invoke('Clear', 'closing').retainedRecords, 0);
    assert.deepEqual(invoke('Remove', 'closing'), { removed: 'closing' });
    assert.equal(events.hasOwnership, false);
  }));

  await test('Events IPC exposes failed socket cleanup and permits exact-owner retry while shutdown blocks removal', async () => {
    class Socket extends EventEmitter {
      bind() { setImmediate(() => this.emit('listening')); }
      close() {
        this.closeCalls = (this.closeCalls || 0) + 1;
        if (!this.allowClose) throw new Error('Synthetic close failure');
        setImmediate(() => this.emit('close'));
      }
    }
    const socket = new Socket(), events = new EventConsole({ createSocket: () => socket, closeTimeoutMs: 40 });
    const { state, invoke } = harness(events);
    const task = settled(events.run({ listenerId: 'retry', protocol: 'syslog' }, () => {}));
    try {
      await until(() => invoke('Snapshot', 'retry').state === 'listening', 'injected listener');
      await assert.rejects(invoke('Stop', 'retry'), { code: 'EVENTS_CLEANUP' });
      assert.equal((await task).error.code, 'EVENTS_CLEANUP');
      assert.equal(events.hasOwnership, true); assert.equal(events.get('retry').owner.socket, socket);
      assert.equal(invoke('List').listeners[0].state, 'cleanup-pending');
      assert.equal(invoke('Snapshot', 'retry').hasOwnership, true);
      assert.throws(() => invoke('Remove', 'retry'), { code: 'EVENTS_BUSY' });
      state.closing = true;
      assert.throws(() => invoke('Clear', 'retry'), /KonX is closing/);
      assert.throws(() => invoke('Remove', 'retry'), /KonX is closing/);
      socket.allowClose = true;
      const result = await invoke('Stop', 'retry');
      assert.ok(socket.closeCalls >= 2); assert.equal(result.hasOwnership, false); assert.equal(events.hasOwnership, false);
      assert.equal(invoke('List').listeners[0].state, 'stopped');
      assert.throws(() => invoke('Remove', 'retry'), /KonX is closing/);
      state.closing = false; assert.deepEqual(invoke('Remove', 'retry'), { removed: 'retry' });
    } finally { socket.allowClose = true; await events.close(); }
  });
}

module.exports = { runEventsIpcTests };
if (require.main === module) runEventsIpcTests(async (name, fn) => { await fn(); console.log('PASS ' + name); })
  .catch(error => { console.error(error); process.exitCode = 1; });
