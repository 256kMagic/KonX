'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
async function runSupportUiTests(test) {
  await test('Support report real IPC previews opt-in logs, retains editable errors/cancel, exports exact reviewed data without submission', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-support-ui-'));
    let child, output = '';
    try {
      const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_SUPPORT_TEST: root, KONX_CAPTURE: '', KONX_DEMO: '' };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--support-fixture'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => { output = (output + data).slice(-131072); });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Support fixture timeout\n' + output)); }, 40000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0, output); assert.match(output, /SUPPORT_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) child.kill();
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-support-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
async function fixture() {
  const { app, BrowserWindow, dialog, shell } = require('electron');
  const root = path.resolve(process.env.KONX_SUPPORT_TEST);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-support-ui-'));
  const logs = path.join(root, 'profile', 'diagnostics'); fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'javascript-errors.log'), 'SYNTHETIC_ERROR_MARKER\npassword=SUPPORT_PRIVATE_SENTINEL\n' + path.join(root, 'profile', 'private.json'));
  let saveCalls = 0, externalCalls = 0, finished = false;
  const file = path.join(root, 'reviewed.json');
  dialog.showSaveDialog = async () => (++saveCalls === 1 ? { canceled: true } : { canceled: false, filePath: file });
  shell.openExternal = async () => { externalCalls++; };
  const finish = (code, error) => { if (finished) return; finished = true; if (error) console.error(error.stack || error); for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code); };
  process.on('uncaughtException', error => finish(1, error)); process.on('unhandledRejection', error => finish(1, error));
  dialog.showErrorBox = (title, message) => finish(1, new Error(title + ': ' + message));
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.once('did-finish-load', async () => {
      const run = code => win.webContents.executeJavaScript(code);
      const until = async (code, label) => { const end = Date.now() + 10000; while (!(await run(code))) { if (Date.now() > end) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 20)); } };
      try {
        await until('!!window.__app', 'app');
        await run(`document.querySelector('.welcome-update button:last-child').click();true`);
        await until(`!!document.querySelector('[aria-label="Diagnostic report preview"]')?.value`, 'preview');
        const initial = await run(`document.querySelector('[aria-label="Diagnostic report preview"]').value`);
        assert.equal(JSON.parse(initial).kind, 'konx-support-report'); assert.ok(!initial.includes('SYNTHETIC_ERROR_MARKER'));
        assert.ok(!initial.includes('SUPPORT_PRIVATE_SENTINEL')); assert.ok(!initial.includes(root));
        assert.equal(saveCalls, 0); assert.equal(externalCalls, 0);
        await run(`document.querySelector('[aria-label="Include JavaScript error logs"]').click();document.querySelector('.support-report button').click();true`);
        await until(`document.querySelector('[aria-label="Diagnostic report preview"]').value.includes('SYNTHETIC_ERROR_MARKER')`, 'optional logs');
        const withLogs = await run(`document.querySelector('[aria-label="Diagnostic report preview"]').value`);
        assert.ok(!withLogs.includes('SUPPORT_PRIVATE_SENTINEL')); assert.ok(!withLogs.includes(root.replaceAll('\\', '\\\\')));
        await run(`document.querySelector('[aria-label="Diagnostic report preview"]').value='invalid json';document.querySelector('.support-report .primary').click();true`);
        await until(`!document.querySelector('.support-report .primary').disabled`, 'invalid report');
        assert.equal(saveCalls, 0); assert.equal(await run(`document.querySelector('[aria-label="Diagnostic report preview"]').value`), 'invalid json');
        const edited = JSON.stringify({ schemaVersion: 1, kind: 'konx-support-report', problem: 'ONLY_REVIEWED_TEXT' }, null, 2);
        await run(`document.querySelector('[aria-label="Diagnostic report preview"]').value=${JSON.stringify(edited)};document.querySelector('.support-report .primary').click();true`);
        await until(`document.querySelector('.support-report [role="status"]').textContent.includes('cancelled')`, 'save cancel');
        assert.equal(fs.existsSync(file), false); assert.equal(externalCalls, 0);
        await run(`document.querySelector('.support-report .primary').click();true`);
        await until(`document.querySelector('.support-report [role="status"]').textContent.includes('Report saved')`, 'save report');
        assert.equal(fs.readFileSync(file, 'utf8'), edited); assert.equal(externalCalls, 0);
        await run(`document.querySelector('.modal > header .x').click();true`);
        await run(`(async()=>{const {settingsDialog}=await import('./js/settings.js');void settingsDialog(window.__app);return true;})()`);
        await until(`!![...document.querySelectorAll('.mtabs button')].find(button=>button.textContent==='Support')`, 'settings support');
        await run(`[...document.querySelectorAll('.mtabs button')].find(button=>button.textContent==='Support').click();document.querySelector('.mpane.active button').click();true`);
        await until(`!!document.querySelector('.support-report')`, 'nested support');
        assert.equal(saveCalls, 2); assert.equal(externalCalls, 0);
        console.log('SUPPORT_UI_PASS'); finish(0);
      } catch (error) { finish(1, error); }
    });
  });
  require(path.join(repo, 'src/main/main'));
}
module.exports = { runSupportUiTests };
if (process.versions.electron && process.argv.includes('--support-fixture')) fixture().catch(error => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) runSupportUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
