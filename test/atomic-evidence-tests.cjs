'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ChangeValidationStore } = require('../src/main/change-validation');
const { IncidentStore } = require('../src/main/incidents');
const plan = name => ({ name, scope: 'Owned synthetic fixture', expectedOutcome: 'Save once', rollbackPlan: '', checks: [{ id: 'check', label: 'Review retained evidence' }] });
const failure = code => Object.assign(new Error('Synthetic filesystem ' + code), { code });
const io = overrides => new Proxy(fs, { get(target, key) { return key in overrides ? overrides[key] : target[key]; } });
async function fixture(kind, fn) {
  const base = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(base, 'konx-atomic-evidence-'));
  const stores = []; const make = overrides => { const store = kind === 'change' ? new ChangeValidationStore(root, { fs: io(overrides) }) : new IncidentStore(root, { fs: io(overrides) }); stores.push(store); return store; };
  const clean = make({}); const record = kind === 'change' ? await clean.create(plan('Initial')) : await clean.create({ title: 'Initial incident' });
  const file = kind === 'change' ? clean.file(record.id) : path.join(clean.dir(record.id), 'manifest.json');
  const save = store => kind === 'change' ? store.savePlan(record.id, record.revision, plan('Updated once')) : store.addText(record.id, { kind: 'note', text: 'Added once' });
  try { await fn({ root, record, file, make, save, clean, kind }); }
  finally {
    for (const store of stores) await store.close().catch(() => {});
    assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-atomic-evidence-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
async function runAtomicEvidenceTests(test) {
  await test('incident final export owns its pending write through close and publishes the exact prepared report', () => fixture('incident', async ({ make, root, clean, record }) => {
    const destination = path.join(root, 'report.json'), content = await clean.exportJson(record.id);
    let release, entered; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const store = make({ open: async (name, flags, ...args) => {
      const handle = await fs.open(name, flags, ...args); if (!path.basename(name).startsWith('.konx-incident-export-')) return handle;
      return { stat: (...args) => handle.stat(...args), writeFile: async (...args) => { entered(); await gate; return handle.writeFile(...args); }, sync: () => handle.sync(), close: () => handle.close() };
    } });
    const saving = store.writeExport(destination, content); await started; let closed = false; const closing = store.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(store.hasOwnership, true); await assert.rejects(store.writeExport(destination, 'Late'), /closing/);
    release(); assert.equal(await saving, destination); await closing; assert.equal(store.hasOwnership, false); assert.equal(await fs.readFile(destination, 'utf8'), content);
  }));
  await test('incident export preserves existing files and retains a failed temporary close until retry', () => fixture('incident', async ({ make, root }) => {
    const destination = path.join(root, 'report.json'); await fs.writeFile(destination, 'Prior export'); let blocked = true;
    const store = make({ open: async (name, flags, ...args) => {
      const handle = await fs.open(name, flags, ...args); if (!path.basename(name).startsWith('.konx-incident-export-')) return handle;
      return { stat: (...args) => handle.stat(...args), writeFile: (...args) => handle.writeFile(...args), sync: () => handle.sync(), close: async () => { if (blocked) throw failure('EBUSY'); return handle.close(); } };
    } });
    await assert.rejects(store.writeExport(destination, 'New export'), /EBUSY/); assert.equal(store.hasOwnership, true); assert.equal(await fs.readFile(destination, 'utf8'), 'Prior export');
    await assert.rejects(store.close(), /cleanup/); blocked = false; await store.close(); assert.equal(store.hasOwnership, false);
    await store.writeExport(destination, 'New export'); assert.equal(await fs.readFile(destination, 'utf8'), 'New export');
  }));
  await test('incident export rejects managed destinations through a real ancestor alias without changing evidence', () => fixture('incident', async ({ clean, root, file, record }) => {
    const before = await fs.readFile(file), alias = path.join(root, 'ancestor-alias'); await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try { await assert.rejects(clean.writeExport(path.join(alias, 'incidents', record.id, 'manifest.json'), 'Must not overwrite'), /managed incident/); assert.deepEqual(await fs.readFile(file), before); assert.equal(clean.hasOwnership, false); }
    finally { await fs.unlink(alias); }
  }));
  for (const kind of ['change', 'incident']) {
    await test(kind + ' publication retries only transient Windows sharing failures and commits exactly once', () => fixture(kind, async ({ make, save, record }) => {
      let attempts = 0; const store = make({ rename: async (...args) => { attempts++; if (attempts <= 2) throw failure('EPERM'); return fs.rename(...args); } });
      if (process.platform === 'win32') { const value = await save(store); assert.equal(attempts, 3); assert.equal(kind === 'change' ? value.revision : value.evidence.length, kind === 'change' ? record.revision + 1 : 1); assert.equal(store.hasOwnership, false); }
      else { await assert.rejects(save(store), { code: 'EPERM' }); assert.equal(attempts, 1); }
    }));
    await test(kind + ' permanent and exhausted sharing errors preserve the prior record and release unpublished files', () => fixture(kind, async ({ make, save, file, clean, record }) => {
      const previous = await fs.readFile(file);
      for (const code of ['EIO', 'EBUSY']) {
        let attempts = 0; const store = make({ rename: async () => { attempts++; throw failure(code); } });
        await assert.rejects(save(store), { code }); assert.equal(attempts, code === 'EBUSY' && process.platform === 'win32' ? 6 : 1); assert.deepEqual(await fs.readFile(file), previous); assert.equal(store.hasOwnership, false);
      }
      if (kind === 'incident') assert.deepEqual(await fs.readdir(path.join(clean.dir(record.id), 'evidence')), []);
    }));
    await test(kind + ' replacement refuses changed temp or target identities and never deletes their replacement', async () => {
      for (const which of ['source', 'target']) await fixture(kind, async ({ make, save, file }) => {
        let attempts = 0, moved, foreign; const store = make({ rename: async (source, target) => {
          attempts++; if (attempts === 1) { foreign = which === 'source' ? source : target; moved = foreign + '.owned-original'; await fs.rename(foreign, moved); await fs.writeFile(foreign, 'Synthetic replacement that is not ours'); throw failure('EPERM'); }
          return fs.rename(source, target);
        } });
        await assert.rejects(save(store), process.platform === 'win32' ? /changed|cleanup/i : /EPERM|cleanup/i); assert.equal(attempts, 1);
        assert.equal(await fs.readFile(foreign, 'utf8'), 'Synthetic replacement that is not ours');
        if (which === 'source') { assert.equal(store.hasOwnership, true); await assert.rejects(store.close(), /cleanup/i); }
        // Both occupants belong to this isolated fixture. Restore the exact
        // original so the owner can prove identity and retry its own cleanup.
        await fs.unlink(foreign); await fs.rename(moved, foreign); await store.close(); assert.equal(store.hasOwnership, false);
        assert.ok((await fs.readFile(file, 'utf8')).includes(kind === 'change' ? 'Initial' : 'Initial incident'));
      });
    });
    await test(kind + ' save refuses a source revision changed after reading but before the first rename', () => fixture(kind, async ({ make, save, file }) => {
      let changed = false, attempts = 0; const store = make({ open: async (name, flags, ...args) => {
        const handle = await fs.open(name, flags, ...args);
        if (!changed && flags === 'wx') { changed = true; const value = JSON.parse(await fs.readFile(file, 'utf8')); if (kind === 'change') { value.revision++; value.plan.name = 'External revision'; } else value.title = 'External revision'; await fs.writeFile(file, JSON.stringify(value)); }
        return handle;
      }, rename: async (...args) => { attempts++; return fs.rename(...args); } });
      await assert.rejects(save(store), /changed during atomic replacement/i); assert.equal(attempts, 0); assert.ok((await fs.readFile(file, 'utf8')).includes('External revision')); assert.equal(store.hasOwnership, false);
    }));
  }
  await test('incident committed publication retains failed temporary cleanup, rejects unsafe replacement cleanup and recovers exactly once', async () => {
    const base = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(base, 'konx-atomic-evidence-'));
    let blocked = true; const store = new IncidentStore(root, { fs: io({ unlink: async file => { if (blocked && path.basename(file).startsWith('.manifest-')) throw failure('EPERM'); return fs.unlink(file); } }) });
    try {
      const record = await store.create({ title: 'Committed once' }); assert.ok(record.id); assert.equal(store.hasOwnership, true); await assert.rejects(store.close(), /cleanup/);
      const owner = [...store.owners][0], backup = owner.file + '.fixture-owned'; await fs.rename(owner.file, backup); await fs.writeFile(owner.file, 'Synthetic foreign occupant'); blocked = false;
      await assert.rejects(store.close(), /cleanup/); assert.equal(await fs.readFile(owner.file, 'utf8'), 'Synthetic foreign occupant');
      await fs.unlink(owner.file); await fs.rename(backup, owner.file); await store.close(); assert.equal(store.hasOwnership, false); assert.equal((await store.list()).incidents.length, 1); assert.equal((await store.get(record.id)).title, 'Committed once');
    } finally { blocked = false; await store.close().catch(() => {}); assert.equal(path.dirname(root), base); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  await test('incident public reads serialize with writes, close waits queued append, and a failed read close remains owned', () => fixture('incident', async ({ make, save, record, file }) => {
    let release, entered, block = true; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const store = make({ open: async (name, flags, ...args) => {
      const handle = await fs.open(name, flags, ...args); if (name !== file || flags !== 'r' || !block) return handle;
      return { stat: (...args) => handle.stat(...args), read: async (...args) => { entered(); await gate; block = false; return handle.read(...args); }, close: () => handle.close() };
    } });
    const reading = store.get(record.id); await started; const saving = save(store), closing = store.close(); await assert.rejects(store.get(record.id), /closing/); assert.equal(store.hasOwnership, true); release(); await reading; assert.equal((await saving).evidence.length, 1); await closing; assert.equal(store.hasOwnership, false);
    let failClose = true; const retained = make({ open: async (name, flags, ...args) => {
      const handle = await fs.open(name, flags, ...args); if (flags !== 'r') return handle;
      return { stat: (...args) => handle.stat(...args), read: (...args) => handle.read(...args), close: async () => { if (failClose) throw failure('EBUSY'); return handle.close(); } };
    } });
    await assert.rejects(retained.get(record.id), /EBUSY/); assert.equal(retained.hasOwnership, true); await assert.rejects(retained.close(), /cleanup/); failClose = false; await retained.close(); assert.equal(retained.hasOwnership, false);
  }));
}
module.exports = { runAtomicEvidenceTests };
if (require.main === module) runAtomicEvidenceTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
