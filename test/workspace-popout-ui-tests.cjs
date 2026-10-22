'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!(await read())) { if (Date.now() >= end) throw new Error('Timed out: ' + label); await pause(25); }
}
async function runWorkspacePopoutUiTests(test) {
  await test('workspace popouts: native windows preserve live terminal, editor, dialogs, theme and docking without reconnecting', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-popout-ui-'));
    let child;
    try {
      const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_POPOUT_UI_ROOT: root, KONX_CAPTURE: '', KONX_DEMO: '' };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--popout-ui'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const collect = data => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Popout fixture timed out\n' + output)); }, 120000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0, output); assert.match(output, /WORKSPACE_POPOUT_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) child.kill();
      assert.equal(path.dirname(fs.realpathSync(root)), base); assert.ok(path.basename(root).startsWith('konx-popout-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
async function fixture() {
  const { app, BrowserWindow, dialog, shell } = require('electron');
  const root = fs.realpathSync(process.env.KONX_POPOUT_UI_ROOT);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-popout-ui-'));
  const peers = new Set(); let connections = 0, closes = 0, written = '', finished = false, main;
  const server = net.createServer(socket => {
    connections++; peers.add(socket); socket.on('error', () => {});
    socket.on('close', () => { closes++; peers.delete(socket); });
    socket.on('data', bytes => { written += bytes.toString(); socket.write(bytes); });
    socket.write('LIVE_POP_OUT_BUFFER\r\nRouter# ');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const unexpected = operation => { throw new Error('Unexpected external operation: ' + operation); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, error: 'Isolated popout fixture', builtin: { available: false } });
  shell.openExternal = async () => unexpected('external browser');
  dialog.showOpenDialog = dialog.showSaveDialog = async () => unexpected('native file dialog');
  dialog.showMessageBoxSync = () => 1;
  const finish = async (code, error) => {
    if (finished) return; finished = true;
    if (error) console.error(error.stack || error);
    for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve));
    for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code);
  };
  process.on('uncaughtException', error => { void finish(1, error); });
  process.on('unhandledRejection', error => { void finish(1, error); });
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    if (main) return;
    main = win;
    main.webContents.once('did-finish-load', async () => {
      const run = code => main.webContents.executeJavaScript(code).catch(error => { throw new Error(error.message + '\nRenderer check: ' + code); });
      main.webContents.on('console-message', event => { if (event.level === 'error') console.error('Renderer: ' + event.message); });
      const popup = () => BrowserWindow.getAllWindows().find(win => win !== main);
      const click = async (win, selector) => {
        const point = await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(30);
      };
      try {
        await until(() => run('Boolean(window.__app?.popouts)'), 'application ready');
        await run(`window.__t=__app.openTerminal({protocol:'raw',host:'127.0.0.1',port:${server.address().port}},{name:'Pop-out terminal',protocol:'raw'});true;`);
        await until(() => run('__t.state==="connected"'), 'loopback terminal');
        await run('window.__termObject=__t.term; window.__tabNode=__t.tabElement;true;');
        // Actual tab menu, not a second app/connection, opens the native window.
        await run(`__t.tabElement.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:200,clientY:100}));[...document.querySelectorAll('.ctx .item')].find(e=>e.textContent.includes('Pop out to window')).click();true;`);
        await until(async () => popup() && await run('__app.workspaceLayout.placement(__t)==="external"'), 'native terminal popout');
        let child = popup();
        const prefs = child.webContents.getLastWebPreferences();
        assert.equal(prefs.sandbox, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true);
        assert.equal(await run('__t.term===__termObject&&__t.tabElement===__tabNode'), true);
        assert.equal(await run(`(()=>{const original=__app.popouts.focus;let calls=0;__app.popouts.focus=()=>calls++;try{__t.tabElement.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));return calls;}finally{__app.popouts.focus=original;}})()`), 0, 'Drag start must not focus the native child');
        main.minimize();
        await run('__t.term.focus();true;'); child.webContents.sendInputEvent({ type: 'char', keyCode: 'X' });
        await until(() => written.includes('X'), 'popout terminal input');
        await until(() => run('__t.wrap.clientWidth>800&&__t.term.cols===__t.fit.proposeDimensions()?.cols'), 'initial popout layout');
        const cols = await run('__t.term.cols'); child.setSize(660, 440);
        await until(async () => await run('__t.term.cols') < cols, 'popout terminal resize').catch(async error => {
          throw new Error(error.message + ' ' + JSON.stringify({ before: cols, bounds: child.getBounds(), current: await run('({cols:__t.term.cols,active:__t.active,disposed:__t.disposed,ownerWidth:__t.el.ownerDocument.defaultView.innerWidth,width:__t.wrap.clientWidth,height:__t.wrap.clientHeight,expected:__t.fit.proposeDimensions()})') }));
        });
        await run(`__app.saveSettings({uiTheme:'light'})`);
        assert.equal(await child.webContents.executeJavaScript('document.documentElement.dataset.theme'), 'light');
        main.restore();
        app.quit(); await pause(150); // existing connection confirmation returns Cancel
        assert.equal(child.isDestroyed(), false); assert.equal(await run('__t.state'), 'connected');
        child.close();
        await until(() => !popup(), 'native X docks panel');
        assert.equal(await run('__t.el.ownerDocument===document&&__t.term===__termObject&&__t.state==="connected"'), true);
        assert.equal(connections, 1); assert.equal(closes, 0);
        await run(`__app.workspaceLayout.float(__t);__app.workspaceLayout.float(__t);true;`);
        assert.equal(await run(`document.querySelectorAll('.workspace-floating').length`), 1);
        await run(`__app.workspaceLayout.dock(__t);true;`);
        assert.equal(await run('__app.workspaceLayout.placement(__t)'), 'docked');

        await run(`(async()=>{window.__np=await __app.openNotepad();window.__draft=__np.newDoc({text:'draft retained'});window.__model=__np.current.model;return true;})()`);
        assert.equal(await run('__app.popouts.open(__np)'), true);
        child = popup();
        await run(`__np.editor.setSelection({startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:6});__np.editor.focus();true;`);
        await child.webContents.insertText('edited');
        assert.equal(await run('__model.getValue()'), 'edited retained');
        await run('__np.editor.trigger("fixture","undo");true;');
        assert.equal(await run('__model.getValue()'), 'draft retained');
        await run('__np.editor.trigger("fixture","actions.find");true;');
        assert.equal(await child.webContents.executeJavaScript('Boolean(document.querySelector(".find-widget"))'), true);
        // UI helpers must put menus and unsaved-close dialogs in the host window.
        await click(child, '.np-menu');
        assert.equal(await child.webContents.executeJavaScript('Boolean(document.querySelector(".ctx"))'), true);
        await child.webContents.executeJavaScript(`[...document.querySelectorAll('.ctx .item')].find(e=>e.textContent.startsWith('Close')&&!e.textContent.startsWith('Close all')).click();true;`);
        await until(() => child.webContents.executeJavaScript('Boolean(document.querySelector(".modal-back"))'), 'unsaved document close guard');
        child.close(); // dock with an unanswered dialog; retain the dialog in main
        await until(() => !popup(), 'editor native close docks');
        assert.equal(await run('Boolean(document.querySelector(".modal-back"))&&__np.current.model===__model'), true);
        await run(`[...document.querySelectorAll('.modal footer button')].find(e=>e.textContent==='Cancel').click();true;`);
        assert.equal(await run('__app.tabs.includes(__np)&&__model.getValue()==="draft retained"'), true);
        assert.equal(connections, 1); assert.equal(closes, 0);
        // Simultaneous popouts and reset return each original node exactly once.
        assert.equal(await run('__app.popouts.open(__t)'), true);
        assert.equal(await run('__app.popouts.open(__np)'), true);
        assert.equal(BrowserWindow.getAllWindows().length, 3);
        const terminalChild = BrowserWindow.getAllWindows().find(win => win !== main && win.getTitle().includes('Pop-out terminal'));
        const editorChild = BrowserWindow.getAllWindows().find(win => win !== main && win !== terminalChild);
        await click(terminalChild, '.popout-title');
        await run(`(async()=>{const {modal,h}=await import('./js/ui.js');window.__firstDialog=null;void modal({title:'First window',body:h('p','Independent dialog')}).then(value=>window.__firstDialog=value);return true;})()`);
        await click(editorChild, '.popout-title');
        await run(`(async()=>{const {modal,h}=await import('./js/ui.js');window.__secondDialog=null;void modal({title:'Second window',body:h('p','Independent dialog')}).then(value=>window.__secondDialog=value);return true;})()`);
        await click(terminalChild, '.modal footer .btn.primary');
        await until(() => run('__firstDialog===true'), 'first window dialog works while second window dialog is open');
        assert.equal(await editorChild.webContents.executeJavaScript('Boolean(document.querySelector(".modal-back"))'), true);
        await click(editorChild, '.modal footer .btn.primary');
        await until(() => run('__secondDialog===true'), 'second independent dialog');
        await run(`__app.workspaceLayout.reset()`);
        await until(() => BrowserWindow.getAllWindows().length === 1, 'workspace reset docks all windows');
        assert.equal(await run('__t.el.ownerDocument===document&&__np.el.ownerDocument===document&&__np.current.model===__model'), true);
        assert.equal(connections, 1); assert.equal(closes, 0);
        assert.equal(await run('__app.popouts.open(__np)'), true);
        popup().destroy();
        await until(() => run('__app.workspaceLayout.placement(__np)==="docked"&&__np.el.ownerDocument===document'), 'unexpected native destruction recovery');
        assert.equal(await run('__np.current.model===__model&&__model.getValue()==="draft retained"'), true);
        await run(`(async()=>{const {createComparisonDemo}=await import('./js/capture/sample-compare.mjs');const demo=createComparisonDemo();window.__cap=__app.openTool('capture');await __cap.loadBytes(demo.before.bytes,demo.before.name);window.__packets=__cap.packets;__cap.setFilter('tcp');return true;})()`);
        assert.equal(await run('__app.popouts.open(__cap)'), true);
        child = popup();
        const split = await child.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.cap-split').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
        const before = await run('__cap.left.querySelector(".cap-bottom").getBoundingClientRect().height');
        child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...split });
        child.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', buttons: ['left'], x: split.x, y: split.y - 45 });
        child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: split.x, y: split.y - 45 });
        await until(async () => await run('__cap.left.querySelector(".cap-bottom").getBoundingClientRect().height') > before + 20, 'capture splitter uses popout window');
        child.close(); await until(() => !popup(), 'capture redock');
        assert.equal(await run('__cap.packets===__packets&&__cap.dfilter.value==="tcp"&&__cap.packets.length===11'), true);
        console.log('WORKSPACE_POPOUT_UI_PASS'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require('../src/main/main');
}
if (process.argv.includes('--popout-ui')) fixture().catch(error => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) runWorkspacePopoutUiTests(async (name, run) => { await run(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { runWorkspacePopoutUiTests };
