'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { KnowledgeLibrary, ALGORITHM } = require('../src/main/knowledge');
const bundle = require('../src/knowledge/articles.json');

const PREFIX = 'konx-knowledge-test-';

function temporary() { return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), PREFIX)); }
function cleanup(root) {
  const target = path.resolve(root);
  assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(target).startsWith(PREFIX));
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
async function fixture(callback) {
  const dir = temporary();
  const library = new KnowledgeLibrary({ dir });
  try { return await callback(library, dir); }
  finally { await library.close(); cleanup(dir); }
}
function openDatabase(dir) { return new DatabaseSync(path.join(dir, 'knowledge', 'library.sqlite')); }

async function runKnowledgeTests(test) {
  await test('knowledge: background initialization creates a real persistent SQLite vector index without any AI key', async () => {
    await fixture(async (library, dir) => {
      let uiTurn = false;
      const turn = new Promise((resolve) => setImmediate(() => { uiTurn = true; resolve(); }));
      const state = await library.status();
      await turn;
      assert.equal(uiTurn, true);
      assert.equal(state.state, 'ready');
      assert.equal(state.algorithm, ALGORITHM);
      assert.equal(state.documents, bundle.articles.length);
      assert.equal(state.customDocuments, 0);
      assert.ok(state.chunks >= state.documents);
      assert.ok(Number.isFinite(Date.parse(state.updatedAt)));
      assert.ok(fs.readFileSync(path.join(dir, 'knowledge/library.sqlite')).subarray(0, 16).equals(Buffer.from('SQLite format 3\0')));
      const db = openDatabase(dir);
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE length(vector)=4096').get().count, state.chunks);
        assert.equal(JSON.parse(db.prepare('SELECT value FROM metadata WHERE key=?').get('idf').value).length, 1024);
      } finally { db.close(); }
      assert.deepEqual(fs.readdirSync(dir), ['knowledge']);
    });
  });

  await test('knowledge: ranked cosine retrieval finds tool explanations, bounds excerpts, and rejects collision-only grounding', async () => {
    await fixture(async (library) => {
      assert.equal((await library.search('RSSI signal noise Wi-Fi'))[0].id, 'builtin:wifi-signal');
      assert.equal((await library.search('Nyquest automatic model routing'))[0].id, 'builtin:ai-nyquest');
      const results = await library.search('SIP INVITE SDP call ladder', { limit: 3 });
      assert.equal(results[0].id, 'builtin:sip-calls');
      assert.ok(results.length <= 3);
      assert.equal(new Set(results.map((row) => row.id)).size, results.length);
      for (const result of results) {
        assert.ok(result.score > 0 && result.score <= 1.000001);
        assert.ok(result.content.length <= 900);
        assert.ok(result.chunkId.startsWith(result.id + '#'));
        assert.ok(result.sourceUrl.startsWith('https://'));
      }
      assert.deepEqual(await library.search(''), []);
      assert.deepEqual(await library.search('the and of'), []);
      assert.deepEqual(await library.search('zzzunobservedquasarwordbbb'), [], 'A hashed collision must not ground an unrelated answer');
    });
  });

  await test('knowledge: article CRUD searches full text, preserves metadata, and protects bundled articles', async () => {
    await fixture(async (library) => {
      const saved = await library.save({ title: 'Lab switch runbook', vendor: 'Lab vendor', sourceUrl: 'https://example.com/runbook', tags: ['switch', 'lab', 'switch'], content: 'Check the distinctive zephyranchor counter before reviewing the uplink.' });
      assert.match(saved.id, /^custom:[a-f0-9-]{36}$/);
      assert.equal(saved.builtin, false);
      assert.deepEqual(saved.tags, ['switch', 'lab']);
      assert.deepEqual(await library.get(saved.id), saved);
      const listed = await library.list({ query: 'zephyranchor', vendor: 'lab VENDOR' });
      assert.equal(listed[0].id, saved.id);
      assert.equal(Object.hasOwn(listed[0], 'content'), false);
      assert.equal((await library.search('zephyranchor'))[0].id, saved.id);
      assert.ok((await library.list({ query: 'noise measurement' })).some((row) => row.id === 'builtin:wifi-signal'));
      const updated = await library.save({ ...saved, content: 'The new distinctive cumulonimbusmarker replaces the old procedure.' });
      assert.equal(updated.id, saved.id);
      assert.equal((await library.search('cumulonimbusmarker'))[0].id, saved.id);
      assert.deepEqual(await library.search('zephyranchor'), []);
      await assert.rejects(library.save({ id: 'builtin:wifi-signal', title: 'Overwrite', content: 'Never replace bundled explanations.' }), /Built-in/);
      await assert.rejects(library.remove('builtin:wifi-signal'), /Built-in/);
      assert.deepEqual(await library.remove(saved.id), { removed: true, id: saved.id });
      assert.equal(await library.get(saved.id), null);
      assert.deepEqual(await library.search('cumulonimbusmarker'), []);
      await assert.rejects(library.remove(saved.id), /not found/);
    });
  });

  await test('knowledge: reopening and rebuilding retain custom content and reconcile changed bundled explanations', async () => {
    const dir = temporary();
    let library = new KnowledgeLibrary({ dir });
    try {
      const saved = await library.save({ title: 'Persistent lab note', content: 'Zephyrpersist is a synthetic offline knowledge marker.', tags: ['lab'] });
      const original = await library.get('builtin:wifi-signal');
      await library.close();
      const db = openDatabase(dir);
      try {
        db.prepare('UPDATE documents SET title=?,content=? WHERE id=?').run('Old bundle title', 'Stale bundled text.', 'builtin:wifi-signal');
        db.prepare('UPDATE metadata SET value=? WHERE key=?').run('old-bundle-checksum', 'bundleChecksum');
      } finally { db.close(); }
      library = new KnowledgeLibrary({ dir });
      assert.equal((await library.status()).customDocuments, 1);
      assert.equal((await library.get('builtin:wifi-signal')).content, original.content);
      assert.equal((await library.get('builtin:wifi-signal')).title, original.title);
      assert.deepEqual(await library.get(saved.id), saved);
      assert.equal((await library.search('zephyrpersist'))[0].id, saved.id);
      const rebuilt = await library.rebuild();
      assert.equal(rebuilt.customDocuments, 1);
      assert.equal(rebuilt.documents, bundle.articles.length + 1);
      assert.equal((await library.search('zephyrpersist'))[0].id, saved.id);
    } finally { await library.close(); cleanup(dir); }
  });

  await test('knowledge: failed indexing rolls back article and vector mutations atomically', async () => {
    await fixture(async (library, dir) => {
      const before = await library.status();
      const db = openDatabase(dir);
      try {
        db.exec("CREATE TRIGGER synthetic_index_failure BEFORE INSERT ON chunks BEGIN SELECT RAISE(ABORT, 'Synthetic index write failure'); END;");
        await assert.rejects(library.save({ title: 'Must roll back', content: 'Rollbackmarker content must never be committed alone.' }), /Synthetic index write failure/);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents WHERE title=?').get('Must roll back').count, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chunks').get().count, before.chunks);
        db.exec('DROP TRIGGER synthetic_index_failure');
      } finally { db.close(); }
      assert.equal((await library.status()).documents, before.documents);
      assert.equal((await library.search('RSSI signal noise'))[0].id, 'builtin:wifi-signal');
      const after = await library.save({ title: 'Recovery after rollback', content: 'Commitmarker is now a valid article.' });
      assert.equal((await library.search('commitmarker'))[0].id, after.id);
    });
  });

  await test('knowledge: article and query limits reject malformed input and source credentials without damaging the index', async () => {
    await fixture(async (library) => {
      const invalid = [
        { title: '', content: 'Empty title' }, { title: 'Too much', content: 'x'.repeat(32001) },
        { title: 'Bad source', content: 'Sample', sourceUrl: 'http://example.com/' },
        { title: 'Bad source', content: 'Sample', sourceUrl: 'https://user:secret@example.com/' },
        { title: 'Bad source', content: 'Sample', sourceUrl: 'file:///C:/secret' },
        { title: 'Bad tags', content: 'Sample', tags: Array(21).fill('tag') },
        { title: 'Bad tags', content: 'Sample', tags: [null] },
        { title: 'Bad ID', content: 'Sample', id: '../other.sqlite' },
      ];
      for (const input of invalid) await assert.rejects(library.save(input));
      await assert.rejects(library.search('x'.repeat(4001)), /4000/);
      for (const limit of [0, 6, 1.5, '5']) await assert.rejects(library.search('wifi', { limit }), /limit/);
      await assert.rejects(library.list({ vendor: 'x'.repeat(81) }), /80/);
      await assert.rejects(library.get('../../outside'), /Invalid article ID/);
      assert.equal((await library.status()).state, 'ready');
      assert.equal((await library.status()).customDocuments, 0);
    });
  });

  await test('knowledge: custom article capacity is bounded while updates and removals remain available', async () => {
    await fixture(async (library) => {
      let first;
      for (let index = 0; index < 200; index++) {
        const saved = await library.save({ title: `Synthetic capacity article ${index}`, content: `Capacityfixture ${index} is deliberately small.` });
        if (!first) first = saved;
      }
      assert.equal((await library.status()).customDocuments, 200);
      await assert.rejects(library.save({ title: 'Over capacity', content: 'This must not be saved.' }), /at most 200/);
      await library.save({ ...first, content: 'Existing articles can still be edited at capacity.' });
      await library.remove(first.id);
      await library.save({ title: 'Replacement article', content: 'A freed slot can be reused.' });
      assert.equal((await library.status()).customDocuments, 200);
    });
  });

  await test('knowledge: damaged databases are reported and retained without deleting user files', async () => {
    const dir = temporary();
    const folder = path.join(dir, 'knowledge');
    fs.mkdirSync(folder);
    const corrupt = Buffer.from('Synthetic corrupt database; preserve for recovery.');
    fs.writeFileSync(path.join(folder, 'library.sqlite'), corrupt);
    const library = new KnowledgeLibrary({ dir });
    try {
      const status = await library.status();
      assert.equal(status.state, 'error');
      assert.match(status.error, /unavailable/i);
      await assert.rejects(library.search('wifi'), /unavailable/i);
      assert.deepEqual(fs.readFileSync(path.join(folder, 'library.sqlite')), corrupt);
    } finally { await library.close(); cleanup(dir); }
  });

  await test('knowledge: custom integrity failures preserve recoverable text instead of silently resetting the library', async () => {
    const dir = temporary();
    let library = new KnowledgeLibrary({ dir });
    try {
      const saved = await library.save({ title: 'Recovery fixture', content: 'Preserve this custom article.' });
      await library.close();
      const db = openDatabase(dir);
      try { db.prepare('UPDATE documents SET checksum=? WHERE id=?').run('damaged-checksum', saved.id); }
      finally { db.close(); }
      library = new KnowledgeLibrary({ dir });
      const status = await library.status();
      assert.equal(status.state, 'error');
      assert.match(status.error, /integrity/i);
      const recovered = openDatabase(dir);
      try { assert.equal(recovered.prepare('SELECT content FROM documents WHERE id=?').get(saved.id).content, saved.content); }
      finally { recovered.close(); }
    } finally { await library.close(); cleanup(dir); }
  });

  await test('knowledge: shutdown and unexpected worker exit settle pending requests and never respawn', async () => {
    const dir = temporary();
    const library = new KnowledgeLibrary({ dir });
    const pending = library.search('wifi');
    const rejected = assert.rejects(pending, /closed/);
    await library.close();
    await rejected;
    assert.equal((await library.status()).state, 'closed');
    await assert.rejects(library.list(), /closed/);
    await library.close();
    cleanup(dir);
    await fixture(async (value) => {
      await value.status();
      const worker = value._worker;
      const operation = value.search('signal');
      const rejection = assert.rejects(operation, /worker exited/);
      await worker.terminate();
      await rejection;
      assert.equal((await value.status()).state, 'error');
      assert.equal(value._worker, worker);
    });
  });

  await test('knowledge: an unresponsive worker has a bounded request timeout and a visible error state', async () => {
    let terminated = 0;
    class UnresponsiveWorker extends EventEmitter {
      constructor() { super(); queueMicrotask(() => this.emit('message', { ready: true })); }
      ref() {} unref() {} postMessage() {}
      terminate() { terminated++; return Promise.resolve(0); }
    }
    const filename = path.join(__dirname, '../src/main/knowledge.js');
    const context = { module: { exports: {} }, __dirname: path.dirname(filename),
      require: (name) => name === 'node:worker_threads' ? { Worker: UnresponsiveWorker } : require(name),
      setTimeout: (fn, ms) => { assert.equal(ms, 30000); return setTimeout(fn, 20); }, clearTimeout,
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const library = new context.module.exports.KnowledgeLibrary({ dir: path.resolve(os.tmpdir()) });
    await assert.rejects(library.search('wifi'), /timed out/);
    assert.equal((await library.status()).state, 'error');
    assert.equal(terminated, 1);
    await library.close();
  });

  await test('knowledge: Electron loads SQLite and the background worker directly from a packaged ASAR', runElectronAsarFixture);
}

