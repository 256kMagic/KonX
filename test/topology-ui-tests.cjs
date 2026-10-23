'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { REPO } = require('./topology-tests.cjs');
const { loadTopologyIpc } = require('./topology-ipc-tests.cjs');
const { setViewport } = require(path.join(REPO, 'test/lib/electron-viewport.cjs'));
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) { const deadline = Date.now() + timeout; while (!(await check())) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await pause(); } }
async function runTopologyUiTests(test) {
  await test('Topology real Electron map selection, evidence, endpoint overlay, snapshots, export, keyboard/drag and late-load disposal', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-topology-ui-'));
    let child, output = '', exited;
    try {
      const env = { ...process.env, KONX_TOPOLOGY_UI_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--topology-ui-fixture'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
      child.stdout.on('data', data => { output = (output + data).slice(-1024 * 1024); }); child.stderr.on('data', data => { output = (output + data).slice(-1024 * 1024); });
      exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      let timer;
      const code = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error('Topology UI timeout\n' + output)); }, 65000); })]).finally(() => clearTimeout(timer));
      assert.equal(code, 0, output); assert.match(output, /TOPOLOGY_UI_PASS/);
    } finally {
      if (child && child.exitCode === null) { child.kill(); await Promise.race([exited.catch(() => {}), pause(5000)]); }
      assert.equal(path.dirname(path.resolve(root)), base); assert.ok(path.basename(root).startsWith('konx-topology-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
async function fixture() {
  const { app, BrowserWindow, ipcMain, dialog } = require('electron');
  const root = path.resolve(process.env.KONX_TOPOLOGY_UI_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-topology-ui-'));
  app.setPath('userData', path.join(root, 'profile'));
  let win, finished = false, releaseBuild = null, delayBuild = false, failBuild = false, builds = 0;
  const finish = (code, error) => { if (finished) return; finished = true; if (error) console.error(error.stack || error); releaseBuild?.(); if (win && !win.isDestroyed()) win.destroy(); app.exit(code); };
  process.on('uncaughtException', error => finish(1, error)); process.on('unhandledRejection', error => finish(1, error));
  dialog.showErrorBox = (title, message) => finish(1, new Error(title + ': ' + message));
  const core = require(path.join(REPO, 'src/main/device-analysis'));
  const demo = JSON.parse(fs.readFileSync(path.join(REPO, 'assets/device-inspector-demo.json'), 'utf8'));
  demo.devices[0].connectionId = 'fixture-ssh'; const report = core.analyzeDevices(demo);
  const hostile = structuredClone(report); hostile.devices[0].label = '<img src=x onerror="window.INJECTED=true">';
  const importPath = path.join(root, 'report.json'); fs.writeFileSync(importPath, JSON.stringify(hostile));
  const { SnapshotStore } = require(path.join(REPO, 'src/main/device-snapshots'));
  const snapshots = new SnapshotStore(path.join(root, 'profile')); const saved = await snapshots.save({ label: 'Topology fixture', report });
  const exports = []; let selectedImport = importPath, cancelImport = false;
  ipcMain.handle('tools:deviceDemo', () => report);
  ipcMain.handle('tools:snapshotList', () => snapshots.list()); ipcMain.handle('tools:snapshotGet', (_event, id) => snapshots.get(id));
  loadTopologyIpc().registerTopology((name, handler) => ipcMain.handle(name, async (_event, ...args) => {
    if (name === 'tools:topologyBuild') {
      builds++;
      if (delayBuild) await new Promise(resolve => { releaseBuild = () => { releaseBuild = null; resolve(); }; });
      if (failBuild) { failBuild = false; throw new Error('Fixture graph failure'); }
    }
    return handler(...args);
  }), { dialogOwner: () => win, dialog: {
    showOpenDialog: async () => cancelImport ? { canceled: true } : { filePaths: [selectedImport] },
    showSaveDialog: async () => { const filePath = path.join(root, 'topology-' + exports.length + '.json'); exports.push(filePath); return { filePath }; },
  } });
  const renderer = path.join(root, 'renderer'); fs.mkdirSync(path.join(renderer, 'js'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../src/renderer/js/topology.js'), path.join(renderer, 'js/topology.js'));
  fs.copyFileSync(path.join(__dirname, '../src/renderer/topology.css'), path.join(renderer, 'topology.css'));
  fs.copyFileSync(path.join(REPO, 'src/renderer/js/ui.js'), path.join(renderer, 'js/ui.js'));
  fs.copyFileSync(path.join(REPO, 'src/renderer/styles.css'), path.join(renderer, 'styles.css'));
  fs.writeFileSync(path.join(root, 'preload.cjs'), "const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{invoke:(channel,...args)=>ipcRenderer.invoke(channel,...args)});");
  fs.writeFileSync(path.join(renderer, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><link rel="stylesheet" href="styles.css"><body><script type="module" src="fixture.js"></script></body>');
  fs.writeFileSync(path.join(renderer, 'fixture.js'), `import {TopologyTab} from './js/topology.js';\nwindow.calls={activation:[],inspector:[]};\nconst terminal={id:'fixture-ssh',kind:'terminal',protocol:'ssh',state:'connected'};\nwindow.fixtureApp={byId:new Map([['fixture-ssh',terminal]]),activate:tab=>calls.activation.push(tab.id),openDeviceInspector:(report,options)=>calls.inspector.push({kind:report.kind,...options}),updateStatus:()=>{}};\nwindow.makeTopology=params=>{const tab=new TopologyTab(fixtureApp,params);tab.el.classList.add('active');document.body.replaceChildren(tab.el);window.topo=tab;return tab.ready;};\nawait makeTopology();`);
  await app.whenReady();
  win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1100, height: 760, webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const run = code => win.webContents.executeJavaScript(code);
  const mouse = (type, point, extra = {}) => win.webContents.sendInputEvent({ type, ...point, ...extra });
  const click = async expression => {
    let point, previous;
    await until(async () => {
      point = await run(`(()=>{const el=${expression};if(!el)return null;el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return{x,y,ready:!el.disabled&&r.width>0&&r.height>0&&(hit===el||el.contains(hit))};})()`);
      const stable = point?.ready && previous?.x === point.x && previous?.y === point.y; previous = point; return stable;
    }, 'clickable ' + expression);
    const p = { x: point.x, y: point.y }; mouse('mouseDown', p, { button: 'left', clickCount: 1 }); mouse('mouseUp', p, { button: 'left', clickCount: 1 }); await pause(30);
  };
  try {
    await win.loadFile(path.join(renderer, 'index.html')); await until(() => run('Boolean(window.topo && !topo.snapshotBusy)'), 'initial topology');
    assert.equal(builds, 0, 'opening must not build/collect/connect until source selected');
    await click('topo.demoButton'); await until(() => run('Boolean(topo.report && !topo.busy)'), 'demo graph');
    assert.equal(await run('topo.report.nodes.length'), 2); assert.equal(await run('topo.report.links.length'), 2);
    await click("topo.nodeEls.get('device:demo-core')");
    assert.match(await run('topo.detail.textContent'), /Demo core switch/);
    await click("[...topo.detail.querySelectorAll('button')].find(b=>b.textContent.includes('Open terminal'))");
    assert.deepEqual(await run('calls.activation'), ['fixture-ssh']);
    await click("[...topo.detail.querySelectorAll('button')].find(b=>b.textContent==='Open Device Inspector')");
    assert.equal(await run('calls.inspector[0].deviceId'), 'demo-core');
    const linkPoint = await run("(()=>{const p=topo.linkEls.get(topo.report.links[0].id).querySelector('path');const v=p.getPointAtLength(p.getTotalLength()/2).matrixTransform(p.getScreenCTM());return{x:Math.round(v.x),y:Math.round(v.y)};})()");
    mouse('mouseDown', linkPoint, { button: 'left', clickCount: 1 }); mouse('mouseUp', linkPoint, { button: 'left', clickCount: 1 });
    await until(() => run("topo.selection?.type==='link'"), 'native link selection');
    await click('topo.detail.querySelector(".topology-source")');
    assert.equal(await run('topo.evidence.open'), true); assert.match(await run('topo.raw.textContent'), /Device ID: edge-sw/);
    await click('topo.evidenceHeading.querySelector("button")');
    assert.equal(await run('calls.inspector.at(-1).source.commandId'), 'cdp');
    await run('topo.evidence.open=false;topo.query.value="192.0.2.100";void 0'); await click('topo.traceButton');
    await until(() => run('Boolean(topo.report.endpoint && !topo.busy)'), 'endpoint overlay');
    assert.equal(await run('topo.report.nodes.filter(n=>n.kind==="endpoint").length'), 1);
    assert.match(await run('topo.endpointSummary.textContent'), /candidate-edge/);
    const before = await run('topo.map.getAttribute("viewBox")'); await click('topo.zoomInButton'); assert.notEqual(await run('topo.map.getAttribute("viewBox")'), before);
    await click('topo.fitButton'); assert.equal(await run('topo.map.getAttribute("viewBox")'), before);
    await run("topo.nodeEls.get('device:demo-core').focus();void 0");
    const oldX = await run("topo.positions.get('device:demo-core').x");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await until(() => run(`topo.positions.get('device:demo-core').x===${oldX + 10}`), 'keyboard node movement');
    const start = await run("(()=>{const r=topo.nodeEls.get('device:demo-core').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()");
    mouse('mouseDown', start, { button: 'left', clickCount: 1 }); mouse('mouseMove', { x: start.x + 40, y: start.y + 20 }, { button: 'left' }); mouse('mouseUp', { x: start.x + 40, y: start.y + 20 }, { button: 'left', clickCount: 1 });
    await until(() => run(`topo.positions.get('device:demo-core').x>${oldX + 11}&&!topo.drag`), 'native node drag');
    await click('topo.exportButton'); await until(() => exports.length === 1 && run('!topo.busy'), 'topology export');
    const exported = JSON.parse(fs.readFileSync(exports[0], 'utf8')); assert.equal(exported.sourceReport.kind, 'device'); assert.equal(exported.endpoint.query, '192.0.2.100');
    assert.equal(exported.generatedAt, await run('topo.report.generatedAt'));
    selectedImport = exports[0]; await click('topo.importButton'); await until(() => run('!topo.busy'), 'reopen topology export');
    assert.equal(await run('topo.report.nodes.length'), 3); assert.equal(await run('topo.inputReport.kind'), 'device');
    assert.equal(await run('topo.inputReport.devices[0].commands[0].output'), exported.sourceReport.devices[0].commands[0].output);
    cancelImport = true; await click('topo.importButton'); await until(() => run('!topo.busy'), 'cancel import');
    assert.equal(await run('topo.report.nodes.length'), 3); assert.match(await run('topo.status.textContent'), /Load cancelled/); cancelImport = false;
    failBuild = true; await click('topo.traceButton'); await until(() => run('!topo.busy'), 'failed rebuild');
    assert.match(await run('topo.status.textContent'), /Fixture graph failure/); assert.equal(await run('topo.report.endpoint.query'), '192.0.2.100');
    await run(`topo.snapshots.value=${JSON.stringify(saved.id)};topo.snapshots.dispatchEvent(new Event('change'));void 0`); await click('topo.snapshotButton');
    await until(() => run('!topo.busy'), 'snapshot load'); assert.match(await run('topo.status.textContent'), /Saved snapshot loaded/);
    selectedImport = importPath; await click('topo.importButton'); await until(() => run('!topo.busy'), 'import');
    assert.equal(await run('topo.report.nodes[0].label'), hostile.devices[0].label); assert.equal(await run('Boolean(window.INJECTED||topo.el.querySelector("img"))'), false);
    const incident = await run(`(async()=>{const{incidentEvidence}=await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'src/renderer/js/incident-evidence.mjs')).href)});return incidentEvidence(topo)})()`);
    assert.equal(JSON.parse(incident.text).kind, 'topology'); assert.ok(incident.text.includes('excerpt'));
    await click('topo.demoButton'); await until(() => run('!topo.busy'), 'clean demo for visual review');
    await run('topo.select("link",topo.report.links[0].id);void 0');
    for (const [width, height] of [[430, 600], [900, 560], [1400, 900]]) {
      await setViewport(win, run, width, height); await pause(60);
      assert.ok(await run('document.documentElement.scrollWidth<=innerWidth+2'));
      for (const name of ['demoButton', 'importButton', 'snapshotButton', 'query', 'traceButton', 'fitButton']) {
        const box = await run(`(()=>{const el=topo.${name};el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight};})()`);
        assert.ok(box.left >= -2 && box.right <= box.w + 2 && box.top >= -2 && box.bottom <= box.h + 2, name + JSON.stringify(box));
      }
      if (process.env.KONX_TOPOLOGY_SCREENSHOTS === '1') { const out = path.join(REPO, 'review/phase-0.20/screenshots'); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, `topology-${width}x${height}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG()); }
    }
    delayBuild = true; await click('topo.traceButton'); await until(() => !!releaseBuild, 'held build');
    await run('window.oldTopo=topo;oldTopo.dispose();oldTopo.el.remove();void 0'); const previous = await run('oldTopo.report.generatedAt'); releaseBuild();
    await pause(70); assert.equal(await run('oldTopo.report.generatedAt'), previous); assert.equal(await run('oldTopo.disposed'), true);
    console.log('TOPOLOGY_UI_PASS: hidden Electron/native input with real parser, topology, snapshot files, JSON export, incident serialization and lifecycle; terminal/inspector integration hooks are isolated fixtures.');
    finish(0);
  } catch (error) { finish(1, error); }
}
module.exports = { runTopologyUiTests };
if (process.versions.electron && process.argv.includes('--topology-ui-fixture')) fixture().catch(error => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runTopologyUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
