'use strict';

// Load the complete production tab classes. Controlled schedulers and editor
// adapters exercise late callbacks that the real Electron layout test cannot
// deterministically interleave; no App methods are copied into this harness.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let evidenceContext, workspaceEvidence, connectionSessions;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const frames = [], timers = [], calls = [], listeners = new Map();
  const api = {
    invoke(channel, ...args) { calls.push([channel, ...args]); return Promise.resolve({ ok: true }); },
    send(channel, ...args) { calls.push([channel, ...args]); },
    on(channel, fn) { listeners.set(channel, fn); return () => listeners.delete(channel); },
  };
  const globals = {
    requestedConnectionMetadata: (...args) => workspaceEvidence.requestedConnectionMetadata(...args),
    observeConnectionSession: (...args) => connectionSessions.observeConnectionSession(...args),
    api, requestAnimationFrame: (fn) => frames.push(fn),
    setTimeout: (fn) => { timers.push(fn); return fn; },
    clearTimeout: (fn) => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); },
    debounce: (fn) => () => timers.push(fn),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
    errMsg: (error) => error.message,
    mountThemeOutput() {},
  };
  function load(relative, name, extra = {}) {
    const filename = path.join(__dirname, '../src/renderer/js', relative);
    const source = fs.readFileSync(filename, 'utf8')
      .replace(/^import .*;\r?\n/gm, '').replace(`export class ${name}`, `class ${name}`);
    const module = { exports: {} };
    vm.runInNewContext(source + `\nmodule.exports = ${name};`, { module, ...globals, ...extra }, { filename });
    return module.exports;
  }
  function terminal(app = { active: null, tabStateChanged() {}, tabActivity() {} }) {
    const Tab = load('terminal.js', 'TerminalTab');
    const tab = Object.create(Tab.prototype);
    const counts = { focus: 0, fit: 0, write: 0, dispose: 0, unobserve: 0 };
    let disposed = false;
    const live = () => assert.equal(disposed, false, 'disposed terminal accessed');
    Object.assign(tab, {
      app, id: 'terminal', kind: 'terminal', spec: {}, state: 'idle', active: false,
      copilot: new evidenceContext.EvidenceContext('terminal', 'terminal', 'Terminal fixture'),
      disposed: false, visibilityGeneration: 0,
      term: {
        cols: 80, rows: 24,
        focus() { live(); counts.focus++; },
        write() { live(); counts.write++; },
        dispose() { live(); disposed = true; counts.dispose++; },
      },
      fit: { fit() { live(); counts.fit++; } }, wrap: { offsetParent: {} },
      ro: { disconnect() { counts.unobserve++; } },
      _hideOverlay() { live(); }, _showOverlay() { live(); },
      // This fixture bypasses DOM construction to control focus scheduling.
      // Logging controls have their own real Electron workflow coverage.
      _renderLogging() { live(); },
    });
    return { tab, counts };
  }
  function notepad(extra = {}) {
    const Tab = load('notepad/notepad.js', 'NotepadTab', extra);
    const tab = Object.create(Tab.prototype);
    const counts = { focus: 0, dispose: 0, modelDispose: 0, setModel: 0 };
    let disposed = false;
    const live = () => assert.equal(disposed, false, 'disposed editor accessed');
    const model = {
      getAlternativeVersionId() { live(); return 2; },
      getValueLength() { live(); return 5; }, getValue() { live(); return 'draft'; },
      getLanguageId() { live(); return 'plaintext'; },
      dispose() { counts.modelDispose++; },
    };
    const doc = { id: 'draft', title: 'draft', model, savedVersion: 1, untitled: true };
    Object.assign(tab, {
      app: { active: null, settings: {}, setTabTitle() {} }, opts: {}, id: 'notepad', kind: 'notepad',
      copilot: new evidenceContext.EvidenceContext('notepad', 'notepad', 'Editor fixture'),
      active: false, disposed: false, visibilityGeneration: 0,
      monaco: {}, current: doc, docs: [doc],
      editor: {
        focus() { live(); counts.focus++; },
        saveViewState() { live(); return null; },
        setModel() { live(); counts.setModel++; }, updateOptions() { live(); },
        dispose() { live(); disposed = true; counts.dispose++; },
      },
      renderTabs() {}, updateStatus() {},
    });
    return { tab, counts, doc, Tab };
  }
  return { api, calls, frames, timers, listeners, terminal, notepad,
    drainFrames() { for (const fn of frames.splice(0)) fn(); },
    drainTimers() { for (const fn of timers.splice(0)) fn(); },
  };
}

