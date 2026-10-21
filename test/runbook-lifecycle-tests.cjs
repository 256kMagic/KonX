'use strict';
const assert = require('node:assert/strict');
const { mainLifecycleFixture, deferred, tick } = require('./update-lifecycle-tests.cjs');

async function runRunbookLifecycleTests(test) {
  await test('runbook main runner: production job routing passes declared inputs, emits evidence, and owns completion', async () => {
    const f = mainLifecycleFixture(), result = deferred(), params = { definition: { schemaVersion: 1 }, inputs: { host: 'fixture.test' } };
    f.runbook.run = async (input, emit, signal, connections) => {
      assert.equal(input, params); assert.equal(connections, f.connections); assert.equal(signal.kind, 'runbook');
      emit('step', { id: 'manual', status: 'unknown' }); await result.promise; emit('report', { kind: 'runbook', complete: true });
    };
    f.invoke('tools:start', 'runbook', params, 'book'); const task = f.jobs.get('book').task; await tick();
    assert.ok(f.sent.some(event => event[0] === 'tools:event' && event[2] === 'step')); assert.equal(f.jobs.size, 1);
    result.resolve(); await task; assert.equal(f.jobs.size, 0); assert.ok(f.sent.some(event => event[2] === 'report')); assert.ok(f.sent.some(event => event[2] === 'done'));
  });
  await test('runbook quit: native window close waits for owned probe completion before closing the window or SSH connections', async () => {
    const f = mainLifecycleFixture(), cleanup = deferred(); let stopped = false;
    f.connections.conns.set('borrowed-terminal', {});
    f.runbook.run = async (_params, _emit, signal) => { signal.onStop = () => { stopped = true; }; await cleanup.promise; signal.onStop = null; };
    f.invoke('tools:start', 'runbook', {}, 'probe'); const signal = f.jobs.get('probe'); await tick();
    assert.equal(f.nativeClose().defaultPrevented, true); await tick(); assert.equal(stopped, true); assert.equal(signal.stopped, true);
    assert.equal(f.app.exited, false); assert.equal(f.window.destroyed, false); assert.equal(f.connections.conns.size, 1);
    assert.throws(() => f.invoke('tools:start', 'runbook', {}, 'blocked'), /closing/); assert.throws(() => f.invoke('tools:runbookSave', {}), /closing/);
    cleanup.resolve(); await signal.task; await tick(); assert.equal(f.app.exited, true);
  });
  await test('runbook quit: a queued runbook is stopped before execution and remains awaited with remote jobs', async () => {
    const f = mainLifecycleFixture(), book = deferred(), remote = deferred(); let bookStarted = false;
    f.runbook.run = async (_params, _emit, signal) => { bookStarted = true; assert.equal(signal.stopped, true); await book.promise; };
    f.remote.run = async () => { await remote.promise; };
    f.invoke('tools:start', 'runbook', {}, 'book'); f.invoke('tools:start', 'remote-capture', {}, 'remote');
    const tasks = [...f.jobs.values()].map(signal => signal.task); f.app.quit(); await tick(); assert.equal(bookStarted, true);
    book.resolve(); await tick(); assert.equal(f.app.exited, false); remote.resolve(); await Promise.all(tasks); await tick(); assert.equal(f.app.exited, true);
  });
  await test('runbook store quit: queued file work is awaited and failed cleanup stays visible for a later retry', async () => {
    const f = mainLifecycleFixture(), cleanup = deferred(); f.runbook.hasOwnership = true; let fail = true, closes = 0;
    f.runbook.close = async () => { closes++; await cleanup.promise; if (fail) { f.runbook.hasPendingCleanup = true; throw Error('fixture runbook file busy'); } f.runbook.hasOwnership = false; f.runbook.hasPendingCleanup = false; };
    assert.equal(f.nativeClose().defaultPrevented, true); await tick(); assert.equal(f.app.exited, false); assert.equal(f.window.destroyed, false);
    cleanup.resolve(); await tick(); assert.equal(f.app.exited, false); assert.ok(f.calls.includes('shutdown-error')); assert.equal(f.runbook.hasPendingCleanup, true);
    fail = false; f.app.quit(); await tick(); assert.equal(closes, 2); assert.equal(f.app.exited, true);
  });
  await test('runbook main IPC: templates and CRUD use the store, import stays unsaved, export uses a selected saved ID', async () => {
    const f = mainLifecycleFixture(), calls = [];
    f.runbook.templates = () => [{ id: 'fixture' }]; f.runbook.list = async () => ({ runbooks: [{ id: 'saved' }], issues: [] });
    f.runbook.get = async id => { calls.push(['get', id]); return { id }; }; f.runbook.save = async params => { calls.push(['save', params]); return { id: 'saved' }; };
    f.runbook.remove = async id => { calls.push(['remove', id]); return { removed: true }; };
    f.runbook.importFile = async file => { calls.push(['import', file]); return { name: 'Validated imported definition' }; };
    f.runbook.exportFile = async (id, file) => { calls.push(['export', id, file]); return file; };
    assert.equal(f.invoke('tools:runbookTemplates')[0].id, 'fixture'); assert.equal((await f.invoke('tools:runbookList')).runbooks[0].id, 'saved');
    assert.equal(await f.invoke('tools:runbookImport'), null); assert.equal(calls.length, 0);
    f.dialogs.open = async () => ({ canceled: false, filePaths: ['C:\\chosen\\procedure.json'] });
    assert.equal((await f.invoke('tools:runbookImport')).name, 'Validated imported definition'); assert.deepEqual(calls, [['import', 'C:\\chosen\\procedure.json']]);
    await f.invoke('tools:runbookSave', { definition: { name: 'Validated' } }); await f.invoke('tools:runbookGet', 'saved');
    f.dialogs.save = async () => ({ canceled: false, filePath: 'C:\\chosen\\export.json' });
    assert.equal(await f.invoke('tools:runbookExport', 'saved'), 'C:\\chosen\\export.json'); assert.deepEqual(calls.at(-1), ['export', 'saved', 'C:\\chosen\\export.json']);
    await f.invoke('tools:runbookRemove', 'saved'); assert.deepEqual(calls.at(-1), ['remove', 'saved']);
    f.runbook.get = async () => { throw Error('unknown saved procedure'); }; f.dialogs.save = async () => { throw Error('must validate before picker'); };
    await assert.rejects(f.invoke('tools:runbookExport', 'foreign'), /unknown saved procedure/);
  });
  await test('runbook file picker: a late selected path cannot start import after the app has closed', async () => {
    const f = mainLifecycleFixture(), selected = deferred(); let imports = 0;
    f.dialogs.open = () => selected.promise; f.runbook.importFile = async () => { imports++; };
    const pending = f.invoke('tools:runbookImport'); f.app.quit(); await tick(); assert.equal(f.app.exited, true);
    selected.resolve({ canceled: false, filePaths: ['C:\\chosen\\late.json'] }); await assert.rejects(pending, /closing/); assert.equal(imports, 0);
  });
  await test('updater ownership: known capture, result, and runbook cleanup failures block helper commitment', async () => {
    for (const kind of ['capture', 'result', 'runbook']) {
      const f = mainLifecycleFixture();
      if (kind === 'capture') f.remote.hasPendingCleanup = true;
      else if (kind === 'result') f.remote.hasResultPendingCleanup = true;
      else f.runbook.hasPendingCleanup = true;
      await assert.rejects(f.invoke('app:updateInstall'), /retry pending .* cleanup before updating/);
      assert.equal(f.controller.committed, false); assert.ok(!f.calls.includes('launch-helper')); assert.ok(!f.calls.includes('commit-helper'));
    }
  });
}
module.exports = { runRunbookLifecycleTests };
if (require.main === module) {
  let passed = 0;
  runRunbookLifecycleTests(async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); })
    .then(() => console.log(`${passed} runbook lifecycle tests passed`)).catch(error => { console.error(error); process.exitCode = 1; });
}
