'use strict';
const assert = require('node:assert/strict');
const { mainLifecycleFixture, deferred, tick } = require('./update-lifecycle-tests.cjs');
const rawReport = () => ({ schemaVersion: 1, kind: 'remote-capture', file: 'C:\\private-profile\\remote-captures\\source.pcap', bytes: 100, packets: 1, complete: true });
const events = fixture => fixture.sent.filter(item => item[0] === 'tools:event');
async function runRemoteLifecycleTests(test) {
  await test('remote main runner: streams progress but publishes only registered opaque reports and awaits registration', async () => {
    const f = mainLifecycleFixture(), registration = deferred(), raw = rawReport();
    f.remote.run = async (_params, emit) => { emit('progress', { phase: 'fixture capturing' }); emit('report', raw); return raw; };
    f.remote.remember = async report => { assert.equal(report, raw); await registration.promise; f.remote.hasOpenHandles = true; const { file, ...value } = report; return { ...value, captureId: 'opaque', fileName: 'saved.pcap' }; };
    assert.equal(f.invoke('tools:start', 'remote-capture', {}, 'capture-one'), 'capture-one');
    const task = f.jobs.get('capture-one').task; assert.equal(typeof task.then, 'function'); await tick();
    assert.ok(events(f).some(event => event[2] === 'progress')); assert.ok(!events(f).some(event => event[2] === 'report')); assert.equal(f.jobs.size, 1);
    registration.resolve(); await task;
    const report = events(f).find(event => event[2] === 'report')[3]; assert.equal(report.captureId, 'opaque'); assert.equal(report.file, undefined); assert.equal(f.jobs.size, 0);
    assert.ok(!JSON.stringify(events(f)).includes('private-profile')); assert.equal(events(f).filter(event => event[2] === 'done').length, 1);
    assert.equal((await f.invoke('tools:remoteCaptureRead', 'opaque')).name, 'opaque.pcap'); assert.equal((await f.invoke('tools:remoteCaptureRemove', 'opaque')).captureId, 'opaque');
  });
  await test('remote main runner: synchronous capacity reservations include in-flight jobs and release on failure', async () => {
    const f = mainLifecycleFixture(), first = deferred(), second = deferred(); let starts = 0;
    f.remote.run = () => (++starts === 1 ? first.promise : second.promise);
    f.invoke('tools:start', 'remote-capture', {}, 'one'); f.invoke('tools:start', 'remote-capture', {}, 'two');
    assert.deepEqual(f.remote.capacityChecks, [0, 1]); const one = f.jobs.get('one').task, two = f.jobs.get('two').task;
    assert.throws(() => f.invoke('tools:start', 'remote-capture', {}, 'one'), /already running/); assert.deepEqual(f.remote.capacityChecks, [0, 1]);
    f.remote.capacityError = Error('capacity fixture'); assert.throws(() => f.invoke('tools:start', 'remote-capture', {}, 'three'), /capacity fixture/); assert.equal(f.jobs.size, 2);
    first.reject(Error('capture failed')); second.resolve(); await Promise.all([one, two]); assert.equal(f.jobs.size, 0);
    f.remote.capacityError = null; f.remote.run = async () => undefined; f.invoke('tools:start', 'remote-capture', {}, 'four'); assert.equal(f.remote.capacityChecks.at(-1), 0); await f.jobs.get('four').task;
    assert.ok(events(f).some(event => event[2] === 'error' && event[3].message === 'capture failed'));
  });
  await test('remote quit: cancellation waits for late report registration before closing result handles', async () => {
    const f = mainLifecycleFixture(), registration = deferred(); let registering = false, closes = 0;
    f.remote.run = async () => rawReport();
    f.remote.remember = async report => { registering = true; await registration.promise; f.remote.hasOpenHandles = true; const { file, ...value } = report; return { ...value, captureId: 'late' }; };
    f.remote.close = async () => { closes++; assert.equal(f.remote.hasOpenHandles, true); f.remote.hasOpenHandles = false; };
    f.invoke('tools:start', 'remote-capture', {}, 'late'); const signal = f.jobs.get('late'); await tick(); assert.equal(registering, true);
    f.app.quit(); f.app.quit(); await tick(); assert.equal(signal.stopped, true); assert.equal(closes, 0); assert.equal(f.app.exited, false); assert.equal(f.window.destroyed, false);
    assert.throws(() => f.invoke('tools:start', 'remote-capture', {}, 'blocked'), /closing/);
    registration.resolve(); await signal.task; await tick(); assert.equal(closes, 1); assert.equal(f.app.exited, true);
  });
  await test('remote main runner: pending writable cleanup prevents new jobs before reserving capacity', async () => {
    const f = mainLifecycleFixture(); f.remote.hasPendingCleanup = true;
    assert.throws(() => f.invoke('tools:start', 'remote-capture', {}, 'blocked'), /cleanup is pending/);
    assert.equal(f.jobs.size, 0); assert.deepEqual(f.remote.capacityChecks, []);
    f.remote.hasPendingCleanup = false; f.remote.run = async () => undefined;
    f.invoke('tools:start', 'remote-capture', {}, 'ready'); await f.jobs.get('ready').task;
    assert.deepEqual(f.remote.capacityChecks, [0]);
  });
  await test('remote quit: a job stopped before its microtask starts is still awaited and cannot escape the quit gate', async () => {
    const f = mainLifecycleFixture(); let starts = 0, closes = 0;
    f.remote.run = async (_params, _emit, signal) => { starts++; assert.equal(signal.stopped, true); return undefined; };
    f.remote.close = async () => { closes++; };
    f.invoke('tools:start', 'remote-capture', {}, 'queued'); const task = f.jobs.get('queued').task; f.app.quit();
    assert.equal(f.app.exited, false); await task; await tick(); assert.equal(starts, 1); assert.equal(closes, 1); assert.equal(f.app.exited, true);
  });
  await test('remote quit: native window close retains the window on cleanup failure and retries ownership', async () => {
    const f = mainLifecycleFixture(); f.remote.hasOpenHandles = true; let fail = true, closes = 0;
    f.remote.close = async () => { closes++; if (fail) throw Error('fixture result handle is busy'); f.remote.hasOpenHandles = false; };
    assert.equal(f.nativeClose().defaultPrevented, true); await tick();
    assert.equal(f.app.exited, false); assert.equal(f.window.destroyed, false); assert.equal(f.remote.hasOpenHandles, true); assert.ok(f.calls.includes('shutdown-error'));
    fail = false; f.app.quit(); await tick(); assert.equal(closes, 2); assert.equal(f.app.exited, true);
  });
  await test('remote quit: failed writable-file cleanup is retained and does not skip registry cleanup', async () => {
    const f = mainLifecycleFixture(); f.remote.hasPendingCleanup = true; f.remote.hasOpenHandles = true; let fail = true, registryCloses = 0, writableCloses = 0;
    f.remote.closePending = async () => { writableCloses++; if (fail) throw Error('fixture writable handle is busy'); f.remote.hasPendingCleanup = false; };
    f.remote.close = async () => { registryCloses++; f.remote.hasOpenHandles = false; };
    f.app.quit(); await tick(); assert.equal(f.app.exited, false); assert.equal(f.window.destroyed, false); assert.equal(f.remote.hasPendingCleanup, true); assert.equal(registryCloses, 1);
    fail = false; f.app.quit(); await tick(); assert.equal(writableCloses, 2); assert.equal(registryCloses, 2); assert.equal(f.app.exited, true);
  });
  await test('remote updater quit: committed installer handoff still awaits registry handles and preserves its payload', async () => {
    const f = mainLifecycleFixture(), cleanup = deferred(); f.remote.hasOpenHandles = true; let closes = 0;
    f.remote.close = async () => { closes++; await cleanup.promise; f.remote.hasOpenHandles = false; };
    await f.invoke('app:updateInstall'); assert.equal(f.controller.committed, true); await tick();
    assert.equal(closes, 1); assert.equal(f.app.exited, false); assert.equal(f.window.destroyed, false); assert.equal(f.calls.filter(call => call === 'cancel-download').length, 1);
    cleanup.resolve(); await tick(); assert.equal(f.app.exited, true); assert.equal(f.calls.filter(call => call === 'cancel-helper').length, 0);
  });
  await test('remote quit: cancelled connection prompt permits a later remote capture with fresh cleanup ownership', async () => {
    const f = mainLifecycleFixture(); f.remote.hasOpenHandles = true; f.connections.conns.set('terminal', {}); f.setPromptChoice(1);
    f.app.quit(); await tick(); assert.equal(f.app.exited, false); assert.equal(f.remote.hasOpenHandles, false); assert.ok(f.calls.includes('connection-prompt'));
    f.remote.run = async () => undefined; f.invoke('tools:start', 'remote-capture', {}, 'after-cancel'); await f.jobs.get('after-cancel').task;
    f.setPromptChoice(0); f.app.quit(); await tick(); assert.equal(f.app.exited, true);
  });
  await test('remote main runner: rejected registration emits an error without exposing a local path or leaking capacity', async () => {
    const f = mainLifecycleFixture(); f.remote.run = async () => rawReport(); f.remote.remember = async () => { throw Error('fixture registration rejected'); };
    f.invoke('tools:start', 'remote-capture', {}, 'reject'); await f.jobs.get('reject').task;
    assert.equal(f.jobs.size, 0); assert.ok(!events(f).some(event => event[2] === 'report')); assert.ok(events(f).some(event => event[2] === 'error')); assert.ok(!JSON.stringify(events(f)).includes('private-profile'));
    f.remote.run = async () => undefined; f.invoke('tools:start', 'remote-capture', {}, 'retry'); assert.equal(f.remote.capacityChecks.at(-1), 0); await f.jobs.get('retry').task;
  });
}
module.exports = { runRemoteLifecycleTests };
if (require.main === module) {
  let passed = 0;
  runRemoteLifecycleTests(async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); })
    .then(() => console.log(`${passed} remote lifecycle tests passed`)).catch(error => { console.error(error); process.exitCode = 1; });
}
