'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { SiteWorkspaceStore, LIMITS, PASSIVE_TOOLS } = require('../src/main/site-workspaces');
const faultFs = overrides => new Proxy(fs, { get(target, name) { return Object.hasOwn(overrides, name) ? overrides[name] : target[name]; } });
const code = expected => error => error.code === expected;
const withStore = fn => async () => {
  const base = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(base, 'konx-sites-test-'));
  try { await fn(new SiteWorkspaceStore(directory), directory); }
  finally { assert.equal(path.dirname(directory), base); assert.ok(path.basename(directory).startsWith('konx-sites-test-')); await fs.rm(directory, { recursive: true, force: true }); }
};
const sample = directory => ({ name: 'Branch office', description: 'Reviewed maintenance context', notes: 'User-authored notes remain literal: show ip route\nNo commands are executed.',
  sessions: [{ id: 'legacy-session-01', name: 'Core switch', group: 'Branch / Network' }],
  captures: [{ id: 'capture-a', name: 'Before.pcapng', path: path.join(directory, 'not-opened.pcapng') }],
  incidentIds: ['c9420a20-bf97-4a76-b154-e1aac30d0529'],
  layout: { preset: 'workbench', wallCount: 4, panels: [
    { key: 'core', kind: 'session', referenceId: 'legacy-session-01', placement: 'docked', slot: 'primary' },
    { key: 'traffic', kind: 'capture', referenceId: 'capture-a', placement: 'floating', bounds: { x: 0.3, y: 0.1, width: 0.15, height: 0.3 } },
    { key: 'case', kind: 'incident', referenceId: 'c9420a20-bf97-4a76-b154-e1aac30d0529', placement: 'docked', slot: 'companion' },
    { key: 'analysis', kind: 'tool', toolKind: 'device' }, { key: 'notes', kind: 'notes' },
  ], activePanelKey: 'core' } });

