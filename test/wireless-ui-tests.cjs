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

async function runWirelessUiTests(test) {
  await test('real Wi-Fi/Mist IPC, token handling, Marvis, exports, scoped results, cancellation and responsive layout', async () => {
    const tempRoot = path.resolve(os.tmpdir());
    const fixtureRoot = fs.mkdtempSync(path.join(tempRoot, 'konx-wireless-ui-test-'));
    let child, output = '';
    try {
      child = spawn(require('electron'), [__filename, '--electron-wireless-fixture'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, KONX_USERDATA: path.join(fixtureRoot, 'profile'), KONX_WIRELESS_TEST_ROOT: fixtureRoot, KONX_CAPTURE: '', KONX_DEMO: '' },
      });
      const collect = (data) => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Wireless UI fixture timed out\n' + output)); }, 55000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
      });
      assert.equal(code, 0, output); assert.match(output, /WIRELESS_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) child.kill();
      assert.equal(path.dirname(path.resolve(fixtureRoot)), tempRoot);
      assert.ok(path.basename(fixtureRoot).startsWith('konx-wireless-ui-test-'));
      fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function electronFixture() {
  const { app, BrowserWindow, dialog } = require('electron');
  const fixtureRoot = path.resolve(process.env.KONX_WIRELESS_TEST_ROOT || '');
  assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixtureRoot).startsWith('konx-wireless-ui-test-'));
  const exportsRoot = path.join(fixtureRoot, 'exports'); fs.mkdirSync(exportsRoot);
  let screenshotRoot = null;
  if (process.env.KONX_WIRELESS_SCREENSHOT_DIR) {
    const reviewRoot = fs.realpathSync(path.join(__dirname, '..', 'review'));
    const requested = path.resolve(process.env.KONX_WIRELESS_SCREENSHOT_DIR);
    const contained = (value) => {
      const relative = path.relative(reviewRoot, value);
      return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    assert.ok(contained(requested), 'Wireless screenshots must be inside workspace/review');
    let ancestor = requested;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    assert.ok(ancestor === reviewRoot || contained(fs.realpathSync(ancestor)), 'Screenshot parent resolves outside workspace/review');
    fs.mkdirSync(requested, { recursive: true }); screenshotRoot = fs.realpathSync(requested);
    assert.ok(contained(screenshotRoot), 'Screenshot directory resolves outside workspace/review');
  }
  const exported = [], pending = new Set();
  const inventory = { wifiCalls: 0, mistCalls: [], configured: [], cancelled: 0, delayMist: false };
  const malicious = '<img src=x onerror="window.__wirelessInjected=true">';
  const token = 'SyntheticFixtureToken_ThisIsNotARealCredential';
  const now = '2026-10-20T12:00:00.000Z';
  const orgA = '00000000-0000-0000-0000-000000000001', orgB = '00000000-0000-0000-0000-000000000002';
  const siteA = '00000000-0000-0000-0000-000000000003', siteB = '00000000-0000-0000-0000-000000000004';
  const cancellable = (signal) => new Promise((_resolve, reject) => {
    const stop = () => { inventory.cancelled++; pending.delete(stop); signal.onStop = null; reject(new Error('Request cancelled')); };
    pending.add(stop); signal.onStop = stop; if (signal.stopped) stop();
  });
  const wifiReport = {
    schemaVersion: 1, kind: 'wifi', collectedAt: now,
    adapters: [{ id: 'adapter-fixture', name: 'Fixture Wi-Fi', state: 'connected', connection: { ssid: 'Fixture LAN', bssid: '00:11:22:33:44:55', signalPercent: 82, rxMbps: 720, txMbps: 600, authentication: 'WPA3-Personal', encryption: 'CCMP' }, issues: [] }],
    networks: [
      { adapterId: 'adapter-fixture', ssid: malicious, hidden: false, bssid: '00:11:22:33:44:55', band: '5 GHz', channel: 36, frequencyMHz: 5180, signalPercent: 82, rssiDbm: -45, authentication: 'WPA3-Personal', encryption: 'CCMP', securityEnabled: true, connected: true, hostTimestamp: now },
      { adapterId: 'adapter-fixture', ssid: 'Fixture Open', hidden: false, bssid: '00:11:22:33:44:66', band: '2.4 GHz', channel: 6, frequencyMHz: 2437, signalPercent: 30, rssiDbm: -80, authentication: 'Open', encryption: 'None', securityEnabled: false, connected: false, hostTimestamp: null },
    ], channels: [{ band: '5 GHz', channel: 36, bssidCount: 1, strongestRssiDbm: -45 }, { band: '2.4 GHz', channel: 6, bssidCount: 1, strongestRssiDbm: -80 }],
    findings: [{ id: 'fixture-open', title: 'Open wireless network observed', status: 'warning', severity: 'medium', evidence: malicious, remediation: 'Use an authenticated wireless network.' }],
    limitations: ['Synthetic cached observations. No wireless driver or location API was queried.'],
  };
  // Only providers are replaced. Renderer, tool runner, main IPC, dialog export,
  // cancellation and disposal paths remain real; no cloud/local survey runs.
  require('../src/main/wifi').run = async (_params, emit, signal) => {
    inventory.wifiCalls++;
    if (inventory.wifiCalls > 1) return cancellable(signal);
    emit('progress', { phase: 'Reading synthetic wireless cache…' }); emit('report', wifiReport);
  };
  require('../src/main/mist').MistClient = class {
    constructor() { this.hasToken = false; this.region = 'global01'; this.revision = 0; }
    getConfig() { return { region: this.region, hasToken: this.hasToken, revision: 'fixture-revision-' + this.revision, regions: [
      { id: 'global01', label: 'Global 01', origin: 'https://api.mist.com' }, { id: 'emea01', label: 'EMEA 01', origin: 'https://api.eu.mist.com' },
    ] }; }
    configure(params) {
      inventory.configured.push({ ...params });
      if (inventory.configured.length === 1) throw new Error('Synthetic encrypted-store failure');
      if (params.token === null) this.hasToken = false;
      else if (typeof params.token === 'string') { assert.equal(params.token, token); this.hasToken = true; }
      this.region = params.region || this.region; this.revision++; return this.getConfig();
    }
    async run(params, emit, signal) {
      inventory.mistCalls.push({ ...params });
      assert.equal(this.hasToken, true);
      assert.equal(params.configRevision, 'fixture-revision-' + this.revision);
      if (inventory.delayMist) return cancellable(signal);
      let data;
      if (params.action === 'self') data = { name: 'Synthetic operator', orgs: [{ id: orgA, name: 'Fixture organization A', role: 'admin' }, { id: orgB, name: 'Fixture organization B', role: 'read' }], sites: [] };
      if (params.action === 'sites') data = params.orgId === orgA ? [{ id: siteA, name: 'Fixture site A', timezone: 'UTC', orgId: orgA }, { id: siteB, name: 'Fixture site B', timezone: 'UTC', orgId: orgA }] : [];
      if (params.action === 'aps') data = [{ id: 'ap-fixture', mac: '001122334455', name: malicious, model: 'AP45', status: 'connected', ip: '192.0.2.5', numClients: 3, uptime: 120, version: 'fixture', radios: [{ band: '5', channel: 36, power: 10, utilization: 20 }] }];
      if (params.action === 'clients') data = [{ mac: '001122334466', hostname: malicious, ip: '192.0.2.10', ssid: 'Fixture LAN', apMac: '001122334455', band: '5', channel: 36, rssi: -45, snr: 35, lastSeen: 123 }];
      if (params.action === 'marvis') data = { status: 'ok', summary: malicious, results: [{ symptom: 'Synthetic association issue', recommendation: 'Review the fixture access point.' }] };
      assert.notEqual(data, undefined, 'Unexpected Mist action');
      emit('report', { action: params.action, region: this.region, fetchedAt: now, data, limited: false, limitations: ['Synthetic Mist provider; no network request was made.'] });
    }
  };
  dialog.showSaveDialog = async (_window, options) => {
    const basename = path.basename(options.defaultPath); assert.match(basename, /^konx-(wifi|mist-(aps|clients|marvis))-2026-10-20\.json$/);
    const filePath = path.join(exportsRoot, basename); exported.push(filePath); return { canceled: false, filePath };
  };
  dialog.showErrorBox = (title, message) => { throw new Error('Unexpected native JavaScript error: ' + title + ': ' + message); };
  dialog.showOpenDialog = async () => { throw new Error('No user files may be opened by the fixture'); };
  let finished = false;
  const finish = (code, error) => {
    if (finished) return; finished = true;
    if (error) console.error(error.stack || error);
    for (const stop of [...pending]) stop();
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.exit(code);
  };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.once('did-finish-load', async () => {
      try {
        const run = (code) => win.webContents.executeJavaScript(code).catch((error) => { throw new Error(error.message + '\nFixture expression: ' + code.slice(0, 500)); });
        await until(() => run('Boolean(window.__app)'), 'app initialization');
        const click = async (expression) => {
          let point;
          await until(async () => {
            point = await run(`(() => {
              const el = ${expression}; if (!el) throw new Error('Missing fixture control: ${expression.replaceAll("'", '')}');
              el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              const r = el.getBoundingClientRect(); if (!r.width || !r.height || el.disabled) return {ready:false,disabled:el.disabled,rect:[r.width,r.height]};
              const x = Math.round(r.left+r.width/2), y = Math.round(r.top+r.height/2), hit = document.elementFromPoint(x,y);
              return {x,y,ready:el===hit || el.contains(hit)};
            })()`); return point.ready;
          }, 'unobstructed wireless control ' + expression, 7500);
          delete point.ready;
          win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
          win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(35);
        };
        const choose = (expression, value) => run(`${expression}.value = ${JSON.stringify(value)}; ${expression}.dispatchEvent(new Event('change', {bubbles:true})); void 0;`);
        const completed = (tab, action) => until(() => run(`Boolean(window.__${tab}.report ${action ? '&& window.__' + tab + '.report.action === ' + JSON.stringify(action) : ''} && !window.__${tab}.jobId)`), tab + ' report ' + (action || ''));
        const exportAndRead = async (tab) => {
          const before = exported.length; await click(`window.__${tab}.jsonButton`);
          await until(() => exported.length === before+1 && fs.existsSync(exported[before]), 'wireless JSON export');
          return fs.readFileSync(exported[before], 'utf8');
        };
        await run('window.__wifi = window.__app.openTool("wifi"); void 0;');
        await pause(100); assert.equal(inventory.wifiCalls, 0, 'opening Wi-Fi tools must not query radios');
        await click('window.__wifi.runButton'); await completed('wifi');
        assert.equal(inventory.wifiCalls, 1); assert.equal(await run('window.__wifi.networks.rows.length'), 2);
        assert.equal(await run('Boolean(window.__wirelessInjected)'), false);
        await choose('window.__wifi.band', '5 GHz'); assert.equal(await run('window.__wifi.networks.rows.length'), 1);
        await click('window.__wifi.networks.tbody.querySelector("tr[data-k]")');
        assert.equal(await run('window.__wifi.detail.querySelector("h3").textContent'), malicious);
        assert.match(await run('window.__wifi.detail.textContent'), /RSSI.*-45 dBm/);
        assert.equal(await run('window.__wifi.el.querySelector("img")'), null);
        const wifiJson = await exportAndRead('wifi'); assert.equal(JSON.parse(wifiJson).networks.length, 2); assert.equal(wifiJson.includes(token), false);
        await run('window.__mist = window.__app.openTool("mist"); void 0;');
        await until(() => run('!window.__mist.configBusy'), 'local Mist config');
        assert.equal(inventory.mistCalls.length, 0, 'opening Mist must not contact the cloud');
        assert.equal(await run('window.__mist.token.type'), 'password');
        assert.equal(await run('window.__mist.config.hasToken'), false);
        await run(`window.__mist.token.value = ${JSON.stringify(token)}; void 0;`); await click('window.__mist.saveButton');
        await until(() => run('!window.__mist.configBusy'), 'failed token save');
        assert.equal(await run('window.__mist.token.value'), ''); assert.equal(await run('window.__mist.config.hasToken'), false);
        assert.match(await run('window.__mist.status.textContent'), /Synthetic encrypted-store failure/);
        await run(`window.__mist.token.value = ${JSON.stringify(token)}; void 0;`); await click('window.__mist.saveButton');
        await until(() => run('!window.__mist.configBusy && window.__mist.config.hasToken'), 'successful token save');
        assert.equal(await run('window.__mist.token.value'), ''); assert.equal(await run('JSON.stringify(window.__mist.config).includes(' + JSON.stringify(token) + ')'), false);
        assert.equal(await run('Object.values(localStorage).join("").includes(' + JSON.stringify(token) + ')'), false);
        assert.equal(inventory.mistCalls.length, 0, 'saving a token must not silently query Mist');
        await choose('window.__mist.region','emea01');
        await run(`window.__mist.token.value=${JSON.stringify(token)};window.__app.activate(window.__wifi);window.__app.activate(window.__mist);void 0;`);
        await until(()=>run('!window.__mist.configBusy'),'local refresh of unsaved region');
        assert.equal(await run('window.__mist.region.value'),'emea01','tab reactivation must preserve an unsaved region candidate');
        assert.equal(await run('window.__mist.token.value'),token);
        assert.equal(await run('window.__mist.testButton.disabled'),true,'unsaved region must still block cloud requests');
        assert.equal(inventory.mistCalls.length,0);
        await choose('window.__mist.region','global01');await run('window.__mist.token.value="";void 0;');
        await click('window.__mist.testButton'); await completed('mist', 'self');
        assert.ok((await run('[...window.__mist.org.options].map(o=>o.value)')).includes(orgA),await run('window.__mist.org.outerHTML'));
        await choose('window.__mist.org', orgA); assert.equal(await run('window.__mist.report'), null);
        assert.equal(await run('window.__mist.sitesButton.disabled'),false,await run('JSON.stringify({org:window.__mist.org.value,manual:window.__mist.manualOrg.value,config:window.__mist.config,busy:window.__mist.configBusy,job:window.__mist.jobId})'));
        await click('window.__mist.sitesButton'); await completed('mist', 'sites');
        await choose('window.__mist.site', siteA); assert.equal(await run('window.__mist.report'), null);
        await click('window.__mist.apsButton'); await completed('mist', 'aps');
        await click('window.__mist.table.tbody.querySelector("tr[data-k]")');
        assert.match(await run('window.__mist.detail.textContent'), /radios/); assert.equal(await run('window.__mist.el.querySelector("img")'), null);
        const apsJson = await exportAndRead('mist'); assert.equal(JSON.parse(apsJson).action, 'aps'); assert.equal(apsJson.includes(token), false);
        await choose('window.__mist.site', siteB); assert.equal(await run('window.__mist.report'), null); assert.equal(await run('window.__mist.jsonButton.disabled'), true);
        await click('window.__mist.clientsButton'); await completed('mist', 'clients');
        assert.equal(await run('window.__mist.table.rows[0].hostname'), malicious);
        await run('window.__mist.mac.value="00:11:22:33:44:66"; void 0;');
        await click('window.__mist.marvisButton'); await completed('mist', 'marvis');
        const params = inventory.mistCalls.at(-1); assert.equal(params.action, 'marvis'); assert.equal(params.mac, '00:11:22:33:44:66'); assert.equal(params.orgId, orgA); assert.equal(params.siteId, siteB);
        assert.match(await run('window.__mist.detail.textContent'), /Synthetic association issue/); assert.equal(await run('Boolean(window.__wirelessInjected)'), false);
        const marvisJson = await exportAndRead('mist'); assert.equal(JSON.parse(marvisJson).action, 'marvis'); assert.equal(marvisJson.includes(token), false);
        for (const [width, height] of [[900,560],[1400,880]]) {
          await setViewport(win, run, width, height); await pause(80);
          const bounds = await run(`(() => {
            const t=window.__mist, r=t.el.getBoundingClientRect(), c=t.el.querySelector('.wireless-content').getBoundingClientRect();
            return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,view:[r.left,r.top,r.right,r.bottom],content:[c.left,c.top,c.right,c.bottom,c.height]};
          })()`);
          assert.ok(bounds.documentWidth <= bounds.width+2, JSON.stringify(bounds));
          assert.ok(bounds.view[0]>=-2 && bounds.view[2]<=bounds.width+2 && bounds.view[3]<=bounds.height+2, JSON.stringify(bounds));
          assert.ok(bounds.content[4]>=100 && bounds.content[3]<=bounds.view[3]+2, JSON.stringify(bounds));
          const sidebar = await run(`(() => { const el=document.querySelector('.side-tools .tool-item:last-child'); el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {top:r.top,bottom:r.bottom,height:innerHeight,reachable:el===hit||el.contains(hit)}; })()`);
          assert.ok(sidebar.top>=0 && sidebar.bottom<=sidebar.height && sidebar.reachable, 'Last sidebar tool is unreachable: '+JSON.stringify(sidebar));
          for (const name of ['token','saveButton','testButton','org','site','marvisButton','jsonButton']) {
            const rect = await run(`(() => {const el=window.__mist.${name};el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom,innerWidth,innerHeight];})()`);
            assert.ok(rect[0]>=-2 && rect[1]>=-2 && rect[2]<=rect[4]+2 && rect[3]<=rect[5]+2, `${name} not reachable at ${width}: ${JSON.stringify(rect)}`);
          }
          await click('window.__mist.marvisButton'); await completed('mist', 'marvis');
          if (screenshotRoot) {
            await until(()=>run('!document.querySelector("#toasts .toast")'),'fixture toasts expire before screenshots',8500);
            await run('window.__mist.heading.scrollIntoView({block:"start"});void 0;');
            await pause(80);
            fs.writeFileSync(path.join(screenshotRoot, `mist-${width}.png`), (await win.webContents.capturePage(undefined,{stayHidden:true})).toPNG(), {flag:'wx'});
          }
        }
        await choose('window.__mist.org', orgB); assert.equal(await run('window.__mist.report'), null);
        await choose('window.__mist.org', orgA); await click('window.__mist.sitesButton'); await completed('mist', 'sites'); await choose('window.__mist.site', siteA);
        const beforeManual=inventory.mistCalls.length;
        await run(`window.__mist.manualOrg.value=${JSON.stringify(orgB)};window.__mist.manualSite.value=${JSON.stringify(siteA)};window.__mist.mac.value='001122334466';window.__mist.manualOrg.dispatchEvent(new Event('input',{bubbles:true}));void 0;`);
        assert.equal(await run('window.__mist.site.value + window.__mist.manualSite.value + window.__mist.mac.value'),'','manual organization change must clear old site/device targets');
        assert.equal(inventory.mistCalls.length,beforeManual,'manual scope changes must not make a cloud request');
        await run('window.__mist.manualOrg.value="";window.__mist.manualOrg.dispatchEvent(new Event("input",{bubbles:true}));void 0;');
        await click('window.__mist.sitesButton'); await completed('mist','sites'); await choose('window.__mist.site',siteA);
        inventory.delayMist=true;
        await click('window.__mist.apsButton'); await until(() => pending.size===1, 'pending Mist request');
        await click('window.__mist.cancelButton'); await until(() => run('!window.__mist.jobId'), 'Mist cancellation');
        assert.equal(inventory.cancelled,1); assert.equal(await run('window.__app.jobs.size'),0);
        await click('window.__mist.apsButton'); await until(() => pending.size===1, 'Mist request before tab close');
        await click('window.__app.tabbar.children[window.__app.tabs.indexOf(window.__mist)].querySelector("button.close")');
        await until(() => pending.size===0, 'Mist tab-close cancellation'); assert.equal(inventory.cancelled,2); assert.equal(await run('window.__app.jobs.size'),0);
        await run('window.__mist = window.__app.openTool("mist"); void 0;'); await until(() => run('!window.__mist.configBusy'),'reopened local config');
        await click('window.__mist.forgetButton'); await until(() => run('!window.__mist.configBusy && !window.__mist.config.hasToken'),'token removal');
        assert.equal(inventory.configured.at(-1).token,null); assert.equal(await run('window.__mist.token.value'),'');
        const beforeOtherTab = inventory.mistCalls.length;
        await run('window.__otherMist = window.__app.openTool("mist"); void 0;');
        await until(()=>run('!window.__otherMist.configBusy'),'second Mist tab local settings');
        await run(`window.__otherMist.token.value=${JSON.stringify(token)};void 0;`);await click('window.__otherMist.saveButton');
        await until(()=>run('!window.__otherMist.configBusy && window.__otherMist.config.hasToken'),'second tab token save');
        await run('window.__app.activate(window.__mist);void 0;');
        await until(()=>run('!window.__mist.configBusy && window.__mist.config.hasToken'),'reactivated tab refreshes credential revision');
        assert.equal(await run('window.__mist.config.revision === window.__otherMist.config.revision'),true);
        assert.equal(await run('window.__mist.report'),null);assert.equal(inventory.mistCalls.length,beforeOtherTab,'local tab reactivation must not query Mist');
        await run('window.__app.activate(window.__wifi); void 0;');
        for (const [width,height] of [[900,560],[1400,880]]) {
          await setViewport(win,run,width,height); await pause(80);
          await click('window.__wifi.networks.tbody.querySelector("tr[data-k]")');
          const geometry=await run('({width:innerWidth,documentWidth:document.documentElement.scrollWidth,bottom:window.__wifi.el.getBoundingClientRect().bottom,height:innerHeight})');
          assert.ok(geometry.documentWidth<=geometry.width+2 && geometry.bottom<=geometry.height+2,JSON.stringify(geometry));
          if(screenshotRoot) {
            await until(()=>run('!document.querySelector("#toasts .toast")'),'fixture toasts expire before screenshots',8500);
            await run('window.__wifi.detail.scrollIntoView({block:"nearest"});void 0;');
            await pause(80);
            fs.writeFileSync(path.join(screenshotRoot,`wifi-${width}.png`),(await win.webContents.capturePage(undefined,{stayHidden:true})).toPNG(),{flag:'wx'});
          }
        }
        await click('window.__wifi.runButton'); await until(()=>pending.size===1,'pending Wi-Fi refresh');
        await click('window.__wifi.runButton'); await until(()=>run('!window.__wifi.jobId'),'Wi-Fi cancellation'); assert.equal(inventory.cancelled,3);
        await click('window.__wifi.runButton'); await until(()=>pending.size===1,'Wi-Fi refresh before tab close');
        await click('window.__app.tabbar.children[window.__app.tabs.indexOf(window.__wifi)].querySelector("button.close")');
        await until(()=>pending.size===0,'Wi-Fi tab-close cancellation'); assert.equal(inventory.cancelled,4); assert.equal(await run('window.__app.jobs.size'),0);
        console.log('WIRELESS_UI_PASS: no autorun, real IPC, token clearing, scoped cloud results, escaped remote text, Marvis, JSON exports, responsive layout and cancellation');
        finish(0);
      } catch(error) { finish(1,error); }
    });
  });
  require('../src/main/main');
}

module.exports = { runWirelessUiTests };
if(process.versions.electron && process.argv.includes('--electron-wireless-fixture')) electronFixture().catch((error)=>{console.error(error.stack||error);require('electron').app.exit(1);});
else if(require.main===module) runWirelessUiTests(async(name,test)=>{await test();console.log('PASS '+name);}).catch((error)=>{console.error(error);process.exitCode=1;});