async function runElectronAsarFixture() {
  const dir = temporary();
  let child;
  let output = '';
  try {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(path.join(staging, 'src/main'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'src/knowledge'), { recursive: true });
    for (const name of ['knowledge.js', 'knowledge-worker.js']) fs.copyFileSync(path.join(__dirname, '../src/main', name), path.join(staging, 'src/main', name));
    fs.copyFileSync(path.join(__dirname, '../src/knowledge/articles.json'), path.join(staging, 'src/knowledge/articles.json'));
    const archive = path.join(dir, 'fixture.asar');
    await require('@electron/asar').createPackage(staging, archive);
    const env = { ...process.env, KONX_KNOWLEDGE_FIXTURE_ROOT: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(require('electron'), [__filename, '--knowledge-electron-fixture', archive], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (bytes) => { output = (output + bytes).slice(-16384); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Knowledge Electron fixture timed out: ${output}`)); }, 20000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (value) => { clearTimeout(timeout); resolve(value); });
    });
    assert.equal(code, 0, output);
    const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.ok(result.electron && result.node);
    assert.equal(result.documents, bundle.articles.length);
    assert.equal(result.queryId, 'builtin:wifi-signal');
    assert.equal(result.persisted, true);
  } finally {
    if (child && child.exitCode === null && !child.killed) {
      const closed = new Promise((resolve) => child.once('close', resolve)); child.kill(); await closed;
    }
    cleanup(dir);
  }
}

function electronFixture() {
  const { app, dialog } = require('electron');
  dialog.showErrorBox = (_title, message) => { console.error(message); app.exit(1); };
  const dir = path.resolve(process.env.KONX_KNOWLEDGE_FIXTURE_ROOT || '.');
  assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith(PREFIX));
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    let library;
    try {
      const archive = process.argv[process.argv.indexOf('--knowledge-electron-fixture') + 1];
      const PackagedLibrary = require(path.join(archive, 'src/main/knowledge.js')).KnowledgeLibrary;
      library = new PackagedLibrary({ dir: profile });
      const state = await library.status();
      assert.equal(state.state, 'ready', JSON.stringify(state));
      const results = await library.search('RSSI signal noise Wi-Fi');
      const saved = await library.save({ title: 'Packaged worker note', content: 'Asarpersistmarker verifies local persistence.' });
      await library.close();
      library = new PackagedLibrary({ dir: profile });
      assert.equal((await library.get(saved.id)).content, saved.content);
      await library.close();
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ passed: true, electron: process.versions.electron, node: process.versions.node, documents: state.documents, queryId: results[0].id, persisted: true }));
      app.exit(0);
    } catch (error) {
      await library?.close();
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ passed: false, error: String(error.stack || error) }));
      console.error(error);
      app.exit(1);
    }
  });
}

if (process.argv.includes('--knowledge-electron-fixture')) electronFixture();
module.exports = { runKnowledgeTests };
