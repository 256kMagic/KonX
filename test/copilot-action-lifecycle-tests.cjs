'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { mainLifecycleFixture: fixture, deferred, tick } = require('./update-lifecycle-tests.cjs');
async function settle(check) { for (let i = 0; i < 40 && !check(); i++) await tick(); assert.ok(check(), 'Main lifecycle did not settle'); }
async function runCopilotActionLifecycleTests(test) {
  await test('Reviewed editor bridge is explicitly available through the real isolated preload allowlist', async () => {
    let exposed, subscribed; const listeners = new Map(), invoked = [];
    const filename = path.join(__dirname, '../src/preload/preload.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { process: { platform: process.platform }, require: name => {
      assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'api'); exposed = value; } }, webUtils: {},
        ipcRenderer: { on: (name, listener) => listeners.set(name, listener), removeListener: name => listeners.delete(name), invoke: (...args) => { invoked.push(args); return Promise.resolve(); } } };
    } }, { filename });
    const off = exposed.on('copilot:editorAction', request => { subscribed = request; }); const request = { operationId: 'fixture', nonce: 'owned' };
    listeners.get('copilot:editorAction')({}, request); assert.equal(subscribed, request);
    await exposed.invoke('tools:copilotActionEditorAck', request); assert.deepEqual(invoked[0], ['tools:copilotActionEditorAck', request]); off(); assert.equal(listeners.size, 0);
    assert.throws(() => exposed.on('arbitrary:execute', () => {}), /Blocked/);
  });
  await test('Reviewed actions actual main: shared store, primary-only editor dispatch and acknowledged completion while shutdown freezes new work', async () => {
    const f = fixture(); assert.equal(f.copilot.options.store, f.actions.options.store);
    const request = { operationId: 'owned-operation', nonce: 'owned-nonce', target: { tabId: 'owned-notepad' } };
    assert.equal(f.actions.options.requestEditor(request), true); assert.deepEqual(f.sent.at(-1), ['copilot:editorAction', request]);
    assert.throws(() => f.invokeFrom({ sender: {}, senderFrame: {} }, 'tools:copilotActionEditorAck', request), /primary/);
    assert.throws(() => f.invokeFrom({ sender: f.window.webContents, senderFrame: {} }, 'tools:copilotActionPrepare', {}), /primary/);
    const held = deferred(); let cancelled = false;
    f.actions.run = async (_params, _emit, signal) => { f.actions.hasOwnership = true; signal.onStop = () => { cancelled = true; }; await held.promise; f.actions.hasOwnership = false; };
    await f.invoke('tools:start', 'copilot-action', {}, 'owned-action'); await tick();
    await assert.rejects(f.invoke('app:updateInstall'), /running tools|reviewed Copilot/);
    f.app.quit(); await tick(); assert.equal(cancelled, true); assert.equal(f.app.exited, false); assert.equal(f.window.isDestroyed(), false);
    assert.throws(() => f.invoke('tools:copilotActionPrepare', {}), /closing/); assert.throws(() => f.invoke('tools:start', 'copilot-action', {}, 'late-action'), /closing/);
    assert.equal(f.actions.options.requestEditor(request), false);
    assert.equal(f.invoke('tools:copilotActionEditorAck', request).accepted, true); assert.equal(f.invoke('tools:copilotActionDiscard', 'fixture').discarded, true);
    held.resolve(); await settle(() => f.app.exited); assert.equal(f.jobs.size, 0);
  });
  await test('Reviewed actions actual main: failed finalization retains native window and update blocker until retry, actions close before shared store owner', async () => {
    const f = fixture(), order = []; f.actions.hasOwnership = true; f.actions.hasPendingCleanup = true;
    f.actions.close = async () => { order.push('actions'); throw new Error('Synthetic action outcome could not be saved'); };
    f.copilot.close = async () => { order.push('copilot'); };
    await assert.rejects(f.invoke('app:updateInstall'), /reviewed Copilot/);
    const close = f.nativeClose(); assert.equal(close.defaultPrevented, true); await settle(() => f.calls.includes('shutdown-error'));
    assert.equal(f.app.exited, false); assert.equal(f.window.isDestroyed(), false); assert.equal(f.actions.hasOwnership, true); assert.deepEqual(order.slice(0, 2), ['actions', 'copilot']);
    f.actions.close = async () => { order.push('actions'); f.actions.hasOwnership = false; f.actions.hasPendingCleanup = false; };
    f.app.quit(); await settle(() => f.app.exited); assert.deepEqual(order.slice(-2), ['actions', 'copilot']);
  });
  await test('Reviewed actions actual main: committed updater cannot bypass retained action cleanup or reject correlated completion IPC', async () => {
    const f = fixture(); f.controller.committed = true; f.controller.installing = true; f.actions.hasOwnership = true;
    assert.equal(f.invoke('tools:copilotActionEditorAck', { operationId: 'owned', nonce: 'fixture', status: 'rejected' }).accepted, true);
    f.actions.close = async () => { f.actions.hasOwnership = false; };
    f.app.quit(); await settle(() => f.app.exited); assert.equal(f.actions.hasOwnership, false);
  });
}
module.exports = { runCopilotActionLifecycleTests };
if (require.main === module) { let passed = 0; runCopilotActionLifecycleTests(async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); }).then(() => console.log(`${passed} reviewed-action lifecycle tests passed`)).catch(error => { console.error(error); process.exitCode = 1; }); }