async function runLayoutFocusTests(test) {
  evidenceContext = await import('../src/renderer/js/copilot-context.mjs');
  connectionSessions = await import('../src/renderer/js/connection-session-model.mjs');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/copilot-workspace.mjs'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const module = { exports: {} };
  vm.runInNewContext(source + '\nmodule.exports = { requestedConnectionMetadata };', { module, ...evidenceContext });
  workspaceEvidence = module.exports;
  console.log('workspace layouts: tab focus and late callbacks');

  await test('visible terminal panes refit independently without selecting a command target', async () => {
    const h = harness();
    const a = h.terminal(), b = h.terminal(a.tab.app);
    a.tab.app.active = a.tab;
    a.tab.show({ focus: false }); b.tab.show({ focus: false });
    h.drainFrames();
    assert.equal(a.counts.fit, 1); assert.equal(b.counts.fit, 1);
    assert.equal(a.counts.focus + b.counts.focus, 0);
    b.tab.focus(); a.tab.focus();
    assert.equal(a.counts.focus, 1); assert.equal(b.counts.focus, 0);
    assert.deepEqual(h.calls, [], 'visibility never opens or closes a connection');
  });

  await test('terminal scheduled work belongs to its current visible lifetime', async () => {
    const h = harness(); const { tab, counts } = h.terminal(); tab.app.active = tab;
    tab.show(); tab.hide(); tab.show({ focus: false });
    h.drainFrames();
    assert.equal(counts.fit, 1); assert.equal(counts.focus, 0, 'stale show must not focus a later visible lifetime');
    tab.show(); tab.app.active = {}; h.drainFrames();
    assert.equal(counts.fit, 2); assert.equal(counts.focus, 0);
    tab.app.active = tab; tab.show(); tab.dispose(); tab.dispose();
    h.drainFrames(); tab.refit(); tab.focus(); tab.show(); h.drainFrames();
    assert.equal(counts.fit, 2); assert.equal(counts.focus, 0);
    assert.equal(counts.dispose, 1); assert.equal(counts.unobserve, 1);
    assert.deepEqual(h.calls, [['conn:close', 'terminal']]);
  });

  await test('connection status preserves current child focus and ignores disposed completions', async () => {
    const h = harness(); const { tab, counts } = h.terminal();
    tab.show({ focus: false }); h.drainFrames();
    tab.onStatus({ state: 'connected', info: { host: 'fixture', username: 'fixture-user' } });
    tab.app.active = tab;
    tab.onStatus({ state: 'connected' });
    assert.equal(tab.info.host, 'fixture'); assert.equal(counts.focus, 0);
    assert.equal(tab.sessionReference.info.username, 'fixture-user', 'real metadata owner observes the live connection');
    const open = deferred();
    h.api.invoke = (channel) => channel === 'conn:open' ? open.promise : Promise.resolve();
    const connecting = tab.connect();
    tab.dispose();
    open.resolve({ ok: false, error: 'late failure' });
    await connecting;
    tab.onStatus({ state: 'connected', info: { username: 'late-user' } });
    tab.onStatus({ state: 'disconnected', message: 'late close' });
    tab.onData('late packet');
    assert.equal(counts.focus, 0); assert.equal(counts.write, 0);
    assert.equal(tab.sessionReference.info.username, 'fixture-user', 'disposed status cannot rewrite the saved-session draft owner');
  });

  await test('explicit reconnect focuses only its live command target', async () => {
    const h = harness(); const { tab, counts } = h.terminal();
    tab.show({ focus: false }); h.drainFrames();
    tab.reconnect(); assert.equal(counts.focus, 0);
    tab.app.active = tab; tab.reconnect(); assert.equal(counts.focus, 1);
    await turn();
    tab.onStatus({ state: 'connected' }); assert.equal(counts.focus, 1);
  });

  await test('Notepad scheduled focus cannot outlive pane ownership or visibility', async () => {
    const h = harness(); const { tab, counts } = h.notepad(); tab.app.active = tab;
    tab.show({ focus: false }); assert.equal(h.timers.length, 0);
    tab.show(); tab.hide(); tab.show({ focus: false }); h.drainTimers();
    assert.equal(counts.focus, 0);
    tab.show(); tab.app.active = {}; h.drainTimers(); assert.equal(counts.focus, 0);
    tab.app.active = tab; tab.show(); h.drainTimers(); assert.equal(counts.focus, 1);
    tab.show(); tab.dispose(); tab.dispose(); h.drainTimers();
    tab.show(); tab.focus(); h.drainTimers();
    assert.equal(counts.focus, 1); assert.equal(counts.dispose, 1);
  });

  await test('Notepad document activation retains its model without focusing another pane', async () => {
    const h = harness(); const { tab, counts, doc } = h.notepad();
    tab.show({ focus: false }); tab.activate(doc);
    assert.equal(tab.current, doc); assert.equal(counts.setModel, 1); assert.equal(counts.focus, 0);
    tab.app.active = tab; tab.activate(doc); assert.equal(counts.focus, 1);
    tab.hide(); tab.activate(doc); assert.equal(counts.focus, 1);
    assert.ok(h.calls.some(([channel, id, text]) => channel === 'np:backup' && id === doc.id && text === 'draft'));
    assert.equal(counts.modelDispose, 0, 'visibility retains the draft model');
  });

  await test('closing before Monaco loads prevents late editor allocation', async () => {
    const h = harness(); const loading = deferred();
    const { tab, counts } = h.notepad({ loadMonaco: () => loading.promise });
    tab.editor = null; tab.monaco = null; tab.docs = []; tab.current = null; tab.restoring = true;
    const initializing = tab.init(); tab.dispose();
    loading.resolve({ editor: { create() { throw new Error('editor allocated after close'); } } });
    await initializing;
    assert.equal(counts.focus, 0); assert.equal(h.listeners.size, 0);
    assert.equal(h.calls.some(([channel]) => channel === 'np:session:set'), false);
  });

  await test('closing during restore keeps the prior session and releases editor listeners', async () => {
    for (const stage of ['np:session:get', 'np:backup:read', 'np:read']) {
      for (const rejectRead of stage === 'np:read' ? [false, true] : [false]) {
        const h = harness(); const pending = deferred();
        const { tab, counts } = h.notepad({ loadMonaco: async () => monaco });
        const editor = tab.editor;
        editor.onDidChangeCursorSelection = () => {};
        editor.onDidChangeModelContent = () => {};
        const monaco = { editor: { create: () => editor } };
        tab.host = { replaceChildren() {} }; tab.bindKeys = () => {}; tab.theme = () => 'fixture';
        tab.docs = []; tab.current = null; tab.restoring = true;
        tab.createDoc = () => { throw new Error('document created after close'); };
        h.api.invoke = (channel, ...args) => {
          h.calls.push([channel, ...args]);
          if (channel === stage) return pending.promise;
          if (channel === 'np:session:get') return Promise.resolve({ docs: [{ id: 'saved', dirty: true, path: 'C:/fixture.txt' }] });
          if (channel === 'np:backup:read') return Promise.resolve('saved draft');
          return Promise.resolve();
        };
        const initializing = tab.init(); await turn();
        assert.ok(h.calls.some(([channel]) => channel === stage));
        tab.saveSessionSoon(); tab.backupSoon();
        tab.dispose(); h.drainTimers();
        if (rejectRead) pending.reject(new Error('file unavailable'));
        else pending.resolve(stage === 'np:session:get' ? { docs: [] } : stage === 'np:read' ? { mtime: 1 } : 'draft');
        await initializing;
        assert.equal(h.listeners.size, 0, 'owned unload and IPC listeners removed');
        assert.equal(counts.focus, 0); assert.equal(counts.dispose, 1);
        assert.equal(h.calls.some(([channel]) => channel === 'np:session:set'), false, 'partial restore cannot replace stored session');
      }
    }
  });

  await test('Notepad final flush retains drafts and late persistence callbacks ignore closed models', async () => {
    const h = harness(); const { tab, counts, doc } = h.notepad();
    tab.dispose();
    const writes = h.calls.length;
    tab.saveSession(); tab.backupDirty(); tab.flush();
    assert.equal(h.calls.length, writes);
    assert.equal(counts.modelDispose, 1);
    assert.ok(h.calls.some(([channel, id, text]) => channel === 'np:backup' && id === doc.id && text === 'draft'));
    const saved = h.calls.find(([channel]) => channel === 'np:session:set');
    assert.equal(saved[1].active, doc.id); assert.equal(saved[1].docs[0].dirty, true);
  });
}

module.exports = { runLayoutFocusTests };

if (require.main === module) {
  let passed = 0, failed = 0;
  runLayoutFocusTests(async (name, fn) => {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (error) { failed++; console.error(`  FAIL ${name}\n${error.stack}`); }
  }).then(() => { console.log(`${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0; })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