async function runSiteWorkspaceTests(test) {
  await test('site workspace saves reference-only data, survives a fresh store and never opens capture references', withStore(async (store, directory) => {
    const input = sample(directory), saved = await store.save(input);
    assert.equal(saved.schemaVersion, 1); assert.equal(saved.kind, 'konx-site-workspace'); assert.equal(saved.revision, 1);
    assert.equal(saved.layout.panels[1].bounds.width, 0.15, 'Valid narrow floats on wide monitors must persist');
    assert.equal(saved.layout.panels[0].sessionMode, 'terminal'); assert.equal(saved.layout.panels[1].sessionMode, null);
    assert.deepEqual(saved.sessions, input.sessions); assert.equal(saved.notes, input.notes);
    input.sessions[0].name = 'Changed caller'; saved.sessions[0].name = 'Changed response';
    const fresh = new SiteWorkspaceStore(directory), reopened = await fresh.get(saved.id);
    assert.equal(reopened.sessions[0].name, 'Core switch'); assert.equal(reopened.captures[0].path, input.captures[0].path);
    await assert.rejects(fs.stat(input.captures[0].path), code('ENOENT'));
    const library = await fresh.list(); assert.equal(library.workspaces.length, 1); assert.deepEqual(library.issues, []);
    assert.equal(library.workspaces[0].sessionCount, 1); assert.equal(library.workspaces[0].notes, undefined);
    assert.deepEqual(library.capabilities.toolKinds, [...PASSIVE_TOOLS]);
  }));
  await test('site workspace snapshots caller input before queueing and rejects stale revisions', withStore(async (store, directory) => {
    let release; store.queue = new Promise(resolve => { release = resolve; });
    const input = sample(directory), pending = store.save(input); input.notes = 'Late mutation'; input.layout.panels[0].referenceId = 'wrong'; release();
    const saved = await pending; assert.notEqual(saved.notes, input.notes);
    const outcomes = await Promise.allSettled([store.save({ ...saved, notes: 'first writer' }), store.save({ ...saved, notes: 'stale writer' })]);
    assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'rejected');
    assert.equal(outcomes[1].reason.code, 'SITE_WORKSPACE_CONFLICT');
    const current = await store.get(saved.id); assert.equal(current.revision, 2); assert.equal(current.notes, 'first writer'); assert.equal(current.createdAt, saved.createdAt);
    assert.throws(() => store.save({ id: saved.id, name: 'No revision' }), code('SITE_WORKSPACE_CONFLICT'));
  }));
  await test('site workspace duplicate and reviewed export/import retain data under new identities without copying credentials', withStore(async (store, directory) => {
    const input = sample(directory); input.layout.panels[0].sessionMode = 'sftp';
    const saved = await store.save(input), copy = await store.duplicate(saved.id);
    assert.equal((await new SiteWorkspaceStore(directory).get(saved.id)).layout.panels[0].sessionMode, 'sftp');
    assert.equal(copy.layout.panels[0].sessionMode, 'sftp');
    assert.notEqual(copy.id, saved.id); assert.equal(copy.name, 'Branch office (copy)'); assert.equal(copy.revision, 1);
    const text = await store.exportJson(saved.id), exported = JSON.parse(text);
    assert.equal(exported.kind, 'konx-site-workspace-export'); assert.equal(exported.workspace.id, undefined);
    assert.equal(exported.workspace.notes, saved.notes); assert.equal(exported.workspace.captures[0].path, saved.captures[0].path);
    assert.deepEqual(Object.keys(exported.workspace.sessions[0]), ['id', 'name', 'group']);
    const imported = await store.importJson(text); assert.notEqual(imported.id, saved.id); assert.notEqual(imported.id, copy.id);
    assert.deepEqual(imported.layout, saved.layout); assert.equal(imported.revision, 1);
    await store.remove(copy.id); await assert.rejects(store.get(copy.id), code('SITE_WORKSPACE_NOT_FOUND'));
    assert.equal((await store.list()).workspaces.length, 2);
  }));
  await test('site workspace rejects inline credentials, commands, unknown fields and invalid references before mutation', withStore(async (store, directory) => {
    const attacks = [
      value => { value.password = 'SYNTHETIC_SECRET'; }, value => { value.sessions[0].passwordEnc = 'SYNTHETIC_SECRET'; },
      value => { value.sessions[0].username = 'SYNTHETIC_LOGIN'; }, value => { value.sessions[0].host = '127.0.0.1'; },
      value => { value.layout.panels[3].params = { command: 'arbitrary command' }; }, value => { value.commands = ['arbitrary command']; },
      value => { value.sessions.push({ ...value.sessions[0] }); }, value => { value.layout.panels[0].referenceId = 'missing'; },
      value => { value.layout.panels[0].key = 'traffic'; }, value => { value.layout.panels[2].slot = 'primary'; },
      value => { value.layout.activePanelKey = 'missing'; }, value => { value.layout.panels[3].toolKind = 'netinfo'; },
      value => { value.captures[0].path = '../relative.pcap'; }, value => { value.incidentIds[0] = '../outside'; },
      value => { value.layout.panels[1].bounds.width = Infinity; }, value => { value.layout.panels[1].bounds.width = 0; },
      value => { value.layout.panels[1].bounds.x = 0.99; }, value => { value.layout.geometry = { version: 5 }; },
      value => { value.layout.preset = 'unknown'; }, value => { value.layout.wallCount = 1.5; },
      value => { value.layout.panels[0].sessionMode = 'unknown'; }, value => { value.layout.panels[0].sessionMode = null; },
      value => { value.layout.panels[1].sessionMode = 'sftp'; },
    ];
    for (const mutate of attacks) { const input = sample(directory); mutate(input); assert.throws(() => store.save(input), /workspace|field|reference|identifier|Panel|panel|Floating|floating|layout|path|tool|ratio|wall/i); }
    const valid = await store.save(sample(directory)), exported = JSON.parse(await store.exportJson(valid.id));
    exported.workspace.sessions[0].logon = [{ send: 'SYNTHETIC_COMMAND' }];
    assert.throws(() => store.importJson(JSON.stringify(exported)), /unsupported field/);
    assert.equal((await store.list()).workspaces.length, 1);
    assert.doesNotMatch(await fs.readFile(store.file(valid.id), 'utf8'), /SYNTHETIC_SECRET|SYNTHETIC_LOGIN|SYNTHETIC_COMMAND/);
  }));
  await test('site workspace normalizes native popouts to floats and enforces valid dock roles', withStore(async (store, directory) => {
    const input = sample(directory); input.layout.panels[1].placement = 'external';
    assert.equal((await store.save(input)).layout.panels[1].placement, 'floating');
    input.layout.preset = 'incident-desk'; input.layout.panels[2].slot = 'dossier';
    assert.equal((await store.save(input)).layout.panels[2].slot, 'dossier');
    input.layout.panels[2].slot = null; input.layout.panels[0].slot = 'dossier';
    assert.throws(() => store.save(input), /dossier/);
  }));
  await test('site workspace malformed records remain visible as issues and cannot be overwritten by save or import', withStore(async (store, directory) => {
    const saved = await store.save(sample(directory)), file = store.file(saved.id);
    for (const malformed of ['{broken', '{"schemaVersion":99}', JSON.stringify({ ...saved, id: crypto.randomUUID() }), JSON.stringify({ ...saved, password: 'SYNTHETIC_SECRET' })]) {
      await fs.writeFile(file, malformed);
      await assert.rejects(store.get(saved.id)); await assert.rejects(store.save(saved));
      const library = await store.list(); assert.equal(library.workspaces.length, 0); assert.equal(library.issues[0].id, saved.id);
      assert.equal(await fs.readFile(file, 'utf8'), malformed);
    }
    assert.throws(() => store.importJson('{broken'), code('SITE_WORKSPACE_FORMAT'));
    assert.throws(() => store.importJson(JSON.stringify({ schemaVersion: 2, kind: 'konx-site-workspace-export' })), code('SITE_WORKSPACE_FORMAT'));
    await fs.writeFile(file, JSON.stringify(saved)); await store.remove(saved.id);
  }));
  await test('site workspace validates counts, UTF-8 sizes and serialized representation before writing', withStore(async (store, directory) => {
    const input = sample(directory); input.notes = 'é'.repeat(LIMITS.notesBytes / 2 + 1);
    assert.throws(() => store.save(input), code('SITE_WORKSPACE_LIMIT'));
    assert.throws(() => store.save({ name: 'Many sessions', sessions: new Array(LIMITS.sessions + 1).fill({}) }), code('SITE_WORKSPACE_LIMIT'));
    assert.throws(() => store.importJson('x'.repeat(LIMITS.fileBytes + 1)), code('SITE_WORKSPACE_LIMIT'));
    const expanded = { name: 'Escaped text', notes: '\u0001'.repeat(LIMITS.notesBytes), description: '\u0001'.repeat(4096),
      captures: Array.from({ length: LIMITS.captures }, (_, index) => ({ id: String(index), name: 'x'.repeat(256), path: path.join(directory, 'x'.repeat(4000)) })) };
    await assert.rejects(store.save(expanded), code('SITE_WORKSPACE_LIMIT'));
    assert.deepEqual((await store.list()).workspaces, []);
    for (let index = 0; index < LIMITS.workspaces; index++) await store.save({ name: 'Workspace ' + index });
    await assert.rejects(store.save({ name: 'One too many' }), code('SITE_WORKSPACE_LIMIT'));
    const library = await store.list(); assert.equal(library.workspaces.length, LIMITS.workspaces); assert.deepEqual(library.issues, []);
  }));
  await test('site workspace atomic write failure preserves the prior revision and cleans staged files', withStore(async (store, directory) => {
    const saved = await store.save(sample(directory)), original = await fs.readFile(store.file(saved.id));
    const failed = new SiteWorkspaceStore(directory, { fs: faultFs({ rename: async () => { throw Object.assign(new Error('Synthetic publication denied'), { code: 'EACCES' }); } }) });
    await assert.rejects(failed.save({ ...saved, notes: 'Not published' }), /publication denied/);
    assert.deepEqual(await fs.readFile(store.file(saved.id)), original);
    assert.deepEqual(await fs.readdir(store.directory), [saved.id + '.json']);
    assert.equal((await store.get(saved.id)).revision, 1);
  }));
  await test('site workspace directory inspection stops at its entry bound without modifying foreign files', withStore(async store => {
    await store.ready();
    for (let index = 0; index <= LIMITS.workspaces * 2; index++) await fs.writeFile(path.join(store.directory, 'foreign-' + index), 'keep');
    const result = await store.list(); assert.equal(result.workspaces.length, 0); assert.equal(result.issues.length, LIMITS.workspaces * 2 + 1);
    assert.match(result.issues.at(-1).message, /Directory entry limit/);
    await assert.rejects(store.save({ name: 'Bounded' }), code('SITE_WORKSPACE_LIMIT'));
    assert.equal((await fs.readdir(store.directory)).length, LIMITS.workspaces * 2 + 1);
  }));
  await test('site workspace retries an owned read handle when closing it fails', withStore(async (store, directory) => {
    const saved = await store.save({ name: 'Owned read' }); let deny = true, retried = 0;
    const guarded = new SiteWorkspaceStore(directory, { fs: faultFs({ open: async (file, ...args) => {
      const handle = await fs.open(file, ...args);
      return new Proxy(handle, { get(target, key) {
        if (key === 'close') return async () => { retried++; if (deny) throw new Error('Synthetic close failure'); return target.close(); };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    } }) });
    await assert.rejects(guarded.get(saved.id), /close failure/); assert.equal(guarded.pendingHandles.size, 1); assert.equal(guarded.hasOwnership, true);
    await assert.rejects(guarded.close(), code('SITE_WORKSPACE_CLEANUP')); assert.equal(guarded.hasOwnership, true);
    deny = false; await guarded.close(); assert.equal(guarded.hasOwnership, false);
    assert.equal((await guarded.get(saved.id)).name, 'Owned read'); assert.equal(guarded.pendingHandles.size, 0); assert.ok(retried >= 3);
  }));
  await test('site workspace retains cleanup ownership after failed unlink without falsely failing a committed save', withStore(async (_store, directory) => {
    let deny = true;
    const store = new SiteWorkspaceStore(directory, { fs: faultFs({ unlink: async file => {
      if (deny && path.basename(file).startsWith('.workspace-')) throw Object.assign(new Error('Synthetic cleanup denied'), { code: 'EPERM' }); return fs.unlink(file);
    } }) });
    const saved = await store.save({ name: 'Committed once' }); assert.equal(saved.revision, 1); assert.equal(store.cleanup.size, 1);
    const before = await store.list(); assert.equal(before.workspaces.length, 1); assert.ok(before.issues.length);
    await assert.rejects(store.close(), code('SITE_WORKSPACE_CLEANUP')); assert.equal(store.hasOwnership, true);
    deny = false; await store.close(); assert.equal(store.hasOwnership, false);
    const after = await store.list(); assert.equal(after.workspaces.length, 1); assert.deepEqual(after.issues, []); assert.equal(store.cleanup.size, 0);
  }));
  await test('site workspace closing waits for queued publication and prevents new work until cleanup completes', withStore(async (_store, directory) => {
    let release, began; const blocked = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; });
    const store = new SiteWorkspaceStore(directory, { fs: faultFs({ link: async (...args) => { began(); await blocked; return fs.link(...args); } }) });
    const saving = store.save({ name: 'Finish before closing' }); assert.equal(store.hasOwnership, true); await started;
    let finished = false; const closing = store.close().then(() => { finished = true; });
    assert.throws(() => store.list(), code('SITE_WORKSPACE_CLOSING')); await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
    release(); const saved = await saving; await closing; assert.equal(store.hasOwnership, false);
    assert.equal((await new SiteWorkspaceStore(directory).get(saved.id)).name, 'Finish before closing');
    assert.equal((await store.get(saved.id)).revision, 1, 'A cancelled app shutdown may resume the same store');
  }));
  await test('site workspace retains a newly opened temporary handle when initial identity inspection fails', withStore(async (_store, directory) => {
    let deny = true;
    const store = new SiteWorkspaceStore(directory, { fs: faultFs({ open: async (file, ...args) => {
      const handle = await fs.open(file, ...args);
      if (args[0] !== 'wx') return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === 'stat') return async () => { if (deny) throw new Error('Synthetic identity failure'); return target.stat(); };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    } }) });
    await assert.rejects(store.save({ name: 'Not published' }), /identity failure/); assert.equal(store.hasOwnership, true);
    await assert.rejects(store.close(), code('SITE_WORKSPACE_CLEANUP')); assert.equal(store.hasOwnership, true);
    deny = false; await store.close(); assert.equal(store.hasOwnership, false); assert.deepEqual(await fs.readdir(store.directory), []);
  }));
  await test('site workspace import/export use chosen bounded files and preserve originals on failed publication', withStore(async (store, directory) => {
    const saved = await store.save(sample(directory)), exportedPath = path.join(directory, 'reviewed-export.json');
    assert.deepEqual(await store.exportFile(saved.id, exportedPath), { path: exportedPath });
    const before = await fs.readFile(exportedPath), imported = await store.importFile(exportedPath);
    assert.notEqual(imported.id, saved.id); assert.deepEqual(imported.sessions, saved.sessions); assert.deepEqual(await fs.readFile(exportedPath), before);
    const failed = new SiteWorkspaceStore(directory, { fs: faultFs({ rename: async () => { throw new Error('Synthetic export denied'); } }) });
    await assert.rejects(failed.exportFile(saved.id, exportedPath), /export denied/); assert.deepEqual(await fs.readFile(exportedPath), before);
    assert.throws(() => store.exportFile(saved.id, store.file(saved.id)), /outside the managed/);
    assert.throws(() => store.importFile('../relative'), /absolute/);
    const large = path.join(directory, 'oversized.json'), handle = await fs.open(large, 'wx'); await handle.truncate(LIMITS.fileBytes + 1); await handle.close();
    await assert.rejects(store.importFile(large), code('SITE_WORKSPACE_LIMIT'));
    const invalid = path.join(directory, 'invalid-utf8.json'); await fs.writeFile(invalid, Buffer.from([0xff, 0xfe]));
    await assert.rejects(store.importFile(invalid), code('SITE_WORKSPACE_FORMAT'));
    assert.equal((await store.list()).workspaces.length, 2);
  }));
  await test('site workspace IDs and filesystem links cannot redirect reads, writes or deletion', withStore(async (store, directory) => {
    const saved = await store.save({ name: 'Paths' });
    for (const id of ['../outside', 'not-a-uuid', saved.id.toUpperCase(), directory]) {
      assert.throws(() => store.get(id)); assert.throws(() => store.remove(id)); assert.throws(() => store.exportJson(id));
    }
    const elsewhere = path.join(directory, 'elsewhere'); await fs.mkdir(elsewhere); await fs.writeFile(path.join(elsewhere, 'keep.json'), 'keep');
    const profile = path.join(directory, 'linked-profile'); await fs.mkdir(profile);
    await fs.symlink(elsewhere, path.join(profile, 'site-workspaces'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = new SiteWorkspaceStore(profile); await assert.rejects(linked.list(), /real directory/); await assert.rejects(linked.save({ name: 'Blocked' }), /real directory/);
    const exportFolder = path.join(directory, 'export-link'); await fs.symlink(elsewhere, exportFolder, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.exportFile(saved.id, path.join(exportFolder, 'keep.json')), /real directory/);
    assert.equal(await fs.readFile(path.join(elsewhere, 'keep.json'), 'utf8'), 'keep');
  }));
  await test('site workspace source mutation during import is rejected without creating a workspace', withStore(async (store, directory) => {
    const saved = await store.save({ name: 'Fixture' }), source = path.join(directory, 'source.json'); await store.exportFile(saved.id, source);
    const original = await fs.readFile(source);
    let changed = false;
    const guarded = new SiteWorkspaceStore(directory, { fs: faultFs({ open: async (file, ...args) => {
      const handle = await fs.open(file, ...args);
      if (file !== source || args[0] !== 'r') return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === 'read') return async (...params) => { if (!changed) { changed = true; await fs.appendFile(source, ' '); } return target.read(...params); };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    } }) });
    await assert.rejects(guarded.importFile(source), code('SITE_WORKSPACE_CONFLICT'));
    assert.equal(changed, true); assert.equal((await store.list()).workspaces.length, 1);
    assert.deepEqual((await fs.readFile(source)).subarray(0, original.length), original);
  }));
}

module.exports = { runSiteWorkspaceTests };
if (require.main === module) {
  let passed = 0, failed = 0;
  runSiteWorkspaceTests(async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } })
    .then(() => { console.log(`${passed}/${passed + failed} site workspace tests passed`); process.exitCode = failed ? 1 : 0; });
}
