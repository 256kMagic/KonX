'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!(await read())) { if (Date.now() >= deadline) throw new Error('Timed out: ' + label); await pause(25); }
}

async function runWorkspaceShortcutsUiTests(test) {
  await test('workspace shortcuts: real split/popout controls retain two consoles, focus, logging and safe delayed layout changes', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-workspace-shortcuts-'));
    let child;
    try {
      const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_WORKSPACE_SHORTCUTS_ROOT: root, KONX_CAPTURE: '', KONX_DEMO: '' };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--workspace-shortcuts-ui'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const collect = data => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Workspace shortcut fixture timed out\n' + output)); }, 90000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', value => { clearTimeout(timer); resolve(value); });
      });
      assert.equal(code, 0, output); assert.match(output, /WORKSPACE_SHORTCUTS_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; }
      assert.equal(path.dirname(fs.realpathSync(root)), base); assert.ok(path.basename(root).startsWith('konx-workspace-shortcuts-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, dialog, shell, screen } = require('electron');
  const root = fs.realpathSync(process.env.KONX_WORKSPACE_SHORTCUTS_ROOT);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-workspace-shortcuts-'));
  assert.equal(path.resolve(process.env.KONX_USERDATA), path.join(root, 'profile'));
  let screenshots;
  if (process.env.KONX_WORKSPACE_SHORTCUTS_SCREENSHOTS) {
    const review = fs.realpathSync(path.join(__dirname, '../review')), requested = path.resolve(process.env.KONX_WORKSPACE_SHORTCUTS_SCREENSHOTS);
    const relative = path.relative(review, requested); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.mkdirSync(requested, { recursive: true }); assert.equal(fs.realpathSync(requested), requested); screenshots = requested;
  }
  const peers = [], logFile = path.join(root, 'split-console.txt');
  let connections = 0, closes = 0, finished = false, main;
  const rendererErrors = [];
  const server = net.createServer(socket => {
    const peer = { socket, input: '' }; peers.push(peer); connections++;
    socket.on('error', () => {}); socket.once('close', () => { closes++; });
    socket.on('data', data => { peer.input += data.toString(); socket.write(data); });
    socket.write('SPLIT_CONSOLE_' + connections + '_READY\r\nRouter# ');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const unexpected = operation => { throw new Error('Unexpected shortcut fixture operation: ' + operation); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, error: 'Isolated shortcut fixture', builtin: { available: false } });
  require('../src/main/ai').AIClient.prototype.run = async () => unexpected('AI provider');
  shell.openExternal = async () => unexpected('external browser');
  dialog.showOpenDialog = dialog.showSaveDialog = async () => unexpected('native file dialog');
  dialog.showErrorBox = (title, message) => unexpected(title + ': ' + message);
  const { ConnectionManager } = require('../src/main/connections'), open = ConnectionManager.prototype.open;
  let manager;
  ConnectionManager.prototype.open = function (...args) { manager = this; return open.apply(this, args); };
  const { Store } = require('../src/main/store'), setSettings = Store.prototype.setSettings;
  let settingsMode, releaseSettings, workbenchWrites = 0;
  Store.prototype.setSettings = function (patch) {
    if (patch.uiLayout === 'workbench') {
      workbenchWrites++; const mode = settingsMode; settingsMode = null;
      if (mode === 'fail') throw new Error('Fixture layout save failed before writing.');
      if (mode === 'hold') return new Promise((resolve, reject) => {
        releaseSettings = () => { try { resolve(setSettings.call(this, patch)); } catch (error) { reject(error); } };
      });
    }
    return setSettings.call(this, patch);
  };
  const finish = async (code, error) => {
    if (finished) return; finished = true;
    if (error) console.error(error.stack || error);
    for (const peer of peers) peer.socket.destroy(); await new Promise(resolve => server.close(resolve));
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
    app.exit(code);
  };
  const fail = error => { finish(1, error instanceof Error ? error : new Error(String(error))).catch(error => { console.error(error); app.exit(1); }); };
  process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
  app.on('browser-window-created', (_event, win) => {
    if (win.isDestroyed()) return;
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true); win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
    if (main) return; main = win;
    main.webContents.once('did-finish-load', async () => {
      const run = code => main.webContents.executeJavaScript(code).catch(error => { throw new Error(error.message + '\nExpression: ' + code.slice(0, 1000)); });
      const popup = () => BrowserWindow.getAllWindows().find(win => win !== main && !win.isDestroyed());
      const click = async (expression, host = main) => {
        let point;
        await until(async () => {
          point = await run(`(()=>{const e=${expression};if(!e)return{ready:false};e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=e.ownerDocument.elementFromPoint(x,y);return{x,y,ready:!e.disabled&&r.width>0&&r.height>0&&(hit===e||e.contains(hit))};})()`);
          return point.ready;
        }, 'reachable ' + expression);
        delete point.ready; host.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        host.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        host.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(35);
      };
      const split = `document.querySelector('[data-action="split-screen"]')`;
      const popout = `document.querySelector('[data-action="popout-active"]')`;
      const single = `document.querySelector('[data-action="single-view"]')`;
      const waitLayout = name => until(() => run(`window.__app.workspaceLayout.model.layout===${JSON.stringify(name)}`), name + ' layout');
      const capture = async (name, host = main) => { if (!screenshots) return; await pause(250); fs.writeFileSync(path.join(screenshots, name + '.png'), (await host.webContents.capturePage(undefined, { stayHidden: true })).toPNG()); };
      const buffer = tab => run(String.raw`(()=>{const b=window.${tab}.term.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\n');})()`);
      const stable = async () => {
        assert.equal(connections, 2, 'workspace controls must not create another transport'); assert.equal(closes, 0);
        assert.equal(await run('__a.el===__aNode&&__b.el===__bNode&&__a.term===__aTerm&&__b.term===__bTerm&&__a.state==="connected"&&__b.state==="connected"'), true);
        assert.equal(manager.conns.get(await run('__a.id')), connectionA); assert.equal(manager.conns.get(await run('__b.id')), connectionB);
        assert.equal(await run('!!__a.info.logging'), true, 'moving views retains the active log');
      };
      let connectionA, connectionB;
      try {
        await until(() => run('Boolean(window.__app?.workspaceLayout)'), 'workspace ready'); await setViewport(main, run, 1400, 900);
        await run(`__app.saveSettings({uiLayout:'classic',uiTheme:'dark',themeAnimations:false,fontSize:14})`);
        await run(`window.__a=__app.openTerminal({protocol:'raw',host:'127.0.0.1',port:${server.address().port},logging:{path:${JSON.stringify(logFile)}}},{name:'Console A',protocol:'raw'});true;`);
        await until(() => run('__a.state==="connected"'), 'first console');
        await click(split); await waitLayout('workbench');
        assert.equal(await run('__app.workspaceLayout.model.primaryId===__a.id&&__app.workspaceLayout.model.companionId===null'), true, 'one console leaves an explicit empty second pane');
        assert.equal(connections, 1); assert.equal(await run('document.querySelector(".workspace-companion .workspace-empty").textContent.length>0'), true);
        await capture('split-empty-companion');
        await click(single); await waitLayout('classic');
        assert.equal(await run('__a.state'), 'connected');
        await run(`window.__b=__app.openTerminal({protocol:'raw',host:'127.0.0.1',port:${server.address().port}},{name:'Console B',protocol:'raw'});true;`);
        await until(() => run('__b.state==="connected"'), 'second console');
        await until(async () => (await buffer('__a')).includes('SPLIT_CONSOLE_1_READY') && (await buffer('__b')).includes('SPLIT_CONSOLE_2_READY'), 'both console buffers');
        await run('__a.toggleLog()'); await until(() => run('!!__a.info.logging'), 'owned console log');
        await run('window.__aNode=__a.el;window.__bNode=__b.el;window.__aTerm=__a.term;window.__bTerm=__b.term;__app.activate(__a);true;');
        connectionA = manager.conns.get(await run('__a.id')); connectionB = manager.conns.get(await run('__b.id'));
        await click(split); await waitLayout('workbench');
        await until(() => run('__app.workspaceLayout.model.primaryId===__a.id&&__app.workspaceLayout.model.companionId===__b.id'), 'two existing consoles selected');
        assert.equal(await run('__app.active===__a'), true, 'split preserves explicit source as command target');
        const pair = await run('[__app.workspaceLayout.model.primaryId,__app.workspaceLayout.model.companionId]');
        await click(split); assert.deepEqual(await run('[__app.workspaceLayout.model.primaryId,__app.workspaceLayout.model.companionId]'), pair);
        await stable();
        await click(single); await waitLayout('classic');
        await run('__app.saveSettings({uiLayout:"focus"})'); await waitLayout('focus');
        await click(split); await waitLayout('workbench'); await click(single); await waitLayout('focus');
        assert.equal((await run('window.api.invoke("settings:get")')).uiLayout, 'focus', 'Single view restores the previous Focus layout');
        await run('__app.saveSettings({uiLayout:"workbench"})');
        await run('(async()=>{window.__note=await __app.openNotepad();__app.workspaceLayout.pin("companion",__note.id);__app.activate(__a);return true;})()');
        await run('__app.saveSettings({uiLayout:"classic"})'); await click(split); await waitLayout('workbench');
        assert.equal(await run('__app.workspaceLayout.model.companionId===__b.id'), true, 'fresh split prefers the other console over a stale notepad companion');
        await run('__app.closeTab(__note)'); await click(single); await waitLayout('classic');
        for (const layout of ['incident-desk', 'operations-wall']) {
          await run(`__app.saveSettings({uiLayout:${JSON.stringify(layout)}})`); await waitLayout(layout);
          await click(split); await waitLayout('workbench'); await click(single); await waitLayout('classic');
          assert.equal((await run('window.api.invoke("settings:get")')).uiLayout, 'classic', 'Single view uses Classic after ' + layout);
        }
        await click(split); await waitLayout('workbench'); await stable();
        await click(`document.querySelector('.workspace-pane[data-slot="companion"] .workspace-pane-focus')`);
        assert.equal(await run('__app.active===__b'), true); main.webContents.sendInputEvent({ type: 'char', keyCode: 'B' });
        await until(() => peers[1].input.includes('B'), 'only focused console receives typed input'); assert.equal(peers[0].input.includes('B'), false);
        const separator = await run(`(()=>{const r=document.querySelector('.workspace-splitter[data-axis="columns"]').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
        const beforeRatio = await run('__app.workspaceLayout.geometry.ratios.workbench.columns');
        main.webContents.sendInputEvent({ type: 'mouseMove', ...separator }); main.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...separator });
        main.webContents.sendInputEvent({ type: 'mouseMove', x: separator.x + 75, y: separator.y, movementX: 75, movementY: 0 });
        main.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: separator.x + 75, y: separator.y });
        await until(async () => await run('__app.workspaceLayout.geometry.ratios.workbench.columns') > beforeRatio + 0.04, 'native divider resize');
        await capture('split-two-consoles');
        await click(popout);
        await until(async () => popup() && await run('__app.workspaceLayout.placement(__b)==="external"'), 'Pop out shortcut creates native child');
        let child = popup(); assert.equal(child.isMovable(), true);
        const originalBounds = child.getBounds(), area = screen.getDisplayMatching(originalBounds).workArea;
        const wanted = { x: area.x + 25, y: area.y + 35, width: Math.min(800, area.width - 50), height: Math.min(600, area.height - 70) };
        child.setBounds(wanted); await until(() => child.getBounds().x === wanted.x && child.getBounds().y === wanted.y, 'native child can be moved');
        assert.notDeepEqual(child.getBounds(), originalBounds);
        await stable();
        await run('__b.term.focus();true;'); child.webContents.sendInputEvent({ type: 'char', keyCode: 'P' });
        await until(() => peers[1].input.includes('P'), 'input follows popped-out console'); assert.equal(peers[0].input.includes('P'), false);
        await capture('console-native-popout', child);
        await click(`__b.el.ownerDocument.querySelector('[aria-label="Dock back to KonX"]')`, child);
        await until(() => !popup(), 'Dock back returns child');
        assert.equal(await run('__app.workspaceLayout.placement(__b)'), 'docked'); await stable();
        // Split can safely return an already popped-out source through its owner.
        await click(popout); await until(() => !!popup(), 'second native child');
        await click(split); await until(() => !popup(), 'Split screen docks external source');
        assert.equal(await run('__app.workspaceLayout.model.primaryId===__b.id||__app.workspaceLayout.model.companionId===__b.id'), true); await stable();
        await run('__app.workspaceLayout.float(__a);__app.activate(__a);__app.tabMenu(180,100,__a);true;');
        await click(`[...document.querySelectorAll('.ctx .item')].find(e=>e.textContent.startsWith('Split screen'))`);
        assert.equal(await run('__app.workspaceLayout.placement(__a)'), 'docked'); await stable();
        await setViewport(main, run, 900, 640);
        await until(() => run('__app.workspaceLayout.splitAxes.includes("rows")'), 'narrow split uses responsive stacked panes');
        for (const expression of [split, popout]) {
          const geometry = await run(`(()=>{const e=${expression},r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};})()`);
          assert.ok(geometry.left >= 0 && geometry.right <= geometry.width + 2 && geometry.top >= 0 && geometry.bottom <= geometry.height + 2, JSON.stringify(geometry));
        }
        await capture('split-controls-900');
        await setViewport(main, run, 1400, 900); await click(single); await waitLayout('classic');
        settingsMode = 'fail'; await click(split);
        await until(() => run(`!${split}.disabled&&document.body.textContent.includes('Fixture layout save failed')`), 'save failure reported and shortcut restored');
        assert.equal(await run('__app.workspaceLayout.model.layout'), 'classic');
        assert.equal((await run('window.api.invoke("settings:get")')).uiLayout, 'classic'); await stable();
        await click(split); await waitLayout('workbench'); await stable();
        await click(single); await waitLayout('classic');
        peers[0].socket.write('LOG_AFTER_SPLIT_AND_POPOUT\r\n'); await until(async () => (await buffer('__a')).includes('LOG_AFTER_SPLIT_AND_POPOUT'), 'original output stream retained');
        await run('__a.toggleLog()'); await until(() => run('!__a.info.logging'), 'log safely stopped');
        assert.equal(fs.readFileSync(logFile, 'utf8').split('LOG_AFTER_SPLIT_AND_POPOUT').length - 1, 1);
        await run('__app.popouts.open(__b)'); await until(() => !!popup(), 'native child before held layout change');
        await run('__app.activate(__a);true;');
        settingsMode = 'hold'; const writes = workbenchWrites; await click(split); await until(() => typeof releaseSettings === 'function', 'layout save held at store boundary');
        await run(`${split}.click();${split}.click();true;`); assert.equal(workbenchWrites, writes + 1, 'repeated clicks share the pending split request');
        assert.equal(await run(`${split}.disabled`), true);
        assert.equal(await run('document.querySelector(".workspace-float-active").disabled'), true, 'Float is disabled while Split owns the transition');
        assert.equal(await run('(()=>{let ran=false;const result=__app.workspaceLayout.requestPlacement(()=>{ran=true});return result===false&&!ran})()'), true, 'placement gate does not run competing callbacks');
        await run('document.querySelector(".workspace-float-active").click();true;');
        for (const label of ['Float in workspace', 'Pop out to window']) {
          await run('__app.tabMenu(180,100,__a);true;');
          assert.equal(await run(`(()=>{const item=[...document.querySelectorAll('.ctx .item')].find(e=>e.textContent.startsWith(${JSON.stringify(label)}));const disabled=item.classList.contains('disabled');item.click();return disabled})()`), true, label + ' is disabled and its callback is guarded');
        }
        assert.equal(await run('__app.workspaceLayout.placement(__a)'), 'docked');
        assert.equal(BrowserWindow.getAllWindows().length, 2, 'competing actions cannot create another child');
        assert.equal(await run(`__b.el.ownerDocument.querySelector('[aria-label="Dock back to KonX"]').disabled`), true, 'child placement button is disabled during Split');
        popup().close(); await until(() => !popup(), 'native X still docks through internal cleanup while Split is pending');
        assert.equal(await run('__app.workspaceLayout.placement(__b)==="docked"&&__b.state==="connected"'), true);
        assert.equal(closes, 0, 'native closure retains the transport');
        const closedId = await run('__a.id'); await run('__app.closeTab(__a)'); await until(() => closes === 1, 'closed source disconnects its own transport');
        releaseSettings(); await until(() => run(`!${split}.disabled`), 'late save completed');
        const state = await run('__app.workspaceLayout.get()'); assert.equal(state.visibleIds.includes(closedId), false);
        assert.equal([state.primaryId, state.companionId].includes(closedId), false, 'late split never pins a disposed source');
        assert.equal(await run('__b.state'), 'connected'); assert.equal(connections, 2); assert.equal(closes, 1);
        assert.equal(await run('__app.jobs.size'), 0);
        assert.deepEqual(rendererErrors, []);
        console.log('WORKSPACE_SHORTCUTS_UI_PASS'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require('../src/main/main');
}
module.exports = { runWorkspaceShortcutsUiTests };
if (process.argv.includes('--workspace-shortcuts-ui')) fixture().catch(error => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) runWorkspaceShortcutsUiTests(async (name, run) => { await run(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
