'use strict';

// Exercise the actual renderer methods with a Monaco-shaped model and deferred
// IPC. No Electron window, user document, or SSH connection is required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const sourcePath = path.join(__dirname, '../src/renderer/js/notepad/notepad.js');
const source = fs.readFileSync(sourcePath, 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export class NotepadTab', 'class NotepadTab');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness(T, { remote = false, untitled = false, text = 'first edit', encoding = 'utf-8', confirm = true, modal = null } = {}) {
  const writes = [];
  const backupCommands = [];
  const backups = new Map();
  const prompts = [];
  const errors = [];
  let currentText = text;
  let version = 1;
  let disposed = false;
  const model = {
    getAlternativeVersionId() { assert.equal(disposed, false, 'disposed model accessed'); return version; },
    getValue() { assert.equal(disposed, false, 'disposed model accessed'); return currentText; },
    getValueLength() { return this.getValue().length; },
    getLanguageId() { return 'plaintext'; },
    updateOptions() {},
    isDisposed() { return disposed; },
    dispose() { disposed = true; },
  };
  const doc = {
    id: 'document', model, savedVersion: 0, title: 'notes.txt', encoding, eol: 'LF',
    path: remote || untitled ? null : 'C:/notes.txt',
    remote: remote ? { sftpId: 'sftp', path: '/notes.txt', host: 'server' } : null,
    untitled,
  };
  const api = {
    invoke(channel, ...args) {
      assert.ok(['np:write', 'np:saveAs', 'sftp:writeFile'].includes(channel), channel);
      const operation = deferred();
      writes.push({ channel, args, ...operation });
      return operation.promise;
    },
    send(channel, id, value) {
      assert.equal(channel, 'np:backup');
      backupCommands.push([id, value]);
      if (value == null) backups.delete(id);
      else backups.set(id, value);
    },
  };
  const context = vm.createContext({
    api, T,
    h: () => ({}),
    modal: async () => { prompts.push('close'); return modal; },
    confirmDialog: async () => { prompts.push('lossy'); return confirm; },
    toast: (message) => errors.push(message),
    errMsg: (error) => error.message,
  });
  vm.runInContext(source + '\nglobalThis.TestTab = NotepadTab;', context, { filename: sourcePath });
  const tab = Object.create(context.TestTab.prototype);
  // A second document allows the real removeDoc method to close the test model
  // without creating a fresh Monaco model.
  const other = { id: 'other', model: { getAlternativeVersionId: () => 1, getValueLength: () => 0 }, savedVersion: 1 };
  Object.assign(tab, {
    current: doc, docs: [doc, other], closed: [],
    app: { setTabTitle() {} },
    monaco: { editor: { EndOfLinePreference: { TextDefined: 0 }, setModelLanguage() {} } },
    changed() {}, flashStatus() {}, remember() {},
    activate(d) { this.current = d; },
  });
  tab.backupDirty();
  return {
    tab, doc, writes, backups, backupCommands, prompts, errors,
    edit(value) { currentText = value; version++; },
    bytes(index = 0) {
      const write = writes[index];
      return Buffer.from(write.args[write.channel === 'sftp:writeFile' ? 2 : 1]);
    },
  };
}

