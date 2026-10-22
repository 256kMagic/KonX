'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { setViewport } = require('./lib/electron-viewport.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await pause(20); }
}

async function runSerialUiTests(test) {
  await test('serial UI: opt-in auto baud, saved framing, Home/toolbar requests, progress and cancellation survive restart without hardware', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-serial-ui-'));
    let child;
    try {
      for (const phase of ['exercise', 'restart']) {
        let output = '';
        const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_SERIAL_UI_ROOT: root,
          KONX_SERIAL_UI_PHASE: phase, KONX_CAPTURE: '', KONX_DEMO: '' };
        delete env.ELECTRON_RUN_AS_NODE;
        child = spawn(require('electron'), [__filename, '--serial-ui-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const collect = bytes => { output = (output + bytes).slice(-1024 * 1024); };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        const code = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('Serial UI fixture timed out\n' + output)); }, 60000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); resolve(code); });
        });
        assert.equal(code, 0, output); assert.match(output, new RegExp('SERIAL_UI_PASS ' + phase));
      }
      const saved = JSON.parse(fs.readFileSync(path.join(root, 'profile', 'sessions.json'), 'utf8')).sessions;
      assert.equal(saved.find(s => s.name === 'Automatic serial fixture').baudRate, 'auto');
      assert.equal(saved.find(s => s.name === 'Automatic serial fixture').serialAutoBaudProbe, true);
      assert.equal(saved.find(s => s.name === 'Manual serial fixture').baudRate, 9600);
      assert.equal(saved.find(s => s.name === 'Custom manual fixture').baudRate, 31250);
      if (process.env.KONX_SERIAL_UI_SCREENSHOTS) {
        const destination = path.resolve(process.env.KONX_SERIAL_UI_SCREENSHOTS); fs.mkdirSync(destination, { recursive: true });
        for (const file of fs.readdirSync(root).filter(file => file.endsWith('.png'))) fs.copyFileSync(path.join(root, file), path.join(destination, file));
      }
    } finally {
      if (child && child.exitCode == null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; }
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-serial-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, dialog, shell } = require('electron');
  const root = path.resolve(process.env.KONX_SERIAL_UI_ROOT || ''), phase = process.env.KONX_SERIAL_UI_PHASE;
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-serial-ui-'));
  assert.equal(path.resolve(process.env.KONX_USERDATA), path.join(root, 'profile')); assert.ok(['exercise', 'restart'].includes(phase));
  // Replace the serial producer before main loads it. Real Store, IPC,
  // ConnectionManager and renderer remain in use; no native port is enumerated.
  const transports = [];
  class SyntheticSerial extends EventEmitter {
    constructor(opts) { super(); this.opts = structuredClone(opts); this.closed = false; this.writes = []; transports.push(this); }
    connect() {
      if (this.opts.baudRate !== 'auto') { this.baudRate = Number(this.opts.baudRate) || 9600; return Promise.resolve(); }
      return new Promise((resolve, reject) => {
        this.resolve = resolve; this.reject = reject;
        setImmediate(() => { if (!this.closed) this.emit('baud-detect', { phase: 'sampling', baudRate: 115200, index: 2, total: 11,
          message: 'Listening at 115200 baud (2 of 11)… Waiting for readable device output.' }); });
      });
    }
    complete() {
      if (this.closed) return;
      this.baudRate = 115200; this.autoBaud = { baudRate: 115200, confidence: 'likely' };
      this.emit('baud-detect', { phase: 'complete', baudRate: 115200, index: 2, total: 11, message: 'Likely baud rate: 115200.' });
      this.resolve();
    }
    write(bytes) { this.writes.push(Buffer.from(bytes)); }
    resize() {}
    sendBreak() { throw new Error('UI fixture must never send BREAK'); }
    close() {
      if (this.closed) return;
      this.closed = true;
      if (!this.deferCancel) this.reject?.(new Error('Cancelled'));
      this.emit('close');
    }
  }
  const serialPath = require.resolve('../src/main/serial');
  require.cache[serialPath] = { id: serialPath, filename: serialPath, loaded: true, exports: { SerialConnection: SyntheticSerial,
    listPorts: async () => [{ path: 'COM401', label: 'COM401 - Synthetic fixture' }], serialAvailable: () => true } };
  const unexpected = action => { throw new Error('Serial UI fixture unexpectedly invoked ' + action); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, engine: null, missing: false,
    error: 'Offline serial fixture', npcap: { available: false }, builtin: { available: false } });
  require('../src/main/ai').AIClient.prototype.run = async () => unexpected('AI');
  shell.openExternal = async () => unexpected('external browser');
  dialog.showOpenDialog = async () => unexpected('native open'); dialog.showSaveDialog = async () => unexpected('native save');
  dialog.showErrorBox = (title, message) => unexpected(title + ': ' + message);
  let finished = false;
  const finish = async (code, error) => {
    if (finished) return; finished = true; if (error) console.error(error.stack || error);
    for (const transport of transports) transport.close();
    for (const win of BrowserWindow.getAllWindows()) { await win.webContents.session.flushStorageData(); win.destroy(); }
    app.exit(code);
  };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true); win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') console.error(details.message); });
    win.webContents.once('did-finish-load', async () => {
      const run = code => win.webContents.executeJavaScript(code);
      const click = async expression => {
        let point;
        await until(async () => {
          point = await run(`(()=>{const e=${expression};if(!e)return {ready:false};e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return {x,y,ready:!e.disabled&&r.width>0&&r.height>0&&(hit===e||e.contains(hit))};})()`);
          return point.ready;
        }, 'reachable ' + expression); delete point.ready;
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(25);
      };
      const input = name => `document.querySelector('.modal [name="${name}"]')`;
      const homeInput = name => `document.querySelector('.qc-form [name="${name}"]')`;
      const fill = (expression, value) => run(`(()=>{const e=${expression};if(!e)throw new Error('Missing input');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
      const footer = text => `[...document.querySelectorAll('.modal footer button')].find(e=>e.textContent===${JSON.stringify(text)})`;
      const save = async () => { await click(footer('Save')); await until(() => run('!document.querySelector(".modal")'), 'session saved'); };
      const edit = async name => {
        await run(`void window.__app.editSession(${name ? `window.__app.sessions.data.sessions.find(s=>s.name===${JSON.stringify(name)})` : 'undefined'});true;`);
        await until(() => run(`Boolean(${input('baudRate')})`), 'serial session editor');
      };
      const cancelScan = async () => {
        const instance = transports.at(-1), count = transports.length;
        await until(() => run(`window.__app.active.state==='connecting'&&window.__app.active.el.querySelector('.term-connecting .msg')?.textContent.includes('115200')`), 'visible detection progress');
        assert.match(await run('document.querySelector("#statusbar").textContent'), /115200/);
        await click(`window.__app.active.el.querySelector('button[aria-label="Cancel serial connection"]')`);
        await until(() => run('window.__app.active.state==="disconnected"'), 'scan cancelled');
        assert.equal(instance.closed, true); instance.complete(); await pause(40);
        assert.equal(transports.length, count); assert.equal(await run('window.__app.active.state'), 'disconnected');
      };
      const openHome = async () => { await run('window.__app.showHome();true;'); await until(() => run('Boolean(document.querySelector(".qc-form"))'), 'Home form'); };
      try {
        await until(() => run('Boolean(window.__app?.workspaceLayout)'), 'app initialized'); await setViewport(win, run, 900, 560);
        if (phase === 'restart') {
          await edit('Automatic serial fixture');
          assert.equal(await run(`${input('baudRate')}.value`), 'auto');
          assert.equal(await run(`${input('serialAutoBaudProbe')}.checked`), true);
          assert.equal(await run(`${input('parity')}.value`), 'even');
          await click(footer('Cancel'));
          await edit('Manual serial fixture'); assert.equal(await run(`${input('baudRate')}.value`), '9600');
          assert.equal(await run(`${input('serialAutoBaudProbe')}.checked`), false);
          await click(footer('Cancel'));
          assert.equal(transports.length, 0, 'opening saved editors must not touch a serial device');
          console.log('SERIAL_UI_PASS restart'); await finish(0); return;
        }
        await edit(); await fill(input('protocol'), 'serial');
        assert.equal(await run(`${input('baudRate')}.value`), '9600', 'manual default must remain 9600');
        assert.equal(await run(`${input('serialAutoBaudProbe')}.checked`), false);
        await fill(input('name'), 'Automatic serial fixture'); await fill(input('serialPort'), 'COM401');
        await fill(input('baudRate'), 'auto');
        assert.equal(await run(`${input('serialAutoBaudProbe')}.disabled`), false);
        assert.match(await run(`${input('serialAutoBaudProbe')}.parentElement.parentElement.textContent`), /Only baud is detected/);
        await click(input('serialAutoBaudProbe'));
        await fill(input('dataBits'), 7); await fill(input('parity'), 'even'); await fill(input('stopBits'), 2); await fill(input('flowControl'), 'xonxoff');
        await setViewport(win, run, 1000, 620); await setViewport(win, run, 900, 560); await pause(150);
        fs.writeFileSync(path.join(root, 'serial-auto-session.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
        await save();
        await edit('Automatic serial fixture'); assert.equal(await run(`${input('baudRate')}.value`), 'auto');
        assert.equal(await run(`${input('serialAutoBaudProbe')}.checked`), true); await click(footer('Cancel'));
        await edit(); await fill(input('protocol'), 'serial'); await fill(input('name'), 'Manual serial fixture'); await fill(input('serialPort'), 'COM402'); await save();
        await run(`window.api.invoke('sessions:save',{name:'Custom manual fixture',protocol:'serial',serialPort:'COM499',baudRate:31250}).then(()=>window.__app.sessions.load())`);
        await edit('Custom manual fixture'); assert.equal(await run(`${input('baudRate')}.value`), '31250'); await save();
        await run(`window.__serialTab=window.__app.connectSession(window.__app.sessions.data.sessions.find(s=>s.name==='Automatic serial fixture'));true;`);
        await until(() => transports.length === 1 && transports[0].resolve, 'synthetic saved auto connection');
        const automatic = transports[0];
        assert.deepEqual([automatic.opts.baudRate, automatic.opts.serialAutoBaudProbe, Number(automatic.opts.dataBits), automatic.opts.parity, Number(automatic.opts.stopBits), automatic.opts.flowControl], ['auto', true, 7, 'even', 2, 'xonxoff']);
        await until(() => run(`window.__serialTab.el.querySelector('.term-connecting .msg')?.textContent.includes('115200')`), 'saved session progress');
        fs.writeFileSync(path.join(root, 'serial-auto-progress.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
        automatic.complete(); await until(() => run('window.__serialTab.state==="connected"'), 'numeric detected baud connected');
        assert.equal(await run('window.__serialTab.info.baudRate'), 115200); assert.match(await run('document.querySelector("#statusbar").textContent'), /115200 baud.*detected/);
        assert.equal(await run(`window.__serialTab.el.querySelector('.term-connecting')===null`), true);
        assert.equal((await run(`window.api.invoke('sessions:list')`)).sessions.find(s => s.name === 'Automatic serial fixture').baudRate, 'auto');
        await run('window.__serialTab.disconnect();true;');
        await until(() => run('window.__serialTab.state==="disconnected"'), 'previous detected connection closed');
        await run('window.__oldSerialSettled=false;void window.__serialTab.connect().then(()=>{window.__oldSerialSettled=true;});true;');
        await until(() => transports.length === 2 && transports[1].resolve, 'old delayed serial attempt');
        const delayed = transports[1]; delayed.deferCancel = true;
        assert.equal(await run('window.__serialTab.info'), null, 'reconnecting must clear the previous detected baud');
        assert.doesNotMatch(await run('document.querySelector("#statusbar").textContent'), /baud.*detected/);
        await click(`window.__serialTab.el.querySelector('button[aria-label="Cancel serial connection"]')`);
        await until(() => run('window.__serialTab.state==="disconnected"'), 'old serial attempt cancelled');
        assert.equal(await run('window.__oldSerialSettled'), false, 'cancelled producer deliberately has not settled yet');
        await run('window.__serialTab.reconnect();true;');
        await until(() => transports.length === 3 && transports[2].resolve, 'replacement serial attempt');
        transports[2].complete(); await until(() => run('window.__serialTab.state==="connected"'), 'replacement serial connected');
        delayed.reject(new Error('Late cancelled serial attempt'));
        await until(() => run('window.__oldSerialSettled'), 'old rejected IPC response delivered');
        assert.equal(await run('window.__serialTab.state'), 'connected', 'late old failure must not disconnect the replacement');
        assert.equal(await run('window.__serialTab.info.baudRate'), 115200);
        assert.equal(await run('window.__serialTab.overlay===null'), true);
        await run(`window.__app.connectSession(window.__app.sessions.data.sessions.find(s=>s.name==='Manual serial fixture'));true;`);
        await until(() => run('window.__app.active.state==="connected"'), 'manual default connection'); assert.equal(transports.at(-1).opts.baudRate, 9600);
        await openHome(); await fill(`document.querySelector('.qc-form select')`, 'serial');
        await fill(`document.querySelector('.qc-form input[placeholder="Hostname, IP or COM port"]')`, 'COM403');
        await fill(homeInput('quickPort'), 'auto');
        assert.equal(await run(`${homeInput('quickPort')}.type`), 'text'); assert.equal(await run(`${homeInput('quickSerialAutoBaudProbe')}.checked`), false);
        await click(homeInput('quickSerialAutoBaudProbe')); await click(`document.querySelector('.qc-form button[data-action="quick-connect"]')`);
        await until(() => transports.at(-1).opts.serialPort === 'COM403', 'Home auto request'); assert.equal(transports.at(-1).opts.baudRate, 'auto'); assert.equal(transports.at(-1).opts.serialAutoBaudProbe, true); await cancelScan();
        await openHome(); await fill(`document.querySelector('.qc-form input[placeholder="Hostname, IP or COM port"]')`, 'COM404@auto');
        await fill(homeInput('quickPort'), '');
        await click(`document.querySelector('.qc-form button[data-action="quick-connect"]')`);
        await until(() => transports.at(-1).opts.serialPort === 'COM404', 'Home inline auto request'); assert.equal(transports.at(-1).opts.baudRate, 'auto'); await cancelScan();
        await run(`window.__app.quickInput.value='COM405@auto';window.__app.quickInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true;`);
        await until(() => transports.at(-1).opts.serialPort === 'COM405', 'toolbar auto request'); assert.equal(transports.at(-1).opts.baudRate, 'auto'); assert.notEqual(transports.at(-1).opts.serialAutoBaudProbe, true); await cancelScan();
        const beforeInvalid = transports.length;
        for (const target of ['COM4@autoX', 'COM4@0', 'COM4@-1', 'COM4@NaN']) {
          const parsed = await run(`import('./js/app.js').then(({parseQuick})=>parseQuick(${JSON.stringify(target)}))`);
          assert.equal(parsed.protocol, 'serial', 'malformed serial suffix must not become an SSH target');
          await run(`window.__app.quickInput.value=${JSON.stringify(target)};window.__app.quickInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true;`);
        }
        assert.equal(transports.length, beforeInvalid);
        await openHome(); await fill(`document.querySelector('.qc-form select')`, 'serial');
        await fill(`document.querySelector('.qc-form input[placeholder="Hostname, IP or COM port"]')`, 'COM406');
        for (const invalid of ['autoX', '0', '-1', 'NaN']) {
          await fill(homeInput('quickPort'), invalid); await click(`document.querySelector('.qc-form button[data-action="quick-connect"]')`);
          assert.match(await run(`document.querySelector('.qc-form .qc-error').textContent`), /positive numeric baud rate or auto/);
          assert.equal(transports.length, beforeInvalid);
        }
        await fill(homeInput('quickPort'), 115200);
        await click(`document.querySelector('.qc-form button[data-action="quick-connect"]')`);
        await until(() => run('window.__app.active.state==="connected"'), 'Home manual rate'); assert.equal(transports.at(-1).opts.baudRate, 115200); assert.equal(transports.at(-1).opts.serialAutoBaudProbe, false);
        assert.ok(transports.every(transport => transport.writes.length === 0), 'renderer must not send implicit Enter probes');
        console.log('SERIAL_UI_PASS exercise'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require('../src/main/main');
}

module.exports = { runSerialUiTests };
if (process.versions.electron && process.argv.includes('--serial-ui-fixture')) fixture().catch(error => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) runSerialUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
