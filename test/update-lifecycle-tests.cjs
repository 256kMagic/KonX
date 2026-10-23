'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function cancellableEvent() {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

// The real main module initializes its real controller and registers its real
// IPC/window/application lifecycle handlers. Only Electron and external-resource
// owners are replaced. No app, network request, filesystem write or installer runs.
function fixture() {
  const filename = path.join(__dirname, '../src/main/main.js');
  const load = createRequire(filename), handlers = new Map(), sendHandlers = new Map(), calls = [], sent = [];
  const behavior = { cancel: async () => {}, getReady: async () => ({ version: '0.7.0', mode: 'installed' }) };
  let ready, window, manager, promptChoice = 0;
  const app = new EventEmitter();
  app.isPackaged = true; app.exited = false; app.quitRequests = 0;
  app.whenReady = () => ({ then(fn) { ready = fn; } });
  app.getPath = (name) => path.join(os.tmpdir(), 'konx-update-lifecycle-no-files', name);
  app.getAppPath = () => path.dirname(path.dirname(__dirname));
  app.setPath = () => {};
  app.quit = () => {
    app.quitRequests++;
    const event = cancellableEvent(); app.emit('before-quit', event);
    if (event.defaultPrevented) return;
    if (window && !window.destroyed) {
      const close = cancellableEvent(); window.emit('close', close);
      if (close.defaultPrevented) return;
      window.destroyed = true; window.emit('closed');
    }
    // Electron's app.quit() does not emit window-all-closed; it proceeds to
    // will-quit after closing its windows. Native close is modeled separately.
    app.exited = true; app.emit('will-quit', cancellableEvent());
  };
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); window = this; this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {};
      this.webContents.send = (...args) => sent.push(args);
      this.webContents.setWindowOpenHandler = handler => { this.openWindow = handler; };
      this.webContents.getBackgroundThrottling = () => true;
      this.webContents.setBackgroundThrottling = value => { this.throttling = value; };
    }
    isDestroyed() { return this.destroyed; }
    loadFile() {}
    show() {}
    static getFocusedWindow() { return null; }
  }
  const connections = {
    conns: new Map(), hasSerialOwnership: false,
    open() { calls.push('open-connection'); return { ok: true }; },
    write() { calls.push('write-connection'); }, resize() { calls.push('resize-connection'); },
    closeAll() { calls.push('close-connections'); this.conns.clear(); },
    async waitForSerialCleanup() { calls.push('close-serial'); this.hasSerialOwnership = false; this.conns.clear(); },
  };
  const sftp = { sessions: new Map(), pending: new Map(), queue: { active: new Map(), jobs: [] }, closeAll() { calls.push('close-sftp'); } };
  const capture = { sessions: new Map(), startRequests: new Map(), builtin: { sessions: new Map(), startRequests: new Map() }, stopAll() { calls.push('stop-capture'); } };
  const knowledge = { busy: false, close() { calls.push('close-knowledge'); return Promise.resolve(); } };
  const remote = {
    hasOpenHandles: false, hasPendingCleanup: false, hasResultPendingCleanup: false, capacityChecks: [],
    run: async () => undefined,
    remember: async report => { remote.hasOpenHandles = true; const { file, ...publicReport } = report; return { ...publicReport, captureId: 'fixture-capture-id', fileName: 'fixture.pcap' }; },
    read: async id => ({ name: id + '.pcap', bytes: Buffer.from('fixture') }),
    remove: async id => ({ removed: true, captureId: id }),
    close: async () => { remote.hasOpenHandles = false; },
    closePending: async () => { remote.hasPendingCleanup = false; },
  };
  const runbook = {
    hasOwnership: false, hasPendingCleanup: false,
    run: async () => undefined, templates: () => [], list: async () => ({ runbooks: [], issues: [] }),
    get: async id => ({ id, definition: { name: 'Fixture procedure' } }), save: async params => params, remove: async id => ({ removed: true, id }),
    importFile: async file => ({ name: 'Imported fixture', file }), exportFile: async (_id, file) => file,
    close: async () => { runbook.hasOwnership = false; runbook.hasPendingCleanup = false; },
  };
  const dialogs = { open: async () => ({ canceled: true, filePaths: [] }), save: async () => ({ canceled: true }) };
  const sites = { hasOwnership: false, close: async () => { sites.hasOwnership = false; } };
  const handoff = {
    async commit() { calls.push('commit-helper'); },
    async cancel() { calls.push('cancel-helper'); },
  };
  const modules = {
    './store': { Store: class { getSettings() { return {}; } } },
    './connections': { ConnectionManager: class { constructor() { return connections; } } },
    './workspace-windows': load('./workspace-windows'),
    './sftp': { SftpManager: class { constructor() { return sftp; } } },
    './capture': { CaptureManager: class { constructor() { return capture; } } },
    './knowledge': { KnowledgeLibrary: class { constructor() { return knowledge; } } },
    './device-snapshots': { SnapshotStore: class {} },
    './incidents': { IncidentStore: class {} },
    './site-workspaces': { SiteWorkspaceStore: class { constructor() { return sites; } } },
    './site-workspace-ipc': load('./site-workspace-ipc'),
    './remote-capture': { run: (...args) => remote.run(...args), closePending: () => remote.closePending(), get hasPendingCleanup() { return remote.hasPendingCleanup; } },
    './remote-results': { RemoteCaptureResults: class {
      get hasOpenHandles() { return remote.hasOpenHandles; }
      get hasPendingCleanup() { return remote.hasResultPendingCleanup; }
      assertCapacity(pending) { remote.capacityChecks.push(pending); if (remote.capacityError) throw remote.capacityError; }
      remember(report) { return remote.remember(report); }
      read(id) { return remote.read(id); }
      remove(id) { return remote.remove(id); }
      close() { return remote.close(); }
    } },
    './runbooks': { run: (...args) => runbook.run(...args), getTemplates: () => runbook.templates() },
    './runbook-store': { RunbookStore: class {
      get hasOwnership() { return runbook.hasOwnership || runbook.hasPendingCleanup; }
      get hasPendingCleanup() { return runbook.hasPendingCleanup; }
      list() { return runbook.list(); }
      get(id) { return runbook.get(id); }
      save(params) { return runbook.save(params); }
      remove(id) { return runbook.remove(id); }
      importFile(file) { return runbook.importFile(file); }
      exportFile(id, file) { return runbook.exportFile(id, file); }
      close() { return runbook.close(); }
    } },
    './mist': { MistClient: class {} }, './ai': { AIClient: class {} },
    './notepad': { NotepadStore: class {}, FileWatcher: class {} },
    './updater': { UpdateManager: class {
      constructor(options) { manager = this; this.options = options; this.state = { supported: true, mode: options.mode, currentVersion: options.version, status: 'idle' }; }
      snapshot() { return { ...this.state }; }
      async start() { calls.push('start-download'); this.state.status = 'downloading'; return this.snapshot(); }
      cancel() { calls.push('cancel-download'); return behavior.cancel(); }
      getReady() { calls.push('verify-update'); return behavior.getReady(); }
    } },
    './update-controller': load('./update-controller'),
    './update-install': {
      getInstallTarget: () => ({ mode: 'installed', targetPath: path.join(os.tmpdir(), 'KonX-lifecycle-fixture.exe') }),
      async launchUpdate() { calls.push('launch-helper'); return handoff; },
    },
  };
  const context = vm.createContext({
    __dirname: path.dirname(filename), process: { env: {}, platform: process.platform, arch: process.arch, execPath: process.execPath, pid: process.pid },
    Buffer, URL, console, setTimeout, clearTimeout, setImmediate,
    require(name) {
      if (name === 'electron') return {
        app, BrowserWindow, Menu: { setApplicationMenu() {} }, safeStorage: {}, shell: {}, clipboard: {},
        dialog: { showMessageBoxSync(_window, options) { calls.push(options?.type === 'error' ? 'shutdown-error' : 'connection-prompt'); return promptChoice; },
          showOpenDialog: (...args) => dialogs.open(...args), showSaveDialog: (...args) => dialogs.save(...args) },
        ipcMain: { handle: (name, callback) => handlers.set(name, callback), on: (name, callback) => sendHandlers.set(name, callback) },
      };
      if (Object.hasOwn(modules, name)) return modules[name];
      if (name.startsWith('./')) return {};
      if (name === 'child_process') return { execFile() { throw new Error('No subprocess permitted'); }, spawn() { throw new Error('No subprocess permitted'); } };
      return load(name);
    },
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  ready();
  return {
    app, calls, sent, manager, behavior, handoff, connections, remote, runbook, sites, dialogs,
    get jobs() { return vm.runInContext('toolJobs', context); },
    get controller() { return vm.runInContext('updates', context); },
    get window() { return window; },
    get popouts() { return vm.runInContext('workspaceWindows', context); },
    setPromptChoice(value) { promptChoice = value; },
    invoke(name, ...args) { return handlers.get(name)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args); },
    invokeFrom(event, name, ...args) { return handlers.get(name)(event, ...args); },
    sendFrom(event, name, ...args) { return sendHandlers.get(name)(event, ...args); },
    nativeClose() {
      const event = cancellableEvent(); window.emit('close', event);
      if (!event.defaultPrevented) { window.destroyed = true; window.emit('closed'); app.emit('window-all-closed'); }
      return event;
    },
  };
}

