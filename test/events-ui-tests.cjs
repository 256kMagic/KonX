'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const own = relative => path.resolve(__dirname, '..', relative);

async function runEventsUiTests(test) {
  await test('Live Events real Electron IPC/UDP workflow is passive until Start, bounded, readable, exportable and cleanup-owned', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-events-ui-')); let child, output = '';
    try {
      const env = { ...process.env, KONX_EVENTS_TEST: root }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require(path.join(repo, 'node_modules/electron')), [__filename, '--events-fixture'], { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => { output = (output + data).slice(-131072); });
      const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Events UI timed out\n' + output)); }, 45000);
        child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); resolve(code); }); });
      assert.equal(code, 0, output); assert.match(output, /EVENTS_UI_PASS/);
      const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'))); assert.equal(result.passed, true); assert.ok(result.checks >= 40);
      const exported = fs.readFileSync(path.join(root, 'export-1.json'), 'utf8'); assert.ok(exported.includes('Literal <img')); assert.ok(!exported.includes('SYNTHETIC_COMMUNITY'));
    } finally { if (child && child.exitCode == null) child.kill(); assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-events-ui-')); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
}

async function browserChecks() {
  const { EventsTab } = await import('./js/events.js');
  let checks = 0;
  const ok = (value, message) => { checks++; if (!value) throw new Error(message); };
  const equal = (a, b, message) => ok(JSON.stringify(a) === JSON.stringify(b), message + ': ' + JSON.stringify(a) + ' != ' + JSON.stringify(b));
  const until = async (fn, label) => { const deadline = Date.now() + 4000; while (!fn()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const action = (view, name) => view.el.querySelector(`[data-events-action="${name}"]`);
  const input = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const app = { tabs: [], jobs: new Map(), calls: { connect: [], edit: [], activated: [], opened: [] },
    registerJob(id, tab) { this.jobs.set(id, tab); }, unregisterJob(id) { this.jobs.delete(id); }, tabStateChanged() {}, updateStatus() {},
    activate(tab) { this.calls.activated.push(tab.id); }, editSession(session) { this.calls.edit.push(session.id); }, connectSession(session) { this.calls.connect.push(session.id); },
    openTool(kind, params) { this.calls.opened.push({ kind, params }); }
  };
  window.api.on('tools:event', (id, type, data) => app.jobs.get(id)?.onJobEvent(type, data));
  const add = async params => { const tab = new EventsTab(app, params); app.tabs.push(tab); tab.el.classList.add('active'); document.querySelector('#app').replaceChildren(tab.el); await tab.ready; return tab; };
  const view = await add(); equal((await window.api.invoke('fixture:control', {})).owners, false, 'Opening never binds'); equal(app.calls.connect, [], 'Opening never connects');
  equal(view.address.value, '127.0.0.1', 'Loopback default'); equal(view.port.value, '5514', 'High-port default');
  view.port.value = 0; await view.start(); ok(view.status.getAttribute('role') === 'alert', 'Invalid port is visible'); equal((await window.api.invoke('fixture:control', {})).starts, 0, 'Invalid port never reaches Start');
  view.port.value = await window.api.invoke('fixture:port'); await view.start(); await until(() => view.summary?.state === 'listening', 'syslog listening');
  ok(view.startButton.disabled && !view.stopButton.disabled, 'Running controls'); ok(view.updateBlockers().length > 0, 'Running listener blocks updater');
  await window.api.invoke('fixture:send', view.listenerId, 'syslog'); await until(() => view.records.length === 3, 'real syslog packets');
  ok(view.el.textContent.includes('Literal <img'), 'Message is readable'); equal(view.el.querySelectorAll('img').length, 0, 'Incoming markup remains text');
  view.rows.querySelector('tr').click(); ok(view.details.textContent.includes('Reported time:'), 'Clickable row renders details'); ok(view.details.textContent.includes('structuredData'), 'Structured fields readable');
  equal(view.prepareButton.disabled, false, 'Exact unique saved host offers prepare'); equal(view.terminalButton.disabled, true, 'No live terminal never auto-opens one');
  await view.prepareSession(); equal(app.calls.edit, ['saved-router'], 'Explicit prepare opens editor'); equal(app.calls.connect, [], 'Prepare never connects');
  const terminal = { id: 'existing-terminal', kind: 'terminal', spec: { sessionId: 'saved-router' }, meta: { host: '127.0.0.1' }, state: 'connected' }; app.tabs.push(terminal); view.renderLink();
  view.openTerminal(); equal(app.calls.activated, ['existing-terminal'], 'Open existing terminal only activates');
  terminal.meta.host = '192.0.2.44'; view.renderLink(); ok(view.terminalButton.disabled, 'Edited session reference cannot select a terminal connected to another host'); terminal.meta.host = '127.0.0.1';
  await window.api.invoke('fixture:control', { duplicateHost: true }); await view.refresh(); view.rows.querySelector('tr').click(); ok(view.prepareButton.disabled, 'Ambiguous saved host disables prepare');
  await window.api.invoke('fixture:control', { duplicateHost: false }); await view.refresh();
  input(view.search, 'Literal'); equal(view.rows.children.length, 1, 'Text filter'); input(view.sourceFilter, '192.0.2.1'); equal(view.rows.children.length, 0, 'Exact source IP filter'); input(view.sourceFilter, '127.0.0.1'); equal(view.rows.children.length, 1, 'Source match');
  view.severityFilter.value = '4'; view.severityFilter.dispatchEvent(new Event('change')); equal(view.rows.children.length, 0, 'Severity filter'); view.severityFilter.value = ''; view.severityFilter.dispatchEvent(new Event('change'));
  view.rows.querySelector('input[type=checkbox]').click(); equal(view.selected.size, 1, 'Explicit event selection'); view.addToIncident();
  const evidence = app.calls.opened.at(-1); equal(evidence.kind, 'incidents', 'Incident opens pending evidence'); equal(JSON.parse(evidence.params.evidence.text).selectedRecords.length, 1, 'Only selection retained');
  const incident = await window.api.invoke('fixture:incident', evidence.params.evidence); equal(incident.evidence.length, 1, 'Production incident store accepts selected report');
  ok(!JSON.stringify(view.aiContext).includes('Literal') && !JSON.stringify(view.aiContext).includes('127.0.0.1'), 'AI context excludes text and source addresses'); await view.explain();
  const ai = app.calls.opened.at(-1); equal(ai.kind, 'ai', 'Summary opens AI preparation'); ok(!ai.params.context.includes('Literal') && !ai.params.context.includes('127.0.0.1'), 'Only counts passed through preview');
  const choose = async label => { await until(() => !!document.querySelector('.modal'), 'export review'); [...document.querySelectorAll('.modal button')].find(button => button.textContent === label).click(); };
  const cancelled = view.export('json'); await choose('Cancel'); await cancelled; equal((await window.api.invoke('fixture:control', {})).exports, 0, 'Cancelled review writes nothing');
  const exported = view.export('json'); await choose('Choose export file'); await exported; equal((await window.api.invoke('fixture:control', {})).exports, 1, 'Approved export writes selected filter');
  const textExport = view.export('text'); await choose('Choose export file'); await textExport; equal((await window.api.invoke('fixture:control', {})).exports, 2, 'Text export exists');
  input(view.search, ''); input(view.sourceFilter, '');
  await window.api.invoke('fixture:control', { clearRace: true }); await view.clear(); await until(() => view.records.some(record => record.message === 'after clear'), 'receive during clear');
  ok(view.records.every(record => record.message === 'after clear'), 'Late clear result preserves post-clear packets'); ok(view.summary.hasOwnership, 'Clear retains listener');
  await window.api.invoke('fixture:send', view.listenerId, 'large'); await new Promise(resolve => setTimeout(resolve, 150)); await view.refresh();
  const large = view.records.filter(record => record.message.length === 8000); equal(large.length, 6, 'Backend refresh recovers bounded display omissions');
  for (const record of large) view.select(record, true);
  ok(view.selected.size < 6, 'Selection refuses excessive incident size'); ok(new TextEncoder().encode(JSON.stringify(view.report, null, 2)).length <= 256 * 1024, 'Generic report is within incident boundary');
  await window.api.invoke('fixture:control', { failClose: true }); equal(await view.requestClose(), false, 'Unconfirmed cleanup keeps tab open'); ok(view.summary.hasOwnership, 'Cleanup owner retained'); ok(view.updateBlockers().length > 0, 'Cleanup blocks updater');
  await window.api.invoke('fixture:control', { failClose: false }); equal(await view.requestClose(), true, 'Retry waits for definitive close'); equal((await window.api.invoke('fixture:control', {})).owners, false, 'Socket closed');
  equal(view.updateBlockers(), [], 'Stopped view releases updater'); const savedId = view.listenerId; view.dispose();
  const reopened = await add({ listenerId: savedId }); ok(reopened.records.length > 0, 'Reopen restores backend history'); equal((await window.api.invoke('fixture:control', {})).owners, false, 'Reopen does not bind');
  const refreshedCopy = await add({ listenerId: savedId }), staleCopy = await add({ listenerId: savedId });
  ok(staleCopy.records.length > 1, 'Concurrent history views contain multiple old records');
  refreshedCopy.select(refreshedCopy.records[0], true); staleCopy.select(staleCopy.records[0], true);
  await reopened.removeHistory(); equal(reopened.records.length, 0, 'Remove stopped history clears retained data'); ok(reopened.listenerId !== savedId, 'New identity after removal');
  await refreshedCopy.refresh(); equal(refreshedCopy.records, [], 'Another view refresh clears a removed history'); equal(refreshedCopy.summary, null, 'Removed history loses its summary');
  equal(refreshedCopy.selected.size, 0, 'Removed history loses selected evidence'); equal(refreshedCopy.detailSequence, null, 'Removed history loses event details');
  ok(refreshedCopy.exportJsonButton.disabled && refreshedCopy.incidentButton.disabled, 'Removed history cannot be exported or attached');
  ok(staleCopy.records.length > 1, 'Unrefreshed view still exercises stale history at Start');
  staleCopy.port.value = await window.api.invoke('fixture:port'); await staleCopy.start(); await until(() => staleCopy.summary?.state === 'listening', 'same-ID fresh receiver');
  equal(staleCopy.records, [], 'Authoritative fresh starting status discards old records before receiving'); equal(staleCopy.selected.size, 0, 'Fresh receiver never reuses old selection');
  await window.api.invoke('fixture:send', savedId, 'fresh'); await until(() => staleCopy.records.length === 1, 'one fresh event');
  equal(staleCopy.records.map(record => [record.sequence, record.message]), [[1, 'fresh receiver only']], 'New sequence one cannot merge old higher sequence records');
  staleCopy.select(staleCopy.records[0], true); equal(staleCopy.selectionReport().selectedRecords.map(record => record.message), ['fresh receiver only'], 'Evidence contains only the recreated receiver');
  equal(staleCopy.filtered().length, 1, 'Filtered export contains only recreated history'); await staleCopy.stop(); await staleCopy.removeHistory(); staleCopy.dispose(); refreshedCopy.dispose();
  document.querySelector('#app').replaceChildren(reopened.el);
  reopened.protocol.value = 'snmp'; reopened.protocol.dispatchEvent(new Event('change')); equal(reopened.port.value, '5162', 'SNMP default'); reopened.port.value = await window.api.invoke('fixture:port');
  await reopened.start(); await until(() => reopened.summary?.state === 'listening', 'SNMP listening'); await window.api.invoke('fixture:send', reopened.listenerId, 'snmp');
  await until(() => reopened.records.length === 2, 'SNMP traps'); reopened.rows.querySelector('tr').click(); ok(reopened.details.textContent.includes('trapOid'), 'SNMP details decoded'); ok(!reopened.el.textContent.includes('SYNTHETIC_COMMUNITY'), 'No community in view');
  ok(reopened.rows.querySelector('tr').getBoundingClientRect().bottom <= innerHeight, 'Received row visible at 900x560 with production base styles');
  await window.api.invoke('fixture:screenshot');
  reopened.protocolFilter.value = 'syslog'; reopened.protocolFilter.dispatchEvent(new Event('change')); equal(reopened.rows.children.length, 0, 'Protocol filter'); reopened.protocolFilter.value = ''; reopened.protocolFilter.dispatchEvent(new Event('change'));
  await reopened.stop(); equal((await window.api.invoke('fixture:control', {})).owners, false, 'Stop closes only owned socket');
  await window.api.invoke('fixture:control', { delayedStart: true }); const pending = reopened.start(), closing = reopened.requestClose(); await pending; equal(await closing, true, 'Close waits for pending Start then closes listener'); equal((await window.api.invoke('fixture:control', {})).owners, false, 'No late bind after closed panel');
  const visual = await add(); ok(visual.startButton.getBoundingClientRect().bottom < innerHeight, 'Start visible at 900x560');
  visual.dispose(); reopened.dispose(); equal(app.calls.connect, [], 'No direct connection anywhere in workflow');
  return { passed: true, checks };
}

async function fixture() {
  const { app, BrowserWindow, ipcMain } = require('electron'), { EventConsole } = require(own('src/main/events.js'));
  const { IncidentStore } = require(path.join(repo, 'src/main/incidents.js')), { fixtures } = require('./events-tests.cjs');
  const root = path.resolve(process.env.KONX_EVENTS_TEST); assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-events-ui-'));
  app.setPath('userData', path.join(root, 'profile'));
  const js = path.join(root, 'js'); fs.mkdirSync(js);
  fs.copyFileSync(path.join(repo, 'src/renderer/js/ui.js'), path.join(js, 'ui.js')); fs.copyFileSync(own('src/renderer/js/events.js'), path.join(js, 'events.js'));
  for (const file of ['copilot-context.mjs', 'copilot-investigations.mjs']) fs.copyFileSync(path.join(repo, 'src/renderer/js', file), path.join(js, file));
  fs.copyFileSync(own('src/renderer/css/events.css'), path.join(root, 'events.css'));
  fs.copyFileSync(path.join(repo, 'src/renderer/styles.css'), path.join(root, 'styles.css'));
  fs.writeFileSync(path.join(root, 'preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{invoke:(...args)=>ipcRenderer.invoke('events-fixture',...args),on:(channel,fn)=>ipcRenderer.on(channel,(_e,...args)=>fn(...args))});`);
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html data-theme="dark"><meta charset="UTF-8"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="events.css"><style>#app{display:block;position:relative;height:100vh}</style><div id="app"></div></html>');
  let failClose = false, duplicateHost = false, clearRace = false, delayedStart = false, exports = 0, starts = 0, win;
  const manager = new EventConsole({ closeTimeoutMs: 40, createSocket(type) { const socket = dgram.createSocket(type), close = socket.close.bind(socket); socket.close = (...args) => { if (failClose) throw new Error('Synthetic close denied'); return close(...args); }; return socket; } });
  const incidents = new IncidentStore(path.join(root, 'incident-profile')), jobs = new Map(), sender = dgram.createSocket('udp4');
  const send = (bytes, port) => new Promise((resolve, reject) => sender.send(bytes, port, '127.0.0.1', err => err ? reject(err) : resolve()));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  ipcMain.handle('events-fixture', async (_event, channel, ...args) => {
    if (channel === 'fixture:control') { const options = args[0]; if ('failClose' in options) failClose = options.failClose; if ('duplicateHost' in options) duplicateHost = options.duplicateHost;
      if ('clearRace' in options) clearRace = options.clearRace; if ('delayedStart' in options) delayedStart = options.delayedStart;
      return { owners: manager.hasOwnership, exports, starts }; }
    if (channel === 'fixture:port') { const socket = dgram.createSocket('udp4'); await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port; }
    if (channel === 'fixture:send') {
      const port = manager.snapshot(args[0]).settings.port, type = args[1];
      const packets = type === 'syslog' ? [fixtures.v5424('Literal <img src=x onerror=alert(1)> café'), Buffer.from('<13>Oct  7 07:08:09 router app: legacy message'), Buffer.from('unparsed event')] : type === 'snmp' ? [fixtures.v1(), fixtures.v2()] : type === 'fresh' ? [fixtures.v5424('fresh receiver only')] : Array.from({ length: 6 }, () => Buffer.alloc(8000, 1));
      for (const bytes of packets) { await send(bytes, port); await delay(3); } return;
    }
    if (channel === 'fixture:incident') { const incident = await incidents.create({ title: 'Selected events test' }); return incidents.addText(incident.id, args[0]); }
    if (channel === 'fixture:screenshot') {
      for (const [width, height] of [[900, 560], [1280, 800]]) {
        win.setContentSize(width, height); await delay(150); const image = await win.webContents.capturePage();
        const output = path.join(repo, `review/phase-0.21/events-ui-${width}x${height}.png`); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, image.toPNG());
      }
      win.setContentSize(900, 560); return;
    }
    if (channel === 'sessions:list') return { sessions: [{ id: 'saved-router', name: 'Loopback router', protocol: 'ssh', host: '127.0.0.1' }, ...(duplicateHost ? [{ id: 'second-router', name: 'Ambiguous', protocol: 'ssh', host: '127.0.0.1' }] : [])] };
    if (channel === 'tools:eventsList') return manager.list();
    if (channel === 'tools:eventsSnapshot') return manager.snapshot(...args);
    if (channel === 'tools:eventsStop') return manager.stop(...args);
    if (channel === 'tools:eventsRemove') return manager.remove(...args);
    if (channel === 'tools:eventsClear') { const result = manager.clear(...args); if (clearRace) { clearRace = false; await send(fixtures.v5424('after clear'), result.settings.port); await delay(150); } return result; }
    if (channel === 'tools:start') {
      if (delayedStart) { delayedStart = false; await delay(80); }
      const [kind, params, id] = args; assert.equal(kind, 'events'); starts++; const signal = {}; jobs.set(id, signal);
      const emit = (type, data) => { if (!win.isDestroyed()) win.webContents.send('tools:event', id, type, data); };
      signal.task = Promise.resolve().then(() => manager.run(params, emit, signal)).then(() => emit('done', {}), error => emit('error', { message: error.message })).finally(() => jobs.delete(id)); return id;
    }
    if (channel === 'tools:aiPreview') return { context: args[0].context };
    if (channel === 'dialog:saveText') { exports++; const destination = path.join(root, `export-${exports}.${args[0].endsWith('.json') ? 'json' : 'txt'}`); fs.writeFileSync(destination, args[1]); return destination; }
    throw new Error('Unexpected events fixture IPC: ' + channel);
  });
  await app.whenReady(); win = new BrowserWindow({ width: 900, height: 560, useContentSize: true, show: false, webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true } });
  let code = 0;
  try { await win.loadFile(path.join(root, 'index.html')); const result = await win.webContents.executeJavaScript('(' + browserChecks.toString() + ')()'); fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result)); console.log('EVENTS_UI_PASS ' + result.checks); }
  catch (error) { code = 1; console.error(error.stack || error); }
  finally { failClose = false; await manager.close(); await new Promise(resolve => sender.close(resolve)); win.destroy(); app.exit(code); }
}
module.exports = { runEventsUiTests };
if (process.versions.electron && process.argv.includes('--events-fixture')) fixture().catch(error => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runEventsUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
