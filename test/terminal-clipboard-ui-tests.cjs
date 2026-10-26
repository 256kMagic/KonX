'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) {
  const end = Date.now() + 12000;
  while (!(await read())) { if (Date.now() >= end) throw new Error('Timed out: ' + label); await pause(20); }
}
async function runTerminalClipboardUiTests(test) {
  await test('terminal clipboard UI: right-click preference, immediate highlight copy, confirmation, stale reads, persistence and popouts', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-clipboard-ui-'));
    let child;
    try {
      const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_CLIPBOARD_UI_ROOT: root, KONX_CAPTURE: '', KONX_DEMO: '' };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--clipboard-ui'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const collect = data => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Clipboard fixture timed out\n' + output)); }, 90000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0, output); assert.match(output, /TERMINAL_CLIPBOARD_UI_PASS/);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped;
      }
      const resolved = fs.realpathSync(root);
      assert.equal(path.dirname(resolved), base); assert.ok(path.basename(resolved).startsWith('konx-clipboard-ui-'));
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
async function fixture() {
  const { app, BrowserWindow, dialog, shell, clipboard } = require('electron');
  const root = fs.realpathSync(process.env.KONX_CLIPBOARD_UI_ROOT);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-clipboard-ui-'));
  const peers = new Set(); let input = '', copied = '', clipboardReads = 0, readOverride, finished = false, main;
  const server = net.createServer(socket => {
    peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket));
    socket.on('data', bytes => { input += bytes.toString(); });
    socket.write('HIGHLIGHT_TARGET second word\r\nRouter# ');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const unexpected = action => { throw new Error('Unexpected clipboard fixture operation: ' + action); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, error: 'Isolated clipboard fixture', builtin: { available: false } });
  shell.openExternal = async () => unexpected('external browser');
  dialog.showOpenDialog = dialog.showSaveDialog = async () => unexpected('native file dialog');
  clipboard.writeText = text => { copied = text; };
  clipboard.readText = () => { clipboardReads++; return readOverride ? readOverride() : copied; };
  const finish = async (code, error) => {
    if (finished) return; finished = true;
    if (error) console.error(error.stack || error);
    for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve));
    for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code);
  };
  process.on('uncaughtException', error => { void finish(1, error); });
  process.on('unhandledRejection', error => { void finish(1, error); });
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true); win.webContents.setBackgroundThrottling(false);
    if (main) return;
    main = win;
    main.webContents.once('did-finish-load', async () => {
      const run = code => main.webContents.executeJavaScript(code).catch(error => { throw new Error(error.message + '\nRenderer check: ' + code); });
      const popup = () => BrowserWindow.getAllWindows().find(win => win !== main);
      const point = () => run(`(()=>{const t=__t.term,b=t.buffer.active,r=t.element.querySelector('.xterm-screen').getBoundingClientRect(),target=Array.from({length:b.length},(_,i)=>i).find(i=>b.getLine(i)?.translateToString(true).includes('HIGHLIGHT_TARGET')),row=Math.max(0,(target??b.cursorY)-b.viewportY);return{x:Math.round(r.left+4),y:Math.round(r.top+(row+0.5)*r.height/t.rows),cell:r.width/t.cols};})()`);
      const mouse = async (win, at, button = 'left', count = 1) => {
        const { x, y } = at;
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        win.webContents.sendInputEvent({ type: 'mouseDown', button, clickCount: count, x, y });
        win.webContents.sendInputEvent({ type: 'mouseUp', button, clickCount: count, x, y });
        await pause(15);
      };
      const click = async (expression, win = main) => {
        let at;
        await until(async () => {
          at = await win.webContents.executeJavaScript(`(()=>{const e=${expression};if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}:null;})()`);
          return at;
        }, 'visible control ' + expression);
        await mouse(win, at);
      };
      const rightClick = async (win = main) => mouse(win, await point(), 'right');
      const noInputAfter = async (action, label) => { const before = input; await action(); await pause(160); assert.equal(input, before, label); };
      const drag = async (win = main) => {
        const at = await point(), x = Math.round(at.x + 10 * at.cell), y = at.y;
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: at.x, y });
        win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftbuttondown'], x, y });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
        await pause(20);
      };
      const clear = () => run('__t.term.clearSelection();__t.term.scrollToTop();__t.term.focus();true;');
      const settings = async () => {
        await run(`import('./js/settings.js').then(m=>{void m.settingsDialog(__app);return true;})`);
        await click(`[...document.querySelectorAll('.mtabs button')].find(e=>e.textContent==='Terminal')`);
      };
      const save = async () => {
        await click(`[...document.querySelectorAll('.modal footer button')].find(e=>e.textContent==='Save')`);
        await until(() => run('!document.querySelector(".modal-back")'), 'Settings closed');
      };
      const modalOpen = () => run('Boolean(document.querySelector(".modal-back"))');
      try {
        await until(() => run('Boolean(window.__app?.popouts)'), 'app ready');
        await setViewport(main, run, 1050, 760);
        assert.equal(await run('__app.settings.rightClick'), 'menu');
        assert.equal(await run('__app.settings.copyOnSelect'), true);
        await run(`window.__t=__app.openTerminal({protocol:'raw',host:'127.0.0.1',port:${server.address().port}},{name:'Clipboard terminal',protocol:'raw'});true;`);
        await until(() => run(`__t.state==="connected"&&Array.from({length:__t.term.buffer.active.length},(_,i)=>__t.term.buffer.active.getLine(i)?.translateToString(true)).some(s=>s?.includes('HIGHLIGHT_TARGET'))`), 'loopback terminal');
        copied = 'DEFAULT_OFF'; await noInputAfter(() => rightClick(), 'default right-click opens menu without pasting');
        assert.equal(clipboardReads, 0); assert.equal(await run('Boolean(document.querySelector(".ctx"))'), true);
        await run(`import('./js/ui.js').then(m=>m.closeMenu())`);
        await settings();
        assert.equal(await run(`document.querySelector('input[name="rightClick"]').checked`), false);
        assert.equal(await run(`document.querySelector('input[name="copyOnSelect"]').checked`), true);
        await click(`document.querySelector('input[name="rightClick"]')`); await save();
        await until(() => run('__app.settings.rightClick==="paste"'), 'saved right-click option');
        assert.equal(new (require('../src/main/store').Store)(path.join(root, 'profile'), {}).getSettings().rightClick, 'paste');
        await settings();
        assert.equal(await run(`document.querySelector('input[name="rightClick"]').checked`), true, 'existing saved paste enum reopens checked');
        await save(); await clear(); copied = 'RIGHT_CLICK'; await rightClick();
        await until(() => input === 'RIGHT_CLICK', 'right-click pastes');
        assert.equal(clipboardReads, 1); assert.equal(await run('Boolean(document.querySelector(".ctx"))'), false);
        await noInputAfter(async () => mouse(main, await point()), 'left-click only selects/focuses');
        console.log('CLIPBOARD_STAGE default menu/right-click checkbox/persistence');

        await clear(); copied = 'BEFORE_RAPID_HIGHLIGHT';
        await drag(); const selected = await run('__t.term.getSelection()');
        assert.ok(selected.startsWith('HIGHLIGHT'));
        const beforeRapid = input;
        // Clear and paste within the old 120 ms debounce window, using real
        // Chromium input and the normal renderer/main clipboard IPC boundary.
        await mouse(main, await point()); await rightClick();
        await until(() => input === beforeRapid+selected, 'rapid highlight-clear-right-click retains copied text');
        await noInputAfter(() => drag(), 'drag selection never pastes');
        for (const count of [2, 3]) {
          await clear(); await noInputAfter(async () => { const at = await point(); for (let n=1;n<=count;n++) await mouse(main, at, 'left', n); }, count+' clicks select without paste');
          assert.ok(await run('__t.term.hasSelection()'));
        }
        await settings(); await click(`document.querySelector('input[name="copyOnSelect"]')`); await save();
        await until(() => run('__app.settings.copyOnSelect===false'), 'automatic copy disabled');
        await clear(); copied = 'COPY_DISABLED'; await noInputAfter(() => drag(), 'selection with copy disabled does not paste');
        assert.equal(copied, 'COPY_DISABLED');
        console.log('CLIPBOARD_STAGE rapid selection/double/triple/copy checkbox');

        await clear(); copied = 'first\nsecond'; const beforeMultiline = input;
        await rightClick(); await until(modalOpen, 'multiline confirmation'); assert.equal(input, beforeMultiline);
        await click(`[...document.querySelectorAll('.modal footer button')].find(e=>e.textContent==='Cancel')`);
        assert.equal(input, beforeMultiline, 'cancel sends nothing');
        await rightClick(); await until(modalOpen, 'multiline confirmation again');
        await click(`document.querySelector('.modal footer .primary')`);
        await until(() => input === beforeMultiline+'first\rsecond', 'mouse approval pastes multiline input');
        copied = 'third\nfourth'; const beforeEnter = input;
        await rightClick(); await until(modalOpen, 'keyboard confirmation');
        await until(() => run('document.activeElement===document.querySelector(".modal footer .primary")'), 'confirmation focused');
        main.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
        main.webContents.sendInputEvent({type:'char',keyCode:'\r'});
        main.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
        await until(() => input === beforeEnter+'third\rfourth', 'Enter approval pastes multiline input');
        copied = 'OLD_CONNECTION\nMUST_NOT_SEND'; const beforeReconnect = input;
        await rightClick(); await until(modalOpen, 'connection-specific confirmation');
        await run('__t.disconnect();true;'); await until(() => run('__t.state==="disconnected"'), 'prompt disconnected');
        await run('__t.reconnect();true;'); await until(() => run('__t.state==="connected"'), 'prompt connection replaced');
        await click(`document.querySelector('.modal footer .primary')`); await pause(100);
        assert.equal(input, beforeReconnect, 'approval cannot send into a replaced connection');
        await clear(); for (const peer of peers) peer.write('\x1b[?2004h');
        await until(() => run('__t.term.modes.bracketedPasteMode'), 'bracketed paste mode');
        copied = 'BRACKETED'; await rightClick(); await until(() => input.endsWith('\x1b[200~BRACKETED\x1b[201~'), 'xterm bracketed paste');
        for (const peer of peers) peer.write('\x1b[?2004l'); await until(() => run('!__t.term.modes.bracketedPasteMode'), 'bracketed paste off');
        console.log('CLIPBOARD_STAGE multiline mouse/Enter/cancel/reconnect/bracketed');

        await clear(); let releaseRead;
        readOverride = () => new Promise(resolve => { releaseRead = resolve; });
        await noInputAfter(async () => {
          await rightClick(); await until(() => Boolean(releaseRead), 'clipboard read held');
          await run('__t.disconnect();true;'); await until(() => run('__t.state==="disconnected"'), 'disconnected during read');
          await run('__t.reconnect();true;'); await until(() => run('__t.state==="connected"'), 'new connection during read');
          releaseRead('STALE_READ'); readOverride = null;
        }, 'late clipboard response cannot reach a different connection');
        readOverride = () => { throw Error('Fixture clipboard unavailable'); };
        await noInputAfter(() => rightClick(), 'clipboard failure sends nothing');
        await until(() => run('document.querySelector("#toasts")?.textContent.includes("Fixture clipboard unavailable")'), 'clipboard failure visible');
        readOverride = null;
        await run('__t.disconnect();true;'); await until(() => run('__t.state==="disconnected"'), 'disconnected overlay');
        const beforeDisconnected = clipboardReads; await noInputAfter(() => rightClick(), 'disconnected paste sends nothing');
        assert.equal(clipboardReads, beforeDisconnected, 'disconnected terminal does not read clipboard');
        await run('__t.reconnect();true;'); await until(() => run('__t.state==="connected"'), 'reconnected for host test');
        console.log('CLIPBOARD_STAGE late clipboard/error/disconnected');

        assert.equal(await run('__app.popouts.open(__t)'), true);
        await until(async () => popup() && await run('__t.hostWindow!==window'), 'terminal popout ready');
        await clear(); copied = 'POPUP_RIGHT_CLICK'; await rightClick(popup());
        await until(() => input.endsWith('POPUP_RIGHT_CLICK'), 'native popout paste');
        await noInputAfter(() => drag(popup()), 'popout selection does not paste');
        popup().close(); await until(() => !popup(), 'redocked');
        await clear(); copied = 'DOCKED_RIGHT_CLICK'; await rightClick(); await until(() => input.endsWith('DOCKED_RIGHT_CLICK'), 'redocked paste');
        await settings(); await click(`document.querySelector('input[name="rightClick"]')`); await save();
        await until(() => run('__app.settings.rightClick==="menu"'), 'right-click paste disabled');
        const saved = new (require('../src/main/store').Store)(path.join(root, 'profile'), {}).getSettings();
        assert.equal(saved.rightClick, 'menu'); assert.equal(saved.copyOnSelect, false);
        await noInputAfter(() => rightClick(), 'disabled right-click paste opens menu again');
        assert.equal(await run('Boolean(document.querySelector(".ctx"))'), true);
        console.log('TERMINAL_CLIPBOARD_UI_PASS'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require('../src/main/main');
}
module.exports = { runTerminalClipboardUiTests };
if (process.argv.includes('--clipboard-ui')) fixture().catch(error => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) {
  let failed = 0;
  runTerminalClipboardUiTests(async (name, fn) => { try { await fn(); console.log('PASS '+name); } catch (error) { failed++; console.error(error.stack || error); } })
    .then(() => { process.exitCode = failed ? 1 : 0; }).catch(error => { console.error(error); process.exitCode = 1; });
}
