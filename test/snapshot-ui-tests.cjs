'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) { const end = Date.now() + timeout; while (!(await check())) { if (Date.now() >= end) throw new Error('Timed out: ' + label); await pause(); } }

async function runSnapshotUiTests(test) {
  await test('Snapshot real IPC storage, demo comparison, evidence, manual pairing, safe AI context, deletion and responsive UI', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-snapshot-ui-'));
    let child, output = '';
    try {
      child = spawn(require('electron'), [__filename, '--snapshot-ui-fixture'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_SNAPSHOT_UI_ROOT: root, KONX_CAPTURE: '', KONX_DEMO: '' } });
      const collect = (data) => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Snapshot UI fixture timed out\n' + output)); }, 60000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); }); child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
      });
      assert.equal(code, 0, output); assert.match(output, /SNAPSHOT_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) child.kill();
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-snapshot-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, dialog } = require('electron');
  const root = path.resolve(process.env.KONX_SNAPSHOT_UI_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-snapshot-ui-'));
  let screenshotRoot = null;
  if (process.env.KONX_SNAPSHOT_SCREENSHOT_DIR) {
    const reviewRoot = fs.realpathSync(path.join(__dirname, '../review')), requested = path.resolve(process.env.KONX_SNAPSHOT_SCREENSHOT_DIR);
    const contained = (candidate) => { const relative = path.relative(reviewRoot, candidate); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
    assert.ok(contained(requested), 'Screenshot target must stay in workspace/review');
    let ancestor = requested; while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    assert.ok(ancestor === reviewRoot || contained(fs.realpathSync(ancestor)), 'Screenshot parent resolves outside review');
    fs.mkdirSync(requested, { recursive: true }); screenshotRoot = fs.realpathSync(requested); assert.ok(contained(screenshotRoot));
  }
  const exports = []; let finished = false;
  dialog.showSaveDialog = async () => { const filePath = path.join(root, 'comparison-' + exports.length + '.json'); exports.push(filePath); return { canceled: false, filePath }; };
  dialog.showOpenDialog = async () => { throw new Error('No external files should be opened by this snapshot fixture'); };
  dialog.showErrorBox = (title, message) => { throw new Error(title + ': ' + message); };
  const finish = (code, error) => { if (finished) return; finished = true; if (error) console.error(error.stack || error); for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code); };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.once('did-finish-load', async () => {
      const run = (code) => win.webContents.executeJavaScript(code);
      const click = async (expression) => {
        let point;
        await until(async () => {
          point = await run(`(() => {const el=${expression};if(!el)return {ready:false};el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return {x,y,ready:!el.disabled&&r.width>0&&r.height>0&&(hit===el||el.contains(hit)),debug:{rect:[r.left,r.top,r.width,r.height],hit:hit?.tagName,hitClass:hit?.className,tableRows:window.__snap?.table.rows.length}};})()`);
          return point.ready;
        }, 'clickable ' + expression).catch((error) => { throw new Error(error.message + ' ' + JSON.stringify(point)); });
        delete point.ready; delete point.debug; win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(30);
      };
      const choose = async (expression, value) => { await run(`${expression}.value=${JSON.stringify(value)};${expression}.dispatchEvent(new Event('change'));void 0;`); };
      const compared = () => until(() => run('Boolean(window.__snap.report && !window.__snap.busy)'), 'snapshot comparison');
      try {
        await until(() => run('Boolean(window.__app)'), 'app');
        await run('window.__snap=window.__app.openTool("snapshots");window.__snap.ready.then(()=>true)');
        assert.equal(await run('window.__snap.snapshots.length'), 0); assert.equal(await run('window.__app.jobs.size'), 0);
        await click('window.__snap.demoButton'); await compared();
        assert.equal(await run('window.__snap.snapshots.length'), 2);
        assert.ok(await run('window.__snap.report.changes.length>0'));
        assert.ok(await run('window.__snap.report.devices.length>0'));
        assert.equal(await run('window.__snap.before.value===window.__snap.after.value'), false);
        assert.equal(await run('window.__app.jobs.size'), 0, 'Demo comparison must not start network collection');
        const initial = await run('({before:window.__snap.before.value,after:window.__snap.after.value,count:window.__snap.report.changes.length})');
        if (screenshotRoot) {
          for (const [width, height] of [[1400, 880], [900, 560]]) {
            await setViewport(win, run, width, height); await run('window.__snap.content.scrollTop=0;void 0;'); await pause(100);
            fs.writeFileSync(path.join(screenshotRoot, `snapshot-demo-${width}x${height}-${Date.now()}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG(), { flag: 'wx' });
          }
        }
        const category = await run('window.__snap.report.changes.find(x=>x.beforeSource||x.afterSource).category');
        await choose('window.__snap.category', category);
        await click('window.__snap.table.tbody.querySelector("tr[data-k]")');
        await click('[...window.__snap.detail.querySelectorAll("button")].find(button=>!button.disabled)');
        assert.ok(await run('Boolean(window.__snap.detail.querySelector(".snapshot-source pre"))'), 'Comparison must expose retained source evidence');
        assert.ok(await run('Boolean(window.__snap.detail.querySelector(".snapshot-source-line"))'));
        const context = await run(`(async () => {const {toolContext}=await import('./js/tool-context.mjs'); const report=structuredClone(window.__snap.report);report.changes[0].before='SNAPSHOT_RAW_CONFIG_SENTINEL_98217';return toolContext({toolKind:'snapshots',title:'Device Snapshots',report,aiContext:window.__snap.aiContext});})()`);
        assert.equal(context.includes('SNAPSHOT_RAW_CONFIG_SENTINEL_98217'), false, 'Raw changed values must never enter snapshot AI context');
        assert.equal(context.includes('"changes"'), false, 'Only summary counts and coverage should be offered to AI');
        assert.ok(context.includes('comparedDevices') && context.includes('summary'));
        await choose('window.__snap.changeStatus', 'unknown');
        assert.ok(await run('window.__snap.table.rows.every(row=>row.status==="unknown")'));
        await choose('window.__snap.category', ''); await choose('window.__snap.changeStatus', '');
        await run('window.__snap.search.value="no-match-snapshot-fixture";window.__snap.search.dispatchEvent(new Event("input"));void 0;');
        assert.equal(await run('window.__snap.table.rows.length'), 0);
        await run('window.__snap.search.value="";window.__snap.search.dispatchEvent(new Event("input"));void 0;');
        await click('window.__snap.exportButton'); await until(() => exports.length && fs.existsSync(exports[0]), 'comparison export');
        const exported = JSON.parse(fs.readFileSync(exports[0], 'utf8')); assert.equal(exported.kind, 'device-snapshot-comparison'); assert.equal(exported.changes.length, initial.count);
        await run('window.__snap.pairDetails.open=true;void 0;');
        const mapping = await run('({before:window.__snap.records.before.report.devices[0].id,after:window.__snap.records.after.report.devices[0].id})');
        await choose(`window.__snap.pairHost.querySelector('select[data-before-id="${mapping.before}"]')`, mapping.after);
        assert.equal(await run('window.__snap.report'), null, 'Changing pairing invalidates the displayed comparison');
        await click('window.__snap.compareButton'); await compared();
        assert.ok(await run('window.__snap.report.devices.some(device=>device.pairing==="manual")'));
        await click('window.__snap.openBefore'); await until(() => run('window.__app.active.toolKind==="device"'), 'open stored report');
        assert.ok(await run('window.__app.active.report.devices.length>0'));
        assert.match(await run('window.__app.active.status.textContent'), /Saved snapshot/);
        await run('window.__inspector=window.__app.active;void 0;');
        assert.equal(await run('window.__inspector.includeConfig.checked'), false, 'Configuration collection remains opt-in');
        await click('window.__inspector.snapshotButton'); await until(() => run('Boolean(document.querySelector(".modal input"))'), 'snapshot name prompt');
        const malicious = '<img src=x onerror="window.__snapshotInjected=true">';
        await run(`document.querySelector('.modal input').value=${JSON.stringify(malicious)};void 0;`);
        await click('document.querySelector(".modal footer .primary")');
        await until(() => run('!window.__inspector.loading'), 'save named snapshot');
        assert.match(await run('window.__inspector.status.textContent'), /Saved snapshot/);
        await run('window.__app.activate(window.__snap);window.__snap.refresh().then(()=>true)');
        assert.equal(await run('window.__snap.snapshots.length'), 3);
        assert.equal(await run('Boolean(window.__snapshotInjected || window.__snap.el.querySelector("img"))'), false);
        await choose('window.__snap.before', initial.before); await until(() => run('!window.__snap.busy'), 'before selected');
        await choose('window.__snap.after', initial.after); await until(() => run('!window.__snap.busy'), 'after selected');
        await click('window.__snap.compareButton'); await compared();
        for (const [width, height] of [[900, 560], [1400, 880]]) {
          await setViewport(win, run, width, height); await pause(50);
          const geometry = await run('({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bottom:window.__snap.el.getBoundingClientRect().bottom,contentHeight:window.__snap.content.getBoundingClientRect().height})');
          assert.ok(geometry.documentWidth<=geometry.width+2&&geometry.bottom<=geometry.height+2&&geometry.contentHeight>=99, JSON.stringify(geometry));
          for (const control of ['before', 'after', 'compareButton', 'exportButton', 'category', 'changeStatus', 'search']) {
            const box = await run(`(() => {const el=window.__snap.${control};el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};})()`);
            assert.ok(box.left>=-2&&box.top>=-2&&box.right<=box.width+2&&box.bottom<=box.height+2, control+JSON.stringify(box));
          }
        }
        await click('window.__snap.removeAfter'); await until(() => run('Boolean(document.querySelector(".modal"))'), 'delete prompt');
        await click('document.querySelector(".modal footer button:not(.danger)")'); await until(() => run('!window.__snap.busy'), 'cancel deletion');
        assert.equal(await run('(async()=> (await window.api.invoke("tools:snapshotList")).snapshots.length)()'), 3);
        await click('window.__snap.removeAfter'); await until(() => run('Boolean(document.querySelector(".modal"))'), 'delete prompt again');
        await click('document.querySelector(".modal footer .danger")'); await until(() => run('!window.__snap.busy'), 'confirmed deletion');
        assert.equal(await run('(async()=> (await window.api.invoke("tools:snapshotList")).snapshots.length)()'), 2);
        assert.equal(await run('window.__snap.snapshots.some(item=>item.id===' + JSON.stringify(initial.after) + ')'), false);
        assert.equal(await run('window.__app.jobs.size'), 0);
        console.log('SNAPSHOT_UI_PASS: real local store, explicit demo, snapshot save/open/delete, before/after comparisons, manual pairing, source evidence, JSON, safe AI context and responsive layout; no network device was queried.');
        finish(0);
      } catch (error) { finish(1, error); }
    });
  });
  require('../src/main/main');
}

module.exports = { runSnapshotUiTests };
if (process.versions.electron && process.argv.includes('--snapshot-ui-fixture')) fixture().catch((error) => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runSnapshotUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch((error) => { console.error(error); process.exitCode = 1; });