async function runNotepadSaveRegressionTests(test) {
  const T = await import(pathToFileURL(path.join(__dirname, '../src/renderer/js/notepad/textops.mjs')).href);
  console.log('notepad: asynchronous saves');

  await test('SFTP save keeps edits typed during the write dirty and recoverable', async () => {
    const h = harness(T, { remote: true });
    const saving = h.tab.save();
    await settle();
    h.edit('typed while SFTP was writing');
    h.writes[0].resolve();
    assert.equal(await saving, true);
    assert.equal(h.bytes().toString(), 'first edit');
    assert.equal(h.doc.savedVersion, 1);
    assert.equal(h.tab.isDirty(h.doc), true);
    assert.equal(h.backups.get(h.doc.id), 'typed while SFTP was writing');
    assert.equal(h.doc.backedUpVersion, 2);
    assert.ok(h.backupCommands.every(([, value]) => value != null));
  });

  await test('local save records the written version and clears clean recovery state', async () => {
    const h = harness(T);
    const saving = h.tab.save();
    await settle();
    h.writes[0].resolve({ mtime: 123 });
    assert.equal(await saving, true);
    assert.equal(h.doc.mtime, 123);
    assert.equal(h.doc.savedVersion, 1);
    assert.equal(h.tab.isDirty(h.doc), false);
    assert.equal(h.backups.has(h.doc.id), false);
    assert.equal(h.doc.backedUpVersion, null);
  });

  await test('Save As retains edits made while its dialog/write is pending', async () => {
    const h = harness(T, { untitled: true });
    const saving = h.tab.save();
    await settle();
    assert.equal(h.writes[0].channel, 'np:saveAs');
    h.edit('new text while choosing a filename');
    h.writes[0].resolve({ path: 'C:/saved.txt', mtime: 456 });
    assert.equal(await saving, true);
    assert.equal(h.bytes().toString(), 'first edit');
    assert.equal(h.doc.path, 'C:/saved.txt');
    assert.equal(h.doc.title, 'saved.txt');
    assert.equal(h.doc.untitled, false);
    assert.equal(h.doc.savedVersion, 1);
    assert.equal(h.tab.isDirty(h.doc), true);
    assert.equal(h.backups.get(h.doc.id), 'new text while choosing a filename');
  });

  await test('overlapping saves serialize writes and preserve still newer edits', async () => {
    const h = harness(T, { remote: true });
    const first = h.tab.save();
    await settle();
    h.edit('second edit');
    const second = h.tab.save();
    await settle();
    assert.equal(h.writes.length, 1, 'second write must wait for the first');
    h.writes[0].resolve();
    assert.equal(await first, true);
    await settle();
    assert.equal(h.writes.length, 2);
    assert.equal(h.bytes(1).toString(), 'second edit');
    assert.equal(h.tab.isDirty(h.doc), true);
    h.edit('third edit');
    h.writes[1].resolve();
    assert.equal(await second, true);
    assert.equal(h.doc.savedVersion, 2);
    assert.equal(h.tab.isDirty(h.doc), true);
    assert.equal(h.backups.get(h.doc.id), 'third edit');
    assert.equal(h.doc.savePending, null);
  });

  await test('save queued after Save As uses the newly selected destination', async () => {
    const h = harness(T, { remote: true });
    const first = h.tab.saveAs();
    await settle();
    h.edit('local copy');
    const second = h.tab.save();
    assert.equal(h.writes.length, 1);
    h.writes[0].resolve({ path: 'C:/copy.txt', mtime: 1 });
    assert.equal(await first, true);
    await settle();
    assert.equal(h.writes[1].channel, 'np:write');
    assert.equal(h.writes[1].args[0], 'C:/copy.txt');
    assert.equal(h.bytes(1).toString(), 'local copy');
    h.writes[1].resolve({ mtime: 2 });
    assert.equal(await second, true);
    assert.equal(h.doc.remote, null);
    assert.equal(h.tab.isDirty(h.doc), false);
  });

  await test('encoding changes during a save remain dirty even without text edits', async () => {
    const h = harness(T);
    const saving = h.tab.save();
    await settle();
    h.tab.setEncoding('utf-8-bom');
    h.writes[0].resolve({ mtime: 1 });
    assert.equal(await saving, true);
    assert.equal(h.tab.isDirty(h.doc), true);
    assert.equal(h.backups.get(h.doc.id), 'first edit');
    const next = h.tab.save();
    await settle();
    assert.equal(h.bytes(1).subarray(0, 3).toString('hex'), 'efbbbf');
    h.writes[1].resolve({ mtime: 2 });
    assert.equal(await next, true);
    assert.equal(h.tab.isDirty(h.doc), false);
  });

  await test('lossy confirmation captures the version before awaiting user input', async () => {
    const confirmation = deferred();
    const h = harness(T, { text: 'symbol \u2603', encoding: 'windows-1252', confirm: confirmation.promise });
    const saving = h.tab.saveAs();
    await settle();
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.prompts, ['lossy']);
    h.edit('changed during confirmation');
    confirmation.resolve(true);
    await settle();
    assert.equal(h.bytes().toString(), 'symbol ?');
    h.writes[0].resolve({ path: 'C:/ansi.txt', mtime: 1 });
    assert.equal(await saving, true);
    assert.equal(h.doc.savedVersion, 1);
    assert.equal(h.tab.isDirty(h.doc), true);
    assert.equal(h.backups.get(h.doc.id), 'changed during confirmation');
  });

  await test('failed Save As preserves recovery and does not block a queued save', async () => {
    const h = harness(T);
    const first = h.tab.saveAs();
    await settle();
    const second = h.tab.save();
    h.writes[0].reject(new Error('disk full'));
    assert.equal(await first, false);
    assert.equal(h.doc.path, 'C:/notes.txt');
    assert.equal(h.doc.savedVersion, 0);
    assert.equal(h.backups.get(h.doc.id), 'first edit');
    assert.match(h.errors[0], /Save failed: disk full/);
    await settle();
    assert.equal(h.writes[1].channel, 'np:write');
    h.writes[1].resolve({ mtime: 1 });
    assert.equal(await second, true);
    assert.equal(h.doc.savePending, null);
  });

  await test('closing waits for a pending write and prompts for intervening edits', async () => {
    const h = harness(T);
    const saving = h.tab.save();
    await settle();
    const closing = h.tab.closeDoc(h.doc);
    assert.equal(h.prompts.length, 0);
    h.edit('typed while close was waiting');
    h.writes[0].resolve({ mtime: 1 });
    assert.equal(await saving, true);
    assert.equal(await closing, false);
    assert.deepEqual(h.prompts, ['close']);
    assert.equal(h.tab.docs.includes(h.doc), true);
    assert.equal(h.backups.get(h.doc.id), 'typed while close was waiting');
  });

  await test('Save in the close dialog keeps the document open if more edits arrive', async () => {
    const h = harness(T, { modal: 'save' });
    const closing = h.tab.closeDoc(h.doc);
    await settle();
    h.edit('typed after clicking Save');
    h.writes[0].resolve({ mtime: 1 });
    assert.equal(await closing, false);
    assert.equal(h.tab.docs.includes(h.doc), true);
    assert.equal(h.doc.model.isDisposed(), false);
    assert.equal(h.backups.get(h.doc.id), 'typed after clicking Save');
  });

  await test('closing a document after a clean pending save succeeds', async () => {
    const h = harness(T);
    const saving = h.tab.save();
    await settle();
    const closing = h.tab.closeDoc(h.doc);
    assert.equal(h.doc.model.isDisposed(), false);
    h.writes[0].resolve({ mtime: 1 });
    assert.equal(await saving, true);
    assert.equal(await closing, true);
    assert.equal(h.doc.model.isDisposed(), true);
    assert.equal(h.tab.docs.includes(h.doc), false);
  });

  await test('forced close cancels queued saves and ignores disposed model completions', async () => {
    const h = harness(T, { remote: true });
    const first = h.tab.save();
    await settle();
    const second = h.tab.save();
    assert.equal(await h.tab.closeDoc(h.doc, { force: true }), true);
    assert.equal(h.doc.model.isDisposed(), true);
    h.writes[0].resolve();
    assert.equal(await first, false);
    assert.equal(await second, false);
    assert.equal(h.writes.length, 1);
    assert.equal(h.backups.has(h.doc.id), false);
  });
}

module.exports = { runNotepadSaveRegressionTests };

if (require.main === module) {
  let failed = 0;
  runNotepadSaveRegressionTests(async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (error) { failed++; console.error(`  FAIL ${name}\n${error.stack}`); }
  }).then(() => { process.exitCode = failed ? 1 : 0; }).catch((error) => { console.error(error); process.exitCode = 1; });
}
