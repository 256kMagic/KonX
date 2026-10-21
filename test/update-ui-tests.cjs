'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await pause(); }
}

async function runUpdateUiTests(test) {
  await test('updater renderer: explicit start, progress, safe restart, note guards, cancellation, retries and Settings layout', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'konx-update-ui-test-'));
    let child, output = '';
    try {
      const env = { ...process.env, KONX_UPDATE_UI_ROOT: root };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--update-ui-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = (data) => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Update UI fixture timed out\n' + output)); }, 65000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
      });
      assert.equal(code, 0, output); assert.match(output, /UPDATE_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) child.kill();
      assert.equal(path.dirname(path.resolve(root)), fs.realpathSync(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('konx-update-ui-test-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const root = path.resolve(process.env.KONX_UPDATE_UI_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('konx-update-ui-test-'));
  app.setPath('userData', path.join(root, 'profile'));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const source = path.resolve(__dirname, '../src/renderer');
  const url = (name) => pathToFileURL(path.join(source, name)).href;
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
    let listeners=0;
    contextBridge.exposeInMainWorld('api',{
      invoke:(channel,...args)=>ipcRenderer.invoke('fixture:invoke',channel,args),
      on:(channel,fn)=>{listeners++;const callback=(_event,value)=>fn(value);ipcRenderer.on(channel,callback);return()=>{listeners--;ipcRenderer.removeListener(channel,callback)};},
      listenerCount:()=>listeners
    });`);
  const html = path.join(root, 'fixture.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${url('styles.css')}"><link rel="stylesheet" href="${url('animated-themes.css')}"></head><body><script type="module">
    import {updateKonx,createUpdatesPane,updateBlockers} from ${JSON.stringify(url('js/updates.js'))};
    import {settingsDialog} from ${JSON.stringify(url('js/settings.js'))};
    import {applyApplicationTheme} from ${JSON.stringify(url('js/theme-effects.js'))};
    window.fixture={updateKonx,createUpdatesPane,updateBlockers,settingsDialog,applyApplicationTheme,
      app:{info:{name:'KonX',version:'0.5.0',logDir:''},settings:{uiTheme:'dark',fontSize:14},tabs:[],saveSettings:async()=>{}}};
    window.fixtureReady=true;
    </script></body></html>`);
  let context;
  const state = (status = 'idle', mode = 'installed') => ({ supported: true, mode, currentVersion: '0.5.0', version: '0.6.0', status, message: status, downloaded: 25, total: 100, percent: 25 });
  const publish = (next) => { context.state = next; context.win.webContents.send('app:updateState', next); };
  ipcMain.handle('fixture:invoke', async (_event, name, args) => {
    const c = context; c.calls.push({ name, args });
    if (name === 'app:updateState') return c.state;
    if (name === 'app:updateStart') { publish(state('downloading', c.state.mode)); return c.state; }
    if (name === 'app:updateCancel') { publish(state('cancelled', c.state.mode)); return c.state; }
    if (name === 'np:session:set') {
      if (c.holdSession) await new Promise((resolve) => { c.releaseSession = resolve; });
      return true;
    }
    if (name === 'app:updateInstall') {
      if (c.installError) {
        if (c.invalidDownload) publish(state('error', c.state.mode));
        throw new Error(c.installError);
      }
      publish(state('installing', c.state.mode));
      if (c.holdInstall) await new Promise((resolve) => { c.releaseInstall = resolve; });
      return { success: true };
    }
    if (name === 'hostkeys:list') return [];
    throw new Error('Unexpected fixture call ' + name);
  });
  await app.whenReady();
  async function open(initial = state()) {
    const win = new BrowserWindow({ show: false, width: 900, height: 560, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
    context = { win, state: initial, calls: [] };
    win.setSkipTaskbar(true);
    await win.loadFile(html);
    const run = (code) => win.webContents.executeJavaScript(code);
    await until(() => run('window.fixtureReady === true'), 'fixture modules');
    return { win, run, c: context };
  }
  const count = (c, name) => c.calls.filter((call) => call.name === name).length;
  const close = (run) => run(`document.querySelector('.modal:last-child footer button')?.click(); void 0;`);
  const cleanNotepad = `({kind:'notepad',monaco:{},ready:Promise.resolve(),docs:[{title:'Lab.txt',dirty:false}],isDirty:d=>d.dirty,sessionData(){return {docs:[{title:'Lab.txt',dirty:false}]}}})`;
  try {
    // No import/startup network, coalesced clicks, session ACK before install,
    // and dismissal locked after the helper request has started.
    {
      const { win, run, c } = await open();
      assert.equal(c.calls.length, 0);
      c.holdInstall = true;
      await run(`fixture.app.tabs=[${cleanNotepad}];const a=fixture.updateKonx(fixture.app),b=fixture.updateKonx(fixture.app);window.same=a===b;void 0;`);
      await until(() => count(c, 'app:updateStart') === 1, 'explicit update start');
      assert.equal(await run('same'), true);
      assert.equal(await run('api.listenerCount()'), 1);
      assert.equal(await run('document.querySelector(".update-progress").value'), 25);
      publish(state('ready'));
      await until(() => count(c, 'app:updateInstall') === 1, 'automatic safe installation');
      assert.ok(c.calls.findIndex((call) => call.name === 'np:session:set') < c.calls.findIndex((call) => call.name === 'app:updateInstall'));
      assert.equal(await run('document.querySelector(".modal footer button").disabled'), true);
      await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.querySelector('.modal-back').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));void 0;`);
      assert.equal(await run('document.querySelectorAll(".modal").length'), 1);
      c.releaseInstall(); win.destroy();
    }
    // Closing during an asynchronous session save must prevent installation.
    {
      const { win, run, c } = await open(state('ready', 'portable'));
      await run(`fixture.app.tabs=[${cleanNotepad}];fixture.app.tabs[0].docs[0].dirty=true;void fixture.updateKonx(fixture.app);`);
      await until(() => run('document.querySelector(".update-problems").textContent.includes("Save “Lab.txt”")'), 'dirty document blocker');
      assert.equal(count(c, 'app:updateInstall'), 0);
      c.holdSession = true;
      await run(`fixture.app.tabs[0].docs[0].dirty=false;document.querySelector('.update-actions .primary').click();void 0;`);
      await until(() => Boolean(c.releaseSession), 'session acknowledgement pending');
      await close(run);
      await until(() => run('api.listenerCount()===0'), 'closed dialog cleanup');
      c.releaseSession(); await pause(50);
      assert.equal(count(c, 'app:updateInstall'), 0);
      assert.equal(count(c, 'app:updateStart'), 0);
      win.destroy();
    }
    // A partially restored Notepad session must not be persisted or installed.
    {
      const { win, run, c } = await open(state('ready'));
      await run(`fixture.app.tabs=[${cleanNotepad}];fixture.app.tabs[0].ready=new Promise(resolve=>{fixture.finishLoading=resolve});void fixture.updateKonx(fixture.app);`);
      await until(() => run('document.querySelector(".update-status").textContent.includes("Preparing")'), 'Notepad restore pending');
      assert.equal(count(c, 'np:session:set'), 0); assert.equal(count(c, 'app:updateInstall'), 0);
      await close(run);
      await run('fixture.finishLoading();void 0;'); await pause(30);
      assert.equal(count(c, 'np:session:set'), 0); assert.equal(count(c, 'app:updateInstall'), 0);
      win.destroy();
    }
    // Main-process blockers preserve the verified download for an install retry.
    {
      const { win, run, c } = await open(state('ready'));
      c.installError = 'Disconnect active terminal connections before updating.';
      await run('void fixture.updateKonx(fixture.app);');
      await until(() => run('document.querySelector(".update-problems").textContent.includes("Disconnect active")'), 'main blocker');
      assert.equal(await run('document.querySelector(".update-actions .primary").classList.contains("hidden")'), false);
      c.installError = '';
      await run('document.querySelector(".update-actions .primary").click();void 0;');
      await until(() => count(c, 'app:updateInstall') === 2, 'retry verified installation');
      assert.equal(count(c, 'app:updateStart'), 0);
      win.destroy();
    }
    // A failed checksum invalidates the package; expose download retry instead.
    {
      const { win, run, c } = await open(state('ready'));
      c.installError = 'Downloaded update checksum no longer matches.'; c.invalidDownload = true;
      await run('void fixture.updateKonx(fixture.app);');
      await until(() => run('document.querySelector(".update-problems").textContent.includes("checksum")'), 'invalidated download');
      assert.equal(await run('document.querySelector(".update-actions .primary").classList.contains("hidden")'), true);
      assert.equal(await run('[...document.querySelectorAll(".update-actions button")].find(b=>b.textContent==="Try again").classList.contains("hidden")'), false);
      await close(run); win.destroy();
    }
    // New notes have no editingId. Pending writes and active sends also block.
    {
      const { win, run, c } = await open(state('ready'));
      await run(`const note=document.createElement('div');note.textContent='Unsaved note text';fixture.note=note;fixture.app.tabs=[{toolKind:'ai',editingId:null,noteEditor:note,libraryBusy:true},${cleanNotepad}];fixture.app.tabs[1].sending={};fixture.app.tabs[1].docs[0].savePending=Promise.resolve();void fixture.updateKonx(fixture.app);`);
      await until(() => run('document.querySelector(".update-problems").textContent.includes("Knowledge note")'), 'new note blocker');
      const message = await run('document.querySelector(".update-problems").textContent');
      assert.match(message, /library operation/); assert.match(message, /Stop sending/); assert.match(message, /finish saving/);
      assert.equal(count(c, 'app:updateInstall'), 0);
      assert.equal(await run('fixture.note.textContent'), 'Unsaved note text');
      await close(run); win.destroy();
    }
    // Cancel and Close both revoke automatic install even if a late ready event arrives.
    for (const action of ['cancel', 'close']) {
      const { win, run, c } = await open();
      await run('void fixture.updateKonx(fixture.app);');
      await until(() => count(c, 'app:updateStart') === 1, 'download started');
      if (action === 'cancel') await run(`[...document.querySelectorAll('.update-actions button')].find(b=>b.textContent==='Cancel update').click();void 0;`);
      else await close(run);
      await until(() => count(c, 'app:updateCancel') === 1, 'cancel requested');
      publish(state('ready')); await pause(50);
      assert.equal(count(c, 'app:updateInstall'), 0);
      if (action === 'cancel') await close(run);
      await until(() => run('api.listenerCount()===0'), 'listener removed');
      win.destroy();
    }
    // Actual Settings pane: local status only, theme-safe minimum-size geometry,
    // dirty Settings guard, and disposal of both pane/dialog subscriptions.
    {
      const { win, run, c } = await open(state('ready', 'portable'));
      await run('void fixture.settingsDialog(fixture.app);');
      await until(() => run('Boolean(document.querySelector(".update-settings"))'), 'Settings updates pane');
      assert.equal(count(c, 'app:updateStart'), 0); assert.equal(count(c, 'app:updateInstall'), 0);
      await run(`[...document.querySelectorAll('.mtabs button')].find(b=>b.textContent==='Updates').click();void 0;`);
      assert.match(await run('document.querySelector(".update-settings").textContent'), /Portable application/);
      assert.match(await run('document.querySelector(".update-settings").textContent'), /No account/);
      await setViewport(win, run, 900, 560);
      for (const theme of ['dark', 'light', 'arc-reactor', 'chroma-rgb', 'matrix-mainframe', 'synthwave-grid', 'hologram-prism', 'plasma-forge']) {
        await run(`fixture.applyApplicationTheme({uiTheme:${JSON.stringify(theme)},themeAnimations:false});void 0;`);
        const rect = await run(`(()=>{const r=document.querySelector('.update-settings button').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,w:innerWidth,h:innerHeight}})()`);
        assert.ok(rect.x >= 0 && rect.y >= 0 && rect.right <= rect.w && rect.bottom <= rect.h && rect.width > 0 && rect.height > 0, theme + ' ' + JSON.stringify(rect));
      }
      await run(`document.querySelector('input[type=number]').value='16';document.querySelector('.update-settings button').click();void 0;`);
      await until(() => run('document.querySelector(".update-problems").textContent.includes("Settings changes")'), 'dirty Settings blocker');
      assert.equal(count(c, 'app:updateInstall'), 0);
      await run(`document.querySelectorAll('.modal')[1].querySelector('footer button').click();void 0;`);
      await close(run);
      await until(() => run('api.listenerCount()===0'), 'Settings subscription cleanup');
      win.destroy();
    }
    {
      const { win, run, c } = await open({ ...state(), supported: false, mode: 'development', message: 'Updates require a packaged Windows build.' });
      await run('void fixture.updateKonx(fixture.app);');
      await until(() => run('document.querySelector(".update-status").textContent.includes("packaged")'), 'unsupported build');
      assert.equal(count(c, 'app:updateStart'), 0);
      await close(run); win.destroy();
    }
    console.log('UPDATE_UI_PASS'); app.exit(0);
  } catch (error) { console.error(error.stack || error); for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(1); }
}

if (process.argv.includes('--update-ui-fixture')) fixture().catch((error) => { console.error(error); require('electron').app.exit(1); });
module.exports = { runUpdateUiTests };
if (require.main === module && !process.argv.includes('--update-ui-fixture')) runUpdateUiTests(async (_name, fn) => fn()).catch((error) => { console.error(error); process.exitCode = 1; });
