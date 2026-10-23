'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const { setViewport } = require(path.join(repo, 'test/lib/electron-viewport.cjs'));
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) { const end = Date.now() + timeout; while (!(await check())) { if (Date.now() >= end) throw new Error('Timed out: ' + label); await pause(); } }

async function runIncidentUiTests(test) {
  await test('Incident real IPC library, notes/imports/timeline, verified capture, export, pending evidence and deletion safeguards', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-incident-ui-'));
    let child, output = '';
    try {
      child = spawn(require('electron'), [__filename, '--incident-ui-fixture'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_INCIDENT_UI_ROOT: root, KONX_CAPTURE: '', KONX_DEMO: '' } });
      const collect = (data) => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Incident UI fixture timed out\n' + output)); }, 60000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); }); child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
      });
      assert.equal(code, 0, output); assert.match(output, /INCIDENT_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) child.kill();
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-incident-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
async function fixture() {
  const { app, BrowserWindow, dialog } = require('electron');
  const root = path.resolve(process.env.KONX_INCIDENT_UI_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-incident-ui-'));
  const io = require('node:fs/promises'), originalRename = io.rename, originalOpen = io.open;
  const incidentRoot = path.join(root, 'profile', 'incidents') + path.sep;
  let failPublication = false, guardPublishedRead = false, publishedManifest = null, blockedReads = 0;
  io.rename = async (from, to) => {
    const isManifest = to.startsWith(incidentRoot) && path.basename(to) === 'manifest.json';
    if (isManifest && failPublication) throw Object.assign(new Error('Synthetic incident save permission denied'), { code: 'EACCES' });
    await originalRename(from, to);
    if (isManifest && guardPublishedRead) publishedManifest = to;
  };
  io.open = async (file, ...options) => {
    if (guardPublishedRead && publishedManifest === file) {
      blockedReads++; throw Object.assign(new Error('Synthetic committed manifest read denied'), { code: 'EACCES' });
    }
    return originalOpen(file, ...options);
  };
  const capturePath = path.join(root, 'source-capture.pcapng'), logPath = path.join(root, 'switch-log.txt');
  const { makeRtpDemo } = await import(pathToFileURL(path.join(repo, 'src/renderer/js/capture/sample-rtp.mjs')).href);
  fs.writeFileSync(capturePath, makeRtpDemo().bytes);
  fs.writeFileSync(logPath, '<134>1 2026-10-21T15:30:00-04:00 switch port-7 went down\nOct 21 15:31:00 switch port-7 came up\n');
  const imports = [logPath, capturePath], exports = []; let finished = false;
  dialog.showOpenDialog = async () => { const filePath = imports.shift(); if (!filePath) throw new Error('Unexpected import dialog'); return { canceled: false, filePaths: [filePath] }; };
  dialog.showSaveDialog = async (...args) => { const options = args.at(-1), extension = String(options.defaultPath || '').endsWith('.html') ? 'html' : 'json'; const filePath = path.join(root, 'incident-' + exports.length + '.' + extension); exports.push(filePath); return { canceled: false, filePath }; };
  dialog.showErrorBox = (title, message) => { throw new Error(title + ': ' + message); };
  const finish = (code, error) => { if (finished) return; finished = true; io.rename = originalRename; io.open = originalOpen;
    if (error) console.error(error.stack || error); for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code); };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.once('did-finish-load', async () => {
      const run = (code) => win.webContents.executeJavaScript(code);
      const click = async (expression) => {
        let point;
        await until(async () => {
          point = await run(`(() => {const el=${expression};if(!el)return {ready:false};el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return {x,y,ready:!el.disabled&&r.width>0&&r.height>0&&(hit===el||el.contains(hit)),debug:{rect:[r.left,r.top,r.width,r.height],hit:hit?.tagName,hitClass:hit?.className}};})()`);
          return point.ready;
        }, 'clickable ' + expression).catch((error) => { throw new Error(error.message + ' ' + JSON.stringify(point)); });
        delete point.ready; delete point.debug;
        win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(30);
      };
      const ready = () => until(() => run('!window.__incident.busy'), 'incident operation');
      const field = async (name, value) => run(`window.__incident.${name}.value=${JSON.stringify(value)};window.__incident.${name}.dispatchEvent(new Event('input'));true;`);
      try {
        await until(() => run('Boolean(window.__app)'), 'app');
        await run('window.__incident=window.__app.openTool("incidents");window.__incident.ready.then(()=>true)');
        await run('(async()=>{window.__updateBlockers=(await import("./js/updates.js")).updateBlockers;return true;})()');
        assert.equal(await run('window.__incident.incidents.length'), 0); assert.equal(await run('window.__app.jobs.size'), 0);
        await click('window.__incident.createButton'); await until(() => run('Boolean(document.querySelector(".incident-new"))'), 'new incident dialog');
        await run(`document.querySelector('.incident-new input').value='Phone audio investigation';document.querySelector('.incident-new textarea').value='Synthetic offline test';true;`);
        await click('document.querySelector(".modal footer .primary")'); await until(() => run('Boolean(window.__incident.report)&&!window.__incident.busy'), 'created incident');
        const id = await run('window.__incident.report.id');
        await run('window.__incident.addPanel.open=true;true;');
        const sentinel = '<img src=x onerror="window.__incidentInjected=true"> RAW_NOTE_SENTINEL_713';
        await field('noteText', sentinel); await field('noteLabel', 'Observed audio symptom');
        assert.ok(await run('window.__incident.updateBlockers().length>0'));
        assert.ok(await run('window.__updateBlockers(window.__app).some(reason=>reason.includes("unsaved note"))'), 'Aggregate updater must preserve incident drafts');
        failPublication = true;
        await click('window.__incident.noteButton'); await ready();
        assert.equal(await run('window.__incident.report.evidence.length'), 0);
        assert.equal(await run('window.__incident.noteText.value'), sentinel, 'A failed save must keep the complete draft');
        assert.equal(await run('window.__incident.noteLabel.value'), 'Observed audio symptom');
        assert.equal(await run('window.__incident.status.getAttribute("role")'), 'alert');
        assert.match(await run('window.__incident.status.textContent'), /Note was not saved; your draft has been kept.*Synthetic incident save permission denied/);
        assert.equal(await run('window.__incident.noteButton.disabled'), false, 'Retry must remain available after a failed save');
        assert.ok(await run('window.__updateBlockers(window.__app).some(reason=>reason.includes("unsaved note"))'));
        assert.equal(JSON.parse(fs.readFileSync(path.join(incidentRoot, id, 'manifest.json'), 'utf8')).evidence.length, 0);
        assert.deepEqual(fs.readdirSync(path.join(incidentRoot, id, 'evidence')), [], 'Failed publication must clean its staged evidence');
        failPublication = false; guardPublishedRead = true;
        await click('window.__incident.noteButton'); await ready();
        guardPublishedRead = false;
        assert.ok(publishedManifest); assert.equal(blockedReads, 0, 'A committed save must not become a false failure by rereading its manifest');
        assert.equal(await run('window.__incident.report.evidence.length'), 1); assert.equal(await run('window.__incident.noteText.value'), '');
        assert.equal(await run('window.__incident.status.getAttribute("role")'), 'status');
        assert.match(await run('window.__incident.status.textContent'), /^Saved note/);
        assert.equal(JSON.parse(fs.readFileSync(path.join(incidentRoot, id, 'manifest.json'), 'utf8')).evidence.length, 1, 'Retry must save the note exactly once');
        assert.equal(await run('window.__updateBlockers(window.__app).length'), 0, 'Saved notes release the updater blocker');
        assert.equal(await run('window.__incident.report.timeline[0].observedAt'), null, 'Untimed notes must not inherit import time');
        await field('importKind', 'syslog'); await click('window.__incident.importButton'); await ready();
        assert.equal(await run('window.__incident.report.evidence.length'), 2);
        assert.ok(await run('window.__incident.report.timeline.some(event=>event.timestampStatus==="explicit")'));
        assert.ok(await run('window.__incident.report.timeline.some(event=>event.timestampStatus==="unknown"&&event.timeText?.startsWith("Oct"))'));
        await click('window.__incident.table.tbody.querySelector("tr[data-k]")');
        assert.ok(await run('Boolean(window.__incident.detail.querySelector(".incident-source"))'));
        assert.equal(await run('Boolean(window.__incidentInjected||window.__incident.el.querySelector("img"))'), false);
        const context = await run(`(async()=>{const {toolContext}=await import('./js/tool-context.mjs');return toolContext(window.__incident);})()`);
        assert.equal(context.includes('RAW_NOTE_SENTINEL_713'), false); assert.equal(context.includes('originalPath'), false); assert.ok(context.includes('evidenceCount'));
        await field('importKind', 'capture'); await click('window.__incident.importButton'); await ready();
        assert.equal(await run('window.__incident.report.evidence.length'), 3);
        fs.writeFileSync(capturePath, 'Original source changed after import');
        await click('window.__incident.evidenceButton');
        await run('window.__incident.showEvidence(window.__incident.report.evidence.find(item=>item.kind==="capture").id);true;');
        await click(`window.__incident.detail.querySelector('[data-action="open-capture"]')`);
        await until(() => run('window.__app.active.kind==="capture"&&window.__app.active.packets.length===401'), 'verified retained capture');
        await ready(); await run('window.__sourceCap=window.__app.active;window.__app.activate(window.__incident);true;');
        await click('window.__incident.jsonButton'); await ready(); await click('window.__incident.htmlButton'); await ready();
        assert.equal(exports.length, 2); const json = fs.readFileSync(exports[0], 'utf8'), html = fs.readFileSync(exports[1], 'utf8');
        assert.ok(json.includes('RAW_NOTE_SENTINEL_713')); assert.ok(html.includes('&lt;img')); assert.equal(html.includes('<img src=x'), false);
        const parsed = JSON.parse(json); assert.ok(JSON.stringify(parsed).includes('Phone audio investigation'));
        await run('window.__pending=window.__app.addToIncident(window.__sourceCap);window.__pending.ready.then(()=>true)');
        assert.equal(await run('window.__pending.report'), null, 'Add to incident must require an explicit target selection');
        await run(`window.__pending.openIncident(${JSON.stringify(id)}).then(()=>true)`);
        await run('window.__sourceCap.clear(false);true;');
        assert.equal(await run('window.__pending.report.evidence.length'), 3, 'Opening pending evidence must not save it');
        assert.ok(await run('window.__pending.updateBlockers().some(reason=>reason.includes("unsaved evidence"))'));
        assert.ok(await run('window.__updateBlockers(window.__app).some(reason=>reason.includes("unsaved evidence"))'), 'Aggregate updater must preserve pending capture bytes');
        await run('window.__closing=window.__app.closeTab(window.__pending);true;'); await until(() => run('Boolean(document.querySelector(".modal"))'), 'pending close prompt');
        await click('document.querySelector(".modal footer button:not(.danger)")'); await run('window.__closing.then(()=>true)'); assert.equal(await run('window.__app.byId.has(window.__pending.id)'), true);
        await click('window.__pending.pendingButton'); await until(() => run('!window.__pending.busy'), 'pending evidence save');
        assert.equal(await run('window.__pending.report.evidence.length'), 4); assert.equal(await run('window.__pending.pending'), null);
        assert.equal(await run('window.__updateBlockers(window.__app).length'), 0, 'Saved pending evidence releases the updater blocker');
        await run('window.__app.closeTab(window.__pending).then(()=>true)'); await run('window.__app.closeTab(window.__sourceCap).then(()=>true)'); await run('window.__app.activate(window.__incident);window.__incident.refresh().then(()=>true)');
        assert.equal(await run('window.__incident.report.evidence.length'), 4, 'Library refresh retains saved evidence');
        await click('window.__incident.timelineButton');
        for (const [width, height] of [[1400, 880], [900, 560]]) {
          await setViewport(win, run, width, height); await run('window.__incident.addPanel.open=false;window.__incident.content.scrollTop=0;true;'); await pause(50);
          const geometry = await run('(()=>{const r=window.__incident.content.getBoundingClientRect();return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bottom:r.bottom,contentHeight:r.height};})()');
          assert.ok(geometry.documentWidth<=geometry.width+2&&geometry.bottom<=geometry.height+2&&geometry.contentHeight>120, JSON.stringify(geometry));
          if (process.env.KONX_INCIDENT_SCREENSHOTS === '1') {
            const target = path.join(repo, 'review/release-0.10.0'); fs.mkdirSync(target, { recursive: true }); assert.ok(fs.realpathSync(target).startsWith(fs.realpathSync(path.join(repo, 'review')) + path.sep));
            fs.writeFileSync(path.join(target, `incident-${width}x${height}-${Date.now()}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG(), { flag: 'wx' });
          }
        }
        await click('window.__incident.deleteButton'); await until(() => run('Boolean(document.querySelector(".modal"))'), 'delete incident prompt');
        await click('document.querySelector(".modal footer button:not(.danger)")'); assert.equal(await run('window.__incident.report.id'), id);
        await click('window.__incident.deleteButton'); await until(() => run('Boolean(document.querySelector(".modal"))'), 'delete incident prompt again');
        await click('document.querySelector(".modal footer .danger")'); await until(() => run('!window.__incident.busy&&window.__incident.incidents.length===0'), 'confirmed incident deletion');
        assert.equal(fs.readFileSync(capturePath, 'utf8'), 'Original source changed after import'); assert.ok(fs.existsSync(logPath));
        assert.equal(await run('window.__app.jobs.size'), 0);
        console.log('INCIDENT_UI_PASS: real local IPC, failed publication/draft retention/retry, committed save confirmation, explicit creation/import/pending evidence, unknown timestamps, XSS, source preview, original-file independence, verified retained capture, escaped exports, summary-only AI, close safeguards and deletion; no external network collection.'); finish(0);
      } catch (error) { finish(1, error); }
    });
  });
  require(path.join(repo, 'src/main/main'));
}
module.exports = { runIncidentUiTests };
if (process.versions.electron && process.argv.includes('--incident-ui-fixture')) fixture().catch((error) => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runIncidentUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch((error) => { console.error(error); process.exitCode = 1; });
