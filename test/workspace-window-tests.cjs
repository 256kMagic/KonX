'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WorkspaceWindows, isPrimaryFrame } = require('../src/main/workspace-windows');
const { mainLifecycleFixture, tick } = require('./update-lifecycle-tests.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

class Window extends EventEmitter {
  constructor() {
    super(); this.destroyed = false; this.visible = true;
    this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
    this.webContents.setWindowOpenHandler = handler => { this.openWindow = handler; };
    this.webContents.getBackgroundThrottling = () => this.throttling;
    this.webContents.setBackgroundThrottling = value => { this.throttling = value; };
    this.throttling = true;
    this.bounds = { x: 100, y: 100, width: 1000, height: 700 }; this.boundsWrites = [];
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  show() { this.visible = true; this.emit('show'); }
  hide() { this.visible = false; this.emit('hide'); }
  minimize() { this.minimized = true; this.emit('minimize'); }
  restore() { this.minimized = false; this.emit('restore'); }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds) { this.bounds = { ...bounds }; this.boundsWrites.push({ ...bounds }); }
  isMinimized() { return !!this.minimized; }
  isMaximized() { return !!this.maximized; }
  isFullScreen() { return !!this.fullScreen; }
  close() { const e = event(); this.emit('close', e); if (!e.defaultPrevented) this.destroy(); return e; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  static getFocusedWindow() { return Window.focused || null; }
}
function harness(screen) {
  const primary = new Window(), events = [], external = []; let now = 100;
  const owner = new WorkspaceWindows({ primary, BrowserWindow: Window, emit: (...args) => events.push(args), openExternal: url => external.push(url), now: () => now, screen });
  const open = bounds => {
    const permit = owner.prepare(), details = { url: 'about:blank', frameName: permit.frameName };
    assert.equal(primary.openWindow(details).action, 'allow');
    const child = new Window(); if (bounds) child.bounds = bounds;
    primary.webContents.emit('did-create-window', child, details);
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
const ownershipEvents = events => events.filter(([channel]) => channel !== 'app:windowVisibility');

async function runWorkspaceWindowTests(test) {
  await test('Workspace native visibility snapshots remain independent of live renderer throttling and release their listeners', () => {
    const h = harness();
    try {
      assert.deepEqual(h.owner.visibilityState(), { revision: 0, primary: true, popouts: [] });
      const popup = h.open();
      let revision = 0;
      const check = (primary, child) => {
        const snapshot = h.owner.visibilityState();
        assert.ok(snapshot.revision > revision, 'native visibility revisions increase');
        revision = snapshot.revision;
        assert.deepEqual(snapshot, { revision, primary, popouts: [{ id: popup.id, visible: child }] });
        assert.deepEqual(h.events.at(-1), ['app:windowVisibility', snapshot], 'event and read-only snapshot agree');
        assert.equal(h.primary.throttling, false, 'primary remains available for child input');
        assert.equal(popup.child.throttling, false, 'child retains production live-renderer preference');
      };
      check(true, true);
      h.primary.minimize(); check(false, true);
      popup.child.minimize(); check(false, false);
      popup.child.restore(); check(false, true);
      popup.child.hide(); check(false, false);
      popup.child.show(); check(false, true);
      h.primary.restore(); check(true, true);
      h.primary.hide(); check(false, true);
      h.primary.show(); check(true, true);
      const restoreListeners = popup.child.listenerCount('restore');
      h.owner.close(popup.id);
      assert.deepEqual(h.owner.visibilityState(), { revision: revision + 1, primary: true, popouts: [] });
      assert.equal(h.primary.throttling, true, 'last child restores original throttling');
      for (const name of ['show', 'hide', 'minimize']) assert.equal(popup.child.listenerCount(name), 0, name + ' child listener removed');
      assert.equal(popup.child.listenerCount('restore'), restoreListeners - 1, 'native visibility restore callback removed');
      const retained = h.open();
      const beforeDispose = h.events.length;
      h.owner.dispose(); h.owner.dispose();
      assert.equal(retained.child.destroyed, true);
      for (const name of ['show', 'hide', 'minimize', 'restore']) assert.equal(h.primary.listenerCount(name), 0, name + ' primary listener removed');
      for (const name of ['show', 'hide', 'minimize']) assert.equal(retained.child.listenerCount(name), 0, name + ' remaining child listener removed');
      h.primary.emit('show'); retained.child.emit('hide');
      assert.equal(h.events.length, beforeDispose, 'disposed native visibility cannot emit late snapshots');
    } finally { h.owner.dispose(); }
  });

  await test('Workspace native bounds recover from removed displays and smaller work areas using DIP coordinates', () => {
    const screen = new EventEmitter();
    let area = { x: -1280, y: -200, width: 1280, height: 984 };
    screen.getDisplayMatching = () => ({ workArea: area, scaleFactor: 1.5 });
    const h = harness(screen);
    try {
      const popup = h.open({ x: -1200, y: -100, width: 900, height: 600 });
      assert.deepEqual(popup.child.boundsWrites, [], 'already visible negative-coordinate monitor placement stays unchanged');
      area = { x: 0, y: 0, width: 1000, height: 720 };
      screen.emit('display-removed', {}, {});
      assert.deepEqual(popup.child.getBounds(), { x: 0, y: 0, width: 900, height: 600 });
      popup.child.bounds = { x: 900, y: 600, width: 1200, height: 900 };
      area = { x: 10, y: 30, width: 800, height: 620 };
      screen.emit('display-metrics-changed', {}, {}, ['scaleFactor', 'workArea']);
      assert.deepEqual(popup.child.getBounds(), { x: 10, y: 30, width: 800, height: 620 });
      const writes = popup.child.boundsWrites.length;
      screen.emit('display-metrics-changed', {}, {}, ['rotation']);
      screen.emit('display-metrics-changed', {}, {}, ['workArea']);
      assert.equal(popup.child.boundsWrites.length, writes, 'unaffected and already-clamped events do not churn bounds');
      assert.equal(h.owner.windows.get(popup.id).child, popup.child);
      assert.deepEqual(ownershipEvents(h.events), [], 'bounds recovery does not dock or replace the live window');
    } finally { h.owner.dispose(); }
    assert.equal(screen.listenerCount('display-removed'), 0);
    assert.equal(screen.listenerCount('display-metrics-changed'), 0);
  });

  await test('Workspace display recovery waits for restore and ignores malformed work areas', () => {
    const screen = new EventEmitter(); let area = { x: 0, y: 0, width: 900, height: 650 };
    screen.getDisplayMatching = () => ({ workArea: area });
    const h = harness(screen);
    try {
      const popup = h.open({ x: 4000, y: 3000, width: 800, height: 600 });
      assert.deepEqual(popup.child.getBounds(), { x: 100, y: 50, width: 800, height: 600 }, 'new offscreen windows recover before use');
      for (const [state, event] of [['minimized', 'restore'], ['maximized', 'unmaximize'], ['fullScreen', 'leave-full-screen']]) {
        popup.child[state] = true; popup.child.bounds = { x: 4000, y: 3000, width: 800, height: 600 };
        screen.emit('display-removed', {}, {});
        assert.equal(popup.child.getBounds().x, 4000, state + ' preserves native state');
        popup.child[state] = false; popup.child.emit(event);
        assert.deepEqual(popup.child.getBounds(), { x: 100, y: 50, width: 800, height: 600 });
      }
      area = { x: 0, y: NaN, width: 900, height: 650 };
      const writes = popup.child.boundsWrites.length;
      screen.emit('display-metrics-changed', {}, {}, ['bounds']);
      assert.equal(popup.child.boundsWrites.length, writes);
    } finally { h.owner.dispose(); }
  });

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
      assert.deepEqual(ownershipEvents(h.events), [['app:popoutDock', { id: popup.id }]]);
      assert.equal(h.owner.close(popup.id), true); assert.equal(h.owner.close(popup.id), false);
      assert.equal(popup.child.destroyed, true); assert.equal(h.owner.hasOwnership, false); assert.equal(h.primary.throttling, true);
      assert.equal(ownershipEvents(h.events).length, 1, 'normal acknowledgement does not report unexpected closure');
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
      assert.deepEqual(ownershipEvents(h.events), [['app:popoutClosed', { id: popup.id }]]);
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
      for (const channel of ['app:popoutPrepare', 'app:popoutClose', 'app:windowVisibility', 'conn:open', 'settings:get', 'ui:promptResponse']) assert.throws(() => f.invokeFrom(invalid, channel, 'fixture'), /primary KonX window/);
      for (const channel of ['conn:write', 'conn:resize', 'np:backup']) assert.doesNotThrow(() => f.sendFrom(invalid, channel, 'fixture', 'payload'));
    }
    assert.deepEqual(f.calls, []);
    f.sendFrom(primary, 'conn:write', 'fixture', 'owned input'); assert.deepEqual(f.calls, ['write-connection']);
    const popup = nativePopup(f);
    assert.deepEqual(f.invoke('app:windowVisibility').popouts, [{ id: popup.id, visible: true }], 'primary reads native visibility through the real IPC registration');
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