async function runUpdateLifecycleTests(test) {
  await test('update lifecycle: normal app quit waits for download cleanup and never launches an installer', async () => {
    const f = fixture(), cleanup = deferred(); f.behavior.cancel = () => cleanup.promise;
    assert.deepEqual(f.calls, [], 'Startup must not check releases or install');
    f.app.quit();
    assert.equal(f.app.exited, false); assert.equal(f.window.destroyed, false);
    assert.deepEqual(f.calls, ['cancel-download']);
    f.app.quit();
    assert.deepEqual(f.calls, ['cancel-download'], 'Repeated quit must share cleanup');
    await tick(); assert.equal(f.app.exited, false);
    cleanup.resolve(); await tick();
    assert.equal(f.app.exited, true); assert.equal(f.window.destroyed, true);
    assert.deepEqual(f.calls, ['cancel-download']);
  });

  await test('update lifecycle: native window close waits for updater cleanup before the process exits', async () => {
    const f = fixture(), cleanup = deferred(); f.behavior.cancel = () => cleanup.promise;
    const event = f.nativeClose();
    assert.equal(event.defaultPrevented, false); assert.equal(f.window.destroyed, true); assert.equal(f.app.exited, false);
    assert.ok(f.calls.includes('cancel-download')); assert.ok(f.calls.includes('close-knowledge'));
    assert.ok(!f.calls.includes('launch-helper'));
    cleanup.resolve(); await tick();
    assert.equal(f.app.exited, true);
  });

  await test('update lifecycle: a cancelled connection close prompt does not exempt the next download from cleanup', async () => {
    const f = fixture(), first = deferred(), second = deferred();
    let cancellations = 0;
    f.behavior.cancel = () => (++cancellations === 1 ? first.promise : second.promise);
    f.connections.conns.set('connection', {}); f.setPromptChoice(1);
    f.app.quit(); first.resolve(); await tick();
    assert.equal(f.app.exited, false); assert.equal(f.window.destroyed, false);
    assert.equal(cancellations, 1); assert.ok(f.calls.includes('connection-prompt'));
    await f.invoke('app:updateStart');
    assert.ok(f.calls.includes('start-download'));
    f.app.quit();
    assert.equal(cancellations, 2); assert.equal(f.app.exited, false);
    f.setPromptChoice(0); second.resolve(); await tick();
    assert.equal(f.app.exited, true);
    assert.ok(!f.calls.includes('launch-helper'));
  });

  await test('update lifecycle: quitting prevents a fresh download from starting during asynchronous cleanup', async () => {
    const f = fixture(), cleanup = deferred(); f.behavior.cancel = () => cleanup.promise;
    f.app.quit();
    await assert.rejects(async () => f.invoke('app:updateStart'), /quit|clos|exit|shut/i);
    assert.ok(!f.calls.includes('start-download'));
    cleanup.resolve(); await tick();
    assert.equal(f.app.exited, true);
  });

  await test('update lifecycle: native close and quit cannot interrupt uncommitted installation preparation', async () => {
    const f = fixture(), verification = deferred(); f.behavior.getReady = () => verification.promise;
    const installing = f.invoke('app:updateInstall');
    assert.equal(f.controller.installing, true); assert.equal(f.controller.committed, false);
    assert.equal(f.nativeClose().defaultPrevented, true);
    f.app.quit(); await tick();
    assert.equal(f.app.exited, false); assert.equal(f.window.destroyed, false);
    assert.ok(!f.calls.includes('cancel-download') && !f.calls.includes('launch-helper'));
    verification.reject(new Error('Synthetic verification failure'));
    await assert.rejects(installing, /Synthetic verification failure/);
    assert.equal(f.controller.installing, false);
    f.app.quit(); await tick();
    assert.equal(f.app.exited, true); assert.ok(f.calls.includes('cancel-download'));
  });

  await test('update lifecycle: a committed handoff cleans the download then quits with the helper-owned payload intact', async () => {
    const f = fixture();
    await f.invoke('app:updateInstall');
    assert.equal(f.controller.committed, true);
    await tick();
    assert.equal(f.app.exited, true); assert.equal(f.window.destroyed, true);
    assert.deepEqual(f.calls, ['verify-update', 'launch-helper', 'cancel-download', 'commit-helper']);
  });

  await test('update lifecycle: failed download cleanup does not turn ordinary quit into an installation', async () => {
    const f = fixture(); f.behavior.cancel = () => Promise.reject(new Error('Synthetic locked temporary file'));
    f.app.quit(); await tick();
    assert.equal(f.app.exited, true);
    assert.deepEqual(f.calls, ['cancel-download']);
  });

  await test('site lifecycle: pending workspace ownership blocks installation before helper launch', async () => {
    const f = fixture(); f.sites.hasOwnership = true;
    await assert.rejects(f.invoke('app:updateInstall'), /workspace/i);
    assert.ok(!f.calls.includes('launch-helper'));
  });
  await test('site lifecycle: quit awaits workspace publication and rejects new workspace IPC', async () => {
    const f = fixture(), pending = deferred(); f.sites.hasOwnership = true;
    f.sites.close = async () => { await pending.promise; f.sites.hasOwnership = false; };
    f.app.quit(); await tick(); assert.equal(f.app.exited, false);
    await assert.rejects(async () => f.invoke('tools:siteSave', { name: 'Late save' }), /closing/i);
    pending.resolve(); await tick(); assert.equal(f.app.exited, true);
  });
  await test('site lifecycle: failed workspace cleanup keeps app open and a later quit retries', async () => {
    const f = fixture(); f.sites.hasOwnership = true;
    f.sites.close = async () => { throw new Error('Synthetic workspace close failure'); };
    f.app.quit(); await tick(); assert.equal(f.app.exited, false); assert.ok(f.calls.includes('shutdown-error'));
    f.sites.close = async () => { f.sites.hasOwnership = false; };
    f.app.quit(); await tick(); assert.equal(f.app.exited, true);
  });
}

module.exports = { runUpdateLifecycleTests, mainLifecycleFixture: fixture, deferred, tick };
if (require.main === module) {
  let passed = 0;
  runUpdateLifecycleTests(async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); })
    .then(() => console.log(`${passed} update lifecycle tests passed`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
