'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { SftpManager } = require('../src/main/sftp');
const notepad = require('../src/main/notepad');
const ssh = require('../src/main/ssh');

const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'Timed out waiting for transfer');
    await settle();
  }
}

async function withTemp(fn) {
  const parent = path.resolve(__dirname);
  const dir = fs.mkdtempSync(path.join(parent, '.file-review-'));
  try { await fn(dir); }
  finally {
    const relative = path.relative(parent, dir);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function transferFixture(dir) {
  const events = [];
  const manager = new SftpManager({ emit: (...args) => events.push(args), ask: async () => ({ action: 'overwrite' }) });
  const channel = { end() {}, fastGet(_src, dst, _opts, cb) { fs.writeFileSync(dst, 'downloaded'); cb(); } };
  const session = { stat: async () => ({ mode: 0o100644, size: 10, mtime: 1234 }), channel: async () => channel, close() {} };
  manager.sessions.set('s', session);
  const file = path.join(dir, 'file.txt');
  fs.writeFileSync(file, 'original');
  return { manager, channel, session, file, events };
}

async function queueDownload(fixture, dir) {
  await fixture.manager.download('s', ['/file.txt'], dir, { conflict: 'overwrite' });
  return fixture.manager.queue.jobs[0];
}

async function rendererHarness(T, { confirm = true } = {}) {
  const sourcePath = path.join(__dirname, '../src/renderer/js/notepad/notepad.js');
  const source = fs.readFileSync(sourcePath, 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class NotepadTab', 'class NotepadTab');
  const reads = [], prompts = [], messages = [];
  let text = 'original', version = 1, disposed = false;
  const model = {
    getAlternativeVersionId() { assert.ok(!disposed); return version; },
    getValue() { assert.ok(!disposed); return text; },
    setValue(value) { assert.ok(!disposed); text = value; version++; },
    isDisposed: () => disposed,
  };
  const doc = { id: 'd1', path: 'notes.txt', title: 'notes.txt', model, savedVersion: 1, encoding: 'utf-8', eol: 'LF' };
  const context = vm.createContext({
    T, TextDecoder, Uint8Array,
    api: { invoke(channel, ...args) { assert.equal(channel, 'np:read'); const d = deferred(); reads.push({ ...d, args }); return d.promise; } },
    confirmDialog: async (message) => { prompts.push(message); return confirm; },
    toast: (message) => messages.push(message), errMsg: (e) => e.message,
  });
  vm.runInContext(source + '\nglobalThis.TestTab = NotepadTab;', context, { filename: sourcePath });
  const tab = Object.create(context.TestTab.prototype);
  Object.assign(tab, { docs: [doc], current: doc, editor: { saveViewState: () => null }, changed() {} });
  return {
    tab, doc, reads, prompts, messages,
    edit(value) { model.setValue(value); },
    text: () => text,
    close() { disposed = true; tab.docs = []; },
  };
}

async function runFileReviewRegressionTests(test) {
  function openFixture() {
    let ends = 0, channelEnds = 0;
    const channel = { end() { channelEnds++; }, realpath(_path, cb) { cb(null, '/home/demo'); } };
    const client = new EventEmitter();
    client.end = () => { ends++; };
    client.sftp = (cb) => cb(null, channel);
    const manager = new SftpManager({
      emit() {}, ask: async () => null,
      connections: { resolveSession: () => ({ host: 'demo', username: 'test' }), sshClient: () => ({ client, session: { host: 'demo' } }) },
      store: {},
    });
    return { manager, client, channel, ends: () => ends, channelEnds: () => channelEnds };
  }

  await test('sftp: closing during login closes the late owned client without registering an orphan', async () => {
    const f = openFixture(), login = deferred(), original = ssh.connectChain;
    ssh.connectChain = () => login.promise;
    try {
      const opening = f.manager.open('s', {});
      f.manager.close('s');
      login.resolve({ client: f.client });
      await assert.rejects(opening, /cancel|closed/i);
      await settle();
      assert.equal(f.manager.sessions.size, 0);
      assert.equal(f.ends(), 1);
    } finally { ssh.connectChain = original; }
  });

  await test('sftp: closing a pending shared channel preserves its terminal client', async () => {
    const f = openFixture();
    let finish;
    f.client.sftp = (cb) => { finish = cb; };
    const opening = f.manager.open('s', { fromConn: 'terminal' });
    f.manager.close('s');
    finish(null, f.channel);
    await assert.rejects(opening, /cancel|closed/i);
    await settle();
    assert.equal(f.manager.sessions.size, 0);
    assert.equal(f.ends(), 0);
    assert.equal(f.channelEnds(), 1);
  });

  await test('sftp: failed channel creation closes its owned SSH client', async () => {
    const f = openFixture(), original = ssh.connectChain;
    ssh.connectChain = async () => ({ client: f.client });
    f.client.sftp = (cb) => cb(new Error('Subsystem denied'));
    try {
      await assert.rejects(f.manager.open('s', {}), /Subsystem denied/);
      assert.equal(f.ends(), 1);
      assert.equal(f.manager.sessions.size, 0);
    } finally { ssh.connectChain = original; }
  });

  await test('sftp: established transport errors close the session and clear external-edit watchers', async () => {
    const f = openFixture(), original = ssh.connectChain;
    ssh.connectChain = async () => ({ client: f.client });
    try {
      await f.manager.open('s', {});
      const watcher = setInterval(() => {}, 60000);
      f.manager.watchers.set('s:/file.txt', watcher);
      try { assert.doesNotThrow(() => f.client.emit('error', new Error('Transport reset'))); }
      finally { clearInterval(watcher); }
      assert.equal(f.manager.sessions.size, 0);
      assert.equal(f.manager.watchers.size, 0);
      assert.equal(f.ends(), 1);
    } finally { ssh.connectChain = original; }
  });

  await test('sftp: cancelling during channel creation never starts an upload', () => withTemp(async (dir) => {
    const f = transferFixture(dir), opened = deferred();
    let uploads = 0, ends = 0;
    f.session.channel = () => opened.promise;
    f.channel.fastPut = (_src, _dst, _opts, cb) => { uploads++; cb(); };
    f.channel.end = () => { ends++; };
    await f.manager.upload('s', [f.file], '/', { conflict: 'overwrite' });
    await settle();
    f.manager.queue.cancel(1);
    opened.resolve(f.channel);
    await waitFor(() => !f.manager.queue.active.size);
    assert.equal(uploads, 0);
    assert.equal(ends, 1);
    assert.equal(f.manager.queue.jobs[0].status, 'cancelled');
  }));

  await test('sftp: cancelled channel failure preserves an existing destination', () => withTemp(async (dir) => {
    const f = transferFixture(dir), opened = deferred();
    let requested = false;
    f.session.channel = () => { requested = true; return opened.promise; };
    await queueDownload(f, dir);
    await waitFor(() => requested);
    f.manager.queue.cancel(1);
    opened.reject(new Error('Channel closed'));
    await waitFor(() => !f.manager.queue.active.size);
    await settle();
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(dir), ['file.txt']);
  }));

  for (const cancel of [false, true]) {
    await test(`sftp: ${cancel ? 'cancelled' : 'failed'} partial download preserves original bytes`, () => withTemp(async (dir) => {
      const f = transferFixture(dir);
      let finish;
      f.channel.fastGet = (_src, dst, _opts, cb) => { fs.writeFileSync(dst, 'partial'); finish = cb; };
      f.channel.end = () => { if (finish) { const cb = finish; finish = null; cb(new Error('Transfer interrupted')); } };
      await queueDownload(f, dir);
      await waitFor(() => finish);
      if (cancel) f.manager.queue.cancel(1);
      else { const cb = finish; finish = null; cb(new Error('Network disconnected')); }
      await waitFor(() => !f.manager.queue.active.size);
      assert.equal(fs.readFileSync(f.file, 'utf8'), 'original');
      assert.deepEqual(fs.readdirSync(dir), ['file.txt']);
      assert.equal(f.manager.queue.jobs[0].status, cancel ? 'cancelled' : 'error');
    }));
  }

  await test('sftp: cancelling a pending conflict preserves cancelled status', () => withTemp(async (dir) => {
    const f = transferFixture(dir), answer = deferred();
    let requested = false;
    f.manager.deps.ask = () => { requested = true; return answer.promise; };
    await f.manager.download('s', ['/file.txt'], dir);
    await waitFor(() => requested);
    f.manager.queue.cancel(1);
    answer.resolve({ action: 'skip' });
    await waitFor(() => !f.manager.queue.active.size);
    assert.equal(f.manager.queue.jobs[0].status, 'cancelled');
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original');
  }));

  await test('sftp: successful download replaces original only after completion', () => withTemp(async (dir) => {
    const f = transferFixture(dir);
    let finish;
    f.channel.fastGet = (_src, dst, _opts, cb) => { fs.writeFileSync(dst, 'complete'); finish = cb; };
    await queueDownload(f, dir);
    await waitFor(() => finish);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original');
    finish();
    await waitFor(() => !f.manager.queue.active.size);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'complete');
    assert.deepEqual(fs.readdirSync(dir), ['file.txt']);
    assert.equal(f.manager.queue.jobs[0].status, 'done');
  }));

  await test('sftp: closing during remote enumeration prevents new download jobs', () => withTemp(async (dir) => {
    const f = transferFixture(dir), stat = deferred();
    let requested = false;
    f.session.stat = () => { requested = true; return stat.promise; };
    const enumeration = f.manager.download('s', ['/file.txt'], dir, { conflict: 'overwrite' });
    await waitFor(() => requested);
    f.manager.close('s');
    stat.resolve({ mode: 0o100644, size: 10, mtime: 1234 });
    await assert.rejects(enumeration, /closed|cancel|not open/i);
    assert.equal(f.manager.queue.jobs.length, 0);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original');
  }));

  await test('sftp: closing during local enumeration prevents new upload jobs', () => withTemp(async (dir) => {
    const f = transferFixture(dir), stat = deferred(), original = fs.promises.stat;
    let requested = false;
    fs.promises.stat = (file, ...args) => {
      if (file === f.file) { requested = true; return stat.promise; }
      return original(file, ...args);
    };
    try {
      const enumeration = f.manager.upload('s', [f.file], '/', { conflict: 'overwrite' });
      await waitFor(() => requested);
      f.manager.close('s');
      stat.resolve(fs.statSync(f.file));
      await assert.rejects(enumeration, /closed|cancel|not open/i);
      assert.equal(f.manager.queue.jobs.length, 0);
    } finally { fs.promises.stat = original; }
  }));

  await test('notepad: failed atomic replacement never falls back to truncating the original', () => withTemp(async (dir) => {
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, 'original');
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('File is in use'), { code: 'EPERM' }); return rename(from, to); };
    try { assert.throws(() => notepad.writeFile(file, Buffer.from('new text')), /File is in use/); }
    finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(dir), ['notes.txt']);
  }));

  const T = await import(pathToFileURL(path.join(__dirname, '../src/renderer/js/notepad/textops.mjs')).href);
  await test('notepad: typing during a disk reload remains dirty and intact', async () => {
    const h = await rendererHarness(T);
    const loading = h.tab.reload(h.doc, { ask: false });
    await settle();
    h.edit('typed while disk read was pending');
    h.reads[0].resolve({ bytes: Buffer.from('disk contents'), mtime: 234 });
    await loading;
    assert.equal(h.text(), 'typed while disk read was pending');
    assert.equal(h.tab.isDirty(h.doc), true);
  });

  await test('notepad: reopening with an encoding asks before discarding edits', async () => {
    const h = await rendererHarness(T, { confirm: false });
    h.edit('unsaved edit');
    const reopening = h.tab.reopenWithEncoding('windows-1252', h.doc);
    await settle();
    // Resolve a wrongly issued read so this regression terminates on old code.
    if (h.reads.length) h.reads[0].resolve({ bytes: Buffer.from('disk contents'), mtime: 234 });
    await reopening;
    assert.equal(h.prompts.length, 1);
    assert.equal(h.reads.length, 0);
    assert.equal(h.text(), 'unsaved edit');
  });

  await test('notepad: disk read finishing after document closure ignores its disposed model', async () => {
    const h = await rendererHarness(T);
    const loading = h.tab.reopenWithEncoding('utf-8', h.doc);
    await settle();
    h.close();
    h.reads[0].resolve({ bytes: Buffer.from('disk contents'), mtime: 234 });
    await assert.doesNotReject(loading);
    assert.equal(h.text(), 'original');
  });

  await test('notepad: Find in Files decodes both UTF-16 byte orders and excludes BOM columns', () => withTemp(async (dir) => {
    for (const encoding of ['utf-16le', 'utf-16be']) fs.writeFileSync(path.join(dir, encoding + '.txt'), T.encodeText('needle first\nsecond needle', encoding));
    const found = [];
    await notepad.findInFiles('job', { dir, query: 'needle' }, (event, _id, rows) => { if (event === 'np:found') found.push(...rows); }, { stopped: false });
    assert.equal(found.length, 4);
    assert.deepEqual(found.map((row) => row.col).sort(), [1, 1, 8, 8]);
  }));
}

module.exports = { runFileReviewRegressionTests };
if (require.main === module) {
  let failures = 0;
  runFileReviewRegressionTests(async (name, fn) => {
    try { await fn(); console.log('ok ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); }
  }).then(() => { process.exitCode = failures ? 1 : 0; }, (error) => { console.error(error); process.exitCode = 1; });
}
