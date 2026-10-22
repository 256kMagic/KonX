'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { const end = Date.now() + 10000; while (!(await check())) { if (Date.now() > end) throw new Error('Timed out: ' + label); await pause(20); } }
async function runWorkspacePanelsUiTests(test) {
  await test('workspace panels: real terminal survives floating, dragging, resizing, docking, split changes and geometry-only restart', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-panels-ui-'));
    const sockets = new Set(); let connections = 0, child;
    const server = net.createServer(socket => { connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      socket.write('PANELS_FIXTURE_READY\r\n'); socket.on('data', bytes => socket.write(bytes)); });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      for (const phase of ['exercise', 'restart']) {
        let output = '';
        const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_PANELS_UI_ROOT: root, KONX_PANELS_UI_PHASE: phase,
          KONX_PANELS_UI_PORT: String(server.address().port), KONX_CAPTURE: '', KONX_DEMO: '' };
        delete env.ELECTRON_RUN_AS_NODE;
        child = spawn(require('electron'), [__filename, '--panels-ui-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const collect = bytes => { output = (output + bytes).slice(-1024 * 1024); }; child.stdout.on('data', collect); child.stderr.on('data', collect);
        const code = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('Panels fixture timed out\n' + output)); }, 80000);
          child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
        });
        assert.equal(code, 0, output); assert.match(output, new RegExp('PANELS_UI_PASS ' + phase));
      }
      assert.equal(connections, 1, 'moving panels or restarting geometry must not establish another connection');
      const saved = JSON.parse(fs.readFileSync(path.join(root, 'profile', 'settings.json'), 'utf8')).workspaceGeometry;
      assert.equal(saved.version, 1); assert.doesNotMatch(JSON.stringify(saved), /PANELS|127\.0\.0\.1|password|sessionId|tabId/);
      if (process.env.KONX_PANELS_UI_SCREENSHOTS) { const dest = path.resolve(process.env.KONX_PANELS_UI_SCREENSHOTS); fs.mkdirSync(dest, { recursive: true });
        for (const file of fs.readdirSync(root).filter(file => file.endsWith('.png'))) fs.copyFileSync(path.join(root, file), path.join(dest, file)); }
    } finally {
      if (child && child.exitCode == null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; }
      for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-panels-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
async function fixture() {
  const { app, BrowserWindow, dialog, shell } = require('electron');
  const root = path.resolve(process.env.KONX_PANELS_UI_ROOT || ''), phase = process.env.KONX_PANELS_UI_PHASE;
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-panels-ui-'));
  assert.equal(path.resolve(process.env.KONX_USERDATA), path.join(root, 'profile'));
  const unexpected = action => { throw new Error('Panels fixture unexpectedly invoked ' + action); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, engine: null, missing: false, error: 'Offline panels fixture', npcap: { available: false }, builtin: { available: false } });
  require('../src/main/ai').AIClient.prototype.run = async () => unexpected('AI'); shell.openExternal = async () => unexpected('browser');
  dialog.showOpenDialog = async () => unexpected('file open'); dialog.showSaveDialog = async () => unexpected('file save'); dialog.showErrorBox = (title, message) => unexpected(title + ': ' + message);
  let finished = false;
  const finish = async (code, error) => { if (finished) return; finished = true; if (error) console.error(error.stack || error);
    for (const win of BrowserWindow.getAllWindows()) { await win.webContents.session.flushStorageData(); win.destroy(); } app.exit(code); };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true); win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') console.error(details.message); });
    win.webContents.once('did-finish-load', async () => {
      const run = code => win.webContents.executeJavaScript(code).catch(error => { throw new Error(error.message + '\nExpression: ' + code.slice(0, 700)); });
      const point = expression => run(`(()=>{const e=${expression};if(!e)throw new Error('Missing element');e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
      const click = async expression => { const p = await point(expression); win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p }); win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p }); await pause(40); };
      const drag = async (expression, dx, dy, cancel = false) => {
        const p = await point(expression); win.webContents.sendInputEvent({ type: 'mouseMove', ...p });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p });
        for (let i = 1; i <= 5; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x + dx * i / 5), y: Math.round(p.y + dy * i / 5), movementX: Math.round(dx / 5), movementY: Math.round(dy / 5) }); await pause(20); }
        if (cancel) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' }); }
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: p.x + dx, y: p.y + dy }); await pause(60);
      };
      const bounds = () => run('({...window.__app.workspaceLayout.floating.get(window.__panelTab).bounds})');
      try {
        await until(() => run('Boolean(window.__app?.workspaceLayout)'), 'workspace ready'); await setViewport(win, run, 1400, 900);
        if (phase === 'restart') {
          const expected = JSON.parse(fs.readFileSync(path.join(root, 'geometry.json'), 'utf8'));
          assert.deepEqual(await run('window.__app.workspaceLayout.get().geometry'), expected);
          assert.equal(await run('window.__app.tabs.filter(tab=>tab.kind==="terminal").length'), 0);
          assert.equal(await run('window.__app.workspaceLayout.floating.size'), 0);
          console.log('PANELS_UI_PASS restart'); await finish(0); return;
        }
        await run(`window.__panelTab=window.__app.openTerminal({protocol:'raw',host:'127.0.0.1',port:${Number(process.env.KONX_PANELS_UI_PORT)},name:'Panels live peer'},{name:'Panels live peer',protocol:'raw'});window.__originalPanel=window.__panelTab.el;window.__originalTerminal=window.__panelTab.term;true;`);
        await until(() => run('window.__panelTab.state==="connected"'), 'real raw peer');
        await run(`window.__app.showHome();window.__homePanel=window.__app.active;window.__app.saveSettings({uiLayout:'workbench'}).then(()=>{window.__app.workspaceLayout.pin('companion',window.__homePanel.id);window.__app.activate(window.__panelTab);})`);
        await click('window.__app.workspaceLayout.floatButton');
        assert.equal(await run('window.__app.workspaceLayout.placement(window.__panelTab)'), 'floating');
        assert.equal(await run('[...document.querySelectorAll(".workspace-pane-select option")].some(option=>option.value===window.__panelTab.id)'), false, 'floating view must not also occupy a docked selector');
        const beforeDrag = await bounds(); await drag('document.querySelector(".workspace-float-title")', 70, 25); const moved = await bounds();
        assert.ok(moved.x > beforeDrag.x + 20 && moved.y > beforeDrag.y + 10);
        await drag('document.querySelector(".workspace-float-resize[data-edge=se]")', 45, 35); const resized = await bounds();
        assert.ok(resized.width > moved.width + 10 && resized.height > moved.height + 10);
        await drag('document.querySelector(".workspace-float-title")', -40, -20, true); assert.deepEqual(await bounds(), resized, 'Escape restores gesture start');
        await click(`document.querySelector('button[aria-label="Maximize floating panel"]')`);
        assert.deepEqual(await bounds(), await run('({x:0,y:0,width:window.__app.views.clientWidth,height:window.__app.views.clientHeight})'));
        await click(`document.querySelector('button[aria-label="Restore floating panel"]')`); assert.deepEqual(await bounds(), resized);
        await setViewport(win, run, 900, 560); await pause(100);
        const small = await bounds(), viewport = await run('({width:window.__app.views.clientWidth,height:window.__app.views.clientHeight})');
        assert.ok(small.x >= 0 && small.y >= 0 && small.x + small.width <= viewport.width + 1 && small.y + small.height <= viewport.height + 1);
        await run('window.__app.workspaceLayout.float(window.__panelTab,{x:20,y:20,width:500,height:290});true;'); await pause(100);
        fs.writeFileSync(path.join(root, 'workspace-float-900.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
        await click(`document.querySelector('button[aria-label="Dock floating panel"]')`);
        assert.equal(await run('window.__app.workspaceLayout.placement(window.__panelTab)'), 'docked');
        await run('window.__app.workspaceLayout.float(window.__panelTab);true;');
        await run(`(()=>{const d=new DataTransfer();d.setData('text/x-konx-tab',window.__panelTab.id);document.querySelector('.workspace-pane[data-slot="companion"]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:d}));return true;})()`);
        await until(() => run('window.__app.workspaceLayout.get().companionId===window.__panelTab.id'), 'drop docks into companion');
        await run('window.__app.workspaceLayout.float(window.__panelTab);true;');
        await click('window.__app.workspaceLayout.resetButton');
        await until(() => run('window.__app.workspaceLayout.floating.size===0'), 'reset docks floating views');
        assert.equal(await run('window.__app.workspaceLayout.get().geometry.ratios.workbench.columns'), 0.5);
        assert.equal(await run('window.__panelTab.state'), 'connected');
        await run('window.__app.workspaceLayout.pin("primary",window.__homePanel.id);true;');
        const rowsBefore = await run('window.__app.workspaceLayout.get().geometry.ratios.workbench.rows');
        await drag('document.querySelector(".workspace-splitter[data-axis=rows]")', 0, 65);
        assert.ok(await run('window.__app.workspaceLayout.get().geometry.ratios.workbench.rows') > rowsBefore + 0.04);
        await setViewport(win, run, 1400, 900); await pause(100);
        const columnsBefore = await run('window.__app.workspaceLayout.get().geometry.ratios.workbench.columns');
        await drag('document.querySelector(".workspace-splitter[data-axis=columns]")', 70, 0);
        assert.ok(await run('window.__app.workspaceLayout.get().geometry.ratios.workbench.columns') > columnsBefore + 0.04);
        await run('window.__panelTab.sendText("PANELS_AFTER_MOVES\\r");true;');
        await until(() => run(String.raw`Array.from({length:window.__panelTab.term.buffer.active.length},(_,i)=>window.__panelTab.term.buffer.active.getLine(i)?.translateToString()).join('\n').includes('PANELS_AFTER_MOVES')`), 'same connection still exchanges bytes');
        assert.equal(await run('window.__panelTab.el===window.__originalPanel&&window.__panelTab.term===window.__originalTerminal&&window.__panelTab.state==="connected"'), true);
        assert.equal(await run('new Set(window.__app.workspaceLayout.get().visibleIds).size===window.__app.workspaceLayout.get().visibleIds.length'), true);
        await run('window.__app.workspaceLayout.saveGeometry');
        fs.writeFileSync(path.join(root, 'geometry.json'), JSON.stringify(await run('window.__app.workspaceLayout.get().geometry')));
        console.log('PANELS_UI_PASS exercise'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require('../src/main/main');
}
module.exports = { runWorkspacePanelsUiTests };
if (process.versions.electron && process.argv.includes('--panels-ui-fixture')) fixture().catch(error => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) runWorkspacePanelsUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
