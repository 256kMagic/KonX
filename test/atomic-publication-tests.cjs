'use strict';
const assert = require('node:assert/strict');
const syncFs = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { publishNewFile, publishNewFileSync } = require('../src/main/atomic-replacement');
const { CopilotStore } = require('../src/main/copilot-store');
const { IncidentStore } = require('../src/main/incidents');
const { ChangeValidationStore } = require('../src/main/change-validation');
const { SiteWorkspaceStore } = require('../src/main/site-workspaces');
const error = code => Object.assign(new Error('Owned publication fixture ' + code), { code });
const plan = name => ({ name, checks: [{ id: 'observed', label: 'Review retained observations' }] });
async function fixture(fn) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'konx-publication-test-'));
  try { await fn(root); }
  finally { assert.equal(path.dirname(path.resolve(root)), parent); assert.ok(path.basename(root).startsWith('konx-publication-test-')); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
async function candidate(root, text = 'Complete reviewed record') {
  const file = path.join(root, crypto.randomUUID() + '.tmp'), handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); return { file, version: await handle.stat({ bigint: true }) }; }
  finally { await handle.close(); }
}
function storeOf(kind, root, options) { return kind === 'copilot' ? new CopilotStore(root, options) : kind === 'incident' ? new IncidentStore(root, options) : kind === 'site' ? new SiteWorkspaceStore(root, options) : new ChangeValidationStore(root, options); }
const create = (kind, store) => kind === 'copilot' ? store.create({ name: 'Before' }) : kind === 'incident' ? store.create({ title: 'Before' }) : kind === 'site' ? store.save({ name: 'Before' }) : store.create(plan('Before'));

