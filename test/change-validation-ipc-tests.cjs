'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const { inStore, plan, repo } = require('./change-validation-tests.cjs');
const source = path.join(repo, 'src/main/change-validation-ipc.js');
const { registerChangeValidation } = require('../src/main/change-validation-ipc');
function fixture(store, chooser = async () => ({ canceled: true })) {
  const handlers = new Map(), state = { closing: false, dialogs: 0 }, owner = {};
  registerChangeValidation((name, fn) => handlers.set(name, fn), { changes: store, isClosing: () => state.closing, dialogOwner: () => owner,
    dialog: { async showSaveDialog(parent, options) { assert.equal(parent, owner); state.dialogs++; return chooser(options, state); } } });
  return { handlers, state, invoke: (channel, ...args) => handlers.get(channel)(...args) };
}
async function runChangeValidationIpcTests(test) {
  await test('change production IPC guards every entry during shutdown and validates native export before opening a dialog', () => inStore(async ({ store }) => {
    const { invoke, state, handlers } = fixture(store); assert.equal(handlers.size, 13);
    state.closing = true; for (const handler of handlers.values()) await assert.rejects(handler(), /closing|update/);
    state.closing = false; const record = await invoke('tools:changeCreate', plan());
    await assert.rejects(invoke('tools:changeExport', record.id, record.revision, 'script'), /JSON or HTML/);
    await assert.rejects(invoke('tools:changeExport', record.id, undefined, 'json'), /revision/);
    await assert.rejects(invoke('tools:changeExport', '../foreign', 1, 'json'), /identifier/); assert.equal(state.dialogs, 0);
    const preview = await invoke('tools:changePreview', record.id, record.revision); assert.deepEqual(JSON.parse(preview.text).workflow, record); assert.equal(preview.revision, record.revision);
    assert.equal(await invoke('tools:changeExport', record.id, record.revision, 'json'), null); assert.equal(state.dialogs, 1);
  }));
  await test('change production IPC rechecks shutdown after native export choice and retains the original record', () => inStore(async ({ store, root }) => {
    const file = path.join(root, 'should-not-exist.json'), record = await store.create(plan());
    const { invoke } = fixture(store, async (options, state) => { assert.deepEqual(options.filters[0].extensions, ['json']); state.closing = true; return { canceled: false, filePath: file }; });
    await assert.rejects(invoke('tools:changeExport', record.id, record.revision, 'json'), /closing/);
    await assert.rejects(fs.access(file), { code: 'ENOENT' }); assert.deepEqual(await store.get(record.id), record);
  }));
  await test('change production IPC binds export to the reviewed revision even if another editor saves during the dialog', () => inStore(async ({ store, root }) => {
    const record = await store.create(plan()), file = path.join(root, 'report.json'); let changed;
    const { invoke } = fixture(store, async () => { changed = await store.savePlan(record.id, record.revision, { ...plan(), scope: 'Changed after preview' }); return { canceled: false, filePath: file }; });
    await invoke('tools:changePreview', record.id, record.revision);
    await assert.rejects(invoke('tools:changeExport', record.id, record.revision, 'json'), /changed|current report/); await assert.rejects(fs.access(file), { code: 'ENOENT' });
    await assert.rejects(invoke('tools:changePreview', record.id, record.revision), /changed/);
    const fresh = fixture(store, async () => ({ canceled: false, filePath: file }));
    const preview = await fresh.invoke('tools:changePreview', changed.id, changed.revision); await fresh.invoke('tools:changeExport', changed.id, changed.revision, 'json');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).workflow, JSON.parse(preview.text).workflow);
  }));
  await test('change production IPC copies the reviewed report into a real incident and removes only the workflow definition', () => inStore(async ({ store, incidents, root }) => {
    const { invoke } = fixture(store), record = await invoke('tools:changeCreate', plan()), incident = await incidents.create({ title: 'Owned IPC incident' });
    await assert.rejects(invoke('tools:changeAddToIncident', record.id, record.revision + 1, incident.id), /Reopen/);
    const result = await invoke('tools:changeAddToIncident', record.id, record.revision, incident.id); assert.equal(result.copied, true);
    const retained = await incidents.get(incident.id); assert.equal(retained.evidence.length, 1); assert.deepEqual(JSON.parse(await incidents.verifiedText(incident.id, retained.evidence[0])).workflow, record);
    await invoke('tools:changeRemove', record.id, record.revision); assert.equal((await invoke('tools:changeList')).records.length, 0); assert.equal((await incidents.get(incident.id)).evidence.length, 1);
    assert.equal((await fs.readdir(path.join(root, 'change-validation'))).length, 0);
  }));
}
module.exports = { runChangeValidationIpcTests };
if (require.main === module) runChangeValidationIpcTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
