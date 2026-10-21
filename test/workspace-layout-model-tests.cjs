'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function runWorkspaceLayoutModelTests(test) {
  const { normalizeLayout } = await import('../src/renderer/js/workspace-layouts.mjs');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/workspace-layout.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('export class ', 'class ');
  const module = { exports: {} };
  vm.runInNewContext(source + '\nmodule.exports = WorkspaceLayoutModel;', { module, normalizeLayout });
  const Model = module.exports;
  const tabs = [{ id: 'a', kind: 'terminal' }, { id: 'b', kind: 'terminal' }, { id: 'c', kind: 'capture' }, { id: 'd', kind: 'notepad' }, { id: 'i', kind: 'tool', toolKind: 'incidents' }];
  const ids = model => [...model.slots().map(s => s.id).filter(Boolean)];
  const unique = model => assert.equal(new Set(ids(model)).size, ids(model).length);

  await test('workspace model normalizes unknown layouts and uses canonical existing tab identities', () => {
    const model = new Model(); model.set('__proto__', tabs, 'a'); assert.equal(model.layout, 'classic'); assert.equal(model.primaryId, 'a');
    assert.equal(model.activate('missing', tabs), false); assert.equal(model.primaryId, 'a');
  });
  await test('workspace companion focus preserves the main pane and pinning swaps existing assignments', () => {
    const model = new Model(); model.set('workbench', tabs, 'a'); model.pin('companion', 'b', tabs);
    model.activate('b', tabs); assert.equal(model.primaryId, 'a'); assert.equal(model.companionId, 'b');
    model.pin('companion', 'a', tabs); assert.equal(model.primaryId, 'b'); assert.equal(model.companionId, 'a'); unique(model);
    model.activate('c', tabs); assert.equal(model.primaryId, 'c'); assert.equal(model.companionId, 'a');
  });
  await test('workspace incident dossier accepts only an existing incident and focus never swaps tool identity', () => {
    const model = new Model(); model.set('incident-desk', tabs, 'c');
    assert.throws(() => model.pin('dossier', 'a', tabs), /Incident Workspace/); assert.equal(model.primaryId, 'c');
    model.pin('dossier', 'i', tabs); model.activate('i', tabs);
    assert.equal(model.primaryId, 'c'); assert.equal(model.dossierId, 'i'); unique(model);
  });
  await test('workspace wall selection replaces only the focused pane while preserving other tabs', () => {
    const model = new Model(); model.set('operations-wall', tabs, 'a');
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) model.pin('wall-' + i, id, tabs);
    model.activate('c', tabs); assert.equal(model.wallFocus, 2); assert.equal(ids(model).join(','), 'a,b,c,d');
    model.activate('i', tabs); assert.equal(ids(model).join(','), 'a,b,i,d'); assert.equal(tabs.length, 5);
  });
  await test('workspace wall count changes preserve hidden assignments without duplicating an active tab', () => {
    const model = new Model(); model.set('operations-wall', tabs, 'a');
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) model.pin('wall-' + i, id, tabs);
    model.activate('d', tabs); model.wallCount = 1; model.activate('d', tabs);
    assert.equal(ids(model).join(','), 'd'); model.wallCount = 4; unique(model);
    assert.equal(new Set(model.wallIds).size, 4); assert.ok(model.wallIds.includes('a'));
  });
  await test('workspace expansion follows explicit focus and closed identities are cleared from all stored layouts', () => {
    const model = new Model(); model.set('operations-wall', tabs, 'a'); model.pin('wall-1', 'b', tabs);
    model.expandedSlot = 'wall-0'; model.activate('b', tabs); assert.equal(model.expandedSlot, 'wall-1');
    model.companionId = 'b'; model.remove('b'); model.prune(tabs.filter(t => t.id !== 'b'));
    assert.equal(model.companionId, null); assert.equal(model.expandedSlot, null); assert.equal(model.wallIds.includes('b'), false);
  });
  await test('workspace mode changes never render one existing tab in two panes', () => {
    const model = new Model(); model.set('workbench', tabs, 'a'); model.pin('companion', 'b', tabs);
    model.set('classic', tabs, 'b'); model.set('workbench', tabs, 'b'); unique(model);
    model.set('incident-desk', tabs, 'i'); model.pin('dossier', 'i', tabs); unique(model);
    for (const layout of ['classic', 'focus', 'workbench', 'operations-wall', 'incident-desk']) { model.set(layout, tabs, 'b'); unique(model); }
  });
}
module.exports = { runWorkspaceLayoutModelTests };
if (require.main === module) (async () => {
  let passed = 0, failed = 0;
  await runWorkspaceLayoutModelTests(async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name, error); } });
  console.log(`${passed}/${passed + failed} workspace model tests passed`); process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
