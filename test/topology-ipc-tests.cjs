'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const io = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadTopology, REPO } = require('./topology-tests.cjs');
const { SnapshotStore } = require(path.join(REPO, 'src/main/device-snapshots'));
const loadTopologyIpc = () => require('../src/main/topology-ipc');
const demo = () => JSON.parse(fs.readFileSync(path.join(REPO, 'assets/device-inspector-demo.json'), 'utf8'));
async function temporary(fn) {
  const base = fs.realpathSync(os.tmpdir()), root = await io.mkdtemp(path.join(base, 'konx-topology-ipc-'));
  try { await fn(root); } finally { assert.equal(path.dirname(path.resolve(root)), base); assert.ok(path.basename(root).startsWith('konx-topology-ipc-')); await io.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
function harness(root, options = {}) {
  const handlers = new Map(), state = { selected: path.join(root, 'input.json'), output: path.join(root, 'export.json'), opened: 0, saved: 0, closing: false, cancel: false };
  const owner = {};
  const dialog = {
    async showOpenDialog(received) { assert.equal(received, owner); state.opened++; return state.cancel ? { canceled: true } : { canceled: false, filePaths: [state.selected] }; },
    async showSaveDialog(received) { assert.equal(received, owner); state.saved++; return state.cancel ? { canceled: true } : { canceled: false, filePath: state.output }; },
  };
  loadTopologyIpc().registerTopology((name, handler) => handlers.set(name, handler), { dialog, dialogOwner: () => owner, isClosing: () => state.closing, ...options });
  return { handlers, state, dialog };
}
async function runTopologyIpcTests(test) {
  await test('Topology IPC exports real saved observations and reopens canonical source, ignoring forged graph/facts', () => temporary(async root => {
    const store = new SnapshotStore(path.join(root, 'profile')), saved = await store.save({ label: 'Topology roundtrip', report: demo() });
    const record = await store.get(saved.id), { handlers, state } = harness(root);
    const file = await handlers.get('tools:topologyExport')(record.report, { at: '2026-10-23T12:00:00Z', endpoint: '192.0.2.100' });
    assert.equal(file, state.output); const exported = JSON.parse(await io.readFile(file, 'utf8'));
    assert.equal(exported.endpoint.query, '192.0.2.100'); assert.deepEqual(exported.sourceReport.devices[0].commands, record.report.devices[0].commands);
    exported.nodes = [{ id: 'forged', label: 'FORGED' }]; exported.sourceReport.devices[0].facts = { neighbors: [{ deviceId: 'FORGED' }] };
    await io.writeFile(file, JSON.stringify(exported)); state.selected = file;
    const imported = await handlers.get('tools:topologyImport')();
    assert.equal(imported.kind, 'device'); assert.deepEqual(imported.devices[0].commands, record.report.devices[0].commands);
    const graph = handlers.get('tools:topologyBuild')(imported);
    assert.equal(graph.nodes.length, 2); assert.ok(!JSON.stringify(graph).includes('FORGED'));
    await io.writeFile(state.selected, '\uFEFF' + JSON.stringify(demo())); assert.equal((await handlers.get('tools:topologyImport')()).devices.length, 2);
  }));
  await test('Topology IPC cancellation does not read or overwrite files and invalid reports fail before save dialog', () => temporary(async root => {
    const { handlers, state } = harness(root); await io.writeFile(state.output, 'UNTOUCHED'); state.cancel = true;
    assert.equal(await handlers.get('tools:topologyImport')(), null);
    assert.equal(await handlers.get('tools:topologyExport')(demo()), null); assert.equal(await io.readFile(state.output, 'utf8'), 'UNTOUCHED');
    state.cancel = false; const calls = state.saved;
    await assert.rejects(handlers.get('tools:topologyExport')({ devices: [] }), /Supply between/); assert.equal(state.saved, calls);
    for (const [input, message] of [['{broken', /malformed/], [JSON.stringify({ kind: 'topology', schemaVersion: 2, sourceReport: demo() }), /unsupported schema/], [JSON.stringify({ kind: 'topology', schemaVersion: 1 }), /no retained source/], [JSON.stringify({ devices: [{ commands: [{ id: 'execute', output: 'whoami' }] }] }), /Unknown or duplicate/]]) {
      await io.writeFile(state.selected, input); await assert.rejects(handlers.get('tools:topologyImport')(), message);
    }
  }));
  await test('Topology IPC file reads reject oversized, nonregular and changing files and close their owned handles', () => temporary(async root => {
    const { handlers, state } = harness(root), file = await io.open(state.selected, 'w');
    await file.truncate(loadTopology().LIMITS.exportBytes + 1); await file.close();
    await assert.rejects(handlers.get('tools:topologyImport')(), /20 MiB/);
    state.selected = root; await assert.rejects(handlers.get('tools:topologyImport')(), /regular|EISDIR|EPERM/);
    const changing = path.join(root, 'changing.json'); await io.writeFile(changing, JSON.stringify(demo())); let closed = 0;
    const fixture = harness(root, { io: { ...io, async open(name, flags) { const handle = await io.open(name, flags); return {
      async stat() { const stat = await handle.stat(); await io.appendFile(name, '\n'); return stat; },
      read: (...args) => handle.read(...args), async close() { closed++; await handle.close(); },
    }; } } });
    fixture.state.selected = changing; await assert.rejects(fixture.handlers.get('tools:topologyImport')(), /changed while reading/); assert.equal(closed, 1);
    await io.rename(changing, path.join(root, 'closed.json'));
  }));
  await test('Topology IPC closing during dialogs prevents late imports and export overwrites', () => temporary(async root => {
    const { handlers, state, dialog } = harness(root); await io.writeFile(state.output, 'UNTOUCHED'); await io.writeFile(state.selected, JSON.stringify(demo()));
    state.closing = true; await assert.rejects(handlers.get('tools:topologyImport')(), /closing/); assert.equal(state.opened, 0);
    state.closing = false; dialog.showOpenDialog = async () => { state.closing = true; return { filePaths: [state.selected] }; };
    await assert.rejects(handlers.get('tools:topologyImport')(), /closing/);
    state.closing = false; dialog.showSaveDialog = async () => { state.closing = true; return { filePath: state.output }; };
    await assert.rejects(handlers.get('tools:topologyExport')(demo()), /closing/); assert.equal(await io.readFile(state.output, 'utf8'), 'UNTOUCHED');
  }));
  await test('Topology IPC bounds expanded JSON exports before any file dialog or write', () => temporary(async root => {
    const { handlers, state } = harness(root);
    const report = { devices: [{ id: 'expanded', commands: ['version', 'interfaces', 'vlans', 'arp'].map(id => ({ id, output: '\0'.repeat(1024 * 1024) })) }] };
    await assert.rejects(handlers.get('tools:topologyExport')(report), /20 MiB/); assert.equal(state.saved, 0); assert.equal(fs.existsSync(state.output), false);
  }));
}
module.exports = { runTopologyIpcTests, loadTopologyIpc };
if (require.main === module) runTopologyIpcTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
