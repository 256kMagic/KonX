'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { loadBackend, repo } = require('./change-validation-tests.cjs');
const source = relative => path.join(repo, relative);
async function runChangeValidationUiTests(test) {
  await test('Guided Change Validation real Electron/storage workflow stays passive, retains reviewed evidence, records explicit decisions and exports/reopens', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-change-ui-')); let child, output = '';
    try {
      const env = { ...process.env, KONX_CHANGE_TEST: root }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require(path.join(repo, 'node_modules/electron')), [__filename, '--change-fixture'], { env, cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => { output = (output + data).slice(-131072); });
      const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Change validation fixture timeout\n' + output)); }, 45000);
        child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); resolve(code); }); });
      assert.equal(code, 0, output); assert.match(output, /CHANGE_VALIDATION_UI_PASS/);
      const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'))); assert.ok(result.checks >= 35); assert.equal(result.networkCalls, 0);
      const exported = JSON.parse(fs.readFileSync(path.join(root, 'report.json'))); assert.equal(exported.workflow.phase, 'review'); assert.equal(exported.workflow.evidence[0].report.name, 'Edited reviewed result');
      assert.match(fs.readFileSync(path.join(root, 'report.html'), 'utf8'), /Complete retained report/);
      const evidence = path.join(repo, 'review/phase-0.22/evidence'); fs.mkdirSync(evidence, { recursive: true });
      for (const name of ['validation-900.png', 'validation-1280.png']) { const image = fs.readFileSync(path.join(root, name)); assert.ok(image.length > 1000); fs.writeFileSync(path.join(evidence, name), image); }
    } finally {
      if (child && child.exitCode == null) child.kill(); assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-change-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
async function browserChecks() {
  const { ChangeValidationTab } = await import('./js/change-validation.js'); const { RunbookTab } = await import('./js/runbooks.js');
  const { h } = await import('./js/ui.js'); let checks = 0;
  const ok = (value, message) => { checks++; if (!value) throw new Error(message); }, equal = (actual, expected, message) => ok(JSON.stringify(actual) === JSON.stringify(expected), message + '\n' + JSON.stringify(actual));
  const until = async (fn, label) => { const end = Date.now() + 6000; while (!fn()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const app = { tabs: [], jobs: new Map(), opened: [], statusUpdates: 0, updateStatus() { this.statusUpdates++; }, registerJob() { throw new Error('No job may start in this fixture'); }, openTool(kind, params) {
    this.opened.push({ kind, params }); const tab = kind === 'runbook' ? new RunbookTab(this) : { id: crypto.randomUUID(), toolKind: kind, title: kind, el: h('div', kind) }; this.tabs.push(tab); document.body.append(tab.el); return tab;
  } };
  const seed = await window.api.invoke('fixture:seed');
  const source = { id: 'owned-runbook-result', toolKind: 'runbook', title: 'Synthetic manual runbook', report: seed.report }; app.tabs.push(source);
  const view = new ChangeValidationTab(app); app.tabs.push(view); document.body.append(view.el); await view.ready;
  equal(getComputedStyle(view.el).display, 'none', 'Inactive view stays hidden with production styles'); view.el.classList.add('active');
  equal(getComputedStyle(view.el).display, 'flex', 'Active view displays with production styles');
  const button = key => view.el.querySelector(`[data-change-action="${key}"]`);
  const click = async key => { button(key).click(); await new Promise(resolve => setTimeout(resolve, 0)); await until(() => !view.busy, key); };
  const input = (element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); };
  const select = (element, value) => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); };
  const choose = async label => { await until(() => !!document.querySelector('.modal'), 'modal'); const found = [...document.querySelectorAll('.modal button')].find(b => b.textContent === label); ok(found, 'Modal button ' + label); found.click(); await new Promise(resolve => setTimeout(resolve, 0)); };
  equal(app.opened, [], 'Opening guide does not create tools'); equal((await window.api.invoke('fixture:control', {})).networkCalls, 0, 'Opening guide does not run work');
  input(view.fields.name, 'Synthetic branch validation'); input(view.fields.scope, 'Owned branch fixture'); input(view.fields.expectedOutcome, 'Expected inventory changes are reviewed'); input(view.fields.rollbackPlan, 'Manual reviewed recovery procedure');
  ok(view.isDirty(), 'Plan edit dirty'); ok(view.updateBlockers().length > 0, 'Plan edit blocks updater');
  await window.api.invoke('fixture:control', { failCreate: true }); await click('save-plan'); ok(!view.record, 'Failed save has no fabricated record'); equal(view.fields.scope.value, 'Owned branch fixture', 'Failed save retains scope');
  await click('save-plan'); ok(view.record?.id, 'Plan saved'); const id = view.record.id; equal(view.record.phase, 'plan', 'Save does not advance');
  view.showPage('review'); ok([...view.decisionRows.querySelectorAll('select,textarea')].every(field => field.disabled), 'Review decisions cannot be edited before review'); ok(!view.isDirty(), 'Viewing review creates no unsavable draft'); view.showPage('plan');
  await click('advance'); equal(view.record.phase, 'baseline', 'Explicit first advance');
  select(view.before, seed.beforeId); select(view.after, seed.afterId); await click('save-sources'); await click('load-pairs'); ok(view.pairs.querySelectorAll('select').length > 0, 'Actual snapshot device pairing available');
  await click('compare'); ok(view.record.comparison?.report?.changes.length > 0, 'Actual stored snapshot comparison retained'); equal(view.record.decisions.every(d => d.status === 'unknown'), true, 'Differences do not determine pass/fail');
  await click('advance'); equal(view.record.phase, 'maintenance', 'Explicit maintenance phase'); await click('advance'); equal(view.record.phase, 'maintenance', 'Missing acknowledgment does not advance');
  const statusUpdates = app.statusUpdates; input(view.maintenanceText, 'No hardware touched; maintenance was simulated for this workflow test.'); view.maintenanceCheck.click(); ok(view.updateBlockers().length > 0, 'Unsaved acknowledgment is protected');
  ok(view.isDirty(), 'Acknowledgment belongs to dirty state'); ok(app.statusUpdates >= statusUpdates + 2, 'Both acknowledgment inputs update dirty status'); ok(view.statusSegments().some(s => s.text === 'Unsaved changes'), 'Status reports unsaved acknowledgment'); ok(!button('advance').disabled, 'Acknowledgment can be saved by Advance');
  const cancelClose = view.requestClose(); await choose('Cancel'); equal(await cancelClose, false, 'Cancel close retains maintenance note');
  ok(view.maintenanceText.value.includes('No hardware touched') && view.maintenanceCheck.checked, 'Cancelled close preserves acknowledgment inputs');
  await click('advance'); equal(view.record.phase, 'after', 'Explicit acknowledgment advances'); equal(view.record.maintenance.reason.includes('No hardware touched'), true, 'Acknowledgment retained');
  ok(!view.isDirty() && !view.updateBlockers().length, 'Successful advance leaves no phantom draft');
  await click('refresh-tools'); select(view.evidenceSource, source.id); select(view.evidencePhase, 'after');
  await window.api.invoke('fixture:control', { failAttachment: true }); const attachment = view.attachEvidence();
  await until(() => !!document.querySelector('[aria-label="Reviewed evidence JSON"]'), 'evidence preview');
  const preview = document.querySelector('[aria-label="Reviewed evidence JSON"]'); ok(preview.value.includes('Manual fixture'), 'Preview contains complete existing report');
  const edited = JSON.parse(preview.value); edited.name = 'Edited reviewed result'; preview.value = JSON.stringify(edited, null, 2);
  await choose('Attach reviewed copy'); await attachment; ok(view.pendingAttachment, 'Failed attachment keeps reviewed draft'); equal(view.record.evidence.length, 0, 'Failed attachment not claimed saved');
  const retry = view.attachEvidence(); await until(() => !!document.querySelector('[aria-label="Reviewed evidence JSON"]'), 'retry preview'); ok(document.querySelector('[aria-label="Reviewed evidence JSON"]').value.includes('Edited reviewed result'), 'Retry keeps reviewed edits');
  await choose('Attach reviewed copy'); await retry; equal(view.record.evidence.length, 1, 'Reviewed evidence retained'); equal(view.record.evidence[0].report.steps[0].status, 'unknown', 'Manual runbook remains unknown'); ok(!view.pendingAttachment, 'Successful attachment clears draft');
  view.runbook.value = 'template:gateway'; await view.openRunbook(); const runbook = app.tabs.at(-1); equal(runbook.selectedKey, 'template:gateway', 'Existing runbook template opens for review'); equal(runbook.jobId, null, 'Opening runbook does not run it');
  await click('advance'); equal(view.record.phase, 'review', 'Explicit review phase');
  const savedComparison = view.record.comparison.id, firstRationale = view.el.querySelector('[aria-label="Rationale for expected"]');
  input(firstRationale, 'Retain this unsaved review rationale.'); view.showPage('after'); ok(button('save-sources').disabled, 'Unchanged snapshot selection cannot reset review'); await view.saveSources();
  equal(view.decisions[0].rationale, 'Retain this unsaved review rationale.', 'No-op source save preserves draft'); equal(view.record.comparison.id, savedComparison, 'No-op source save preserves comparison');
  select(view.after, ''); const changeSources = view.saveSources(); await choose('Cancel'); await changeSources;
  equal(view.decisions[0].rationale, 'Retain this unsaved review rationale.', 'Cancelling changed source reset preserves review draft'); equal(view.record.comparison.id, savedComparison, 'Cancelling changed source reset preserves saved comparison');
  select(view.after, seed.afterId); input(firstRationale, 'Not reviewed.'); view.showPage('review'); ok(!view.isDirty(), 'Restoring draft inputs returns to clean baseline');
  for (const check of view.plan.checks) {
    const status = view.el.querySelector(`[aria-label="Decision for ${check.id}"]`), rationale = view.el.querySelector(`[aria-label="Rationale for ${check.id}"]`);
    ok(rationale.value === 'Not reviewed.', 'Unknown initial rationale visible');
    select(status, check.id === 'expected' ? 'pass' : 'unknown'); input(rationale, check.id === 'expected' ? 'User reviewed the synthetic intended change.' : 'No service health conclusion from these observations.');
    const refs = view.el.querySelector(`[aria-label="Evidence for ${check.id}"]`); refs.options[0].selected = true; refs.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await click('save-decisions'); equal(view.record.decisions.find(d => d.checkId === 'expected').status, 'pass', 'Explicit pass retained'); ok(view.reviewSummary.textContent.includes('Unknown'), 'Overall remains unknown with unresolved user checks');
  for (const width of [900, 1280]) {
    await window.api.invoke('fixture:capture', width); equal(window.innerWidth, width, 'Screenshot viewport width');
    ok(view.el.scrollWidth <= view.el.clientWidth + 1, 'No outer horizontal overflow at ' + width);
    const header = view.el.querySelector('.tool-head').getBoundingClientRect(), body = view.el.querySelector('.change-body').getBoundingClientRect();
    ok(body.top >= header.bottom - 1 && body.height > 150, 'Review content remains accessible below header at ' + width);
  }
  const cancelExport = view.export('json'); await choose('Cancel'); await cancelExport; equal((await window.api.invoke('fixture:control', {})).exportCalls, 0, 'Report preview cancel prevents export IPC');
  const exportCancel = view.export('json'); await choose('Choose export file'); await exportCancel; ok(view.status.textContent.includes('cancelled'), 'Native file cancellation visible');
  const exportJson = view.export('json'); await choose('Choose export file'); await exportJson; ok(view.status.textContent.includes('exported'), 'JSON export confirmed');
  const exportHtml = view.export('html'); await choose('Choose export file'); await exportHtml;
  view.incident.value = seed.incidentId; const attachIncident = view.addToIncident(); await choose('Add reviewed report'); await attachIncident;
  equal((await window.api.invoke('fixture:control', {})).incidentEvidence, 1, 'Complete report copied to real incident store');
  const reopened = new ChangeValidationTab(app, { validationId: id }); app.tabs.push(reopened); document.body.append(reopened.el); await reopened.ready;
  equal(reopened.record.phase, 'review', 'Restart/reopen phase preserved'); equal(reopened.record.decisions, view.record.decisions, 'Saved decisions preserved'); equal(reopened.record.evidence, view.record.evidence, 'Retained evidence preserved');
  equal(reopened.record.maintenance, view.record.maintenance, 'Saved acknowledgment preserved on reopen'); ok(!reopened.isDirty() && !reopened.updateBlockers().length, 'Reopened workflow has no phantom unsaved acknowledgment'); equal(getComputedStyle(reopened.el).display, 'none', 'Other inactive workflow stays hidden');
  equal((await window.api.invoke('fixture:control', {})).networkCalls, 0, 'All phases and exports remained passive');
  const ai = JSON.stringify(reopened.aiContext); ok(!ai.includes(seed.beforeId) && !ai.includes('Owned branch') && !ai.includes('Edited reviewed'), 'AI summary excludes source content/IDs');
  await window.api.invoke('fixture:control', { removeAfter: true }); await view.refresh(); equal(view.after.value, seed.afterId, 'Missing source identity retained in selector'); ok(view.after.selectedOptions[0].textContent.includes('Unavailable'), 'Missing source shown');
  await view.compare(); equal(view.record.comparison.status, 'unavailable', 'Missing snapshot comparison remains unknown'); equal(view.record.decisions.every(d => !d.reviewedAt), true, 'New unknown comparison invalidates old assessment');
  input(view.fields.scope, 'Unsaved scope'); const pendingClose = view.requestClose(); await until(() => !!document.querySelector('.modal'), 'close dialog'); equal(await view.requestClose(), false, 'Owned modal blocks second close'); view.dispose(); equal(await pendingClose, false, 'Dispose cancels owned modal'); ok(!document.querySelector('.modal'), 'No orphaned modal');
  const late = new ChangeValidationTab(app); document.body.append(late.el); await late.ready; await window.api.invoke('fixture:control', { delayGet: true }); const pending = late.select(id); await new Promise(resolve => setTimeout(resolve, 0)); late.dispose(); await pending; equal(late.record, null, 'Disposed view ignores late record');
  return { checks, networkCalls: (await window.api.invoke('fixture:control', {})).networkCalls };
}
async function fixture() {
  const { app, BrowserWindow, ipcMain } = require('electron'); const root = path.resolve(process.env.KONX_CHANGE_TEST);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-change-ui-')); app.setPath('userData', path.join(root, 'electron-profile'));
  const { ChangeValidationStore } = loadBackend(), { SnapshotStore } = require(path.join(repo, 'src/main/device-snapshots')), { IncidentStore } = require(path.join(repo, 'src/main/incidents'));
  const runbooks = require(path.join(repo, 'src/main/runbooks')), snapshots = new SnapshotStore(path.join(root, 'profile')), incidents = new IncidentStore(path.join(root, 'profile'));
  const store = new ChangeValidationStore(path.join(root, 'profile'), { snapshots, incidents }), demo = require(path.join(repo, 'assets/device-snapshot-demo.json'));
  const before = await snapshots.save({ label: 'Before fixture', report: demo.before }), after = await snapshots.save({ label: 'After fixture', report: demo.after }), incident = await incidents.create({ title: 'Owned fixture incident' });
  const report = await runbooks.run({ definition: { schemaVersion: 1, name: 'Manual fixture', inputs: [], steps: [{ id: 'review', title: 'Review supplied evidence', kind: 'checklist', instructions: 'Manual only.' }] }, inputs: {} }, () => {}, { stopped: false }, null);
  let failCreate = false, failAttachment = false, delayGet = false, exportCalls = 0, networkCalls = 0, win;
  const { registerChangeValidation } = require(source('src/main/change-validation-ipc.js'));
  const handlers = new Map(); registerChangeValidation((channel, fn) => handlers.set(channel, fn), { changes: store, isClosing: () => false, dialogOwner: () => null,
    dialog: { async showSaveDialog(_owner, options) { exportCalls++; return exportCalls === 1 ? { canceled: true } : { canceled: false, filePath: path.join(root, 'report.' + options.filters[0].extensions[0]) }; } } });
  ipcMain.handle('change-fixture', async (_event, channel, ...args) => {
    if (handlers.has(channel)) {
      if (channel === 'tools:changeCreate' && failCreate) { failCreate = false; throw Error('Synthetic storage failure'); }
      if (channel === 'tools:changeAddEvidence' && failAttachment) { failAttachment = false; throw Error('Synthetic evidence save failure'); }
      if (channel === 'tools:changeGet' && delayGet) { delayGet = false; await new Promise(resolve => setTimeout(resolve, 80)); }
      return handlers.get(channel)(...args);
    }
    switch (channel) {
      case 'fixture:seed': return { beforeId: before.id, afterId: after.id, incidentId: incident.id, report };
      case 'fixture:capture': {
        const width = args[0]; assert.ok([900, 1280].includes(width)); win.setContentSize(width, 900);
        await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        fs.writeFileSync(path.join(root, 'validation-' + width + '.png'), (await win.webContents.capturePage()).toPNG()); return true;
      }
      case 'fixture:control': { const options = args[0]; if ('failCreate' in options) failCreate = options.failCreate; if ('failAttachment' in options) failAttachment = options.failAttachment; if ('delayGet' in options) delayGet = options.delayGet; if (options.removeAfter) await snapshots.remove(after.id); return { exportCalls, networkCalls, incidentEvidence: (await incidents.get(incident.id)).evidence.length }; }
      case 'tools:snapshotList': return snapshots.list();
      case 'tools:snapshotGet': return snapshots.get(...args);
      case 'tools:incidentList': return incidents.list();
      case 'tools:runbookTemplates': return runbooks.getTemplates();
      case 'tools:runbookList': return { runbooks: [], issues: [] };
      case 'tools:deviceConnections': return [];
      default: networkCalls++; throw Error('Unexpected operation: ' + channel);
    }
  });
  const js = path.join(root, 'js'); fs.mkdirSync(js); for (const file of ['change-validation.js', 'runbooks.js', 'ui.js', 'copilot-context.mjs', 'copilot-investigations.mjs']) fs.copyFileSync(source('src/renderer/js/' + file), path.join(js, file));
  fs.copyFileSync(path.join(repo, 'src/renderer/styles.css'), path.join(root, 'styles.css'));
  fs.writeFileSync(path.join(root, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{invoke:(...args)=>ipcRenderer.invoke('change-fixture',...args)});`);
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="styles.css">');
  await app.whenReady(); win = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  try { await win.loadFile(path.join(root, 'index.html')); const result = await win.webContents.executeJavaScript('(' + browserChecks.toString() + ')()'); fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result)); await store.close(); console.log('CHANGE_VALIDATION_UI_PASS ' + result.checks); win.destroy(); app.exit(0); }
  catch (error) { console.error(error.stack || error); await store.close().catch(() => {}); win.destroy(); app.exit(1); }
}
module.exports = { runChangeValidationUiTests };
if (process.versions.electron && process.argv.includes('--change-fixture')) fixture().catch(error => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runChangeValidationUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
