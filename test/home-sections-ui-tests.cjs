'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');

const ids = ['introduction', 'quick-connect', 'recent-sessions', 'sessions', 'network-tools', 'keyboard'];
const layouts = ['classic', 'workbench', 'incident-desk', 'operations-wall', 'focus'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!(await read())) { if (Date.now() >= end) throw new Error('Timed out: ' + label); await pause(25); }
}

async function runHomeSectionsUiTests(test) {
  await test('Home sections: real close/customize controls, retained drafts, races, failed saves, layouts and restart', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-home-ui-'));
    let child;
    try {
      fs.mkdirSync(path.join(root, 'profile'));
      // An existing profile without the new setting upgrades with every group visible.
      fs.writeFileSync(path.join(root, 'profile', 'settings.json'), JSON.stringify({ uiTheme: 'dark', uiLayout: 'classic',
        colorScheme: 'solarized', copyOnSelect: false, themeAnimations: false, fontSize: 17 }));
      for (const phase of ['exercise', 'restart']) {
        const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_HOME_TEST_ROOT: root,
          KONX_HOME_TEST_PHASE: phase, KONX_CAPTURE: '', KONX_DEMO: '' };
        delete env.ELECTRON_RUN_AS_NODE;
        let output = '';
        child = spawn(require('electron'), [__filename, '--home-sections-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const collect = data => { output = (output + data).slice(-1024 * 1024); };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        const code = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('Home fixture timed out\n' + output)); }, 150000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', value => { clearTimeout(timer); resolve(value); });
        });
        assert.equal(code, 0, output); assert.match(output, new RegExp('HOME_SECTIONS_UI_PASS ' + phase));
      }
      const saved = JSON.parse(fs.readFileSync(path.join(root, 'profile', 'settings.json'), 'utf8'));
      assert.deepEqual(saved.homeHiddenSections.slice().sort(), ids.slice().sort());
      assert.equal(saved.fontSize, 17); assert.equal(saved.colorScheme, 'solarized'); assert.equal(saved.copyOnSelect, false);
    } finally {
      if (child && child.exitCode == null) {
        const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped;
      }
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-home-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, dialog, shell, safeStorage } = require('electron');
  const root = fs.realpathSync(process.env.KONX_HOME_TEST_ROOT), profile = path.join(root, 'profile');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-home-ui-'));
  assert.equal(path.resolve(process.env.KONX_USERDATA), profile);
  const phase = process.env.KONX_HOME_TEST_PHASE; assert.ok(['exercise', 'restart'].includes(phase));
  let screenshots = null;
  if (process.env.KONX_HOME_SCREENSHOT_DIR) {
    const review = fs.realpathSync(path.join(__dirname, '../review')), requested = path.resolve(process.env.KONX_HOME_SCREENSHOT_DIR);
    const rel = path.relative(review, requested); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    fs.mkdirSync(requested, { recursive: true }); assert.equal(fs.realpathSync(requested), requested); screenshots = requested;
  }
  const unexpected = action => { throw new Error('Home fixture unexpectedly invoked ' + action); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, engine: null, missing: false,
    error: 'Offline Home fixture', npcap: { available: false }, builtin: { available: false } });
  require('../src/main/ai').AIClient.prototype.run = async () => unexpected('AI provider');
  let connectionAttempts = 0;
  require('../src/main/connections').ConnectionManager.prototype.open = async () => { connectionAttempts++; unexpected('remote connection'); };
  shell.openExternal = async () => unexpected('external browser');
  dialog.showOpenDialog = dialog.showSaveDialog = async () => unexpected('native file dialog');
  dialog.showErrorBox = (title, message) => unexpected(title + ': ' + message);
  const { Store } = require('../src/main/store');
  const setSettings = Store.prototype.setSettings, saveSession = Store.prototype.saveSession;
  let settingsMode = null, releaseSettings = null, releaseSession = null;
  Store.prototype.setSettings = function (patch) {
    if (Object.hasOwn(patch, 'homeHiddenSections')) {
      const mode = settingsMode; settingsMode = null;
      if (mode === 'hold') return new Promise((resolve, reject) => {
        releaseSettings = () => { try { resolve(setSettings.call(this, patch)); } catch (error) { reject(error); } };
      });
      if (mode === 'fail') {
        const save = this.settings.save;
        this.settings.save = () => { throw new Error('Home fixture settings write failed.'); };
        try { return setSettings.call(this, patch); } finally { this.settings.save = save; }
      }
    }
    return setSettings.call(this, patch);
  };
  Store.prototype.saveSession = function (input) {
    if (input.name === '192.0.2.31') return new Promise((resolve, reject) => {
      releaseSession = () => { try { resolve(saveSession.call(this, input)); } catch (error) { reject(error); } };
    });
    return saveSession.call(this, input);
  };
  let finished = false;
  const errors = [];
  const finish = async (code, error) => {
    if (finished) return; finished = true; if (error) console.error(error.stack || error);
    for (const window of BrowserWindow.getAllWindows()) { await window.webContents.session.flushStorageData(); window.destroy(); }
    app.exit(code);
  };
  process.on('uncaughtException', error => { void finish(1, error); });
  process.on('unhandledRejection', error => { void finish(1, error); });
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true); win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    win.webContents.once('did-finish-load', async () => {
      const run = code => win.webContents.executeJavaScript(code).catch(error => { throw new Error(error.message + '\nExpression: ' + code.slice(0, 500)); });
      const section = id => `window.__home.el.querySelector('[data-home-section="${id}"]')`;
      const close = id => `window.__home.el.querySelector('[data-action="hide-home-section"][data-section="${id}"]')`;
      const customize = `window.__home.el.querySelector('[data-action="customize-home"]')`;
      const checkbox = id => `document.querySelector('.modal input[name="homeSection"][value="${id}"]')`;
      const footer = label => `[...document.querySelectorAll('.modal footer button')].find(b=>b.textContent===${JSON.stringify(label)})`;
      const hidden = () => run(`window.__app.settings.homeHiddenSections||[]`);
      const visible = id => run(`getComputedStyle(${section(id)}).display!=='none'&&${section(id)}.getBoundingClientRect().height>0`);
      const settled = async wanted => until(async () => JSON.stringify((await hidden()).slice().sort()) === JSON.stringify(wanted.slice().sort()), 'saved Home choices ' + wanted.join(','));
      const click = async expression => {
        let point;
        await until(async () => {
          point = await run(`(()=>{const e=${expression};if(!e)return{ready:false};e.scrollIntoView({block:'nearest',inline:'nearest'});
            const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);
            return{x,y,ready:!e.disabled&&r.width>0&&r.height>0&&(e===hit||e.contains(hit))};})()`);
          return point.ready;
        }, 'reachable control ' + expression).catch(async error => {
          if (screenshots) fs.writeFileSync(path.join(screenshots, 'home-control-failure.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
          const state = await run(`(()=>{const e=${expression},r=e?.getBoundingClientRect(),h=r&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return{active:window.__app.active?.id,home:window.__home.id,layout:window.__app.workspaceLayout.get(),homeRect:window.__home.el.getBoundingClientRect().toJSON(),homeDisplay:getComputedStyle(window.__home.el).display,control:r?.toJSON(),hit:h?.outerHTML?.slice(0,400),disabled:e?.disabled}})()`);
          throw new Error(error.message + '\nHome diagnostics: ' + JSON.stringify(state));
        });
        delete point.ready; win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(25);
      };
      const fill = (expression, value) => run(`(()=>{const e=${expression};e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
      const showDialog = async keyboard => {
        if (keyboard) {
          await run(`${customize}.scrollIntoView({block:'center'});${customize}.focus();true;`);
          assert.equal(await run(`document.activeElement===${customize}`), true);
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        } else await click(customize);
        await until(() => run(`document.querySelectorAll('.modal input[name="homeSection"]').length===6`), 'Customize Home checkboxes');
      };
      const saveDialog = async () => { await click(footer('Save')); await until(() => run('!document.querySelector(".modal")'), 'Home customization saved'); };
      const restoreAll = async () => {
        await showDialog(false);
        await click(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Restore all')`);
        await saveDialog(); await settled([]);
      };
      const capture = async name => {
        if (!screenshots) return;
        await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await pause(100);
        fs.writeFileSync(path.join(screenshots, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
      };
      try {
        await until(() => run('Boolean(window.__app?.workspaceLayout)'), 'application ready');
        await run(`window.__home=window.__app.tabs.find(t=>t.kind==='welcome');true;`);
        await setViewport(win, run, 1200, 800);
        if (phase === 'restart') {
          await settled(ids);
          for (const id of ids) assert.equal(await visible(id), false);
          assert.equal(await run(`localStorage.getItem('konx.home-fixture.keep')`), 'retained');
          assert.equal(await run('window.__app.recentSessions().length'), 1);
          const saved = await run(`window.api.invoke('sessions:list')`);
          assert.equal(saved.sessions.length, 2); assert.ok(saved.sessions.find(s => s.name === '192.0.2.31').hasPassword);
          assert.equal(connectionAttempts, 0);
          await showDialog(true); assert.equal(await run(`document.querySelectorAll('.modal input[name="homeSection"]:checked').length`), 0);
          await click(footer('Cancel')); assert.deepEqual((await hidden()).sort(), ids.slice().sort());
          await capture('home-hidden-restart'); console.log('HOME_SECTIONS_UI_PASS restart'); await finish(0); return;
        }
        assert.deepEqual(await hidden(), []);
        assert.deepEqual(await run(`[...window.__home.el.querySelectorAll('[data-home-section]')].map(e=>e.dataset.homeSection)`), ids);
        for (const id of ids) {
          assert.equal(await visible(id), true);
          assert.ok(await run(`${close(id)}.getAttribute('aria-label')`), id + ': close has an accessible name');
        }
        await run(`(async()=>{const s=await window.api.invoke('sessions:save',{name:'Retained Home session',host:'192.0.2.30',protocol:'ssh',username:'fixture'});
          await window.__app.sessions.load();window.__app.rememberRecent(s.id);localStorage.setItem('konx.home-fixture.keep','retained');
          window.__np=await window.__app.openNotepad();window.__doc=window.__np.newDoc({title:'Home draft.ios',text:${JSON.stringify('hostname retained-home-draft\n')},language:'ios'});
          window.__app.activate(window.__home);return true;})()`);
        const host = `window.__home.el.querySelector('.qc-form input[placeholder="Hostname, IP or COM port"]')`;
        const username = `window.__home.el.querySelector('input[name="quickUsername"]')`;
        const password = `window.__home.el.querySelector('input[name="quickPassword"]')`;
        await fill(host, 'retained.example'); await fill(username, 'retained-user'); await fill(password, 'retained-only-in-form');
        await capture('home-sections-visible-1200');
        await run(`window.__quickNode=${host};window.__recentNode=window.__home.recentContent;window.__beforeQuickTop=${section('quick-connect')}.offsetTop;true;`);
        await click(close('introduction')); await settled(['introduction']);
        assert.equal(await visible('introduction'), false);
        assert.equal(await run(`${section('introduction')}.getBoundingClientRect().height`), 0, 'hidden group leaves no block');
        assert.equal(await run(`${section('quick-connect')}.offsetTop<window.__beforeQuickTop`), true, 'following group closes the space');
        assert.equal(await run(`${host}===window.__quickNode&&${host}.value==='retained.example'&&${username}.value==='retained-user'&&${password}.value==='retained-only-in-form'`), true);
        await showDialog(true); assert.equal(await run(`${checkbox('introduction')}.checked`), false);
        await click(checkbox('introduction')); await click(footer('Cancel')); await settled(['introduction']);
        assert.equal(await visible('introduction'), false, 'Cancel does not apply checkbox draft');
        await restoreAll(); assert.equal(await visible('introduction'), true);

        // Two clicks share one delayed settings write; neither intent is lost.
        settingsMode = 'hold';
        await run(`${close('network-tools')}.click();${close('keyboard')}.click();true;`);
        await until(() => !!releaseSettings, 'delayed Home settings write');
        releaseSettings(); releaseSettings = null;
        await settled(['network-tools', 'keyboard']);
        for (const id of ['network-tools', 'keyboard']) assert.equal(await visible(id), false);
        assert.equal(await run('window.__np.current.model.getValue()'), 'hostname retained-home-draft\n');
        assert.equal(await run('window.__home.recentContent===window.__recentNode&&window.__app.recentSessions().length===1'), true);
        await restoreAll();

        // Failed disk publication keeps both main-process and renderer settings intact.
        settingsMode = 'fail'; await click(close('sessions'));
        await until(() => run(`document.body.textContent.includes('Home fixture settings write failed.')`), 'visible Home save failure');
        assert.equal(await visible('sessions'), true);
        assert.deepEqual(await hidden(), []);
        assert.deepEqual(await run(`window.api.invoke('settings:get').then(s=>s.homeHiddenSections)`), []);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).homeHiddenSections, []);
        await click(close('sessions')); await settled(['sessions']); await restoreAll();

        // The setting operation belongs to App, not a Home tab that may close meanwhile.
        settingsMode = 'hold'; await click(close('keyboard')); await until(() => !!releaseSettings, 'Home replacement pending save');
        await run(`(async()=>{await window.__app.closeTab(window.__home);window.__app.showHome();window.__home=window.__app.tabs.find(t=>t.kind==='welcome');return true;})()`);
        releaseSettings(); releaseSettings = null; await settled(['keyboard']);
        assert.equal(await visible('keyboard'), false); await restoreAll();

        // Save remains useful, but hiding and restoring the form cancels its old connection intent.
        assert.equal(safeStorage.isEncryptionAvailable(), true);
        await fill(host, '192.0.2.31'); await fill(username, 'home-fixture'); await fill(password, 'Synthetic Home fixture password');
        await click(`window.__home.el.querySelector('input[name="saveQuickSession"]')`);
        await click(`window.__home.el.querySelector('[data-action="quick-connect"]')`);
        await until(() => !!releaseSession, 'delayed quick session save');
        settingsMode = 'fail'; await click(close('quick-connect'));
        await until(() => run(`document.body.textContent.includes('Home fixture settings write failed.')`), 'failed hide still invalidates quick intent');
        assert.equal(await run(`${password}.value`), '', 'hide intent clears the password before persistence');
        assert.equal(await visible('quick-connect'), true);
        await click(close('quick-connect')); await settled(['quick-connect']); await restoreAll();
        releaseSession(); releaseSession = null;
        await until(async () => (await run(`window.api.invoke('sessions:list')`)).sessions.some(s=>s.name==='192.0.2.31'), 'saved pending record retained');
        await until(() => run(`!window.__home.el.querySelector('[data-action="quick-connect"]').disabled`), 'quick operation settled');
        assert.equal(connectionAttempts, 0, 'hide then restore must never launch the stale pending connection');
        assert.equal(await run(`window.__app.tabs.filter(t=>t.kind==='terminal'||t.kind==='sftp').length`), 0);
        assert.equal(await run(`${password}.value`), '');

        // Every layout retains reachable customization at the minimum window size.
        for (const layout of layouts) for (const theme of ['dark', 'arctic-glass', 'ion-storm']) {
          await run(`window.__app.saveSettings({uiLayout:${JSON.stringify(layout)},uiTheme:${JSON.stringify(theme)}}).then(()=>undefined)`);
          await setViewport(win, run, 900, 560); await pause(40);
          // Workbench's existing narrow-window Context is an intentional
          // overlay. Dismiss it through its real control before using Home.
          if (await run(`getComputedStyle(window.__app.workspaceLayout.context).display!=='none'`)) {
            await click('window.__app.workspaceLayout.contextToggle');
          }
          await showDialog(false);
          const geometry = await run(`(()=>{const m=document.querySelector('.modal'),r=m.getBoundingClientRect();return{width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()`);
          assert.ok(geometry.scroll<=geometry.width+2&&geometry.left>=0&&geometry.right<=geometry.width+2&&geometry.top>=0&&geometry.bottom<=geometry.height+2, JSON.stringify({layout,theme,geometry}));
          if (layout==='classic') await capture('customize-' + theme + '-900');
          await click(footer('Cancel'));
        }
        await run(`window.__app.saveSettings({uiLayout:'classic',uiTheme:'ion-storm'}).then(()=>undefined)`);
        await setViewport(win, run, 1400, 880);
        await showDialog(false);
        for (const id of ids) await click(checkbox(id));
        await saveDialog(); await settled(ids);
        for (const id of ids) assert.equal(await visible(id), false);
        await capture('home-all-hidden-1400');
        await showDialog(true); await click(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Restore all')`);
        assert.equal(await run(`document.querySelectorAll('.modal input[name="homeSection"]:checked').length`), ids.length);
        await click(footer('Cancel')); await settled(ids);
        assert.equal(await run('window.__np.current.model.getValue()'), 'hostname retained-home-draft\n');
        assert.equal(await run('window.__app.recentSessions().length'), 1);
        assert.equal(connectionAttempts, 0); assert.deepEqual(errors, []);
        console.log('HOME_SECTIONS_UI_PASS exercise'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require('../src/main/main');
}
module.exports = { runHomeSectionsUiTests };
if (process.argv.includes('--home-sections-fixture')) fixture().catch(error=>{ console.error(error); require('electron').app.exit(1); });
else if (require.main===module) (async()=>{
  let passed=0,failed=0;
  await runHomeSectionsUiTests(async(name,fn)=>{try{await fn();passed++;console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name,error);}});
  console.log(`${passed}/${passed+failed} Home UI checks passed`); process.exitCode=failed?1:0;
})();
