'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WorkspaceWindows, isPrimaryFrame } = require('../src/main/workspace-windows');
const { mainLifecycleFixture, tick } = require('./update-lifecycle-tests.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

class Window extends EventEmitter {
  constructor() {
    super(); this.destroyed = false;
    this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
    this.webContents.setWindowOpenHandler = handler => { this.openWindow = handler; };
    this.webContents.getBackgroundThrottling = () => this.throttling;
    this.webContents.setBackgroundThrottling = value => { this.throttling = value; };
    this.throttling = true;
  }
  isDestroyed() { return this.destroyed; }
  close() { const e = event(); this.emit('close', e); if (!e.defaultPrevented) this.destroy(); return e; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  static getFocusedWindow() { return Window.focused || null; }
}
function harness() {
  const primary = new Window(), events = [], external = []; let now = 100;
  const owner = new WorkspaceWindows({ primary, BrowserWindow: Window, emit: (...args) => events.push(args), openExternal: url => external.push(url), now: () => now });
  const open = () => {
    const permit = owner.prepare(), details = { url: 'about:blank', frameName: permit.frameName };
    assert.equal(primary.openWindow(details).action, 'allow');
    const child = new Window(); primary.webContents.emit('did-create-window', child, details);
    return { ...permit, child };
  };
  return { primary, owner, events, external, open, advance: ms => { now += ms; } };
}
function nativePopup(f) {
  const permit = f.invoke('app:popoutPrepare'), details = { url: 'about:blank', frameName: permit.frameName };
  assert.equal(f.window.openWindow(details).action, 'allow');
  const child = new Window(); f.window.webContents.emit('did-create-window', child, details);
  return { ...permit, child };
}

async function runWorkspaceWindowTests(test) {
  await test('Workspace windows require exact single-use permits and retain secure web preferences', () => {
    const h = harness();
    try {
      const permit = h.owner.prepare();
      for (const url of ['about:blank#extra', 'file:///unowned.html', 'javascript:alert(1)', 'data:text/html,unowned']) assert.equal(h.primary.openWindow({ url, frameName: permit.frameName }).action, 'deny');
      assert.equal(h.primary.openWindow({ url: 'about:blank', frameName: 'unowned' }).action, 'deny');
      const allowed = h.primary.openWindow({ url: 'about:blank', frameName: permit.frameName, features: 'nodeIntegration=yes,sandbox=no,webSecurity=no' });
      assert.equal(allowed.action, 'allow');
      assert.deepEqual(allowed.overrideBrowserWindowOptions.webPreferences, { sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, webviewTag: false, backgroundThrottling: false });
      assert.equal(allowed.outlivesOpener, false);
      assert.equal(h.primary.openWindow({ url: 'about:blank', frameName: permit.frameName }).action, 'deny');
      assert.equal(h.primary.openWindow({ url: 'https://example.invalid/fixture', frameName: 'external' }).action, 'deny');
      assert.deepEqual(h.external, ['https://example.invalid/fixture']);
    } finally { h.owner.dispose(); }
  });

  await test('Workspace permits expire, can be cancelled and bound pending window allocations', () => {
    const h = harness();
    try {
      const expired = h.owner.prepare(); h.advance(15000);
      assert.equal(h.primary.openWindow({ url: 'about:blank', frameName: expired.frameName }).action, 'deny');
      const cancelled = h.owner.prepare(); assert.equal(h.owner.close(cancelled.id), true);
      assert.equal(h.primary.openWindow({ url: 'about:blank', frameName: cancelled.frameName }).action, 'deny');
      const permits = Array.from({ length: 16 }, () => h.owner.prepare());
      assert.throws(() => h.owner.prepare(), /Close an existing/);
      assert.equal(h.owner.close(permits[0].id), true); assert.ok(h.owner.prepare().id);
      const unexpected = new Window(); h.primary.webContents.emit('did-create-window', unexpected, { url: 'about:blank', frameName: 'unowned' });
      assert.equal(unexpected.destroyed, true);
    } finally { h.owner.dispose(); }
  });

  await test('Workspace native close requests redock once and keeps a child alive until renderer acknowledgement', () => {
    const h = harness();
    try {
      const popup = h.open(); assert.equal(h.primary.throttling, false); assert.equal(popup.child.throttling, false);
      assert.equal(popup.child.close().defaultPrevented, true); popup.child.close();
      assert.equal(popup.child.destroyed, false); assert.equal(h.owner.hasOwnership, true);
      assert.deepEqual(h.events, [['app:popoutDock', { id: popup.id }]]);
      assert.equal(h.owner.close(popup.id), true); assert.equal(h.owner.close(popup.id), false);
      assert.equal(popup.child.destroyed, true); assert.equal(h.owner.hasOwnership, false); assert.equal(h.primary.throttling, true);
      assert.equal(h.events.length, 1, 'normal acknowledgement does not report unexpected closure');
    } finally { h.owner.dispose(); }
  });

  await test('Workspace unexpected closure, navigation denial and native dialog ownership stay scoped to owned windows', () => {
    const h = harness();
    try {
      const popup = h.open();
      for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) { const e = event(); popup.child.webContents.emit(name, e); assert.equal(e.defaultPrevented, true); }
      assert.equal(popup.child.openWindow({ url: 'about:blank' }).action, 'deny');
      Window.focused = popup.child; assert.equal(h.owner.dialogOwner(), popup.child);
      Window.focused = new Window(); assert.equal(h.owner.dialogOwner(), h.primary);
      popup.child.destroy();
      assert.deepEqual(h.events, [['app:popoutClosed', { id: popup.id }]]);
      assert.equal(h.owner.hasOwnership, false); assert.equal(h.primary.throttling, true);
    } finally { Window.focused = null; h.owner.dispose(); }
  });

  await test('Workspace shutdown timeout retains windows, retries docking and awaits every acknowledgement', async () => {
    const h = harness();
    try {
      const first = h.open(), second = h.open();
      const failed = h.owner.redockAll(15); assert.throws(() => h.owner.prepare(), /closing/);
      await assert.rejects(failed, /not finished docking/);
      assert.equal(h.owner.windows.size, 2); assert.equal(first.child.destroyed, false);
      const cleanup = h.owner.redockAll(1000); let done = false; cleanup.then(() => { done = true; });
      assert.equal(h.events.filter(([name]) => name === 'app:popoutDock').length, 4);
      h.owner.close(first.id); await tick(); assert.equal(done, false); assert.equal(h.primary.throttling, false);
      h.owner.close(second.id); await cleanup; assert.equal(h.owner.hasOwnership, false); assert.equal(h.primary.throttling, true);
      const last = h.open(); h.primary.destroy(); assert.equal(last.child.destroyed, true); assert.equal(h.owner.disposed, true);
    } finally { h.owner.dispose(); }
  });

  await test('Workspace main IPC rejects foreign windows and subframes for invokes, prompt responses and terminal sends', async () => {
    const f = mainLifecycleFixture(), primary = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    assert.equal(isPrimaryFrame(primary, f.window), true);
    for (const invalid of [{}, { sender: {}, senderFrame: primary.senderFrame }, { sender: primary.sender, senderFrame: {} }]) {
      assert.equal(isPrimaryFrame(invalid, f.window), false);
      for (const channel of ['app:popoutPrepare', 'app:popoutClose', 'conn:open', 'settings:get', 'ui:promptResponse']) assert.throws(() => f.invokeFrom(invalid, channel, 'fixture'), /primary KonX window/);
      for (const channel of ['conn:write', 'conn:resize', 'np:backup']) assert.doesNotThrow(() => f.sendFrom(invalid, channel, 'fixture', 'payload'));
    }
    assert.deepEqual(f.calls, []);
    f.sendFrom(primary, 'conn:write', 'fixture', 'owned input'); assert.deepEqual(f.calls, ['write-connection']);
    const popup = nativePopup(f);
    assert.throws(() => f.invokeFrom({ sender: popup.child.webContents, senderFrame: popup.child.webContents.mainFrame }, 'app:popoutClose', popup.id), /primary KonX window/);
    f.invoke('app:popoutClose', popup.id);
  });

  await test('Workspace main quit confirmation precedes docking and Cancel retains live views and connections', async () => {
    const f = mainLifecycleFixture(), popup = nativePopup(f); f.connections.conns.set('live', {}); f.setPromptChoice(1);
    assert.equal(f.nativeClose().defaultPrevented, true); await tick();
    assert.equal(f.window.destroyed, false); assert.equal(popup.child.destroyed, false); assert.equal(f.connections.conns.size, 1);
    assert.deepEqual(f.calls, ['connection-prompt']); assert.equal(f.sent.some(([channel]) => channel === 'app:popoutDock'), false);
    f.setPromptChoice(0); f.app.quit(); await tick();
    assert.equal(f.app.exited, false); assert.equal(f.sent.filter(([channel]) => channel === 'app:popoutDock').length, 1);
    await assert.rejects(async () => f.invoke('app:popoutPrepare'), /closing/);
    f.invoke('app:popoutClose', popup.id); await tick();
    assert.equal(f.app.exited, true); assert.equal(f.calls.filter(call => call === 'connection-prompt').length, 2, 'one cancelled attempt and one approved attempt');
  });

  await test('Workspace main native-close timeout preserves the primary window and permits cleanup retry', async () => {
    const f = mainLifecycleFixture(), popup = nativePopup(f), redock = f.popouts.redockAll.bind(f.popouts);
    f.popouts.redockAll = () => redock(15);
    f.nativeClose(); await pause(35); await tick();
    assert.equal(f.app.exited, false); assert.equal(f.window.destroyed, false); assert.equal(popup.child.destroyed, false);
    assert.equal(f.calls.includes('shutdown-error'), true);
    f.app.quit(); await tick(); f.invoke('app:popoutClose', popup.id); await tick();
    assert.equal(f.app.exited, true);
  });

  await test('Workspace committed updater permits redock acknowledgement while new operations are frozen', async () => {
    const f = mainLifecycleFixture(), popup = nativePopup(f);
    await f.invoke('app:updateInstall'); await tick();
    assert.equal(f.controller.committed, true); assert.equal(f.app.exited, false); assert.equal(f.window.destroyed, false);
    assert.equal(f.sent.some(([channel]) => channel === 'app:popoutDock'), true);
    assert.equal(f.invoke('app:popoutClose', popup.id), true); await tick();
    assert.equal(f.app.exited, true); assert.equal(f.calls.includes('cancel-helper'), false);
  });
}
module.exports = { runWorkspaceWindowTests };
if (require.main === module) (async () => {
  let passed = 0, failed = 0;
  await runWorkspaceWindowTests(async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name, error); } });
  console.log(`${passed}/${passed + failed} workspace native window tests passed`); process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
