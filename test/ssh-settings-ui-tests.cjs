'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  const end = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error('Timed out: ' + description);
    await pause(20);
  }
}

async function runSshSettingsUiTests(test) {
  await test('SSH transport settings: real editor saves/reopens both modes and requires explicit repair of unknown values', async () => {
    const base = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(base, 'konx-ssh-settings-'));
    let child, output = '';
    try {
      const profile = path.join(root, 'profile');
      fs.mkdirSync(profile);
      // Older and future-version records exercise the real Store/editor boundary.
      fs.writeFileSync(path.join(profile, 'sessions.json'), JSON.stringify({ version: 1, folders: [], sessions: [
        { id: 'old', name: 'Older session fixture', protocol: 'ssh', host: '192.0.2.1', username: 'fixture' },
        { id: 'unknown', name: 'Unknown transport fixture', protocol: 'ssh', host: '192.0.2.2', sshCompatibility: 'future-mode' },
      ] }));
      const env = { ...process.env, KONX_USERDATA: profile, KONX_SSH_SETTINGS_ROOT: root, KONX_CAPTURE: '', KONX_DEMO: '' };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--ssh-settings-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = data => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('SSH settings fixture timed out\n' + output)); }, 60000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0, output);
      assert.match(output, /SSH_SETTINGS_UI_PASS/);
      const saved = JSON.parse(fs.readFileSync(path.join(profile, 'sessions.json'), 'utf8')).sessions;
      assert.equal(saved.length, 3);
      assert.equal(saved.find(s => s.name === 'New transport fixture').sshCompatibility, 'auto');
      assert.equal(saved.find(s => s.id === 'old').sshCompatibility, 'auto');
      assert.equal(saved.find(s => s.id === 'unknown').sshCompatibility, 'modern');
    } finally {
      if (child && child.exitCode == null) {
        const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped;
      }
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-ssh-settings-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, dialog, shell } = require('electron');
  const root = path.resolve(process.env.KONX_SSH_SETTINGS_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('konx-ssh-settings-'));
  assert.equal(path.resolve(process.env.KONX_USERDATA), path.join(root, 'profile'));
  const unexpected = action => { throw new Error('SSH settings fixture unexpectedly invoked ' + action); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, engine: null, missing: false,
    error: 'Offline SSH settings fixture', npcap: { available: false }, builtin: { available: false } });
  require('../src/main/ai').AIClient.prototype.run = async () => unexpected('AI provider');
  require('../src/main/connections').ConnectionManager.prototype.open = async () => unexpected('connection');
  shell.openExternal = async () => unexpected('external browser');
  dialog.showOpenDialog = async () => unexpected('native open');
  dialog.showSaveDialog = async () => unexpected('native save');
  dialog.showErrorBox = (title, message) => unexpected(title + ': ' + message);
  let finished = false;
  const finish = async (code, error) => {
    if (finished) return; finished = true;
    if (error) console.error(error.stack || error);
    for (const win of BrowserWindow.getAllWindows()) { await win.webContents.session.flushStorageData(); win.destroy(); }
    app.exit(code);
  };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.setBackgroundThrottling(false);
    win.webContents.once('did-finish-load', async () => {
      const run = code => win.webContents.executeJavaScript(code);
      const click = async (expression, button = 'left') => {
        let point;
        await until(async () => {
          point = await run(`(()=>{const e=${expression};if(!e)return {ready:false};e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return{x,y,ready:!e.disabled&&r.width>0&&r.height>0&&(hit===e||e.contains(hit))};})()`);
          return point.ready;
        }, 'reachable control ' + expression);
        delete point.ready;
        win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        win.webContents.sendInputEvent({ type: 'mouseDown', button, clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button, clickCount: 1, ...point });
        await pause(25);
      };
      const fill = async (expression, value) => run(`(()=>{const e=${expression};if(!e)throw new Error('Missing input');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
      const footer = label => `[...document.querySelectorAll('.modal footer button')].find(b=>b.textContent===${JSON.stringify(label)})`;
      const mode = `document.querySelector('.modal select[name="sshCompatibility"]')`;
      const connection = `[...document.querySelectorAll('.modal .mtabs button')].find(b=>b.textContent==='Connection')`;
      const sessions = () => run(`window.api.invoke('sessions:list')`);
      const edit = async name => {
        await click(`[...document.querySelectorAll('.tree-row')].find(e=>e.querySelector('.name')?.textContent===${JSON.stringify(name)})`, 'right');
        await click(`[...document.querySelectorAll('.ctx .item')].find(e=>e.textContent.startsWith('Edit…'))`);
        await until(() => run(`Boolean(${mode})`), 'session editor');
        await click(connection);
      };
      const save = async () => { await click(footer('Save')); await until(() => run('!document.querySelector(".modal")'), 'save closes editor'); };
      try {
        await until(() => run('Boolean(window.__app?.workspaceLayout)&&window.__app.sessions.data.sessions.length===2'), 'app ready');
        await setViewport(win, run, 900, 560);
        await click(`document.querySelector('button[title="New session"]')`);
        await until(() => run(`Boolean(${mode})`), 'new session editor');
        await fill(`document.querySelector('.modal input[name="name"]')`, 'New transport fixture');
        await fill(`document.querySelector('.modal input[name="host"]')`, '192.0.2.3');
        await click(connection);
        assert.equal(await run(`${mode}.value`), 'auto');
        assert.deepEqual(await run(`[...${mode}.options].map(o=>o.value)`), ['auto', 'modern']);
        await fill(mode, 'modern'); await save();
        await until(() => run(`window.__app.sessions.data.sessions.some(s=>s.name==='New transport fixture')`), 'session tree refresh');
        assert.equal((await sessions()).sessions.find(s => s.name === 'New transport fixture').sshCompatibility, 'modern');
        await edit('New transport fixture'); assert.equal(await run(`${mode}.value`), 'modern');
        await fill(mode, 'auto'); await save();

        await edit('Older session fixture'); assert.equal(await run(`${mode}.value`), 'auto'); await save();

        await edit('Unknown transport fixture');
        assert.equal(await run(`${mode}.value`), '', 'unknown value must not silently select automatic legacy compatibility');
        await click(footer('Save'));
        assert.equal(await run('Boolean(document.querySelector(".modal"))'), true);
        assert.match(await run(`document.querySelector('.modal [role="alert"]').textContent`), /Choose an SSH transport compatibility setting/);
        assert.equal((await sessions()).sessions.find(s => s.id === 'unknown').sshCompatibility, 'future-mode');
        await fill(mode, 'modern'); await save();
        assert.equal(await run('window.__app.tabs.some(t=>t.kind==="terminal")'), false);
        console.log('SSH_SETTINGS_UI_PASS'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require('../src/main/main');
}

module.exports = { runSshSettingsUiTests };
if (process.versions.electron && process.argv.includes('--ssh-settings-fixture')) {
  fixture().catch(error => { console.error(error.stack || error); require('electron').app.exit(1); });
} else if (require.main === module) {
  runSshSettingsUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
