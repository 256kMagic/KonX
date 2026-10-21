'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await pause(); }
}

async function runDeviceUiTests(test) {
  await test('Device Inspector real IPC demo, trace evidence, report roundtrip, escaped text, cancellation and responsive layout', async () => {
    const base = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(base, 'konx-device-ui-'));
    let child, output = '';
    try {
      child = spawn(require('electron'), [__filename, '--device-ui-fixture'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_DEVICE_UI_ROOT: root, KONX_CAPTURE: '', KONX_DEMO: '' },
      });
      const collect = (data) => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Device UI fixture timeout\n' + output)); }, 60000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
      });
      assert.equal(code, 0, output); assert.match(output, /DEVICE_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) child.kill();
      assert.equal(path.dirname(path.resolve(root)), base); assert.ok(path.basename(root).startsWith('konx-device-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, dialog } = require('electron');
  const root = path.resolve(process.env.KONX_DEVICE_UI_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-device-ui-'));
  let screenshotRoot = null;
  if (process.env.KONX_DEVICE_SCREENSHOT_DIR) {
    const reviewRoot = fs.realpathSync(path.join(__dirname, '../review'));
    const requested = path.resolve(process.env.KONX_DEVICE_SCREENSHOT_DIR);
    const contained = (candidate) => { const relative = path.relative(reviewRoot, candidate); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
    assert.ok(contained(requested), 'Screenshots must remain inside workspace/review');
    let ancestor = requested;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    assert.ok(ancestor === reviewRoot || contained(fs.realpathSync(ancestor)), 'Screenshot parent resolves outside review');
    fs.mkdirSync(requested, { recursive: true }); screenshotRoot = fs.realpathSync(requested);
    assert.ok(contained(screenshotRoot), 'Screenshot directory resolves outside review');
  }
  const core = require('../src/main/device-analysis');
  const collector = require('../src/main/device-collector');
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/device-inspector-demo.json'), 'utf8'));
  const report = core.analyzeDevices(source);
  const malicious = '<img src=x onerror="window.__deviceInjected=true">';
  const importInput = structuredClone(source); importInput.devices[0].label = malicious;
  const importFile = path.join(root, 'import.json'); fs.writeFileSync(importFile, JSON.stringify(importInput));
  const badImportFile = path.join(root, 'invalid.json'); fs.writeFileSync(badImportFile, '{"devices":"not an array"}');
  let chosenImport = importFile, calls = 0, cancelled = 0, finished = false, pending = null;
  const exports = [];
  collector.listConnections = () => [{ id: 'fixture-connected', label: 'Synthetic connected switch', host: '192.0.2.1' }];
  collector.run = async (params, emit, signal) => {
    calls++; assert.deepEqual(params.connectionIds, ['fixture-connected']);
    if (calls === 1) { emit('progress', { phase: 'Reading synthetic switch' }); emit('report', report); return; }
    await new Promise((resolve) => {
      pending = () => { cancelled++; signal.onStop = null; pending = null; resolve(); };
      signal.onStop = pending; if (signal.stopped) pending();
    });
  };
  dialog.showSaveDialog = async () => { const filePath = path.join(root, 'export-' + exports.length + '.json'); exports.push(filePath); return { canceled: false, filePath }; };
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosenImport] });
  dialog.showErrorBox = (title, message) => { throw new Error(title + ': ' + message); };
  const finish = (code, error) => {
    if (finished) return; finished = true;
    if (error) console.error(error.stack || error);
    pending?.(); for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code);
  };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.once('did-finish-load', async () => {
      const run = (code) => win.webContents.executeJavaScript(code);
      const click = async (expression) => {
        let point;
        await until(async () => {
          point = await run(`(() => {const el=${expression}; if(!el)return {ready:false}; el.scrollIntoView({block:'nearest',inline:'nearest'}); const r=el.getBoundingClientRect();const x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2), hit=document.elementFromPoint(x,y);return {x,y,ready:!el.disabled && r.width>0 && r.height>0 && (hit===el||el.contains(hit))};})()`);
          return point.ready;
        }, 'clickable ' + expression);
        delete point.ready;
        win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(30);
      };
      try {
        await until(() => run('Boolean(window.__app)'), 'app ready');
        await run('window.__device=window.__app.openTool("device");window.__device.ready.then(()=>true)');
        assert.equal(calls, 0, 'opening the inspector must not collect devices');
        await click('window.__device.demoButton');
        await until(() => run('Boolean(window.__device.report && !window.__device.loading)'), 'demo');
        assert.equal(await run('window.__device.report.devices.length'), report.devices.length);
        assert.match(await run('window.__device.status.textContent'), /Synthetic demo/);
        assert.ok(await run('document.querySelector("#statusbar").textContent.includes("2 devices")'), 'Footer count should follow a loaded report');
        assert.equal(await run('window.__device.overview.textContent.includes("[object Object]")'), false, 'Source metadata must not become display fields');
        const context = await run(`(async () => {
          const {toolContext}=await import('./js/tool-context.mjs');
          const contextReport=structuredClone(window.__device.report);
          contextReport.devices[0].commands[0].output+='\\nDEVICE_RAW_TRANSCRIPT_SENTINEL_72319';
          return toolContext({toolKind:'device',title:'Device Inspector',report:contextReport});
        })()`);
        assert.equal(context.includes('DEVICE_RAW_TRANSCRIPT_SENTINEL_72319'), false, 'AI context must exclude raw device command transcripts');
        assert.equal(context.includes('"commands"'), false);
        assert.ok(context.includes(report.devices[0].facts.interfaces[0].name) && context.includes('"interfaces"'), 'AI context should still contain selected parsed device facts');
        const endpoint = report.devices.flatMap((device) => device.facts.arp).find((row) => row.mac)?.ip || report.devices.flatMap((device) => device.facts.mac)[0].mac;
        await run(`window.__device.query.value=${JSON.stringify(endpoint)};void 0;`);
        await click('window.__device.findButton');
        await until(() => run('Boolean(window.__device.trace && !window.__device.tracing)'), 'endpoint trace');
        assert.ok(await run('window.__device.trace.matches.length>0'));
        if (screenshotRoot) {
          for (const [width, height] of [[1400, 880], [900, 560]]) {
            await setViewport(win, run, width, height);
            await run('window.__device.connectionDetails.open=false;window.__device.content.scrollTop=0;void 0;');
            await pause(100);
            const file = path.join(screenshotRoot, `device-demo-${width}x${height}-${Date.now()}.png`);
            fs.writeFileSync(file, (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG(), { flag: 'wx' });
          }
          await run('window.__device.connectionDetails.open=true;void 0;');
        }
        await click('window.__device.traceResults.querySelector(".device-match button")');
        assert.equal(await run('window.__device.evidence.open'), true);
        assert.ok(await run('Boolean(window.__device.raw.querySelector(".device-source-line"))'));
        assert.match(await run('window.__device.traceStatus.textContent'), /not proof/);
        await run('window.__device.factSelect.value="mac";window.__device.factSelect.dispatchEvent(new Event("change"));void 0;');
        assert.ok(await run('window.__device.table.rows.length>0'));
        await run('window.__device.search.value="no-match-fixture";window.__device.search.dispatchEvent(new Event("input"));void 0;');
        assert.equal(await run('window.__device.table.rows.length'), 0);
        await run('window.__device.search.value="";window.__device.search.dispatchEvent(new Event("input"));void 0;');
        await click('window.__device.exportButton'); await until(() => exports.length === 1 && fs.existsSync(exports[0]), 'export');
        const exported = JSON.parse(fs.readFileSync(exports[0], 'utf8'));
        assert.equal(exported.kind, 'device'); assert.equal(exported.devices.length, report.devices.length);
        assert.ok(exported.devices[0].commands.some((command) => command.output.length));
        chosenImport = exports[0]; await click('window.__device.importButton');
        await until(() => run('!window.__device.loading'), 'roundtrip import');
        assert.equal(await run('window.__device.report.devices.length'), exported.devices.length);
        chosenImport = importFile; await click('window.__device.importButton');
        await until(() => run('!window.__device.loading'), 'untrusted label import');
        assert.equal(await run('window.__device.report.devices[0].label'), malicious);
        assert.equal(await run('Boolean(window.__deviceInjected || window.__device.el.querySelector("img"))'), false);
        chosenImport = badImportFile; await click('window.__device.importButton'); await until(() => run('!window.__device.loading'), 'invalid import');
        assert.equal(await run('window.__device.report.devices[0].label'), malicious, 'failed import preserves report');
        assert.equal(await run('window.__device.terminalButton.disabled'), true, 'imported synthetic report cannot open a guessed SSH connection');
        for (const [width, height] of [[900, 560], [1400, 880]]) {
          await setViewport(win, run, width, height); await pause(50);
          const geometry = await run('({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bottom:window.__device.el.getBoundingClientRect().bottom,contentHeight:window.__device.content.getBoundingClientRect().height})');
          assert.ok(geometry.documentWidth <= geometry.width + 2 && geometry.bottom <= geometry.height + 2 && geometry.contentHeight >= 99, JSON.stringify(geometry));
          for (const name of ['collectButton', 'importButton', 'demoButton', 'deviceSelect', 'factSelect', 'search', 'query', 'findButton']) {
            const box = await run(`(() => {const el=window.__device.${name};el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};})()`);
            assert.ok(box.left >= -2 && box.top >= -2 && box.right <= box.width + 2 && box.bottom <= box.height + 2, name + JSON.stringify(box));
          }
        }
        await click('window.__device.connectionList.querySelector("input")');
        await click('window.__device.collectButton'); await until(() => run('!window.__device.jobId'), 'fast collection');
        assert.equal(calls, 1); assert.equal(await run('window.__app.jobs.size'), 0);
        assert.match(await run('window.__device.status.textContent'), /Collection finished/);
        await click('window.__device.collectButton'); await until(() => !!pending, 'pending collection');
        await click('window.__device.collectButton'); await until(() => run('!window.__device.jobId'), 'cancel collection');
        assert.equal(cancelled, 1); assert.equal(await run('window.__device.report.devices.length'), report.devices.length);
        await click('window.__device.collectButton'); await until(() => !!pending, 'collection before close');
        await click('window.__app.tabbar.children[window.__app.tabs.indexOf(window.__device)].querySelector("button.close")');
        await until(() => !pending, 'close cancellation'); assert.equal(cancelled, 2); assert.equal(await run('window.__app.jobs.size'), 0);
        console.log('DEVICE_UI_PASS: real IPC demo/import/export, endpoint evidence, safe text, no autorun, bounded table, responsive layout and cancellation. SSH collection provider is simulated.');
        finish(0);
      } catch (error) { finish(1, error); }
    });
  });
  require('../src/main/main');
}

module.exports = { runDeviceUiTests };
if (process.versions.electron && process.argv.includes('--device-ui-fixture')) fixture().catch((error) => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runDeviceUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch((error) => { console.error(error); process.exitCode = 1; });
