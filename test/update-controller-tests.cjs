'use strict';
const assert = require('node:assert/strict');
const { UpdateController } = require('../src/main/update-controller');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}) {
  const calls = [], states = [], reasons = [];
  const manager = {
    snapshot: () => ({ status: 'ready', version: '0.5.2', currentVersion: '0.5.1', supported: true, mode: 'portable' }),
    start: async () => { calls.push('start'); return manager.snapshot(); },
    cancel: async () => { calls.push('cancel-download'); },
    getReady: async () => { calls.push('verify'); return { version: '0.5.2' }; },
  };
  const handoff = { commit: async () => { calls.push('commit'); }, cancel: async () => { calls.push('cancel-helper'); } };
  const controller = new UpdateController({ manager, target: {}, cacheDir: 'fixture', busyReasons: () => [...reasons],
    launch: async () => { calls.push('launch'); return handoff; }, quit: () => calls.push('quit'), onState: (s) => states.push(s), ...overrides });
  return { controller, calls, states, manager, handoff, reasons };
}

async function runUpdateControllerTests(test) {
  await test('updates: startup and ordinary quit never install a downloaded update', async () => {
    const { controller, calls } = fixture();
    assert.equal(controller.snapshot().status, 'ready');
    assert.deepEqual(calls, []);
    await controller.shutdown();
    assert.deepEqual(calls, ['cancel-download']);
  });
  await test('updates: pending file operations and active resources block restart without launching a helper', async () => {
    const { controller, calls, reasons } = fixture();
    const writing = deferred();
    const operation = controller.invoke('np:write', () => writing.promise);
    await assert.rejects(controller.install(), /pending file operations/);
    assert.deepEqual(calls, []);
    writing.resolve(true); await operation;
    reasons.push('Disconnect active terminal connections before updating.');
    await assert.rejects(controller.install(), /Disconnect/);
    assert.deepEqual(calls, []);
    reasons.length = 0;
    await controller.install();
    assert.deepEqual(calls, ['verify', 'launch', 'cancel-download', 'commit', 'quit']);
  });
  await test('updates: operation tracking settles synchronous throws and asynchronous rejection', async () => {
    const { controller } = fixture();
    assert.throws(() => controller.invoke('np:write', () => { throw new Error('disk full'); }), /disk full/);
    assert.equal(controller.pendingOperations, 0);
    await assert.rejects(controller.invoke('sftp:writeFile', () => Promise.reject(new Error('offline'))), /offline/);
    assert.equal(controller.pendingOperations, 0);
    assert.equal(controller.invoke('settings:get', () => 123), 123);
    assert.equal(controller.pendingOperations, 0);
  });
  await test('updates: duplicate install clicks share one verified handoff and new work is frozen', async () => {
    const { controller, manager, calls } = fixture();
    const verifying = deferred();
    manager.getReady = () => { calls.push('verify'); return verifying.promise; };
    const first = controller.install();
    assert.equal(first, controller.install());
    assert.equal(controller.snapshot().status, 'installing');
    assert.throws(() => controller.invoke('conn:open', () => calls.push('connection')), /preparing to restart/);
    assert.throws(() => controller.cancel(), /preparing to restart/);
    assert.equal(controller.invoke('app:updateState', () => controller.snapshot()).status, 'installing');
    verifying.resolve({ version: '0.5.2' });
    await first;
    assert.deepEqual(calls, ['verify', 'launch', 'cancel-download', 'commit', 'quit']);
    await controller.shutdown();
    assert.ok(!calls.includes('cancel-helper') && calls.filter(c => c === 'cancel-download').length === 1);
  });
  await test('updates: a late resource acquired during verification prevents helper launch', async () => {
    const { controller, manager, calls, reasons } = fixture();
    const verifying = deferred();
    manager.getReady = () => verifying.promise;
    const pending = controller.install();
    reasons.push('Stop packet capture before updating.');
    verifying.resolve({});
    await assert.rejects(pending, /Stop packet capture/);
    assert.deepEqual(calls, []);
    assert.equal(controller.installing, false);
  });
  await test('updates: late work during helper preparation cancels the helper and keeps KonX open', async () => {
    const prepared = deferred();
    const { controller, calls, handoff, reasons } = fixture({ launch: () => prepared.promise });
    const pending = controller.install();
    await Promise.resolve();
    reasons.push('Wait for the knowledge library to finish its current operation.');
    prepared.resolve(handoff);
    await assert.rejects(pending, /knowledge library/);
    assert.deepEqual(calls, ['verify', 'cancel-helper']);
    assert.equal(controller.snapshot().status, 'ready');
  });
  await test('updates: checksum or helper failures never quit and a failed handoff can be retried', async () => {
    const { controller, calls, manager, handoff } = fixture();
    manager.getReady = async () => { throw new Error('Checksum mismatch'); };
    await assert.rejects(controller.install(), /Checksum mismatch/);
    assert.deepEqual(calls, []);
    manager.getReady = async () => ({});
    handoff.commit = async () => { throw new Error('Helper exited'); };
    await assert.rejects(controller.install(), /Helper exited/);
    assert.deepEqual(calls, ['launch', 'cancel-download', 'cancel-helper']);
    handoff.commit = async () => { calls.push('commit'); };
    await controller.install();
    assert.deepEqual(calls, ['launch', 'cancel-download', 'cancel-helper', 'launch', 'cancel-download', 'commit', 'quit']);
  });
  await test('updates: failed helper cancellation retains ownership and must settle before retry', async () => {
    const { controller, calls, handoff } = fixture();
    handoff.commit = async () => { throw new Error('Commit interrupted'); };
    handoff.cancel = async () => { throw new Error('Control file locked'); };
    await assert.rejects(controller.install(), /cleanup failed/);
    assert.equal(controller.handoff, handoff);
    await assert.rejects(controller.install(), /Control file locked/);
    assert.deepEqual(calls, ['verify', 'launch', 'cancel-download']);
    handoff.cancel = async () => { calls.push('cancel-helper'); };
    handoff.commit = async () => { calls.push('commit'); };
    await controller.install();
    assert.deepEqual(calls, ['verify', 'launch', 'cancel-download', 'cancel-helper', 'verify', 'launch', 'cancel-download', 'commit', 'quit']);
  });
}
module.exports = { runUpdateControllerTests };
