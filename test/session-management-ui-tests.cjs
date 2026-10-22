'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');

// Synthetic credentials accepted only by the owned loopback peer below.
const USERNAME = 'konx-session-fixture';
const PASSWORD = 'KonX synthetic session password 0.15';
const SAVED_NAME = 'Saved credential fixture';
const ONCE_NAME = 'One-time credential fixture';
const CANCEL_NAME = 'Delayed save fixture';
const CANCEL_FAIL_NAME = 'Delayed failed save fixture';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error('Timed out: ' + description);
    await pause(25);
  }
}

async function runSessionManagementUiTests(test) {
  await test('session management: real encrypted credential dialogs, one-time login, recent-history clear and restart', async () => {
    const base = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(base, 'konx-session-ui-'));
    const sockets = new Set(); let server, child;
    try {
      const { startServer } = require('./ssh-test-server');
      const ssh = await startServer({ port: 0, root, user: USERNAME, password: PASSWORD, hostname: 'session-fixture' });
      server = ssh.server;
      server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      for (const phase of ['exercise', 'restart']) {
        let output = '';
        const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_SESSION_UI_ROOT: root,
          KONX_SESSION_UI_PHASE: phase, KONX_SESSION_UI_PORT: String(ssh.port), KONX_CAPTURE: '', KONX_DEMO: '' };
        delete env.ELECTRON_RUN_AS_NODE;
        child = spawn(require('electron'), [__filename, '--session-management-ui-fixture'], {
          windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const collect = data => { output = (output + data).slice(-1024 * 1024); };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        const code = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('Session management fixture timed out\n' + output)); }, 90000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); resolve(code); });
        });
        assert.equal(code, 0, output);
        assert.match(output, new RegExp('SESSION_MANAGEMENT_UI_PASS ' + phase));
      }
      const raw = fs.readFileSync(path.join(root, 'profile', 'sessions.json'), 'utf8');
      assert.equal(raw.includes(PASSWORD), false, 'synthetic password must never be stored as plaintext');
      const sessions = JSON.parse(raw).sessions;
      assert.equal(sessions.length, 3);
      assert.ok(sessions.find(s => s.name === SAVED_NAME).passwordEnc);
      assert.equal(Object.hasOwn(sessions.find(s => s.name === ONCE_NAME), 'passwordEnc'), false);
    } finally {
      if (child && child.exitCode == null) {
        const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped;
      }
      for (const socket of sockets) socket.destroy();
      if (server) await new Promise(resolve => server.close(resolve));
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-session-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, dialog, shell, safeStorage } = require('electron');
  const root = path.resolve(process.env.KONX_SESSION_UI_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('konx-session-ui-'));
  const phase = process.env.KONX_SESSION_UI_PHASE;
  const port = Number(process.env.KONX_SESSION_UI_PORT);
  assert.ok(['exercise', 'restart'].includes(phase)); assert.ok(port > 0 && port <= 65535);
  const profile = path.join(root, 'profile');
  assert.equal(path.resolve(process.env.KONX_USERDATA), profile);
  let screenshots = null;
  if (process.env.KONX_SESSION_SCREENSHOT_DIR) {
    const review = fs.realpathSync(path.join(__dirname, '../review'));
    const requested = path.resolve(process.env.KONX_SESSION_SCREENSHOT_DIR);
    const relative = path.relative(review, requested);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.mkdirSync(requested, { recursive: true }); assert.equal(fs.realpathSync(requested), requested);
    screenshots = requested;
  }
  const unexpected = action => { throw new Error('Session fixture unexpectedly invoked ' + action); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, engine: null, missing: false,
    error: 'Offline session fixture', npcap: { available: false }, builtin: { available: false } });
  require('../src/main/ai').AIClient.prototype.run = async () => unexpected('AI provider');
  shell.openExternal = async () => unexpected('external browser');
  dialog.showOpenDialog = async () => unexpected('native open');
  dialog.showSaveDialog = async () => unexpected('native save');
  dialog.showErrorBox = (title, message) => unexpected(title + ': ' + message);
  // Control only two explicit failure/latency cases at the real save handler's
  // producer. All successful persistence and encryption use the original Store.
  const { Store } = require('../src/main/store');
  const saveSession = Store.prototype.saveSession;
  let failedOnce = false, releaseDelayedSave = null, delayedStarted = false, rejectDelayedSave = null;
  if (phase === 'exercise') Store.prototype.saveSession = function (input) {
    if (input.name === SAVED_NAME && !input.id && !failedOnce) {
      failedOnce = true;
      throw new Error('Fixture save failed before writing; retry is available.');
    }
    if (input.name === CANCEL_NAME && !input.id && !delayedStarted) {
      delayedStarted = true;
      return new Promise((resolve, reject) => {
        releaseDelayedSave = () => { try { resolve(saveSession.call(this, input)); } catch (error) { reject(error); } };
      });
    }
    if (input.name === CANCEL_FAIL_NAME && !input.id) {
      return new Promise((_resolve, reject) => { rejectDelayedSave = reject; });
    }
    return saveSession.call(this, input);
  };
  let finished = false;
  const finish = async (code, error) => {
    if (finished) return; finished = true;
    if (error) console.error(error.stack || error);
    for (const win of BrowserWindow.getAllWindows()) {
      await win.webContents.session.flushStorageData();
      win.destroy();
    }
    app.exit(code);
  };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.setBackgroundThrottling(false);
    win.webContents.once('did-finish-load', async () => {
      const run = code => win.webContents.executeJavaScript(code);
      const click = async (expression, button = 'left', clickCount = 1) => {
        let point;
        await until(async () => {
          point = await run(`(()=>{const e=${expression};if(!e)return {ready:false};e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return{x,y,ready:!e.disabled&&r.width>0&&r.height>0&&(hit===e||e.contains(hit))};})()`);
          return point.ready;
        }, 'reachable control ' + expression);
        delete point.ready;
        win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        win.webContents.sendInputEvent({ type: 'mouseDown', button, clickCount, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button, clickCount, ...point });
        await pause(25);
      };
      const field = label => `([...document.querySelectorAll('.modal .mpane.active label.field')].find(e=>e.querySelector('span')?.textContent===${JSON.stringify(label)})?.querySelector('input,select,textarea'))`;
      const fill = async (expression, value) => run(`(()=>{const e=${expression};if(!e)throw new Error('Missing input');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
      const footer = label => `[...document.querySelectorAll('.modal footer button')].find(b=>b.textContent===${JSON.stringify(label)})`;
      const row = name => `[...document.querySelectorAll('.tree-row')].find(e=>e.querySelector('.name')?.textContent===${JSON.stringify(name)})`;
      const password = `document.querySelector('.modal input[name="password"][aria-label="Password"]')`;
      const savePassword = `document.querySelector('.modal input[name="savePassword"][aria-label="Save password on this computer"]')`;
      const closeDialog = async label => { await click(footer(label)); await until(() => run('!document.querySelector(".modal")'), 'session dialog closed'); };
      const capture = async (name, width, height, subject) => {
        await setViewport(win, run, width, height);
        await until(() => run('!document.querySelector(".toast")'), 'transient toast finishes before geometry check');
        await pause(75);
        if (subject === 'modal') {
          await run(`document.querySelector('.modal .body').scrollTop=0;true;`);
          const geometry = await run(`(()=>{const box=document.querySelector('.modal'),footer=box.querySelector('footer'),tabs=box.querySelector('.mtabs'),pw=box.querySelector('input[name="password"]');const bounds=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,box:bounds(box),footer:bounds(footer),tabs:bounds(tabs),password:bounds(pw),passwordType:pw.type};})()`);
          assert.ok(geometry.documentWidth <= geometry.width + 3, 'modal causes horizontal document overflow');
          for (const rect of [geometry.box, geometry.footer, geometry.tabs, geometry.password]) {
            assert.ok(rect.width > 0 && rect.height > 0 && rect.left >= -2 && rect.top >= -2 && rect.right <= geometry.width + 2 && rect.bottom <= geometry.height + 2, JSON.stringify(geometry));
          }
          assert.equal(geometry.passwordType, 'password');
        } else {
          await run(`window.__home.el.querySelector('.welcome-recent').scrollIntoView({block:'center',inline:'nearest'});true;`);
          const quick = await run(`(()=>{const form=window.__home.el.querySelector('.qc-form'),rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};return {form:rect(form),clientWidth:form.clientWidth,scrollWidth:form.scrollWidth,controls:[...form.querySelectorAll('input,select,button')].map(e=>({kind:e.tagName+'/'+e.type,...rect(e)}))};})()`);
          assert.equal(quick.controls.length, 5, 'Quick connect retains protocol, host, port, username and Connect');
          assert.ok(quick.scrollWidth <= quick.clientWidth + 3, JSON.stringify(quick));
          for (const control of quick.controls) {
            assert.ok(control.width >= 120 && control.height >= 24, 'Quick connect control is unusably small: ' + JSON.stringify(quick));
            assert.ok(control.left >= quick.form.left - 2 && control.right <= quick.form.right + 2 && control.top >= quick.form.top - 2 && control.bottom <= quick.form.bottom + 2, 'Quick connect control escapes its form: ' + JSON.stringify(quick));
          }
          for (let i = 0; i < quick.controls.length; i++) for (let j = i + 1; j < quick.controls.length; j++) {
            const a = quick.controls[i], b = quick.controls[j];
            assert.ok(Math.min(a.right, b.right) <= Math.max(a.left, b.left) + 1 || Math.min(a.bottom, b.bottom) <= Math.max(a.top, b.top) + 1, 'Quick connect controls overlap: ' + JSON.stringify(quick));
          }
          const geometry = await run(`(()=>{const e=window.__home.el.querySelector('[data-action="clear-recent-sessions"]'),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,reachable:hit===e||e.contains(hit),rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},hit:hit?.tagName+'.'+hit?.className,view:window.__home.el.getBoundingClientRect().toJSON()};})()`);
          if (!geometry.reachable && screenshots) fs.writeFileSync(path.join(screenshots, 'geometry-failure-' + Date.now() + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG(), { flag: 'wx' });
          assert.ok(geometry.documentWidth <= geometry.width + 3 && geometry.inside && geometry.reachable, JSON.stringify(geometry));
        }
        if (!screenshots) return;
        await pause(100);
        const imagePath = path.join(screenshots, name + '-' + width + '-' + Date.now() + '.png');
        fs.writeFileSync(imagePath, (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG(), { flag: 'wx' });
        console.log('SESSION_MANAGEMENT_SCREENSHOT ' + imagePath);
      };
      const editor = async (name = null) => {
        if (name) {
          await click(row(name), 'right');
          await click(`[...document.querySelectorAll('.ctx .item')].find(e=>e.textContent.startsWith('Edit…'))`);
        } else await click(`document.querySelector('button[title="New session"]')`);
        await until(() => run(`Boolean(${password})`), 'General credential controls');
        assert.equal(await run(`${password}.closest('.mpane').classList.contains('active')`), true);
        assert.equal(await run(`document.querySelectorAll('.modal input[name="username"][aria-label="Username"]').length`), 1);
        assert.equal(await run(`document.querySelectorAll('.modal input[name="password"]').length`), 1);
      };
      const fillNew = async (name, save) => {
        await editor();
        await fill(field('Name'), name); await fill(field('Hostname or IP'), '127.0.0.1'); await fill(field('Port'), port);
        await fill(`document.querySelector('.modal input[name="username"]')`, USERNAME);
        await fill(password, PASSWORD);
        assert.equal(await run(`${savePassword}.checked`), true, 'new encrypted credential save defaults on');
        if (!save) await click(savePassword);
      };
      const publicSessions = () => run(`window.api.invoke('sessions:list')`);
      const assertPublic = async () => {
        const data = await publicSessions();
        assert.equal(JSON.stringify(data).includes(PASSWORD), false);
        for (const session of data.sessions) for (const field of ['password', 'passwordEnc', 'passphrase', 'passphraseEnc', '_oncePassword']) {
          assert.equal(Object.hasOwn(session, field), false, 'session-list response exposes ' + field);
        }
        return data;
      };
      const savedOnDisk = () => {
        const raw = fs.readFileSync(path.join(profile, 'sessions.json'), 'utf8');
        assert.equal(raw.includes(PASSWORD), false);
        return JSON.parse(raw).sessions.find(session => session.name === SAVED_NAME);
      };
      const assertEncrypted = () => {
        const stored = savedOnDisk();
        assert.equal(stored.username, USERNAME); assert.ok(stored.passwordEnc);
        assert.equal(Object.hasOwn(stored, 'password'), false);
        assert.equal(safeStorage.decryptString(Buffer.from(stored.passwordEnc, 'base64')), PASSWORD);
        return stored.passwordEnc;
      };
      const terminalConnected = async name => until(() => run(`window.__app.tabs.some(t=>t.kind==='terminal'&&t.title===${JSON.stringify(name)}&&t.state==='connected')`), name + ' authenticated');
      try {
        await until(() => run('Boolean(window.__app?.workspaceLayout)'), 'app ready');
        assert.equal(safeStorage.isEncryptionAvailable(), true, 'real OS encryption required for this workflow');
        assert.equal(await run('window.__app.info.encryption'), true);
        await setViewport(win, run, 1200, 780);
        await run(`window.__credentialPrompts=[];window.__hostPrompts=0;window.__app.handlePrompt=async p=>{if(p.kind==='hostkey'&&p.host==='127.0.0.1'){window.__hostPrompts++;return 'once';}window.__credentialPrompts.push({kind:p.kind,fields:(p.fields||[]).map(f=>f.name)});return null;};true;`);

        if (phase === 'restart') {
          assert.equal(await run(`localStorage.getItem('konx.recent')`), null, 'cleared history survives process restart');
          assert.equal(await run(`localStorage.getItem('konx.session-fixture.keep')`), 'retained', 'unrelated local storage survives clearing and restart');
          assert.equal(await run('window.__app.recentSessions().length'), 0);
          assert.equal(await run(`document.querySelector('.welcome-recent').textContent.includes('No recent sessions.')`), true);
          const data = await assertPublic();
          assert.equal(data.sessions.length, 3);
          assert.equal(data.sessions.find(s => s.name === SAVED_NAME).hasPassword, true);
          assert.equal(data.sessions.find(s => s.name === ONCE_NAME).hasPassword, false);
          assertEncrypted();
          assert.equal(await run('window.__app.workspaceLayout.get().layout'), 'workbench');
          await click(row(SAVED_NAME), 'left', 2); await terminalConnected(SAVED_NAME);
          assert.equal(await run('window.__credentialPrompts.length'), 0, 'stored login must not request credentials after restart');
          assert.equal(await run(`window.__app.tabs.find(t=>t.kind==='terminal').info.username`), USERNAME);
          await click(row(ONCE_NAME), 'left', 2);
          await until(() => run(`window.__credentialPrompts.some(p=>p.fields.includes('password'))`), 'one-time password is requested again after restart');
          await until(() => run(`window.__app.tabs.some(t=>t.kind==='terminal'&&t.title===${JSON.stringify(ONCE_NAME)}&&t.state==='disconnected')`), 'cancelled one-time login');
          assertEncrypted();
          console.log('SESSION_MANAGEMENT_UI_PASS restart'); await finish(0); return;
        }

        await run(`localStorage.setItem('konx.session-fixture.keep','retained');true;`);
        for (const invalidHistory of ['{"not":"a list"}', 'null']) {
          await run(`localStorage.setItem('konx.recent',${JSON.stringify(invalidHistory)});true;`);
          assert.equal(await run('window.__app.recentSessions().length'), 0, 'malformed recent history falls back to empty');
          await click(`document.querySelector('[data-action="clear-recent-sessions"]')`);
          assert.equal(await run(`localStorage.getItem('konx.recent')`), null);
          assert.equal(await run(`localStorage.getItem('konx.session-fixture.keep')`), 'retained');
        }

        await fillNew(SAVED_NAME, true);
        await capture('session-general', 900, 560, 'modal');
        await capture('session-general', 1400, 880, 'modal');
        await run(`window.__dialogBefore=document.querySelector('.modal');window.__passwordBefore=${password};true;`);
        await click(footer('Save'));
        await until(() => run(`document.querySelector('.modal [role="alert"]')?.textContent.includes('Fixture save failed')`), 'inline save error');
        assert.equal(failedOnce, true);
        assert.equal(await run('document.querySelector(".modal")===window.__dialogBefore'), true, 'failed save retains the same dialog');
        assert.equal(await run(`${password}===window.__passwordBefore`), true, 'failed save retains the same typed credential input');
        assert.equal(await run(`${password}.value`), PASSWORD);
        assert.equal(await run(`${field('Name')}.value`), SAVED_NAME);
        assert.equal(await run(`document.querySelector('.modal input[name="username"]').value`), USERNAME);
        assert.equal((await publicSessions()).sessions.length, 0, 'failed save does not create a record');
        await until(() => run(`!${footer('Save')}.disabled`), 'retry action enabled');
        await closeDialog('Save');
        await until(async () => (await publicSessions()).sessions.length === 1, 'saved session');
        const originalCiphertext = assertEncrypted();
        assert.equal((await assertPublic()).sessions[0].hasPassword, true);
        assert.equal(await run(`window.__app.tabs.filter(t=>t.kind==='terminal').length`), 0, 'Save alone does not connect');

        await editor(SAVED_NAME);
        assert.equal(await run(`${password}.value`), '', 'saved secret is not filled back into renderer');
        assert.equal(await run(`${savePassword}.checked`), true);
        assert.equal(await run(`document.querySelector('.modal input[name="username"]').value`), USERNAME);
        await closeDialog('Save');
        assert.equal(assertEncrypted(), originalCiphertext, 'blank edit retains the stored password');

        await editor(SAVED_NAME); await closeDialog('Save & Connect'); await terminalConnected(SAVED_NAME);
        assert.equal(await run('window.__credentialPrompts.length'), 0, 'saved credentials avoid a second login prompt');
        await run(`window.__savedTerminal=window.__app.tabs.find(t=>t.kind==='terminal'&&t.title===${JSON.stringify(SAVED_NAME)});true;`);
        assert.equal(await run('window.__savedTerminal.info.username'), USERNAME);

        await fillNew(ONCE_NAME, false); await closeDialog('Save & Connect'); await terminalConnected(ONCE_NAME);
        const onceData = await assertPublic();
        assert.equal(onceData.sessions.find(s => s.name === ONCE_NAME).hasPassword, false);
        const onceStored = JSON.parse(fs.readFileSync(path.join(profile, 'sessions.json'), 'utf8')).sessions.find(s => s.name === ONCE_NAME);
        assert.equal(Object.hasOwn(onceStored, 'passwordEnc'), false); assert.equal(Object.hasOwn(onceStored, 'password'), false);
        assert.equal(await run('window.__credentialPrompts.length'), 0, 'typed one-time password is used for this connection');

        await fillNew(CANCEL_NAME, true);
        await click(footer('Save & Connect'));
        await until(() => !!releaseDelayedSave, 'held save reaches main handler');
        assert.equal(await run(`${password}.disabled`), true, 'inputs stay locked while their save is pending');
        await closeDialog('Cancel');
        const terminalCount = await run(`window.__app.tabs.filter(t=>t.kind==='terminal').length`);
        releaseDelayedSave();
        await until(() => run(`window.__app.sessions.data.sessions.some(s=>s.name===${JSON.stringify(CANCEL_NAME)})`), 'late successful save refreshes session tree');
        assert.equal(await run(`Boolean(${row(CANCEL_NAME)})`), true);
        assert.equal(await run(`window.__app.tabs.filter(t=>t.kind==='terminal').length`), terminalCount, 'closing pending Save & Connect suppresses late connection');
        assert.equal(await run('Boolean(document.querySelector(".modal"))'), false);

        const beforeRejectedSave = await assertPublic();
        await fillNew(CANCEL_FAIL_NAME, true);
        await click(footer('Save & Connect'));
        await until(() => !!rejectDelayedSave, 'held failing save reaches main handler');
        await closeDialog('Cancel');
        rejectDelayedSave(new Error('Fixture delayed save failed after closing.'));
        await until(() => run(`([...document.querySelectorAll('.toast.err')].some(e=>e.textContent.includes('Fixture delayed save failed after closing.')))`), 'late save failure remains visible after Cancel');
        assert.deepEqual(await assertPublic(), beforeRejectedSave, 'failed cancelled save does not create a record');
        assert.equal(await run(`window.__app.tabs.filter(t=>t.kind==='terminal').length`), terminalCount);
        assert.equal(await run('Boolean(document.querySelector(".modal"))'), false);

        await click(`document.querySelector('#toolbar button[title="Home"]')`);
        await until(() => run('window.__app.active.kind==="welcome"'), 'Home active');
        await fill(`document.querySelector('.workspace-layout-select')`, 'workbench');
        await until(() => run('window.__app.workspaceLayout.get().layout==="workbench"'), 'Workbench persisted');
        await click(`window.__app.workspaceLayout.contextToggle`);
        assert.equal(await run('window.__app.workspaceLayout.contextHidden.workbench'), true, 'close the narrow-window Context overlay through its control');
        const savedId = await run('window.__savedTerminal.id');
        await fill(`document.querySelector('.workspace-pane[data-slot="companion"] .workspace-pane-select')`, savedId);
        await run(`window.__home=window.__app.tabs.find(t=>t.kind==='welcome');window.__app.activate(window.__home);true;`);
        await fill(`window.__home.el.querySelector('.qc-form select')`, 'telnet');
        await fill(`window.__home.el.querySelector('input[placeholder="Hostname, IP or COM port"]')`, 'unfinished-home-host');
        await fill(`window.__home.el.querySelector('.qc-form input[type="number"]')`, 2300);
        await fill(`window.__home.el.querySelector('input[placeholder="Username (optional)"]')`, 'unfinished-home-user');
        await fill(`window.__app.quickInput`, 'unfinished-toolbar-host');
        const beforePublic = await assertPublic();
        await run(`window.__tabsBefore=[...window.__app.tabs];window.__homeInputs=[...window.__home.el.querySelectorAll('.qc-form input,.qc-form select')];window.__homeValues=window.__homeInputs.map(e=>e.value);window.__layoutBefore=JSON.stringify(window.__app.workspaceLayout.get());true;`);
        assert.equal(await run('window.__app.recentSessions().length'), 2);
        assert.equal(await run(`window.__home.el.querySelectorAll('.welcome-recent button.card').length`), 2, 'recent cards retain native button semantics');
        await capture('home-recents-populated', 900, 560, 'home');
        await capture('home-recents-populated', 1400, 880, 'home');
        await click(`window.__home.el.querySelector('[data-action="clear-recent-sessions"]')`);
        assert.equal(await run('window.__app.recentSessions().length'), 0);
        assert.equal(await run(`localStorage.getItem('konx.recent')`), null);
        assert.equal(await run(`localStorage.getItem('konx.session-fixture.keep')`), 'retained');
        assert.equal(await run(`window.__home.el.querySelector('.welcome-recent').textContent.includes('No recent sessions.')`), true);
        assert.equal(await run('Boolean(document.querySelector(".modal"))'), false, 'history clearing does not ask to delete saved sessions');
        assert.deepEqual(await assertPublic(), beforePublic);
        assert.equal(await run('window.__tabsBefore.length===window.__app.tabs.length&&window.__tabsBefore.every((t,i)=>window.__app.tabs[i]===t)'), true);
        assert.equal(await run('window.__homeInputs.every((e,i)=>e.isConnected&&e.value===window.__homeValues[i])'), true, 'clear must preserve Home input nodes and unfinished values');
        assert.equal(await run('window.__app.quickInput.value'), 'unfinished-toolbar-host');
        assert.equal(await run('JSON.stringify(window.__app.workspaceLayout.get())===window.__layoutBefore'), true);
        assert.equal(await run('window.__app.workspaceLayout.contextHidden.workbench'), true, 'history clear preserves collapsed context');
        assert.equal(await run(`window.__app.tabs.filter(t=>t.kind==='terminal'&&t.state==='connected').length`), 2);
        assert.equal(assertEncrypted(), originalCiphertext);
        await capture('home-recents-cleared', 900, 560, 'home');
        await capture('home-recents-cleared', 1400, 880, 'home');
        console.log('SESSION_MANAGEMENT_UI_PASS exercise'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require('../src/main/main');
}

module.exports = { runSessionManagementUiTests };
if (process.versions.electron && process.argv.includes('--session-management-ui-fixture')) {
  fixture().catch(error => { console.error(error.stack || error); require('electron').app.exit(1); });
} else if (require.main === module) {
  runSessionManagementUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
