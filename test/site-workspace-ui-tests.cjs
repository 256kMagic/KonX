'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const source = relative => path.join(repo, relative);

async function runSiteWorkspaceUiTests(test) {
  await test('Saved site workspace real Electron editor/store/layout preserves references, never auto-connects, and retains failed or cancelled drafts', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-site-ui-'));
    let child, output = '';
    try {
      const env = { ...process.env, KONX_SITE_TEST: root }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require(path.join(repo, 'node_modules/electron')), [__filename, '--site-fixture'], { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => { output = (output + data).slice(-131072); });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Site fixture timed out\n' + output)); }, 45000);
        child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); resolve(code); });
      });
      const failurePath = path.join(root, 'failure.json');
      const failure = fs.existsSync(failurePath) ? JSON.parse(fs.readFileSync(failurePath, 'utf8')) : null;
      assert.equal(code, 0, `Site fixture exited ${code}: ${failure?.error || 'no renderer failure report'}\n${output}`); assert.match(output, /SITE_WORKSPACE_UI_PASS/);
      const report = JSON.parse(fs.readFileSync(path.join(root, 'result.json')));
      assert.equal(report.passed, true); assert.ok(report.checks >= 45, JSON.stringify(report));
      const files = fs.readdirSync(path.join(root, 'profile/site-workspaces')).filter(file => file.endsWith('.json'));
      assert.ok(files.length >= 2);
      for (const file of files) {
        const text = fs.readFileSync(path.join(root, 'profile/site-workspaces', file), 'utf8');
        for (const secret of ['NEVER_PERSIST_PASSWORD', 'NEVER_PERSIST_HOST', 'NEVER_PERSIST_COMMAND']) assert.ok(!text.includes(secret), secret);
      }
    } catch (error) {
      // Preserve owned synthetic evidence before deleting the isolated profile.
      const evidence = path.join(repo, 'review', 'site-workspace-ui-failures', path.basename(root));
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'child-output.log'), output);
      fs.writeFileSync(path.join(evidence, 'parent-error.log'), String(error?.stack || error));
      for (const file of ['result.json', 'failure.json', 'failure.png']) {
        if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(evidence, file));
      }
      error.message += '\nFailure evidence: ' + evidence;
      throw error;
    } finally {
      if (child && child.exitCode == null) child.kill();
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-site-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function browserChecks() {
  const { SiteWorkspacesTab, captureSiteLayout, restoreSiteLayout } = await import('./js/site-workspaces.js');
  const { WorkspaceLayout } = await import('./js/workspace-layout.js');
  const { h } = await import('./js/ui.js');
  let checks = 0;
  const ok = (value, message) => { checks++; window.__siteCheck = { checks, message }; if (!value) throw new Error(message); };
  const equal = (a, b, message) => ok(JSON.stringify(a) === JSON.stringify(b), message + '\n' + JSON.stringify(a) + ' != ' + JSON.stringify(b));
  const until = async (predicate, label) => { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const app = { tabs: [], byId: new Map(), jobs: new Map(), active: null, settings: { uiLayout: 'classic' }, sessions: { data: { sessions: [] }, async load() { this.data = await window.api.invoke('sessions:list'); } }, calls: { connect: [], tools: [], sftp: [], disconnect: 0 },
    root: document.querySelector('#app'), main: document.querySelector('main'), toolbar: document.querySelector('nav'), themeHeader: document.querySelector('#theme'), tabstrip: document.querySelector('#tabs'), views: document.querySelector('#views'),
    popouts: { focus() {}, disposeTab() {}, async dock(tab) { app.workspaceLayout.releaseExternal(tab); } },
    scheduleTabLayout() {}, updateStatus() {}, renderTabs() {}, toggleSidebar() {},
    async saveSettings(patch) { this.settings = await window.api.invoke('settings:set', patch); this.workspaceLayout.set(this.settings.uiLayout); },
    addTab(tab) { this.tabs.push(tab); this.byId.set(tab.id, tab); this.workspaceLayout.mount(tab); this.activate(tab); return tab; },
    activate(tab) { if (!this.tabs.includes(tab)) return; this.active = tab; this.workspaceLayout.activate(tab); },
    async closeTab(tab) { if (tab.requestClose && !await tab.requestClose()) return; this.workspaceLayout.detach(tab); this.tabs = this.tabs.filter(t => t !== tab); this.byId.delete(tab.id); tab.el.remove(); tab.dispose?.(); if (this.active === tab) this.active = null; },
    connectSession(session) { this.calls.connect.push(session.id); return this.addTab(dummy('terminal', { spec: { sessionId: session.id }, state: 'connected' })); },
    openSftp(spec) { this.calls.sftp.push(spec); return this.addTab(dummy('sftp', { spec, state: 'connected' })); },
    openTool(kind, params) { this.calls.tools.push({ kind, params }); return this.addTab(dummy('tool', { toolKind: kind, async loadBytes(bytes, name) { this.bytes = bytes; this.fileName = name; } })); }
  };
  const dummy = (kind, extra = {}) => ({ id: crypto.randomUUID(), kind, title: 'Owned ' + kind, icon: 'file', el: h('div.view', 'Synthetic retained view'), state: 'idle', show() {}, hide() {}, dispose() { this.disposed = true; }, ...extra });
  app.workspaceLayout = new WorkspaceLayout(app);
  const live = app.addTab(dummy('terminal', { state: 'connected', spec: { protocol: 'ssh', host: 'NEVER_PERSIST_HOST', password: 'NEVER_PERSIST_PASSWORD', logonActions: ['NEVER_PERSIST_COMMAND'] }, dispose() { app.calls.disconnect++; } }));
  const view = app.addTab(new SiteWorkspacesTab(app)); await view.ready;
  const button = action => view.el.querySelector(`[data-site-action="${action}"]`);
  const click = async action => { button(action).click(); await new Promise(resolve => setTimeout(resolve, 0)); await until(() => !view.busy, action); };
  const input = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const modalChoice = async label => { await until(() => !!document.querySelector('.modal'), 'confirmation'); const choice = [...document.querySelectorAll('.modal button')].find(b => b.textContent === label); ok(choice, 'Confirmation choice ' + label); choice.click(); await new Promise(resolve => setTimeout(resolve, 0)); };
  equal(app.calls.connect, [], 'Constructor must not connect'); equal(app.calls.tools, [], 'Constructor must not create tools');
  input(view.name, 'Branch office'); input(view.description, 'Synthetic site definition'); input(view.notes, 'Review uplinks before maintenance.');
  view.sessionSelect.value = 'saved-ssh'; input(view.group, 'Network'); await click('add-session');
  view.sessionSelect.value = 'saved-sftp'; await click('add-session');
  view.incidentSelect.value = '11111111-1111-4111-8111-111111111111'; await click('add-incident'); await click('add-capture');
  equal(view.draft.sessions.map(s => s.id), ['saved-ssh', 'saved-sftp'], 'References selected'); equal(view.draft.sessions[0].group, 'Network', 'Group retained');
  ok(view.isDirty(), 'Editing marks dirty'); ok(view.updateBlockers().length > 0, 'Draft blocks updater');
  const close = view.requestClose(); await modalChoice('Cancel'); equal(await close, false, 'Cancelled close keeps draft');
  await window.api.invoke('fixture:control', { failSave: true }); await click('save');
  ok(view.isDirty(), 'Failed save keeps draft'); equal(view.notes.value, 'Review uplinks before maintenance.', 'Failed save keeps notes'); ok(view.status.getAttribute('role') === 'alert', 'Failed save is visible');
  await click('save'); ok(view.saved?.id, 'Save creates identity'); equal(view.saved.revision, 1, 'Initial revision'); equal(view.updateBlockers(), [], 'Saved definition releases updater');
  const firstId = view.saved.id; equal(app.calls.connect.length, 0, 'Save does not connect');
  await click('open');
  equal(app.calls.connect.length, 0, 'Open does not connect'); equal(app.calls.sftp.length, 0, 'Open does not SFTP');
  equal((await window.api.invoke('fixture:control', {})).captureReads, 0, 'Open does not read capture');
  ok(app.tabs.includes(live), 'Open keeps existing live tab'); equal(app.calls.disconnect, 0, 'Open does not disconnect');
  const owned = app.tabs.filter(t => t.siteWorkspace?.workspaceId === firstId); equal(owned.length, 5, 'All saved references/notes get panels');
  const before = app.tabs.length; app.activate(view); await click('open'); equal(app.tabs.length, before, 'Opening again reuses owned panels');
  const ssh = owned.find(t => t.siteWorkspace.panel.referenceId === 'saved-ssh');
  ssh.el.querySelector('button').click(); await until(() => !app.tabs.includes(ssh), 'Connect replaces inert placeholder'); equal(app.calls.connect, ['saved-ssh'], 'Explicit Connect targets saved ID');
  const sftp = owned.find(t => t.siteWorkspace.panel.referenceId === 'saved-sftp'); sftp.el.querySelector('button').click(); await until(() => !app.tabs.includes(sftp), 'SFTP placeholder replaces'); equal(app.calls.sftp, [{ sessionId: 'saved-sftp' }], 'SFTP explicit saved ID');
  const cap = owned.find(t => t.siteWorkspace.panel.kind === 'capture'); cap.el.querySelector('button').click(); await until(() => !app.tabs.includes(cap), 'Capture opened explicitly');
  equal((await window.api.invoke('fixture:control', {})).captureReads, 1, 'Only click reads capture');
  equal(app.calls.tools[0].kind, 'capture', 'Click opens capture tool'); ok(app.tabs.some(t => t.fileName === 'owned.pcap'), 'Capture bytes loaded');
  app.activate(view); const retained = app.tabs.find(t => t.siteWorkspace?.workspaceId === firstId && t.kind === 'terminal');
  app.workspaceLayout.set('workbench'); app.workspaceLayout.pin('primary', retained.id);
  const notes = owned.find(t => t.siteWorkspace.panel.kind === 'notes'); app.workspaceLayout.float(notes, { x: 70, y: 80, width: 410, height: 300 });
  app.workspaceLayout.geometry.ratios.workbench.columns = 0.61;
  await click('capture-layout'); ok(view.draft.layout.panels.some(p => p.kind === 'session' && p.slot === 'primary'), 'Capture maps runtime tab to saved reference');
  ok(view.status.textContent.includes('unsaved'), 'Unsaved connection omission visible');
  equal(view.draft.layout.geometry.ratios.workbench.columns, 0.61, 'Split size saved');
  const float = view.draft.layout.panels.find(p => p.kind === 'notes'); ok(float.placement === 'floating' && float.bounds.width > 0 && float.bounds.width < 1, 'Floating bounds normalized');
  const serialized = JSON.stringify(view.draft); ok(!serialized.includes('NEVER_PERSIST'), 'No inline connection content in captured draft');
  await click('save'); equal(view.saved.revision, 2, 'Edits preserve revision guard');
  const savedGeometry = await window.api.invoke('tools:siteGet', firstId);
  app.workspaceLayout.set('classic'); app.workspaceLayout.geometry.ratios.workbench.columns = 0.3;
  await restoreSiteLayout(app, savedGeometry, view.toolKinds);
  equal(app.workspaceLayout.get().layout, 'workbench', 'Saved preset restores from disk');
  equal(app.workspaceLayout.geometry.ratios.workbench.columns, 0.61, 'Saved split geometry restores from disk');
  const restoredNotes = app.workspaceLayout.floating.get(notes);
  ok(restoredNotes && Math.abs(restoredNotes.bounds.width - 410) < 1 && Math.abs(restoredNotes.bounds.x - 70) < 1, 'Saved floating geometry restores from disk');
  ok(!JSON.stringify(view.aiContext).includes('Review uplinks') && !JSON.stringify(view.aiContext).includes('saved-ssh'), 'AI summary excludes notes and identifiers');
  const exportPromise = view.export(); await modalChoice('Cancel'); await exportPromise; equal((await window.api.invoke('fixture:control', {})).exports, 0, 'Export requires review');
  const export2 = view.export(); await modalChoice('Choose export file'); await export2; equal((await window.api.invoke('fixture:control', {})).exports, 1, 'Reviewed export occurs once');
  const counts = JSON.stringify(app.calls); await click('duplicate'); ok(view.saved.id !== firstId, 'Duplicate new identity'); equal(JSON.stringify(app.calls), counts, 'Duplicate is passive');
  const duplicateId = view.saved.id;
  await click('import'); ok(view.saved.id !== duplicateId && view.saved.id !== firstId, 'Import new identity'); equal(JSON.stringify(app.calls), counts, 'Import is passive');
  const importedId = view.saved.id;
  await window.api.invoke('fixture:control', { missingSession: true }); await click('refresh');
  const missing = view.el.querySelector('[data-site-connect="saved-ssh"]'); ok(missing.disabled, 'Missing session Connect disabled'); ok(view.sessionRows.textContent.includes('Missing saved session'), 'Missing session visible');
  view.el.querySelector('[data-session-reference="saved-ssh"] button:last-child').click(); equal(view.draft.sessions.some(s => s.id === 'saved-ssh'), false, 'Missing ref can be removed');
  view.sessionSelect.value = 'replacement'; await click('add-session'); ok(view.draft.sessions.some(s => s.id === 'replacement'), 'Replacement uses chosen saved ID');
  await click('save');
  const remove = view.remove(); await modalChoice('Delete workspace'); await remove; ok(!view.workspaces.some(w => w.id === importedId), 'Delete removes definition');
  ok(app.tabs.includes(live), 'Delete keeps live tabs'); equal(app.calls.disconnect, 0, 'No disconnect throughout CRUD');
  await view.select(firstId); input(view.notes, 'UNSAVED_NOTES_RETAIN');
  const importCancelled = view.import(); await modalChoice('Discard changes'); await importCancelled;
  // The fixture's second import is cancelled; accepting a discard prompt must not erase the draft until replacement succeeds.
  equal(view.notes.value, 'UNSAVED_NOTES_RETAIN', 'Cancelled file chooser retains draft'); ok(view.isDirty(), 'Cancelled import remains dirty');
  const snapshot = captureSiteLayout(app, { ...view.draft, id: firstId }, view.toolKinds); ok(snapshot.omissions.length > 0, 'Capture reports unsupported data omissions');
  const sourceRecord = await window.api.invoke('tools:siteGet', firstId);
  const passive = structuredClone(sourceRecord); passive.id = '99999999-9999-4999-8999-999999999999'; passive.layout.panels = [{ key: 'passive-security', kind: 'tool', toolKind: 'security', placement: 'docked', slot: 'primary' }]; passive.layout.activePanelKey = 'passive-security';
  await restoreSiteLayout(app, passive, view.toolKinds); equal(app.calls.tools.at(-1), { kind: 'security', params: {} }, 'Tools restore with empty params');
  equal(app.calls.connect, ['saved-ssh'], 'No implicit later reconnect'); equal(app.calls.disconnect, 0, 'Restore preserves existing connection');
  const sftpWorkspace = structuredClone(sourceRecord); sftpWorkspace.id = '88888888-8888-4888-8888-888888888888';
  sftpWorkspace.layout.panels = [{ key: 'ssh-sftp', kind: 'session', referenceId: 'saved-ssh', sessionMode: 'sftp', placement: 'docked', slot: 'primary' }]; sftpWorkspace.layout.activePanelKey = 'ssh-sftp';
  await restoreSiteLayout(app, sftpWorkspace, view.toolKinds);
  const missingPanel = app.tabs.find(t => t.siteWorkspace?.workspaceId === sftpWorkspace.id);
  ok(missingPanel.button.disabled, 'Restored missing reference disabled');
  await window.api.invoke('fixture:control', { missingSession: false }); await app.sessions.load();
  await restoreSiteLayout(app, sftpWorkspace, view.toolKinds);
  ok(!missingPanel.button.disabled && missingPanel.status.textContent.includes('Disconnected'), 'Reused missing reference refreshes availability');
  missingPanel.button.click(); await until(() => !app.tabs.includes(missingPanel), 'SSH-backed SFTP explicit connect');
  equal(app.calls.sftp.at(-1), { sessionId: 'saved-ssh' }, 'SFTP mode survives saved SSH reference'); equal(app.calls.connect.length, 1, 'SFTP mode does not open terminal');
  app.addTab(dummy('sftp', { spec: { sessionId: 'saved-ssh', password: 'NEVER_PERSIST_PASSWORD' } }));
  const modeSnapshot = captureSiteLayout(app, sourceRecord, view.toolKinds);
  ok(modeSnapshot.layout.panels.some(p => p.referenceId === 'saved-ssh' && p.sessionMode === 'sftp'), 'Capturing SSH-backed SFTP preserves view mode');
  // A closed view may finish backend I/O, but must not adopt a late result or open panels.
  const late = app.addTab(new SiteWorkspacesTab(app)); await late.ready;
  input(late.name, 'Late save'); await window.api.invoke('fixture:control', { delaySave: true }); const pending = late.save(); late.dispose(); await pending;
  equal(late.saved, null, 'Disposed editor ignores late save result'); equal(app.calls.connect.length, 1, 'Late completion never connects');
  const prompting = app.addTab(new SiteWorkspacesTab(app)); await prompting.ready; input(prompting.name, 'Unsaved dialog');
  const pendingClose = prompting.requestClose(); await until(() => !!document.querySelector('.modal'), 'owned discard modal');
  ok(prompting.updateBlockers().length > 0, 'Pending confirmation blocks update'); equal(await prompting.requestClose(), false, 'Pending confirmation blocks a second close');
  prompting.dispose(); equal(await pendingClose, false, 'Disposal cancels confirmation'); ok(!document.querySelector('.modal'), 'Disposal closes owned modal');
  return { passed: true, checks };
}

async function fixture() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const root = path.resolve(process.env.KONX_SITE_TEST);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-site-ui-'));
  app.setPath('userData', path.join(root, 'electron-profile'));
  const { SiteWorkspaceStore } = require(source('src/main/site-workspaces.js'));
  const store = new SiteWorkspaceStore(path.join(root, 'profile'));
  const capturePath = path.join(root, 'owned.pcap'); fs.writeFileSync(capturePath, 'SYNTHETIC_CAPTURE');
  const js = path.join(root, 'js'); fs.mkdirSync(js);
  for (const file of ['ui.js', 'workspace-layout.js', 'workspace-layouts.mjs', 'workspace-panels-model.mjs', 'site-workspaces.js', 'connection-session-model.mjs', 'copilot-context.mjs', 'copilot-investigations.mjs']) fs.copyFileSync(source('src/renderer/js/' + file), path.join(js, file));
  fs.writeFileSync(path.join(root, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{invoke:(...args)=>ipcRenderer.invoke('site-fixture',...args)});`);
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><meta charset="UTF-8"><style>body{margin:0}#views{width:1200px;height:700px;position:relative}.hidden,.workspace-parking{display:none}.view{background:white}.workspace-panes{display:grid}.workspace-float{position:absolute}</style><div id="app"><nav><span id="theme"></span></nav><main><div id="tabs"></div><div id="views"></div></main></div>');
  let settings = { uiLayout: 'classic' }, missingSession = false, failSave = false, delaySave = false, imports = 0, exports = 0, captureReads = 0;
  const exportPath = path.join(root, 'export.json');
  ipcMain.handle('site-fixture', async (_event, channel, ...args) => {
    switch (channel) {
      case 'fixture:control': {
        const value = args[0]; if ('failSave' in value) failSave = value.failSave; if ('delaySave' in value) delaySave = value.delaySave; if ('missingSession' in value) missingSession = value.missingSession;
        return { exports, captureReads };
      }
      case 'settings:set': settings = { ...settings, ...args[0] }; return settings;
      case 'sessions:list': return { folders: [], sessions: [{ id: missingSession ? 'replacement' : 'saved-ssh', name: 'Router', protocol: 'ssh', password: 'NEVER_PERSIST_PASSWORD', host: 'NEVER_PERSIST_HOST' }, { id: 'saved-sftp', name: 'Files', protocol: 'sftp' }] };
      case 'tools:incidentList': return { incidents: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Synthetic incident' }], issues: [] };
      case 'tools:siteList': return store.list();
      case 'tools:siteGet': return store.get(...args);
      case 'tools:siteSave': if (failSave) { failSave = false; throw new Error('Synthetic disk failure'); } if (delaySave) { delaySave = false; await new Promise(resolve => setTimeout(resolve, 80)); } return store.save(...args);
      case 'tools:siteDuplicate': return store.duplicate(...args);
      case 'tools:siteRemove': return store.remove(...args);
      case 'tools:sitePickCapture': return { id: '22222222-2222-4222-8222-222222222222', name: 'owned.pcap', path: capturePath };
      case 'tools:siteReadCapture': { const record = await store.get(args[0]); const reference = record.captures.find(c => c.id === args[1]); assert.ok(reference); captureReads++; return { name: reference.name, bytes: fs.readFileSync(reference.path) }; }
      case 'tools:siteExport': exports++; await store.exportFile(args[0], exportPath); return exportPath;
      case 'tools:siteImport': imports++; return imports === 1 ? store.importFile(exportPath) : null;
      default: throw new Error('Unexpected fixture IPC: ' + channel);
    }
  });
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  try { await win.loadFile(path.join(root, 'index.html')); const result = await win.webContents.executeJavaScript('(' + browserChecks.toString() + ')()'); fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result)); console.log('SITE_WORKSPACE_UI_PASS ' + result.checks); win.destroy(); app.exit(0); }
  catch (error) {
    const report = { error: String(error?.stack || error), diagnostics: null };
    try { report.diagnostics = await win.webContents.executeJavaScript(`({check:window.__siteCheck || null,alerts:[...document.querySelectorAll('[role="alert"]')].map(el=>el.textContent),modals:[...document.querySelectorAll('.modal')].map(el=>el.textContent)})`); } catch (diagnosticError) { report.diagnostics = { error: String(diagnosticError) }; }
    fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify(report, null, 2));
    try { fs.writeFileSync(path.join(root, 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch {}
    console.error(error.stack || error); win.destroy(); app.exit(1);
  }
}
module.exports = { runSiteWorkspaceUiTests };
if (process.versions.electron && process.argv.includes('--site-fixture')) fixture().catch(error => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runSiteWorkspaceUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
