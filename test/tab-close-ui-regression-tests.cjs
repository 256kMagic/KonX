'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');

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
  await test('real session panels and overflowing tabs stay usable; SIP ladder, SDP, packet navigation and exports work', runLayoutFixture);
}

async function runLayoutFixture() {
  const tempRoot = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, 'konx-layout-test-'));
  let child;
  let output = '';
  try {
    child = spawn(require('electron'), [__filename, '--electron-layout-fixture'], {
      windowsHide: true,
      env: { ...process.env, KONX_USERDATA: path.join(profile, 'profile'), KONX_CAPTURE: '', KONX_DEMO: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Electron layout test timed out\n' + output)); }, 45000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
    });
    assert.equal(code, 0, output);
    assert.match(output, /LAYOUT_UI_PASS/);
  } finally {
    if (child && child.exitCode == null) child.kill();
    assert.equal(path.dirname(path.resolve(profile)), tempRoot);
    assert.ok(path.basename(profile).startsWith('konx-layout-test-'));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function layoutChecks(win, run) {
  const clickElement = async (expression) => {
    const point = await run(`(() => {
      const target = ${expression};
      if (!target) throw new Error('Test control not found: ' + ${JSON.stringify(expression)});
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) throw new Error('Test control is hidden');
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await pause(50);
  };
  const measureDialog = () => run(`(() => {
    const modal = document.querySelector('.modal');
    const rect = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    return { dialog: rect(modal), header: rect(modal.querySelector('header')), tabs: rect(modal.querySelector('.mtabs')),
      footer: rect(modal.querySelector('footer')), width: innerWidth, height: innerHeight,
      selected: modal.querySelector('.mtabs button.active').textContent };
  })()`);
  for (const [width, height] of [[1400, 880], [900, 560]]) {
    await setViewport(win, run, width, height);
    await run('window.__layoutSession = window.__app.editSession(); void 0;');
    await until(() => run('Boolean(document.querySelector(".modal .mtabs"))'), 'New session dialog');
    const baseline = await measureDialog();
    const toolbar = await run(`(() => {
      const style = (element) => { const s = getComputedStyle(element); return [s.backgroundColor, s.borderTopColor, s.color]; };
      const settings = document.querySelector('#toolbar [title="Settings"]').getBoundingClientRect();
      return { quick: style(window.__app.quickProto), form: style(document.querySelector('.modal .mpane.active select')),
        settingsLeft: settings.left, settingsRight: settings.right, width: innerWidth };
    })()`);
    assert.deepEqual(toolbar.quick, toolbar.form, 'quick-connect protocol must use the same select styling as session fields');
    assert.ok(toolbar.settingsLeft >= 0 && toolbar.settingsRight <= toolbar.width + 1,
      `${width}x${height}: the rightmost toolbar control must remain inside the window`);
    const panels = await run(`Array.from(document.querySelectorAll('.modal .mtabs button')).filter((b) => b.getBoundingClientRect().width).map((b) => b.textContent)`);
    assert.equal(panels.length, 7, 'all SSH session panels should be available');
    for (const panel of panels) {
      await clickElement(`Array.from(document.querySelectorAll('.modal .mtabs button')).find((b) => b.textContent === ${JSON.stringify(panel)})`);
      const current = await measureDialog();
      assert.equal(current.selected, panel, 'native click must select the requested panel');
      for (const region of ['dialog', 'header', 'tabs']) {
        for (const axis of ['left', 'top']) assert.ok(Math.abs(current[region][axis] - baseline[region][axis]) <= 2,
          `${width}x${height}: ${region} ${axis} shifted when selecting ${panel}`);
      }
      assert.ok(current.dialog.top >= 0 && current.dialog.left >= 0 && current.dialog.right <= current.width + 1, 'dialog must stay horizontally inside the window');
      assert.ok(current.footer.bottom <= current.height + 1 && current.footer.top >= current.tabs.bottom,
        `${width}x${height}: ${panel} must keep footer actions inside the window`);
    }
    await clickElement(`Array.from(document.querySelectorAll('.modal footer button')).find((b) => b.textContent === 'Cancel')`);
    await until(() => run('!document.querySelector(".modal")'), 'session dialog to close');
    assert.equal(await run('window.__app.sessions.data.sessions.length'), 0, 'layout fixture must not save sessions');
  }

  await setViewport(win, run, 1400, 880);
  await run(`window.__layoutTabs = Array.from({ length: 24 }, (_, index) => {
    const tab = window.__app.openTool('subnet');
    window.__app.setTabTitle(tab, 'Layout workspace ' + (index + 1));
    return tab;
  }); void 0;`);
  const activeVisible = () => run(`(() => {
    const bar = window.__app.tabbar.getBoundingClientRect();
    const active = window.__app.tabbar.querySelector('.tab.active').getBoundingClientRect();
    return active.left >= bar.left - 2 && active.right <= bar.right + 2;
  })()`);
  const control = (name) => `document.querySelector('[aria-label="${name}"]')`;
  const scrollWithControl = async (name) => {
    await clickElement(control(name));
    let previous = NaN;
    let stableSince = Date.now();
    await until(async () => {
      const current = await run('window.__app.tabbar.scrollLeft');
      if (current !== previous) { previous = current; stableSince = Date.now(); }
      return Date.now() - stableSince >= 120;
    }, 'tab navigation animation to settle');
  };
  await until(activeVisible, 'last opened tab to be visible');
  assert.equal(await run('window.__app.tabbar.scrollWidth > window.__app.tabbar.clientWidth'), true, 'fixture must overflow');
  assert.equal(await run(`${control('Show all tabs')}.getBoundingClientRect().width > 0`), true, 'overflow menu control must be visible');
  // Revealing the final tab can leave trailing strip padding scrollable.
  if (!(await run(`${control('Scroll tabs right')}.disabled`))) await scrollWithControl('Scroll tabs right');
  assert.equal(await run(`${control('Scroll tabs right')}.disabled`), true, 'right navigation disables at the last tab');

  for (let n = 0; n < 30 && !(await run(`${control('Scroll tabs left')}.disabled`)); n++) await scrollWithControl('Scroll tabs left');
  assert.ok(await run('window.__app.tabbar.scrollLeft <= 2'), 'left navigation reaches the first tab');
  assert.equal(await run(`${control('Scroll tabs left')}.disabled`), true);
  // Background status updates should not undo a user's deliberate navigation.
  await run('window.__app.tabStateChanged(window.__app.active)');
  await pause(50);
  assert.ok(await run('window.__app.tabbar.scrollLeft <= 2'), 'status rerender must preserve manual tab scrolling');
  await scrollWithControl('Scroll tabs right');
  assert.ok(await run('window.__app.tabbar.scrollLeft > 2'), 'right navigation reveals later tabs');

  await clickElement(control('Show all tabs'));
  assert.equal(await run('document.querySelectorAll(".ctx .item").length'), 25, 'overflow menu includes every tab including Home');
  await clickElement(`Array.from(document.querySelectorAll('.ctx .item')).find((item) => item.textContent.includes('Layout workspace 3'))`);
  await until(() => run('window.__app.active === window.__layoutTabs[2]'), 'overflow selection to activate the requested tab');
  await until(activeVisible, 'overflow-selected tab to be visible');

  await run('window.__app.activate(window.__layoutTabs[23])');
  await setViewport(win, run, 900, 560);
  await until(activeVisible, 'active tab to remain visible after narrowing the window');
  await run('window.__app.toggleSidebar()');
  await until(activeVisible, 'active tab to remain visible after sidebar width changes');
  await run('window.__app.toggleSidebar()');
  await until(activeVisible, 'active tab to remain visible when sidebar returns');
  await run('(async () => { for (const tab of window.__layoutTabs) await window.__app.closeTab(tab); })()');
  await until(() => run(`${control('Show all tabs')}.getBoundingClientRect().width === 0`), 'overflow controls to hide when tabs fit');
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
        assert.equal(await run('window.__app.info.version'), require('../package.json').version,
          'application version must come from KonX package metadata, not the Electron runtime');
        if (process.argv.includes('--electron-layout-fixture')) {
          await layoutChecks(win, run);
          await require('./sip-view-tests.cjs').runSipViewChecks(win, run);
          console.log('LAYOUT_UI_PASS: stable session navigation, overflow controls, active visibility, and resize');
          finish(0);
          return;
        }
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
if (process.versions.electron && (process.argv.includes('--electron-fixture') || process.argv.includes('--electron-layout-fixture'))) electronFixture();
else if (require.main === module) {
  runTabCloseUiRegressionTests(async (name, test) => {
    await test(); console.log('PASS ' + name);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
