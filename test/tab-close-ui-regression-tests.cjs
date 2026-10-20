'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, description, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!(await test())) {
    if (Date.now() >= end) throw new Error('Timed out: ' + description);
    await pause();
  }
}

async function runTabCloseUiRegressionTests(test) {
  await test('real tab X clicks remove active/inactive SSH tabs and disconnect their sessions', async () => {
    const { startServer } = require('./ssh-test-server');
    const tempRoot = path.resolve(os.tmpdir());
    const profile = fs.mkdtempSync(path.join(tempRoot, 'konx-tab-close-test-'));
    const serverRoot = path.join(profile, 'server');
    fs.mkdirSync(serverRoot);
    const { server, port } = await startServer({ port: 0, root: serverRoot });
    const clients = new Set();
    server.on('connection', (client) => {
      clients.add(client);
      client.once('close', () => clients.delete(client));
    });
    let output = '';
    let child;
    try {
      child = spawn(require('electron'), [__filename, '--electron-fixture'], {
        windowsHide: true,
        env: { ...process.env, KONX_USERDATA: path.join(profile, 'profile'), KONX_TEST_SSH_PORT: String(port),
          KONX_CAPTURE: '', KONX_DEMO: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let pendingLines = '';
      child.stdout.on('data', (data) => {
        output += data;
        pendingLines += data;
        let newline;
        while ((newline = pendingLines.indexOf('\n')) !== -1) {
          const line = pendingLines.slice(0, newline);
          pendingLines = pendingLines.slice(newline + 1);
          const expected = /TAB_CLOSE_EXPECT_PEERS (\d+) (\d+)/.exec(line);
          if (expected) {
            const answer = path.join(profile, 'profile', 'peer-check-' + expected[1] + '.json');
            until(() => clients.size === Number(expected[2]), 'remote SSH peer to disconnect', 5000)
              .then(() => fs.writeFileSync(answer, JSON.stringify({ ok: true })),
                (error) => fs.writeFileSync(answer, JSON.stringify({ ok: false, error: error.message })));
          }
        }
      });
      child.stderr.on('data', (data) => { output += data; });
      const code = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill(); reject(new Error('Electron tab-close test timed out\n' + output)); }, 45000);
        child.once('error', (error) => { clearTimeout(timeout); reject(error); });
        child.once('exit', (code) => { clearTimeout(timeout); resolve(code); });
      });
      assert.equal(code, 0, output);
      assert.match(output, /TAB_CLOSE_UI_PASS/);
      await until(() => clients.size === 0, 'SSH server connections to close');
    } finally {
      if (child && child.exitCode == null) child.kill();
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
      // Only remove the fresh fixture directory created above.
      assert.equal(path.dirname(path.resolve(profile)), tempRoot);
      assert.ok(path.basename(profile).startsWith('konx-tab-close-test-'));
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function electronFixture() {
  const { app, BrowserWindow } = require('electron');
  let finished = false;
  const finish = (code, error) => {
    if (finished) return;
    finished = true;
    if (error) console.error(error.stack || error);
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.exit(code);
  };
  app.on('browser-window-created', (_event, win) => {
    // The real application runs with an isolated profile, without taking focus.
    win.setOpacity(0);
    win.setFocusable(false);
    win.setSkipTaskbar(true);
    win.webContents.once('did-finish-load', async () => {
      try {
        const run = (code) => win.webContents.executeJavaScript(code);
        await until(() => run('Boolean(window.__app)'), 'app initialization');
        await run(`
          window.__tabCloseTrace = [];
          document.addEventListener('mousedown', (event) => window.__tabCloseTrace.push(Boolean(event.target.closest('button.close'))), true);
          window.__app.handlePrompt = async (prompt) => {
            if (prompt.kind === 'hostkey' && prompt.host === '127.0.0.1') return 'once';
            throw new Error('Unexpected test prompt: ' + prompt.kind);
          };
          window.__newTestTerminal = (name) => window.__app.openTerminal({
            protocol: 'ssh', host: '127.0.0.1', port: ${Number(process.env.KONX_TEST_SSH_PORT)}, username: 'test', password: 'test',
          }, { name, protocol: 'ssh' });
          window.__testA = window.__newTestTerminal('Close active SSH');
          void 0;
        `);
        await until(() => run('window.__testA.state === "connected"'), 'first SSH connection');

        const click = async (variable, closeButton = true, button = 'left') => {
          const point = await run(`(() => {
            const index = window.__app.tabs.indexOf(window.${variable});
            const tab = window.__app.tabbar.children[index];
            const target = tab.querySelector(${JSON.stringify(closeButton ? 'button.close' : '.title')});
            const rect = target.getBoundingClientRect();
            return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
          })()`);
          win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          win.webContents.sendInputEvent({ type: 'mouseDown', button, clickCount: 1, ...point });
          win.webContents.sendInputEvent({ type: 'mouseUp', button, clickCount: 1, ...point });
          await pause(100);
        };
        const assertClosed = async (variable) => {
          assert.equal(await run(`window.__app.tabs.includes(window.${variable})`), false, 'X click left the connection tab visible');
          assert.equal(await run(`window.api.invoke('conn:info', window.${variable}.id)`), null, 'X click left the backend session open');
        };
        let peerCheck = 0;
        const assertPeers = async (count) => {
          const check = ++peerCheck;
          const answer = path.join(process.env.KONX_USERDATA, 'peer-check-' + check + '.json');
          console.log('TAB_CLOSE_EXPECT_PEERS ' + check + ' ' + count);
          await until(() => fs.existsSync(answer), 'peer-disconnect confirmation', 7000);
          const result = JSON.parse(fs.readFileSync(answer, 'utf8'));
          assert.equal(result.ok, true, result.error || 'The remote SSH session remained connected after X');
        };
        await click('__testA');
        assert.equal(await run('window.__tabCloseTrace.includes(true)'), true, 'native mouse event must hit the X button');
        await assertClosed('__testA');
        await assertPeers(0);

        await run(`window.__testA = window.__newTestTerminal('Close inactive SSH');
          window.__testB = window.__newTestTerminal('Keep active SSH'); void 0;`);
        await until(() => run('window.__testA.state === "connected" && window.__testB.state === "connected"'), 'two SSH connections');
        await run('window.__app.activate(window.__testB)');
        await click('__testA');
        await assertClosed('__testA');
        await assertPeers(1);
        assert.equal(await run('window.__app.active === window.__testB'), true, 'closing inactive tab must preserve the selected tab');

        // Tab-body selection and middle-click closure must keep working too.
        await run('window.__app.showHome()');
        await click('__testB', false);
        assert.equal(await run('window.__app.active === window.__testB'), true);
        await click('__testB', false, 'middle');
        await assertClosed('__testB');
        await assertPeers(0);
        console.log('TAB_CLOSE_UI_PASS: active X, inactive X, tab selection, middle click, and SSH cleanup');
        finish(0);
      } catch (error) { finish(1, error); }
    });
  });
  require(path.join(process.env.KONX_TEST_APP_ROOT || path.join(__dirname, '..'), 'src/main/boot.js'));
}

module.exports = { runTabCloseUiRegressionTests };
if (process.versions.electron && process.argv.includes('--electron-fixture')) electronFixture();
else if (require.main === module) {
  runTabCloseUiRegressionTests(async (name, test) => {
    await test(); console.log('PASS ' + name);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
