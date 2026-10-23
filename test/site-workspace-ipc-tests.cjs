'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { SiteWorkspaceStore } = require('../src/main/site-workspaces');
const { registerSiteWorkspaces } = require('../src/main/site-workspace-ipc');

async function fixture(run) {
  const base = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(base, 'konx-site-ipc-'));
  const sites = new SiteWorkspaceStore(path.join(root, 'profile')), handlers = new Map();
  const state = { closing: false, chosen: null, destination: null, dialogs: 0 };
  const dialog = {
    async showOpenDialog() { state.dialogs++; return state.chosen ? { canceled: false, filePaths: [state.chosen] } : { canceled: true, filePaths: [] }; },
    async showSaveDialog() { state.dialogs++; return state.destination ? { canceled: false, filePath: state.destination } : { canceled: true }; },
  };
  registerSiteWorkspaces((channel, handler) => handlers.set(channel, handler), { sites, dialog, dialogOwner: () => undefined, isClosing: () => state.closing });
  const invoke = (channel, ...args) => Promise.resolve().then(() => handlers.get('tools:site' + channel)(...args));
  try { await run({ root, sites, state, dialog, invoke }); }
  finally {
    await sites.close();
    assert.equal(path.dirname(await fs.realpath(root)), base);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function runSiteWorkspaceIpcTests(test) {
  await test('Site IPC opens only an explicitly requested capture reference in the saved workspace', () => fixture(async ({ root, state, invoke }) => {
    state.chosen = path.join(root, 'selected.pcapng');
    const reference = await invoke('PickCapture');
    assert.equal(reference.path, state.chosen); // Picker did not try to read the nonexistent file.
    const saved = await invoke('Save', { name: 'Capture site', captures: [reference] });
    await assert.rejects(invoke('ReadCapture', saved.id, reference.id), /ENOENT/);
    const bytes = await fs.readFile(path.join(__dirname, '../assets/samples/branch-office.pcapng'));
    await fs.writeFile(state.chosen, bytes);
    const loaded = await invoke('ReadCapture', saved.id, reference.id);
    assert.deepEqual(loaded.bytes, bytes); assert.equal(loaded.name, 'selected.pcapng');
    await assert.rejects(invoke('ReadCapture', saved.id, 'unknown'), /no longer/);
    await invoke('Remove', saved.id);
    assert.deepEqual(await fs.readFile(state.chosen), bytes);
    await assert.rejects(invoke('ReadCapture', saved.id, reference.id), /not found/);
  }));
  await test('Site IPC native export/import round trip creates a separate identity and cancelled dialogs keep records', () => fixture(async ({ root, state, invoke }) => {
    const original = await invoke('Save', { name: 'Original site', notes: 'Reviewed literal notes', sessions: [{ id: 'session-ref', name: 'Router', group: 'Core' }] });
    assert.equal(await invoke('Export', original.id), null);
    state.destination = path.join(root, 'site.json');
    const exported = await invoke('Export', original.id);
    assert.equal(exported.path, state.destination);
    const document = JSON.parse(await fs.readFile(state.destination, 'utf8'));
    assert.equal(document.workspace.notes, 'Reviewed literal notes');
    assert.deepEqual(Object.keys(document.workspace.sessions[0]).sort(), ['group', 'id', 'name']);
    assert.equal(await invoke('Import'), null);
    state.chosen = state.destination;
    const imported = await invoke('Import');
    assert.notEqual(imported.id, original.id); assert.deepEqual(imported.sessions, original.sessions);
    assert.equal((await invoke('List')).workspaces.length, 2);
    document.workspace.sessions[0].password = 'DO_NOT_IMPORT';
    await fs.writeFile(state.destination, JSON.stringify(document));
    await assert.rejects(invoke('Import'), /unsupported field/);
    assert.equal((await invoke('List')).workspaces.length, 2);
  }));
  await test('Site IPC rejects shutdown work and rechecks after native dialogs before touching files', () => fixture(async ({ root, state, dialog, invoke }) => {
    const record = await invoke('Save', { name: 'Shutdown site' });
    await assert.rejects(invoke('Export', 'invalid'), /identifier/); assert.equal(state.dialogs, 0);
    const destination = path.join(root, 'late-export.json');
    dialog.showSaveDialog = async () => { state.closing = true; return { canceled: false, filePath: destination }; };
    await assert.rejects(invoke('Export', record.id), /closing/);
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    await assert.rejects(invoke('Save', { name: 'Late site' }), /closing/);
    state.closing = false; assert.equal((await invoke('List')).workspaces.length, 1);
  }));
}
module.exports = { runSiteWorkspaceIpcTests };
if (require.main === module) {
  let failed = 0;
  runSiteWorkspaceIpcTests(async (name, run) => { try { await run(); console.log('PASS ' + name); } catch (error) { failed++; console.error(error); } })
    .then(() => { process.exitCode = failed ? 1 : 0; }).catch(error => { console.error(error); process.exitCode = 1; });
}
