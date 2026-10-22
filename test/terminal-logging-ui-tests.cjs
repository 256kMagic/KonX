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

async function runTerminalLoggingUiTests(test) {
  await test('Terminal logging UI: real clicks, backend status, tab isolation, failure, pending closure and compact layouts', async () => {
    const base = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(base, 'konx-log-ui-'));
    let child, output = '';
    try {
      const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_LOG_UI_ROOT: root, KONX_CAPTURE: '', KONX_DEMO: '' };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--logging-ui-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = data => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Terminal logging UI timed out\n' + output)); }, 60000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0, output);
      assert.match(output, /TERMINAL_LOGGING_UI_PASS/);
      if (process.env.KONX_LOG_UI_SCREENSHOTS) {
        const destination = path.resolve(process.env.KONX_LOG_UI_SCREENSHOTS);
        fs.mkdirSync(destination, { recursive: true });
        for (const file of fs.readdirSync(root).filter(file => file.endsWith('.png'))) fs.copyFileSync(path.join(root, file), path.join(destination, file));
      }
    } finally {
      if (child && child.exitCode == null) {
        const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped;
      }
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-log-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, dialog, shell } = require('electron');
  const root = path.resolve(process.env.KONX_LOG_UI_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('konx-log-ui-'));
  assert.equal(path.resolve(process.env.KONX_USERDATA), path.join(root, 'profile'));
  const unexpected = action => { throw new Error('Logging UI fixture unexpectedly invoked ' + action); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, engine: null, missing: false,
    error: 'Offline logging fixture', npcap: { available: false }, builtin: { available: false } });
  require('../src/main/ai').AIClient.prototype.run = async () => unexpected('AI provider');
  shell.openExternal = async () => unexpected('external browser');
  dialog.showOpenDialog = async () => unexpected('native open');
  dialog.showSaveDialog = async () => unexpected('native save');
  dialog.showErrorBox = (title, message) => unexpected(title + ': ' + message);

  // Keep the real IPC/preload/renderer boundary; substitute only owned console
  // lifecycle and file-open results. Actual log-file writes have separate tests.
  const states = new Map(), starts = [], stops = [], closes = [], revealed = [];
  let manager, hold = false, failNext = false, releaseStart;
  shell.showItemInFolder = file => revealed.push(file);
  const { ConnectionManager } = require('../src/main/connections');
  const publish = (id, logging) => {
    const info = states.get(id); if (!info) return;
    info.logging = logging;
    manager._status(id, 'connected', { info: { ...info } });
  };
  ConnectionManager.prototype.open = async function (id, spec) {
    manager = this;
    states.set(id, { protocol: spec.protocol, host: spec.host, port: 2222, logging: null });
    publish(id, null);
    this.deps.emit('conn:data', id, Buffer.from('Synthetic console ready.\r\n'));
    return { ok: true };
  };
  ConnectionManager.prototype.startLog = function (id) {
    starts.push(id);
    if (failNext) { failNext = false; throw new Error('Fixture log folder is not writable'); }
    const file = path.join(root, 'logs', `console-${id}.txt`);
    if (hold) return new Promise(resolve => { releaseStart = () => { publish(id, file); resolve(file); }; });
    publish(id, file); return file;
  };
  ConnectionManager.prototype.stopLog = function (id) { stops.push(id); publish(id, null); };
  ConnectionManager.prototype.close = function (id) {
    closes.push(id); states.delete(id); this._status(id, 'disconnected', { message: 'Fixture closed' });
  };
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
      const control = `window.__app.active.logSwitch`;
      const state = () => run(`({checked:${control}.getAttribute('aria-checked'),disabled:${control}.disabled,busy:${control}.getAttribute('aria-busy'),error:window.__app.active.logErrorEl.textContent})`);
      const tab = name => `[...document.querySelectorAll('#tabbar .tab')].find(e=>e.querySelector('.title')?.textContent===${JSON.stringify(name)})`;
      try {
        await until(() => run('Boolean(window.__app?.workspaceLayout)'), 'app ready');
        await setViewport(win, run, 900, 560);
        const first = await run(`window.__app.openTerminal({protocol:'raw',host:'192.0.2.10'},{name:'Console A',protocol:'raw'}).id`);
        await until(async () => !(await state()).disabled, 'first console connected');
        assert.equal((await state()).checked, 'false');

        hold = true; await click(control);
        await until(() => Boolean(releaseStart), 'held start request');
        assert.deepEqual(await state(), { checked: 'false', disabled: true, busy: 'true', error: '' });
        await run('window.__app.active.toggleLog()'); assert.equal(starts.length, 1, 'pending invocation cannot duplicate start');
        releaseStart(); hold = false;
        await until(async () => (await state()).checked === 'true' && !(await state()).disabled, 'confirmed logging');
        assert.equal(await run(`window.__app.active.logState.textContent`), 'On');
        assert.notEqual(await run(`getComputedStyle(${control}.querySelector('.term-log-track')).boxShadow`), 'none');
        await click('window.__app.active.logReveal');
        assert.deepEqual(revealed, [path.join(root, 'logs', `console-${first}.txt`)]);

        const second = await run(`window.__app.openTerminal({protocol:'raw',host:'192.0.2.11'},{name:'Console B',protocol:'raw'}).id`);
        await until(async () => !(await state()).disabled, 'second console connected');
        assert.equal((await state()).checked, 'false');
        await click(tab('Console A')); assert.equal((await state()).checked, 'true');
        await click('window.__app.active.wrap', 'right');
        await click(`[...document.querySelectorAll('.ctx .item')].find(e=>e.textContent==='Stop Logging')`);
        await until(async () => (await state()).checked === 'false', 'context menu stops visible switch');
        assert.deepEqual(stops, [first]);
        assert.equal(await run('window.__app.active.logPath.textContent'), revealed[0], 'last file remains available');

        failNext = true; await click(control);
        await until(async () => (await state()).error.includes('not writable'), 'visible start failure');
        assert.equal((await state()).checked, 'false'); assert.equal((await state()).disabled, false);
        await click(control);
        await until(async () => (await state()).checked === 'true', 'retry succeeds');
        assert.equal((await state()).error, '', 'retry clears stale error');

        for (const layout of ['classic', 'workbench', 'incident-desk', 'operations-wall', 'focus']) {
          await run(`window.__app.activate(window.__app.byId.get(${JSON.stringify(first)}))`);
          await run(`window.__app.workspaceLayout.set(${JSON.stringify(layout)})`);
          if (layout === 'workbench') await run(`window.__app.workspaceLayout.pin('companion',${JSON.stringify(second)})`);
          if (layout === 'operations-wall') await run(`window.__app.workspaceLayout.pin('wall-1',${JSON.stringify(second)})`);
          await run(`window.__app.activate(window.__app.byId.get(${JSON.stringify(first)}))`);
          await pause(60);
          const geometry = await run(`(()=>{const t=window.__app.byId.get(${JSON.stringify(first)}),bar=t.logbar.getBoundingClientRect(),button=t.logSwitch.getBoundingClientRect(),wrap=t.wrap.getBoundingClientRect();return{bar:[bar.left,bar.right,bar.top,bar.bottom],button:[button.left,button.right,button.top,button.bottom],wrapHeight:wrap.height,overflow:t.logbar.scrollWidth-t.logbar.clientWidth,checked:t.logSwitch.getAttribute('aria-checked')};})()`);
          assert.ok(geometry.button[0] >= geometry.bar[0] && geometry.button[1] <= geometry.bar[1] + 1, layout + ': switch stays in its pane');
          assert.ok(geometry.button[2] >= geometry.bar[2] && geometry.button[3] <= geometry.bar[3] + 1, layout + ': switch stays in bar');
          assert.ok(geometry.overflow <= 1, layout + ': no logging-strip horizontal overflow');
          assert.ok(geometry.wrapHeight > 40, layout + ': terminal remains usable');
          assert.equal(geometry.checked, 'true');
          fs.writeFileSync(path.join(root, `${layout}.png`), (await win.webContents.capturePage()).toPNG());
        }
        await run(`window.__app.workspaceLayout.set('classic')`);
        await click(tab('Console A'));
        // A backend write failure is authoritative even without a switch click.
        publish(first, null);
        await until(async () => (await state()).checked === 'false', 'backend clears failed logger');
        manager.close(first);
        await until(async () => (await state()).disabled, 'disconnect disables switch');
        assert.equal((await state()).checked, 'false');
        const before = starts.length; await run('window.__app.active.toggleLog()'); assert.equal(starts.length, before);

        await click(tab('Console B'));
        hold = true; releaseStart = null; await click(control);
        await until(() => Boolean(releaseStart), 'second pending start');
        await click(`${tab('Console B')}.querySelector('button.close')`);
        await until(() => closes.includes(second), 'closing pending console closes backend');
        releaseStart(); await pause(50);
        assert.equal(await run(`window.__app.byId.has(${JSON.stringify(second)})`), false);
        assert.equal((await state()).checked, 'false', 'late result cannot light another console');
        assert.equal((await state()).error, '');
        console.log('TERMINAL_LOGGING_UI_PASS'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require('../src/main/main');
}

module.exports = { runTerminalLoggingUiTests };
if (process.versions.electron && process.argv.includes('--logging-ui-fixture')) {
  fixture().catch(error => { console.error(error.stack || error); require('electron').app.exit(1); });
} else if (require.main === module) {
  runTerminalLoggingUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
