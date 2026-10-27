'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');

// Credentials belong only to the owned loopback peer, never a user profile.
const USER = 'on-demand-fixture';
const PASSWORD = 'KonX synthetic on-demand password';
const SAVED = 'On-demand router';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await pause(25); }
}

async function runSaveConnectionSessionUiTests(test) {
  await test('on-demand sessions: live save, shared SFTP, credential choice, late saves and restart through the production UI', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-save-connection-'));
    let child, server;
    const peers = new Set();
    try {
      const ssh = await require('./ssh-test-server').startServer({ port: 0, root, user: USER, password: PASSWORD, hostname: 'on-demand-switch' });
      server = ssh.server;
      server.on('connection', client => { peers.add(client); client.once('close', () => peers.delete(client)); });
      for (const phase of ['exercise', 'restart']) {
        let output = '';
        const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_SAVE_CONNECTION_ROOT: root,
          KONX_SAVE_CONNECTION_PHASE: phase, KONX_SAVE_CONNECTION_PORT: String(ssh.port), KONX_CAPTURE: '', KONX_DEMO: '' };
        delete env.ELECTRON_RUN_AS_NODE;
        child = spawn(require('electron'), [__filename, '--save-connection-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const collect = bytes => { output = (output + bytes).slice(-1024 * 1024); };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        const code = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('Save connection UI fixture timed out\n' + output)); }, 150000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); resolve(code); });
        });
        assert.equal(code, 0, output);
        assert.match(output, new RegExp('SAVE_CONNECTION_UI_PASS ' + phase));
      }
      const raw = fs.readFileSync(path.join(root, 'profile/sessions.json'), 'utf8');
      assert.equal(raw.includes(PASSWORD), false);
      const sessions = JSON.parse(raw).sessions;
      assert.equal(new Set(sessions.map(s => s.id)).size, sessions.length);
      assert.equal(sessions.filter(s => s.name === SAVED).length, 1);
      assert.ok(sessions.find(s => s.name === SAVED).passwordEnc);
      assert.equal(Object.hasOwn(sessions.find(s => s.name === 'No remembered password'), 'passwordEnc'), false);
      if (process.env.KONX_SAVE_CONNECTION_SCREENSHOTS) {
        const review = fs.realpathSync(path.join(__dirname, '../review'));
        const destination = path.resolve(process.env.KONX_SAVE_CONNECTION_SCREENSHOTS), relative = path.relative(review, destination);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        fs.mkdirSync(destination, { recursive: true });
        assert.equal(fs.realpathSync(destination), destination);
        for (const name of fs.readdirSync(root).filter(name => name.endsWith('.png'))) fs.copyFileSync(path.join(root, name), path.join(destination, name));
      }
    } finally {
      if (child && child.exitCode == null && child.signalCode == null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; }
      for (const peer of peers) peer.end();
      if (server) await new Promise(resolve => server.close(resolve));
      const resolved = fs.realpathSync(root);
      assert.equal(path.dirname(resolved), base); assert.ok(path.basename(resolved).startsWith('konx-save-connection-'));
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, dialog, shell, safeStorage } = require('electron');
  const root = path.resolve(process.env.KONX_SAVE_CONNECTION_ROOT || ''), profile = path.join(root, 'profile');
  const phase = process.env.KONX_SAVE_CONNECTION_PHASE, port = Number(process.env.KONX_SAVE_CONNECTION_PORT);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-save-connection-'));
  assert.equal(path.resolve(process.env.KONX_USERDATA), profile); assert.ok(['exercise', 'restart'].includes(phase));
  assert.ok(port > 0 && port <= 65535);

  // Serial is synthetic; all saving, encryption, IPC and UI use production code.
  class SyntheticSerial extends EventEmitter {
    constructor(options) { super(); this.options = options; this.baudRate = 115200; }
    async connect() {}
    write() {}
    close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
  }
  const serialPath = require.resolve('../src/main/serial');
  require.cache[serialPath] = { id: serialPath, filename: serialPath, loaded: true, exports: { SerialConnection: SyntheticSerial,
    listPorts: async () => [{ path: 'COM401', label: 'Synthetic fixture' }], serialAvailable: () => true } };
  const unexpected = action => { throw new Error('Unexpected save-session fixture operation: ' + action); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, error: 'Offline fixture', builtin: { available: false } });
  require('../src/main/ai').AIClient.prototype.run = async () => unexpected('AI provider');
  shell.openExternal = async () => unexpected('external browser');
  dialog.showOpenDialog = dialog.showSaveDialog = async () => unexpected('native file dialog');
  dialog.showErrorBox = (title, message) => unexpected(title + ': ' + message);

  const peers = new Set();
  const rawServer = net.createServer(socket => { peers.add(socket); socket.on('error', () => {}); socket.once('close', () => peers.delete(socket)); socket.write('Fixture ready\r\n'); });
  await new Promise(resolve => rawServer.listen(0, '127.0.0.1', resolve));
  const rawPort = rawServer.address().port;
  const { ConnectionManager } = require('../src/main/connections'), { SftpManager } = require('../src/main/sftp');
  const terminalOpen = ConnectionManager.prototype.open, sftpOpen = SftpManager.prototype.open;
  let connectionOpens = 0, manager;
  ConnectionManager.prototype.open = function (...args) { connectionOpens++; manager = this; return terminalOpen.apply(this, args); };
  SftpManager.prototype.open = function (...args) { connectionOpens++; return sftpOpen.apply(this, args); };
  const { Store } = require('../src/main/store'), originalSave = Store.prototype.saveSession;
  let saveMode = null, releaseSave = null, saveCalls = 0;
  Store.prototype.saveSession = function (input) {
    saveCalls++;
    const mode = saveMode; saveMode = null;
    if (mode === 'fail') throw new Error('Fixture save failed before writing.');
    if (mode === 'hold') return new Promise((resolve, reject) => { releaseSave = () => { try { resolve(originalSave.call(this, input)); } catch (error) { reject(error); } }; });
    return originalSave.call(this, input);
  };
  let finished = false;
  const finish = async (code, error) => {
    if (finished) return; finished = true;
    if (error) console.error(error.stack || error);
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => rawServer.close(resolve));
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      await win.webContents.session.flushStorageData(); win.destroy();
    }
    app.exit(code);
  };
  const fail = error => { finish(1, error instanceof Error ? error : new Error(String(error))).catch(error => { console.error(error); app.exit(1); }); };
  process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
  app.on('browser-window-created', (_event, win) => {
    if (win.isDestroyed()) return;
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true); win.webContents.setBackgroundThrottling(false);
  });
  app.once('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', async () => {
    const run = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(error.message + '\nRenderer expression: ' + code.slice(0, 1000)); }
    };
    const click = async (expression, host = win) => {
      let point;
      await until(async () => {
        point = await run(`(()=>{const e=${expression};if(!e)return {ready:false};e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=e.ownerDocument.elementFromPoint(x,y);return {x,y,ready:!e.disabled&&r.width>0&&r.height>0&&(hit===e||e.contains(hit))};})()`);
        return point.ready;
      }, 'reachable ' + expression);
      delete point.ready;
      host.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      host.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      host.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await pause(25);
    };
    const input = name => `document.querySelector('.modal [name="${name}"]')`;
    const footer = label => `[...document.querySelectorAll('.modal footer button')].find(b=>b.textContent===${JSON.stringify(label)})`;
    const fill = async (name, value) => run(`(()=>{const e=${input(name)};if(!e)throw new Error('Missing ${name}');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    const tabButton = tab => `window.${tab}.el.querySelector('[data-action="save-session"]')`;
    const openEditor = async tab => {
      await run(`window.__app.activate(window.${tab});true;`);
      await click(tabButton(tab));
      await until(() => run(`Boolean(${input('name')})`), 'save editor');
      assert.deepEqual(await run(`[...document.querySelectorAll('.modal footer button')].map(b=>b.textContent)`), ['Cancel', 'Save']);
    };
    const closeEditor = async label => { await click(footer(label)); await until(() => run('!document.querySelector(".modal")'), 'editor closed'); };
    const list = async () => {
      const data = await run(`window.api.invoke('sessions:list')`);
      assert.equal(JSON.stringify(data).includes(PASSWORD), false);
      for (const session of data.sessions) for (const key of ['password', 'passwordEnc', 'passphrase', 'passphraseEnc', '_oncePassword']) assert.equal(Object.hasOwn(session, key), false);
      return data.sessions;
    };
    const stored = () => JSON.parse(fs.readFileSync(path.join(profile, 'sessions.json'), 'utf8')).sessions;
    const connected = tab => until(() => run(`window.${tab}.state==='connected'`), tab + ' connected');
    const saveAs = async (tab, name) => { await openEditor(tab); await fill('name', name); await closeEditor('Save'); await until(async () => (await list()).some(s => s.name === name), name + ' persisted'); };
    const screenshot = async name => {
      if (!process.env.KONX_SAVE_CONNECTION_SCREENSHOTS) return;
      await pause(250);
      await until(() => run(`[...document.querySelectorAll('.modal-back,.modal')].every(e=>Number(getComputedStyle(e).opacity)===1)`), 'settled opaque modal');
      fs.writeFileSync(path.join(root, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    };
    try {
      await until(() => run('Boolean(window.__app?.workspaceLayout)'), 'app ready');
      assert.equal(safeStorage.isEncryptionAvailable(), true);
      await setViewport(win, run, 1200, 780);
      await run(`window.__loginPrompts=[];window.__app.handlePrompt=async p=>{if(p.kind==='hostkey'&&p.host==='127.0.0.1')return 'once';window.__loginPrompts.push((p.fields||[]).map(f=>f.name));if(p.fields?.some(f=>f.name==='username'))return {username:${JSON.stringify(USER)}};if(p.fields?.some(f=>f.name==='password'))return {password:${JSON.stringify(PASSWORD)}};return null;};true;`);
      if (phase === 'restart') {
        const sessions = await list(), saved = sessions.find(s => s.name === SAVED);
        assert.ok(saved); assert.equal(saved.username, USER); assert.equal(saved.folder, 'Fixture/On demand'); assert.equal(saved.hasPassword, true);
        await run(`window.__reopened=window.__app.connectSession(window.__app.sessions.data.sessions.find(s=>s.name===${JSON.stringify(SAVED)}));true;`);
        await connected('__reopened');
        assert.deepEqual(await run('window.__loginPrompts'), [], 'saved login survives a real process restart');
        assert.equal(await run(`${tabButton('__reopened')}.textContent.trim()`), 'Edit saved session');
        assert.equal(sessions.find(s => s.name === 'Serial settings').baudRate, 'auto');
        console.log('SAVE_CONNECTION_UI_PASS restart'); await finish(0); return;
      }

      await run(`window.__term=window.__app.quickConnect({protocol:'ssh',host:'127.0.0.1',port:${port},password:${JSON.stringify(PASSWORD)}});window.__initialSpec=JSON.stringify(window.__term.spec);true;`);
      await connected('__term');
      const initialId = await run('window.__term.id'), liveConnection = manager.conns.get(initialId), initialOpens = connectionOpens;
      assert.equal(await run('window.__term.info.username'), USER);
      await openEditor('__term');
      assert.equal(await run(`${input('username')}.value`), USER, 'prefill the username supplied by the authentication prompt');
      assert.equal(await run(`${input('password')}.type`), 'password');
      assert.equal(await run(`${input('password')}.value`), PASSWORD, 'inline one-time password is offered for explicit retention');
      await fill('name', SAVED); await fill('folder', 'Fixture/On demand');
      await screenshot('save-session-1200');
      await setViewport(win, run, 900, 620);
      await screenshot('save-session-900');
      await closeEditor('Cancel');
      assert.equal((await list()).length, 0);
      assert.equal(await run('window.__term.sessionReference.savedId || null'), null);

      await openEditor('__term'); await fill('name', SAVED); await fill('folder', 'Fixture/On demand');
      saveMode = 'fail'; await click(footer('Save'));
      await until(() => run(`document.querySelector('.modal [role="alert"]')?.textContent.includes('Fixture save failed')`), 'inline error');
      assert.equal((await list()).length, 0); assert.equal(await run(`${input('password')}.value`), PASSWORD);
      assert.equal(await run('window.__term.sessionReference.savedId || null'), null);
      saveMode = 'hold'; releaseSave = null;
      const callsBefore = saveCalls;
      await click(footer('Save')); await until(() => !!releaseSave, 'save pending');
      await run(`document.querySelector('.modal footer .primary').click();void window.__app.saveConnectionSession(window.__term);true;`);
      assert.equal(saveCalls, callsBefore + 1); assert.equal(await run('document.querySelectorAll(".modal").length'), 1);
      releaseSave(); await until(() => run('!document.querySelector(".modal")'), 'saved editor closed');
      await until(() => run('Boolean(window.__term.sessionReference.savedId)'), 'saved association');
      const savedId = await run('window.__term.sessionReference.savedId');
      const disk = stored().find(s => s.id === savedId);
      assert.equal(disk.username, USER); assert.equal(disk.folder, 'Fixture/On demand');
      assert.equal(safeStorage.decryptString(Buffer.from(disk.passwordEnc, 'base64')), PASSWORD);
      assert.equal(connectionOpens, initialOpens, 'saving never opens another connection');
      assert.equal(manager.conns.get(initialId), liveConnection, 'same live transport remains owned');
      assert.equal(await run('JSON.stringify(window.__term.spec)===window.__initialSpec'), true);
      const toolbar = await run(`(()=>{const e=${tabButton('__term')},r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,reachable:hit===e||e.contains(hit),overflow:document.documentElement.scrollWidth>innerWidth+2};})()`);
      assert.deepEqual(toolbar, { inside: true, reachable: true, overflow: false }, 'Save action remains reachable with the terminal toolbar at 900px');
      await screenshot('saved-terminal-toolbar-900');
      await run(String.raw`window.__term.sendText('show version\r');true;`);
      await until(() => run(String.raw`(()=>{const b=window.__term.term.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\n').includes('Version 17.9.4a')})()`), 'original connection still usable');

      await openEditor('__term');
      assert.equal(await run(`${input('password')}.value`), '', 'editing does not reveal the encrypted saved secret');
      await fill('host', '192.0.2.50'); await closeEditor('Save');
      assert.equal((await list()).length, 1, 'Edit updates the same saved session');
      assert.equal(await run('JSON.stringify(window.__term.spec)===window.__initialSpec'), true, 'editing the saved destination leaves running and reconnect parameters intact');
      await openEditor('__term'); await fill('host', '127.0.0.1'); await closeEditor('Save');
      assert.equal(connectionOpens, initialOpens);

      // Clone reuses the inline spec object, but owns an independent connection.
      await run(`window.__clone=window.__app.openTerminal(window.__term.spec,window.__term.cloneMeta());true;`); await connected('__clone');
      assert.equal(await run('window.__clone.sessionReference===window.__term.sessionReference'), false);
      assert.equal(await run('window.__clone.sessionReference.savedId || null'), null);
      await saveAs('__clone', 'Cloned connection');
      assert.notEqual(await run('window.__clone.sessionReference.savedId'), savedId);
      assert.equal(await run('window.__term.sessionReference.savedId'), savedId);
      await run(`window.__app.closeTab(window.__clone);true;`);

      await run(`window.__shared=window.__app.openSftpFromTerminal(window.__term);true;`); await connected('__shared');
      assert.equal(await run('window.__shared.sessionReference===window.__term.sessionReference'), true);
      await openEditor('__shared'); assert.equal(await run(`${input('name')}.value`), SAVED); await closeEditor('Cancel');
      const layout = await run(`import('./js/site-workspaces.js').then(m=>m.captureSiteLayout(window.__app))`);
      assert.equal(layout.sessions.filter(s => s.id === savedId).length, 1);
      assert.deepEqual(layout.layout.panels.filter(p => p.referenceId === savedId).map(p => p.sessionMode).sort(), ['sftp', 'terminal']);
      assert.equal(JSON.stringify(layout).includes(PASSWORD), false);

      // Password prompt answers are deliberately not harvested after login.
      await run(`window.__prompted=window.__app.quickConnect({protocol:'ssh',host:'127.0.0.1',port:${port}});true;`); await connected('__prompted');
      await openEditor('__prompted');
      assert.equal(await run(`${input('username')}.value`), USER);
      assert.equal(await run(`${input('password')}.value`), '');
      await closeEditor('Cancel');
      await run(`window.__once=window.__app.quickConnect({protocol:'ssh',host:'127.0.0.1',port:${port},username:${JSON.stringify(USER)},password:${JSON.stringify(PASSWORD)}});true;`); await connected('__once');
      await openEditor('__once'); await fill('name', 'No remembered password');
      if (await run(`${input('savePassword')}.checked`)) await click(input('savePassword'));
      await closeEditor('Save');
      assert.equal((await list()).find(s => s.name === 'No remembered password').hasPassword, false);

      // Cancelling a pending save does not cancel the durable write or lose its identity.
      await run(`window.__late=window.__app.quickConnect({protocol:'raw',host:'127.0.0.1',port:${rawPort}});true;`); await connected('__late');
      await openEditor('__late'); await fill('name', 'Late saved raw');
      saveMode = 'hold'; releaseSave = null; await click(footer('Save')); await until(() => !!releaseSave, 'late pending save');
      await closeEditor('Cancel');
      await run(`void window.__app.saveConnectionSession(window.__late);true;`);
      await pause(50); assert.equal(await run('document.querySelectorAll(".modal").length'), 0, 'pending durable save cannot open a duplicate editor');
      releaseSave(); await until(() => run('Boolean(window.__late.sessionReference.savedId)'), 'late save association');
      await openEditor('__late'); assert.equal(await run(`${input('name')}.value`), 'Late saved raw'); await closeEditor('Save');
      assert.equal((await list()).filter(s => s.name === 'Late saved raw').length, 1);

      // A saved record must be associated before a refresh can fail.
      await run(`window.__refresh=window.__app.quickConnect({protocol:'raw',host:'127.0.0.1',port:${rawPort}});true;`); await connected('__refresh');
      await openEditor('__refresh'); await fill('name', 'Refresh failure');
      await run(`window.__originalLoad=window.__app.sessions.load;window.__app.sessions.load=async()=>{throw new Error('Fixture session refresh failed')};true;`);
      await closeEditor('Save'); await until(() => run('Boolean(window.__refresh.sessionReference.savedId)'), 'durable association despite refresh failure');
      await run(`(async()=>{window.__app.sessions.load=window.__originalLoad;await window.__app.sessions.load();return true;})()`);
      await openEditor('__refresh'); await closeEditor('Save');
      assert.equal((await list()).filter(s => s.name === 'Refresh failure').length, 1);

      // Shared SFTP retains its draft/owner when its source tab closes mid-save.
      await run(`window.__source=window.__app.quickConnect({protocol:'ssh',host:'127.0.0.1',port:${port},username:${JSON.stringify(USER)},password:${JSON.stringify(PASSWORD)}});true;`); await connected('__source');
      await run(`window.__orphan=window.__app.openSftpFromTerminal(window.__source);true;`); await connected('__orphan');
      await openEditor('__orphan'); await fill('name', 'Saved from shared SFTP');
      saveMode = 'hold'; releaseSave = null; await click(footer('Save')); await until(() => !!releaseSave, 'shared save pending');
      await run(`void window.__app.saveConnectionSession(window.__source);window.__app.closeTab(window.__source);true;`);
      assert.equal(await run('document.querySelectorAll(".modal").length'), 1);
      await closeEditor('Cancel'); releaseSave();
      await until(() => run('Boolean(window.__orphan.sessionReference.savedId)'), 'shared record retained after source close');
      await openEditor('__orphan'); await closeEditor('Save');
      assert.equal((await list()).filter(s => s.name === 'Saved from shared SFTP').length, 1);

      await run(`window.__standalone=window.__app.quickSftp({host:'127.0.0.1',port:${port},password:${JSON.stringify(PASSWORD)}});true;`); await connected('__standalone');
      await openEditor('__standalone');
      assert.equal(await run(`${input('username')}.value`), USER, 'standalone SFTP exposes its actual prompted username as structured metadata');
      await fill('name', 'Standalone SFTP'); await closeEditor('Save');
      assert.equal((await list()).find(s => s.name === 'Standalone SFTP').protocol, 'ssh');

      await run(`window.__serial=window.__app.quickConnect({protocol:'serial',serialPort:'COM401',baudRate:'auto',dataBits:7,parity:'even',stopBits:2,flowControl:'xonxoff',serialAutoBaudProbe:true});true;`); await connected('__serial');
      await saveAs('__serial', 'Serial settings');
      const serial = (await list()).find(s => s.name === 'Serial settings');
      assert.deepEqual([serial.serialPort, serial.baudRate, Number(serial.dataBits), serial.parity, Number(serial.stopBits), serial.flowControl, serial.serialAutoBaudProbe], ['COM401', 'auto', 7, 'even', 2, 'xonxoff', true]);
      await run(`window.__telnet=window.__app.quickConnect({protocol:'telnet',host:'127.0.0.1',port:${rawPort},username:'telnet-user',password:${JSON.stringify(PASSWORD)},autoLogin:false});true;`); await connected('__telnet');
      await saveAs('__telnet', 'Telnet settings');
      const telnet = (await list()).find(s => s.name === 'Telnet settings');
      assert.equal(telnet.protocol, 'telnet'); assert.equal(telnet.port, rawPort); assert.equal(telnet.username, 'telnet-user');
      assert.equal(telnet.autoLogin, false, 'saving preserves explicit options without editor controls');

      await run(`window.__unencrypted=window.__app.quickConnect({protocol:'raw',host:'127.0.0.1',port:${rawPort},password:${JSON.stringify(PASSWORD)}});window.__app.info.encryption=false;true;`); await connected('__unencrypted');
      await openEditor('__unencrypted');
      assert.equal(await run(`${input('savePassword')}.disabled`), true);
      assert.equal(await run(`${input('savePassword')}.checked`), false);
      await closeEditor('Cancel'); await run(`window.__app.info.encryption=true;true;`);

      // The same dialog follows a live tab from a child window back to KonX.
      await run(`window.__popupTab=window.__app.quickConnect({protocol:'raw',host:'127.0.0.1',port:${rawPort}});true;`); await connected('__popupTab');
      const opensBeforePopup = connectionOpens;
      assert.equal(await run('window.__app.popouts.open(window.__popupTab)'), true);
      const child = BrowserWindow.getAllWindows().find(candidate => candidate !== win);
      assert.ok(child && !child.isDestroyed());
      await click(tabButton('__popupTab'), child);
      await until(() => run(`Boolean(window.__popupTab.el.ownerDocument.querySelector('.modal input[name="name"]'))`), 'editor in pop-out');
      assert.equal(await run('Boolean(document.querySelector(".modal"))'), false);
      await run(`window.__popupTab.el.ownerDocument.querySelector('.modal input[name="name"]').value='Popped out session';window.__app.popouts.dock(window.__popupTab);true;`);
      await until(() => run('window.__popupTab.el.ownerDocument===document&&Boolean(document.querySelector(".modal"))'), 'editor redocked');
      assert.equal(await run(`${input('name')}.value`), 'Popped out session');
      await closeEditor('Save');
      await until(() => run('Boolean(window.__popupTab.sessionReference.savedId)'), 'popped-out connection saved');
      assert.equal(connectionOpens, opensBeforePopup);
      assert.equal(await run('window.__popupTab.state'), 'connected');
      await list();
      console.log('SAVE_CONNECTION_UI_PASS exercise'); await finish(0);
    } catch (error) { await finish(1, error); }
  }));
  require('../src/main/main');
}

module.exports = { runSaveConnectionSessionUiTests };
if (process.versions.electron && process.argv.includes('--save-connection-fixture')) {
  fixture().catch(error => { console.error(error.stack || error); require('electron').app.exit(1); });
} else if (require.main === module) {
  runSaveConnectionSessionUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
