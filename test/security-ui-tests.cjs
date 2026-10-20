'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');

const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Timed out: ' + label);
    await pause();
  }
}

async function runSecurityUiTests(test) {
  await test('real Security Suite IPC, baseline, exports, configuration redaction, cancellation and responsive layout', async () => {
    const tempRoot = path.resolve(os.tmpdir());
    const fixtureRoot = fs.mkdtempSync(path.join(tempRoot, 'konx-security-ui-test-'));
    let child;
    let output = '';
    try {
      child = spawn(require('electron'), [__filename, '--electron-security-fixture'], {
        windowsHide: true,
        env: { ...process.env, KONX_USERDATA: path.join(fixtureRoot, 'profile'), KONX_SECURITY_TEST_ROOT: fixtureRoot,
          KONX_CAPTURE: '', KONX_DEMO: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const collect = (data) => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Electron security UI test timed out\n' + output)); }, 45000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
      });
      assert.equal(code, 0, output);
      assert.match(output, /SECURITY_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) child.kill();
      // This exact mkdtemp directory is the only recursive cleanup target.
      assert.equal(path.dirname(path.resolve(fixtureRoot)), tempRoot);
      assert.ok(path.basename(fixtureRoot).startsWith('konx-security-ui-test-'));
      fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function electronFixture() {
  const { app, BrowserWindow, dialog } = require('electron');
  const { finding, makeReport } = require('../src/main/security/common');
  const fixtureRoot = path.resolve(process.env.KONX_SECURITY_TEST_ROOT || '');
  assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixtureRoot).startsWith('konx-security-ui-test-'));
  const exportsRoot = path.join(fixtureRoot, 'exports');
  fs.mkdirSync(exportsRoot);
  let screenshotRoot = null;
  if (process.env.KONX_SECURITY_SCREENSHOT_DIR) {
    const reviewRoot = fs.realpathSync(path.join(__dirname, '..', 'review'));
    const requested = path.resolve(process.env.KONX_SECURITY_SCREENSHOT_DIR);
    const contained = (value) => {
      const relative = path.relative(reviewRoot, value);
      return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    assert.ok(contained(requested), 'Security screenshots must be inside workspace/review');
    let ancestor = requested;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    assert.ok(ancestor === reviewRoot || contained(fs.realpathSync(ancestor)), 'Screenshot parent resolves outside workspace/review');
    fs.mkdirSync(requested, { recursive: true });
    screenshotRoot = fs.realpathSync(requested);
    assert.ok(contained(screenshotRoot), 'Screenshot directory resolves outside workspace/review');
  }
  const exportsMade = [];
  const inventory = { calls: 0, cancelled: 0, pending: new Set() };
  const maliciousEvidence = '<script data-test="security-fixture">window.__securityInjected = true</script>';

  // Replace the provider before main imports the security dispatch table. The
  // renderer, job runner, report normalization and IPC handlers remain real.
  require('../src/main/security/windows').scanWindows = async (_params, signal) => {
    const call = ++inventory.calls;
    if (call >= 3) return new Promise((_resolve, reject) => {
      const stop = () => {
        inventory.cancelled++;
        inventory.pending.delete(stop);
        signal.onStop = null;
        reject(new Error('Assessment cancelled'));
      };
      inventory.pending.add(stop);
      signal.onStop = stop;
      if (signal.stopped) stop();
    });
    return makeReport({ kind: 'windows', title: 'Windows UI fixture', target: 'This PC',
      checks: [
        finding({ id: 'fixture-primary', title: 'Fixture protection setting', status: call === 1 ? 'warning' : 'pass',
          severity: call === 1 ? 'medium' : 'info', evidence: maliciousEvidence, remediation: 'Review the synthetic fixture setting.' }),
        finding({ id: 'fixture-unknown', title: 'Restricted fixture check', status: 'unknown', severity: 'info',
          evidence: 'The current permission level cannot read this synthetic setting.', remediation: 'Unknown is not a passing check.' }),
      ], limitations: ['Synthetic Windows provider. No system inventory was queried.'] });
  };
  // Fail immediately if this fixture accidentally starts a network assessment.
  const network = require('../src/main/security/network');
  for (const name of ['scanTls', 'scanSsh', 'scanWeb', 'scanExposure']) network[name] = async () => { throw new Error('Network assessments are forbidden in this fixture'); };
  dialog.showSaveDialog = async (_window, options) => {
    const basename = path.basename(options.defaultPath);
    assert.match(basename, /^konx-security-(windows|config)-\d{4}-\d\d-\d\d\.(json|html)$/);
    const filePath = path.join(exportsRoot, basename);
    exportsMade.push(filePath);
    return { canceled: false, filePath };
  };
  dialog.showOpenDialog = async () => { throw new Error('The fixture must not open user files'); };

  let finished = false;
  const finish = (code, error) => {
    if (finished) return;
    finished = true;
    if (error) console.error(error.stack || error);
    for (const stop of [...inventory.pending]) stop();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(code);
  };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0);
    win.setFocusable(false);
    win.setSkipTaskbar(true);
    win.webContents.once('did-finish-load', async () => {
      try {
        const run = (code) => win.webContents.executeJavaScript(code);
        await until(() => run('Boolean(window.__app)'), 'app initialization');
        const click = async (expression) => {
          let point;
          // Toasts can temporarily cover a row after an export at a narrow
          // viewport. Wait for the real hit target rather than clicking through.
          await until(async () => {
            point = await run(`(() => {
              const element = ${expression};
              if (!element) throw new Error('Missing security test control');
              element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              const rect = element.getBoundingClientRect();
              if (!rect.width || !rect.height || element.disabled) throw new Error('Security test control is hidden or disabled');
              const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
              const hit = document.elementFromPoint(x, y);
              return { x, y, ready: element === hit || element.contains(hit) };
            })()`);
            return point.ready;
          }, 'security control to be unobstructed: ' + expression, 7000);
          delete point.ready;
          win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
          win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
          await pause(40);
        };
        const completed = () => run('window.__security.report && !window.__security.jobId');
        const choose = (kind) => run(`window.__security.audit.value = ${JSON.stringify(kind)};
          window.__security.audit.dispatchEvent(new Event('change', { bubbles: true })); void 0;`);
        const exportAndRead = async (format, kind) => {
          const before = exportsMade.length;
          await click(`window.__security.${format}Button`);
          await until(() => exportsMade.length === before + 1 && fs.existsSync(exportsMade[before]), `${kind} ${format} export`);
          const filePath = exportsMade[before];
          assert.ok(path.basename(filePath).startsWith('konx-security-' + kind + '-'));
          return fs.readFileSync(filePath, 'utf8');
        };

        await run('window.__security = window.__app.openTool("security"); void 0;');
        assert.equal(await run('window.__app.active === window.__security'), true);
        assert.equal(await run('window.__security.audit.value'), 'windows');
        assert.equal(await run('window.__security.report'), null);
        await pause(100);
        assert.equal(inventory.calls, 0, 'opening Security Suite must never autorun an assessment');
        assert.equal(await run('window.__security.jsonButton.disabled && window.__security.baselineButton.disabled'), true);

        await click('window.__security.runButton');
        await until(completed, 'first Windows report through real IPC');
        assert.equal(inventory.calls, 1);
        assert.deepEqual(await run('window.__security.report.checks.map((c) => c.status)'), ['warning', 'unknown']);
        assert.equal(await run('window.__app.jobs.size'), 0);
        await click('window.__security.table.tbody.querySelector("tr[data-k=fixture-primary]")');
        assert.equal(await run('window.__security.detail.querySelector(".security-evidence").textContent'), maliciousEvidence);
        assert.equal(await run('Boolean(window.__securityInjected)'), false, 'evidence must render as text');
        await click('window.__security.baselineButton');
        assert.match(await run('window.__security.baselineStatus.textContent'), /Baseline saved/);
        assert.equal(await run('Object.values(window.__security.baselines())[0].checks[0].status'), 'warning');

        await click('window.__security.runButton');
        await until(completed, 'second Windows report through real IPC');
        assert.equal(inventory.calls, 2);
        await click('window.__security.compareButton');
        assert.match(await run('window.__security.baselineStatus.textContent'), /1 changed · 1 unchanged/);
        assert.deepEqual(await run('window.__security.comparison.changes.map((c) => c.change)'), ['changed', 'unchanged']);
        assert.equal(await run('window.__security.report.checks.find((c) => c.id === "fixture-unknown").status'), 'unknown');
        const windowsJson = JSON.parse(await exportAndRead('json', 'windows'));
        assert.equal(windowsJson.checks[0].status, 'pass');
        assert.equal(windowsJson.checks[1].status, 'unknown');
        const windowsHtml = await exportAndRead('html', 'windows');
        assert.match(windowsHtml, /&lt;script data-test=/);
        assert.doesNotMatch(windowsHtml, /<script data-test=/);
        assert.match(windowsHtml, /Unknown and inaccessible checks are not passing results/);

        // Size checks use the real sidebar, shell, table and assessment controls.
        // Internal table/result scrolling is allowed; page/view overflow is not.
        for (const [width, height] of [[900, 560], [1400, 880]]) {
          await setViewport(win, run, width, height);
          await pause(80); // Let Chromium's surface finish the native resize.
          const bounds = await run(`(() => {
            const s = window.__security;
            const rect = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
            return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
              view: rect(s.el), results: rect(s.el.querySelector('.security-results')),
              actions: rect(s.el.querySelector('.security-actions')), run: rect(s.runButton),
              select: rect(s.audit), controls: [s.filter, s.baselineButton, s.compareButton, s.jsonButton, s.htmlButton].map(rect) };
          })()`);
          assert.ok(bounds.documentWidth <= bounds.width + 2, JSON.stringify(bounds));
          for (const [name, rect] of Object.entries({ view: bounds.view, results: bounds.results, actions: bounds.actions, run: bounds.run, select: bounds.select })) {
            assert.ok(rect.left >= -2 && rect.right <= bounds.width + 2, `${width}: ${name} overflowed horizontally: ${JSON.stringify(bounds)}`);
          }
          assert.ok(bounds.view.top >= -2 && bounds.view.bottom <= bounds.height + 2, `${width}: security view overflowed vertically`);
          assert.ok(bounds.results.bottom <= bounds.view.bottom + 2, `${width}: results escaped their scroll container`);
          for (const rect of bounds.controls) assert.ok(rect.left >= bounds.view.left - 2 && rect.right <= bounds.view.right + 2, `${width}: report action overflowed`);
          await click('window.__security.table.tbody.querySelector("tr[data-k=fixture-unknown]")');
          assert.match(await run('window.__security.detail.textContent'), /Restricted fixture check/,
            `${width}: native result selection failed; ` + await run(`(() => {
              const el = window.__security.table.tbody.querySelector('tr[data-k=fixture-unknown]');
              const r = el.getBoundingClientRect();
              return JSON.stringify({ row: [r.left,r.top,r.right,r.bottom], hit: document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.outerHTML?.slice(0,200), selected: [...window.__security.table.selected] });
            })()`));
          if (screenshotRoot) {
            const image = await win.webContents.capturePage(undefined, { stayHidden: true });
            const destination = path.join(screenshotRoot, width < 1000 ? 'windows-security-narrow.png' : 'windows-security-wide.png');
            // Exclusive creation also prevents following an existing file link.
            fs.writeFileSync(destination, image.toPNG(), { flag: 'wx' });
            console.log('SECURITY_UI_SCREENSHOT ' + destination);
          }
        }

        // Changing assessment type only changes the visible fields. It must not
        // start any provider or leave irrelevant controls taking up header space.
        for (const [kind, expected] of [
          ['windows', [false, false, false, false, false]],
          ['windows-remote', [true, false, false, false, false]],
          ['tls', [true, true, false, false, false]],
          ['ssh', [true, true, false, false, false]],
          ['web', [false, false, true, false, false]],
          ['capture', [false, false, false, true, false]],
          ['config', [true, false, false, true, true]],
        ]) {
          await choose(kind);
          assert.deepEqual(await run(`(() => {
            const s = window.__security;
            return [s.hostField,s.portField,s.urlField,s.fileField,s.config].map((element) => Boolean(element.getClientRects().length));
          })()`), expected, kind + ' field visibility');
        }
        assert.equal(inventory.calls, 2, 'changing assessment modes must not autorun a provider');
        await setViewport(win, run, 900, 560);
        await pause(80);
        await choose('config');
        const secrets = ['FixturePlaintext_OnlyForTesting_123', 'FixtureCommunity_OnlyForTesting', 'fixture_private_account'];
        const configuration = `! Cisco IOS test fixture\nversion 15.2\nhostname fixture-switch\nusername ${secrets[2]} password 0 ${secrets[0]}\nsnmp-server community ${secrets[1]} RO\nip http server\nline vty 0 4\n transport input telnet ssh\n!\n`;
        await run(`window.__security.config.value = ${JSON.stringify(configuration)};
          window.__security.config.dispatchEvent(new Event('input', { bubbles: true })); void 0;`);
        assert.equal(await run('window.__security.filePath'), null);
        const configBounds = await run(`(() => {
          const s = window.__security, result = s.el.querySelector('.security-results').getBoundingClientRect();
          const view = s.el.getBoundingClientRect(), button = s.runButton.getBoundingClientRect();
          return { resultsHeight: result.height, resultsBottom: result.bottom, viewBottom: view.bottom,
            runTop: button.top, runBottom: button.bottom, runLeft: button.left, runRight: button.right,
            width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth };
        })()`);
        assert.ok(configBounds.resultsHeight >= 100, 'narrow configuration must leave a usable results region: ' + JSON.stringify(configBounds));
        assert.ok(await run('window.__security.config.getBoundingClientRect().height >= 100'), 'configuration editor must retain a usable multiline height');
        assert.ok(configBounds.resultsBottom <= configBounds.viewBottom + 2, 'narrow configuration results must remain inside the view');
        assert.ok(configBounds.runTop >= 0 && configBounds.runBottom <= configBounds.height && configBounds.runLeft >= 0 && configBounds.runRight <= configBounds.width, 'narrow configuration Run control must be visible: ' + JSON.stringify(configBounds));
        assert.ok(configBounds.documentWidth <= configBounds.width + 2, 'narrow configuration must not overflow the page');
        await click('window.__security.runButton');
        await until(completed, 'offline configuration engine report through real IPC');
        const config = await run('JSON.stringify(window.__security.report)');
        const report = JSON.parse(config);
        assert.equal(report.kind, 'config');
        assert.equal(report.checks.find((item) => item.id === 'config-user-cleartext').status, 'warning');
        assert.match(report.checks.find((item) => item.id === 'config-user-cleartext').evidence, /Lines 4.*value omitted/);
        assert.equal(inventory.calls, 2, 'configuration assessment must not query Windows');
        assert.equal(report.scopeId, '', 'unlabeled pasted configurations must not share a generic baseline');
        assert.equal(await run('window.__security.baselineButton.disabled && window.__security.compareButton.disabled'), true);
        assert.match(await run('window.__security.baselineStatus.textContent'), /distinct configuration label.*run.*again/i);
        // Both native export clicks must be reachable by scrolling the narrow
        // results container, even with the configuration editor above it.
        const configJson = await exportAndRead('json', 'config');
        const configHtml = await exportAndRead('html', 'config');
        for (const secret of secrets) for (const text of [config, configJson, configHtml]) assert.equal(text.includes(secret), false, 'configuration report/export leaked a synthetic secret or account name');
        assert.match(configHtml, /value omitted/);
        await run('window.__security.host.value = "Fixture switch A"; void 0;');
        await click('window.__security.runButton');
        await until(completed, 'labeled configuration assessment');
        assert.equal(await run('window.__security.report.target'), 'Fixture switch A');
        assert.match(await run('window.__security.report.scopeId'), /^[0-9a-f]{64}$/);
        assert.equal(await run('window.__security.baselineButton.disabled || window.__security.compareButton.disabled'), false);
        await click('window.__security.baselineButton');
        assert.match(await run('window.__security.baselineStatus.textContent'), /Baseline saved for Fixture switch A/);
        if (screenshotRoot) {
          const image = await win.webContents.capturePage(undefined, { stayHidden: true });
          fs.writeFileSync(path.join(screenshotRoot, 'configuration-security-narrow.png'), image.toPNG(), { flag: 'wx' });
        }

        await choose('windows');
        await click('window.__security.runButton');
        await until(() => inventory.calls === 3 && inventory.pending.size === 1, 'cancellable provider start');
        assert.equal(await run('window.__security.audit.disabled && window.__security.config.disabled'), true);
        assert.match(await run('window.__security.runButton.textContent'), /Cancel assessment/);
        await click('window.__security.runButton');
        await until(() => run('!window.__security.jobId && window.__security.state === "idle"'), 'cancel acknowledgement');
        assert.equal(inventory.cancelled, 1);
        assert.equal(inventory.pending.size, 0);
        assert.equal(await run('window.__security.report'), null);
        assert.match(await run('window.__security.status.textContent'), /Assessment cancelled/);
        assert.equal(await run('window.__app.jobs.size'), 0);

        await click('window.__security.runButton');
        await until(() => inventory.calls === 4 && inventory.pending.size === 1, 'provider before disposal');
        await click('window.__app.tabbar.children[window.__app.tabs.indexOf(window.__security)].querySelector("button.close")');
        await until(() => inventory.cancelled === 2 && inventory.pending.size === 0, 'tab disposal cancellation');
        assert.equal(await run('window.__app.tabs.includes(window.__security)'), false);
        assert.equal(await run('window.__security.disposed'), true);
        assert.equal(await run('window.__app.jobs.size'), 0);
        assert.equal(exportsMade.length, 4);
        assert.equal(await run('window.__app.sessions.data.sessions.length'), 0);
        console.log('SECURITY_UI_PASS: no autorun, real IPC, baseline compare, escaped/redacted exports, responsive layout, cancellation and disposal');
        finish(0);
      } catch (error) { finish(1, error); }
    });
  });
  require('../src/main/main');
}

module.exports = { runSecurityUiTests };
if (process.versions.electron && process.argv.includes('--electron-security-fixture')) electronFixture();
else if (require.main === module) {
  runSecurityUiTests(async (name, test) => { await test(); console.log('PASS ' + name); })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
