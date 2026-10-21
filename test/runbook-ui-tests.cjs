'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const { setViewport } = require(path.join(repo, 'test/lib/electron-viewport.cjs'));
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) { const end = Date.now() + timeout; while (!(await check())) { if (Date.now() >= end) throw new Error('Timed out: ' + label); await pause(); } }

async function runRunbookUiTests(test) {
  await test('Runbook real Electron review/store/run workflow, local TCP probe, manual capture, cancellation and draft safeguards', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-runbook-ui-'));
    let child, output = '';
    try {
      child = spawn(require('electron'), [__filename, '--runbook-ui-fixture'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_RUNBOOK_UI_ROOT: root, KONX_CAPTURE: '', KONX_DEMO: '' } });
      const collect = (data) => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Runbook UI fixture timed out\n' + output)); }, 90000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); }); child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
      });
      assert.equal(code, 0, output); assert.match(output, /RUNBOOK_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) child.kill();
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-runbook-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
async function fixture() {
  const { app, BrowserWindow, dialog } = require('electron');
  const root = path.resolve(process.env.KONX_RUNBOOK_UI_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-runbook-ui-'));
  let connections = 0, questions = 0, finished = false;
  const tcp = net.createServer(socket => { connections++; socket.on('error', () => {}); socket.end(); }); await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const dns = dgram.createSocket('udp4'); dns.on('message', () => { questions++; }); await new Promise(resolve => dns.bind(0, '127.0.0.1', resolve));
  const definition = { schemaVersion: 1, name: 'Synthetic local procedure', description: 'Explicit offline test with manual capture review', inputs: [{ id: 'port', label: 'Local listener port', kind: 'port', required: true }],
    steps: [{ id: 'tcp', title: 'Observe local test listener', kind: 'tcp', target: '127.0.0.1', port: { input: 'port' } },
      { id: 'manual', title: 'Review synthetic scope', kind: 'checklist', instructions: '<img src=x onerror="window.__runbookInjected=true"> MANUAL_EVIDENCE' },
      { id: 'media', title: 'Inspect existing sample RTP', kind: 'capture', view: 'rtp', instructions: 'Select the synthetic captured sample.' }] };
  const importPath = path.join(root, 'procedure.json'); fs.writeFileSync(importPath, JSON.stringify(definition));
  const exports = [];
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [importPath] });
  dialog.showSaveDialog = async () => { const filePath = path.join(root, 'export-' + exports.length + '.json'); exports.push(filePath); return { canceled: false, filePath }; };
  dialog.showErrorBox = (title, message) => { throw new Error(title + ': ' + message); };
  const finish = async (code, error) => { if (finished) return; finished = true; if (error) console.error(error.stack || error); await Promise.all([new Promise(resolve => tcp.close(resolve)), new Promise(resolve => dns.close(resolve))]); for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code); };
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
      const ready = () => until(() => run('!window.__runbook.busy&&!window.__runbook.jobId'), 'runbook idle');
      try {
        await until(() => run('Boolean(window.__app)'), 'app');
        await run(`(async()=>{window.__runbook=window.__app.openTool('runbook');await window.__runbook.ready;window.__updateBlockers=(await import('./js/updates.js')).updateBlockers;return true;})()`);
        assert.equal(await run('window.__runbook.templates.length'), 3); assert.equal(connections + questions, 0); assert.equal(await run('window.__app.jobs.size'), 0);
        await click('window.__runbook.importButton'); await ready();
        assert.equal(await run('window.__runbook.isDirty()'), true); assert.equal(await run('window.__runbook.definition.name'), definition.name);
        assert.ok(await run('window.__updateBlockers(window.__app).some(reason=>reason.includes("unsaved runbook"))'));
        assert.equal(connections + questions, 0, 'Import and review do not perform network probes');
        await run(`window.__runbook.inputs.get('port').element.value=${JSON.stringify(String(tcp.address().port))};true;`);
        await click('window.__runbook.saveButton'); await ready();
        assert.ok(await run('Boolean(window.__runbook.customId)')); assert.equal(await run('window.__runbook.isDirty()'), false);
        assert.equal(await run('window.__runbook.inputs.get("port").element.value'), String(tcp.address().port), 'Saving a procedure preserves explicitly entered target values');
        const customId = await run('window.__runbook.customId');
        await click('window.__runbook.runButton'); await until(() => run('Boolean(window.__runbook.report)&&!window.__runbook.jobId'), 'real procedure result');
        assert.equal(connections, 1); assert.equal(await run('window.__runbook.report.steps[0].status'), 'pass');
        assert.equal(await run('window.__runbook.report.steps.filter(step=>step.status==="unknown").length'), 2);
        assert.equal(await run('window.__runbook.report.complete'), true, 'Finished procedure can still contain manual unknowns');
        await run('window.__runbook.showStep(window.__runbook.report.steps[1]);true;');
        assert.equal(await run('Boolean(window.__runbookInjected||window.__runbook.el.querySelector("img"))'), false);
        assert.match(await run('window.__runbook.detail.textContent'), /MANUAL_EVIDENCE/);
        await click('window.__runbook.reportButton'); await ready(); await click('window.__runbook.exportButton'); await ready();
        assert.equal(exports.length, 2); assert.equal(JSON.parse(fs.readFileSync(exports[0], 'utf8')).kind, 'runbook'); assert.equal(JSON.parse(fs.readFileSync(exports[1], 'utf8')).name, definition.name);
        await run(`(async()=>{const {makeRtpDemo}=await import('./js/capture/sample-rtp.mjs');const sample=makeRtpDemo();window.__sample=window.__app.openTool('capture');await window.__sample.loadBytes(sample.bytes,sample.name);window.__app.activate(window.__runbook);window.__runbook.showStep(window.__runbook.report.steps[2]);return true;})()`);
        await click('window.__runbook.detail.querySelector("button")'); await until(() => run('Boolean(document.querySelector(".modal select"))'), 'manual existing capture selector');
        assert.equal(await run('document.querySelector(".modal select").value'), '', 'Manual capture action requires explicit selection');
        await run('document.querySelector(".modal select").value=window.__sample.id;true;'); await click('document.querySelector(".modal footer .primary")');
        await until(() => run('Boolean(document.querySelector(".rtp-workspace"))'), 'manual RTP viewer');
        assert.equal(await run('window.__runbook.report.steps[2].status'), 'unknown', 'Opening analysis must not fabricate a manual pass');
        await click('document.querySelector(".modal > header .x")'); await run('window.__app.activate(window.__runbook);true;');
        for (const [width, height] of [[1400, 880], [900, 560]]) {
          await setViewport(win, run, width, height); await run('window.__runbook.editorPanel.open=false;window.__runbook.content.scrollTop=0;true;'); await pause(50);
          const geometry = await run('(()=>{const r=window.__runbook.content.getBoundingClientRect();return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bottom:r.bottom,contentHeight:r.height};})()');
          assert.ok(geometry.documentWidth<=geometry.width+2&&geometry.bottom<=geometry.height+2&&geometry.contentHeight>120, JSON.stringify(geometry));
          if (process.env.KONX_RUNBOOK_SCREENSHOTS === '1') {
            const target = path.join(repo, 'review/release-0.12.0'); fs.mkdirSync(target, { recursive: true }); assert.ok(fs.realpathSync(target).startsWith(fs.realpathSync(path.join(repo, 'review')) + path.sep));
            fs.writeFileSync(path.join(target, `runbook-${width}x${height}-${Date.now()}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG(), { flag: 'wx' });
          }
        }
        await run('window.__runbook.editorPanel.open=true;window.__runbook.editor.value="{broken";window.__runbook.editor.dispatchEvent(new Event("input"));true;');
        assert.equal(await run('window.__runbook.runButton.disabled'), true, 'Unreviewed edits cannot run');
        await click('window.__runbook.reviewButton'); assert.equal(await run('window.__runbook.definition'), null); assert.ok(await run('window.__runbook.reviewError.textContent.length>0'));
        const slowDefinition = { ...definition, name: 'Cancellation fixture', inputs: [], steps: [{ id: 'dns', title: 'Wait on local DNS fixture', kind: 'dns', target: 'fixture.example', recordType: 'A', server: '127.0.0.1:' + dns.address().port, timeoutMs: 30000 }, { id: 'later', title: 'Must never connect', kind: 'tcp', target: '127.0.0.1', port: tcp.address().port }] };
        await run(`window.__runbook.editor.value=${JSON.stringify(JSON.stringify(slowDefinition, null, 2))};window.__runbook.editor.dispatchEvent(new Event('input'));true;`);
        await click('window.__runbook.reviewButton'); await click('window.__runbook.saveButton'); await ready();
        assert.equal(await run('window.__runbook.customId'), customId, 'Custom editing updates the existing procedure identity');
        await click('window.__runbook.runButton'); await until(() => questions > 0, 'actual local DNS query pending');
        await run('window.__app.closeTab(window.__runbook).then(()=>true)'); assert.equal(await run('window.__app.byId.has(window.__runbook.id)'), true);
        await until(() => run('!window.__runbook.jobId&&window.__runbook.report.stopped'), 'runbook cancellation cleanup');
        assert.equal(connections, 1, 'Cancelled DNS must not proceed to later TCP step'); assert.equal(await run('window.__runbook.report.steps[1].status'), 'unknown');
        assert.equal(await run('window.__updateBlockers(window.__app).length'), 0);
        await click('window.__runbook.removeButton'); await until(() => run('Boolean(document.querySelector(".modal"))'), 'delete procedure confirmation');
        await click('document.querySelector(".modal footer .danger")'); await ready();
        assert.equal(await run('window.__runbook.saved.length'), 0); assert.equal(await run('window.__app.jobs.size'), 0);
        console.log('RUNBOOK_UI_PASS: real local TCP/DNS primitives, reviewed typed inputs, template/custom store and exports, retained pass/unknown evidence, manual existing capture navigation, no fabricated manual pass, cancellation before later probes, drafts/updater/close safeguards and responsive layout. No external target queried.'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require(path.join(repo, 'src/main/main'));
}
module.exports = { runRunbookUiTests };
if (process.versions.electron && process.argv.includes('--runbook-ui-fixture')) fixture().catch((error) => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runRunbookUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch((error) => { console.error(error); process.exitCode = 1; });