async function runAtomicPublicationTests(test) {
  await test('synchronous initial settings publication preserves complete Unicode-path contents and refuses target collisions', () => fixture(async root => {
    const folder = path.join(root, 'settings-ü-' + 'a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80)); await fs.mkdir(folder, { recursive: true });
    const source = await candidate(folder, 'Complete encrypted settings fixture'), target = path.join(folder, 'ai-ü.json');
    const consumed = publishNewFileSync(syncFs, source.file, target, source.version);
    assert.equal(consumed, process.platform === 'win32');
    assert.equal(await fs.readFile(target, 'utf8'), 'Complete encrypted settings fixture');
    if (consumed) await assert.rejects(fs.lstat(source.file), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(source.file, 'utf8'), 'Complete encrypted settings fixture');
    const collision = await candidate(folder, 'Different pending settings fixture');
    assert.throws(() => publishNewFileSync(syncFs, collision.file, target, collision.version), { code: 'EEXIST' });
    assert.equal(await fs.readFile(target, 'utf8'), 'Complete encrypted settings fixture');
    assert.equal(await fs.readFile(collision.file, 'utf8'), 'Different pending settings fixture');
  }));
  await test('synchronous settings publication rejects changed source contents or identity before reaching the native move', () => fixture(async root => {
    const target = path.join(root, 'ai.json'); let invoked = false;
    const options = { platform: 'win32', moveNoReplace: () => { invoked = true; } };
    const modified = await candidate(root); await fs.appendFile(modified.file, '\nChanged after flush');
    assert.throws(() => publishNewFileSync(syncFs, modified.file, target, modified.version, options), { code: 'ATOMIC_CONFLICT' });
    const replaced = await candidate(root), retained = replaced.file + '.owned';
    await fs.rename(replaced.file, retained); await fs.writeFile(replaced.file, 'Foreign path occupant', { flag: 'wx' });
    assert.throws(() => publishNewFileSync(syncFs, replaced.file, target, replaced.version, options), { code: 'ATOMIC_CONFLICT' });
    assert.equal(invoked, false); assert.equal(await fs.readFile(replaced.file, 'utf8'), 'Foreign path occupant');
    assert.equal(await fs.readFile(retained, 'utf8'), 'Complete reviewed record');
    await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
  }));
  await test('synchronous native publication fails once without fallback, keeping its source available for owned cleanup', () => fixture(async root => {
    const source = await candidate(root), target = path.join(root, 'ai.json'), io = Object.create(syncFs);
    for (const name of ['renameSync', 'linkSync', 'copyFileSync']) io[name] = () => assert.fail('Forbidden synchronous publication fallback: ' + name);
    for (const code of ['EIO', 'EBUSY']) {
      let calls = 0;
      assert.throws(() => publishNewFileSync(io, source.file, target, source.version, { platform: 'win32', moveNoReplace: () => { calls++; throw error(code); } }), { code });
      assert.equal(calls, 1); assert.equal(await fs.readFile(source.file, 'utf8'), 'Complete reviewed record');
      await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
    }
  }));
  await test('new file publication preserves Unicode long paths and refuses an existing target without altering either file', () => fixture(async root => {
    const folder = path.join(root, 'unicode-ü-' + 'a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80)); await fs.mkdir(folder, { recursive: true });
    const { file, version } = await candidate(folder), target = path.join(folder, 'report-ü.json');
    const consumed = await publishNewFile(fs, file, target, version); assert.equal(consumed, process.platform === 'win32'); assert.equal(await fs.readFile(target, 'utf8'), 'Complete reviewed record');
    if (consumed) await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
    const other = await candidate(folder, 'Must not replace'); await assert.rejects(publishNewFile(fs, other.file, target, other.version), { code: 'EEXIST' });
    assert.equal(await fs.readFile(target, 'utf8'), 'Complete reviewed record'); assert.equal(await fs.readFile(other.file, 'utf8'), 'Must not replace');
  }));
  await test('new publication checks the exact source revision and refuses a cross-directory destination', () => fixture(async root => {
    const source = await candidate(root), target = path.join(root, 'report.json'); await fs.writeFile(source.file, 'Changed after sync');
    let invoked = false; const moveNoReplace = () => { invoked = true; };
    await assert.rejects(publishNewFile(fs, source.file, target, source.version, { platform: 'win32', moveNoReplace }), { code: 'ATOMIC_CONFLICT' }); assert.equal(invoked, false);
    await assert.rejects(publishNewFile(fs, source.file, path.join(root, 'other', 'report.json'), await fs.lstat(source.file, { bigint: true })), { code: 'ATOMIC_CONFLICT' });
    await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
  }));
  await test('native publication failures never fall back to copy, hardlink or overwrite and retries remain bounded', () => fixture(async root => {
    const source = await candidate(root), target = path.join(root, 'report.json'); let calls = 0;
    const io = Object.create(fs); for (const name of ['rename', 'link', 'copyFile']) io[name] = async () => { assert.fail('Forbidden publication fallback: ' + name); };
    for (const code of ['EIO', 'EBUSY']) {
      calls = 0; await assert.rejects(publishNewFile(io, source.file, target, source.version, { platform: 'win32', moveNoReplace: () => { calls++; throw error(code); } }), { code });
      assert.equal(calls, code === 'EBUSY' ? 6 : 1); assert.equal(await fs.readFile(source.file, 'utf8'), 'Complete reviewed record'); await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
    }
  }));
  await test('a changed source during native publication retry is retained and a late target collision remains untouched', () => fixture(async root => {
    const source = await candidate(root), target = path.join(root, 'report.json'), backup = source.file + '.original'; let calls = 0;
    await assert.rejects(publishNewFile(fs, source.file, target, source.version, { platform: 'win32', moveNoReplace: async () => {
      calls++; await fs.rename(source.file, backup); await fs.writeFile(source.file, 'Foreign source occupant'); throw error('EBUSY');
    } }), { code: 'ATOMIC_CONFLICT' });
    assert.equal(calls, 1); assert.equal(await fs.readFile(source.file, 'utf8'), 'Foreign source occupant'); assert.equal(await fs.readFile(backup, 'utf8'), 'Complete reviewed record');
    if (process.platform === 'win32') {
      const next = await candidate(root); calls = 0;
      await assert.rejects(publishNewFile(fs, next.file, target, next.version, { moveNoReplace: async (from, to) => {
        calls++; if (calls === 1) { await fs.writeFile(to, 'Foreign target occupant', { flag: 'wx' }); throw error('EBUSY'); }
        return publishNewFile(fs, from, to, next.version);
      } }), { code: 'EEXIST' });
      assert.equal(calls, 2); assert.equal(await fs.readFile(target, 'utf8'), 'Foreign target occupant'); assert.equal(await fs.readFile(next.file, 'utf8'), 'Complete reviewed record');
    }
  }));
  await test('all four real stores publish then immediately replace without retaining temporary aliases', () => fixture(async root => {
    for (const kind of ['copilot', 'incident', 'change', 'site']) {
      const profile = path.join(root, kind), store = storeOf(kind, profile, {});
      try {
        for (let i = 0; i < 12; i++) {
          const before = await create(kind, store);
          const after = kind === 'copilot' ? await store.rename(before.id, before.revision, 'After') : kind === 'incident' ? await store.addText(before.id, { kind: 'note', text: 'Retained once' }) : kind === 'site' ? await store.save({ ...before, name: 'After' }) : await store.savePlan(before.id, before.revision, plan('After'));
          assert.equal(kind === 'incident' ? after.evidence.length : after.revision, kind === 'incident' ? 1 : 2); assert.equal(store.hasOwnership, false);
        }
        assert.ok(!(await fs.readdir(store.directory)).some(name => name.startsWith('.')));
      } finally { await store.close(); }
    }
  }));
  await test('each store retains failed native-publication cleanup until its exact temporary file can be removed', () => fixture(async root => {
    for (const kind of ['copilot', 'incident', 'change', 'site']) {
      let blocked = true; const io = Object.create(fs); io.unlink = async file => { if (blocked && path.basename(file).startsWith('.')) throw error('EBUSY'); return fs.unlink(file); };
      const store = storeOf(kind, path.join(root, kind), { fs: io, publishNew: (io, from, to, version) => publishNewFile(io, from, to, version, { platform: 'win32', moveNoReplace: () => { throw error('EIO'); } }) });
      try {
        await assert.rejects(create(kind, store)); assert.equal(store.hasOwnership, true); await assert.rejects(store.close(), /cleanup/i);
        blocked = false; await store.close(); assert.equal(store.hasOwnership, false);
      } finally { blocked = false; await store.close(); }
    }
  }));
}
module.exports = { runAtomicPublicationTests };
if (require.main === module) runAtomicPublicationTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
