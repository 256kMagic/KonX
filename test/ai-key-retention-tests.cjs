'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const KEY = 'Synthetic_Nyquest_Retention_Key_0123456789';
const OTHER = 'Synthetic_Independent_Provider_Key_0123456789';
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 12000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await pause(); } }

async function runAiKeyRetentionTests(test) {
  await test('Nyquest encrypted key survives repeated real UI tests, failure/retry, provider changes and process restart; selected deletion persists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'konx-ai-key-retention-')); let child, output = '';
    try {
      for (const phase of ['save', 'restart', 'deleted']) {
        const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_KEY_TEST_ROOT: root, KONX_KEY_TEST_PHASE: phase, KONX_CAPTURE: '', KONX_DEMO: '' };
        delete env.ELECTRON_RUN_AS_NODE;
        child = spawn(require('electron'), [__filename, '--key-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let current = ''; const collect = value => { current = (current + value).slice(-1024 * 1024); };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('AI key fixture timeout: ' + phase + '\n' + current)); }, 70000);
          child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', value => { clearTimeout(timer); resolve(value); }); });
        output += current; assert.equal(code, 0, phase + '\n' + current); assert.match(current, /AI_KEY_RETENTION_PASS/);
      }
      const disk = JSON.parse(fs.readFileSync(path.join(root, 'profile', 'ai.json'), 'utf8'));
      assert.equal(disk.providers.nyquest.keyEnc, undefined); assert.ok(disk.providers.anthropic.keyEnc);
      assert.equal(JSON.stringify(disk).includes(KEY), false); assert.equal(JSON.stringify(disk).includes(OTHER), false);
    } catch (error) {
      const logs = path.resolve(__dirname, '../review/ai-key-retention'); fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(path.join(logs, 'failure.log'), output + '\n' + error.stack); throw error;
    } finally {
      if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^konx-ai-key-retention-/);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, safeStorage, dialog } = require('electron');
  const root = path.resolve(process.env.KONX_KEY_TEST_ROOT || ''), phase = process.env.KONX_KEY_TEST_PHASE;
  assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^konx-ai-key-retention-/); assert.ok(['save', 'restart', 'deleted'].includes(phase));
  let client, finished = false, requests = 0, nextStatus = 200;
  const module = require('../src/main/ai'), RealClient = module.AIClient;
  const request = (options, respond) => {
    assert.equal(options.hostname, 'api.nyquest.ai'); assert.equal(options.path, '/v1/chat/completions'); assert.equal(options.headers.Authorization, 'Bearer ' + KEY);
    const req = new EventEmitter(); let destroyed = false;
    req.setTimeout = () => req; req.destroy = () => { destroyed = true; };
    req.end = body => { assert.ok(JSON.parse(body).messages); requests++; queueMicrotask(() => {
      if (destroyed) return;
      const res = new EventEmitter(); res.statusCode = nextStatus; nextStatus = 200; res.headers = { 'content-type': 'application/json' }; res.destroy = () => {};
      respond(res); res.emit('data', Buffer.from(JSON.stringify({ choices: [{ message: { content: 'Synthetic connection test succeeded.' }, finish_reason: 'stop' }], model: 'nyquest/auto' }))); res.emit('end');
    }); }; return req;
  };
  module.AIClient = class extends RealClient { constructor(options) { super({ ...options, request }); client = this; } };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, engine: null, missing: false, error: 'Offline fixture', npcap: { available: false }, builtin: { available: false } });
  const finish = (code, error) => { if (finished) return; finished = true; if (error) console.error(error.stack || error); for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code); };
  dialog.showErrorBox = (title, text) => { throw new Error(title + ': ' + text); };
  process.on('uncaughtException', error => finish(1, error)); process.on('unhandledRejection', error => finish(1, error));
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.once('did-finish-load', async () => {
      try {
        const run = code => win.webContents.executeJavaScript(code).catch(error => { throw new Error(error.message + '\nExpression: ' + code.replaceAll(KEY, '[synthetic key]').replaceAll(OTHER, '[synthetic key]')); });
        const input = (control, value, event = 'input') => run(`${control}.value=${JSON.stringify(value)};${control}.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));void 0;`);
        const click = async control => {
          let point; await until(async () => { point = await run(`(()=>{const e=${control};if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=e.ownerDocument.elementFromPoint(x,y);return r.width&&r.height&&(hit===e||e.contains(hit))?{x,y}:null})()`); return point; }, 'reachable ' + control);
          win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(25);
        };
        const ready = () => until(() => run('Boolean(window.__ai?.config && !__ai.configBusy && !__ai.prompting)'), 'settings ready');
        const idle = () => until(() => run('!__app.copilot.busy && !__app.copilot.jobId && !__app.copilot.prompting'), 'connection test completed');
        const choice = async label => { const selector = `Array.from(document.querySelectorAll('.modal footer button')).find(e=>e.textContent===${JSON.stringify(label)})`; await until(() => run(`Boolean(${selector})`), 'dialog ' + label); await click(selector); };
        const activateSettings = async () => { await run('__app.activate(__ai);void 0;'); await ready(); };
        const testConnection = async (ok = true) => {
          await run('__app.activate(__app.copilot.panel);__app.copilot.panel.connectionDetails.open=true;void 0;'); await idle();
          const before = requests; await click('__app.copilot.panel.testButton'); await idle();
          assert.equal(requests, before, 'review does not contact provider'); assert.ok(await run('__app.copilot.prepared'));
          await click('__app.copilot.panel.sendButton'); await until(() => requests === before + 1, 'synthetic provider request'); await idle();
          assert.equal(await run('__app.copilot.provider.lastTest.ok'), ok, await run('__app.copilot.message')); assert.equal(client.getConfig().hasKey, true);
          assert.equal(await run('__ai.key.value'), '');
        };
        await until(() => run('Boolean(window.__app)'), 'application ready'); assert.equal(safeStorage.isEncryptionAvailable(), true);
        await run('__app.settings.uiLayout="workbench";__app.workspaceLayout.set("workbench");void 0;');
        await run('window.__ai=__app.openTool("ai");void 0;'); await ready();
        await run('__app.openCopilot(__ai).then(()=>undefined)'); await idle();
        await run('__app.copilot.selectStream(false);void 0;');
        const savedPath = path.join(root, 'profile', 'ai.json');
        if (phase === 'save') {
          assert.equal(await run('__app.copilot.panel.testButton.disabled'), true);
          await activateSettings(); await input('__ai.provider', 'nyquest', 'change'); await input('__ai.key', KEY);
          await input('__ai.model', 'invalid model'); await click('__ai.saveButton'); await ready();
          assert.equal(await run('__ai.key.value'), KEY); assert.equal(client.getConfig().hasKey, false); assert.equal(fs.existsSync(savedPath), false);
          assert.match((await run('__ai.updateBlockers()')).join(' '), /unsaved AI connection/);
          await input('__ai.model', 'nyquest/auto');
          const sync = fs.fsyncSync; fs.fsyncSync = () => { throw Object.assign(new Error('Synthetic flush failure'), { code: 'EIO' }); };
          try { await click('__ai.saveButton'); await ready(); assert.equal(await run('__ai.key.value'), KEY); assert.equal(client.getConfig().hasKey, false); }
          finally { fs.fsyncSync = sync; }
          await click('__ai.saveButton'); await ready();
          assert.equal(await run('__ai.key.value'), ''); assert.match(await run('__ai.key.placeholder'), /Saved encrypted/);
          assert.match(await run('__ai.keyStatus.textContent'), /No need to enter it again/);
          assert.equal(await run('__app.copilot.panel.testButton.disabled'), false, 'saved key refreshes continuously visible companion immediately');
          const stored = fs.readFileSync(savedPath, 'utf8'); assert.equal(stored.includes(KEY), false);
          assert.equal(await run(`JSON.stringify(__ai.config).includes(${JSON.stringify(KEY)})`), false);
          await testConnection(); nextStatus = 401; await testConnection(false); await testConnection();
          assert.equal(fs.readFileSync(savedPath, 'utf8'), stored, 'tests never rewrite or delete the saved key');
          await activateSettings(); await input('__ai.key', OTHER);
          await input('__ai.provider', 'anthropic', 'change'); await choice('Cancel'); await ready();
          assert.equal(await run('__ai.provider.value'), 'nyquest'); assert.equal(await run('__ai.key.value'), OTHER);
          await run('window.__closing=__app.closeTab(__ai);void 0;'); await choice('Cancel'); await run('__closing');
          assert.equal(await run('__ai.key.value'), OTHER);
          await input('__ai.provider', 'anthropic', 'change'); await choice('Discard connection edits'); await ready();
          await input('__ai.key', OTHER); await click('__ai.saveButton'); await ready();
          await input('__ai.provider', 'nyquest', 'change'); await click('__ai.saveButton'); await ready();
          const both = JSON.parse(fs.readFileSync(savedPath, 'utf8')); assert.equal(both.providers.nyquest.keyEnc, JSON.parse(stored).providers.nyquest.keyEnc); assert.ok(both.providers.anthropic.keyEnc);
          await run('__app.closeTab(__ai)'); await run('window.__ai=__app.openTool("ai");void 0;'); await ready();
          assert.equal(await run('__ai.savedKey()'), true); assert.equal(await run('__ai.key.value'), '');
          await testConnection();
        } else if (phase === 'restart') {
          assert.equal(client.getConfig().provider, 'nyquest'); assert.equal(client.getConfig().hasKey, true);
          const stored = fs.readFileSync(savedPath, 'utf8'); await testConnection(); await testConnection(); assert.equal(fs.readFileSync(savedPath, 'utf8'), stored);
          await activateSettings(); await input('__ai.key', 'Synthetic_Uncommitted_Replacement_0123456789'); await input('__ai.model', 'invalid unsaved model');
          await click('__ai.forgetButton'); await ready();
          assert.equal(client.getConfig().keyPresence.nyquest, false); assert.equal(client.getConfig().keyPresence.anthropic, true);
          assert.equal(await run('__ai.model.value'), 'invalid unsaved model'); assert.equal(await run('__ai.key.value'), 'Synthetic_Uncommitted_Replacement_0123456789');
          assert.equal(await run('__app.copilot.panel.testButton.disabled'), true);
          assert.equal(fs.readFileSync(savedPath, 'utf8').includes('Synthetic_Uncommitted'), false);
          await input('__ai.key', ''); await input('__ai.model', 'nyquest/auto');
          await input('__ai.provider', 'anthropic', 'change'); assert.equal(await run('__ai.savedKey()'), true);
          await input('__ai.provider', 'nyquest', 'change');
        } else {
          assert.equal(client.getConfig().provider, 'nyquest'); assert.equal(client.getConfig().keyPresence.nyquest, false); assert.equal(client.getConfig().keyPresence.anthropic, true);
          assert.equal(await run('__ai.key.value'), ''); assert.equal(await run('__app.copilot.panel.testButton.disabled'), true); assert.equal(requests, 0);
        }
        client.close(); assert.equal(client.hasOwnership, false); console.log('AI_KEY_RETENTION_PASS ' + phase); finish(0);
      } catch (error) { finish(1, error); }
    });
  });
  require('../src/main/main');
}
module.exports = { runAiKeyRetentionTests };
if (process.versions.electron && process.argv.includes('--key-fixture')) fixture().catch(error => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runAiKeyRetentionTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
