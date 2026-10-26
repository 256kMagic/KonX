'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const layouts = ['classic', 'workbench', 'incident-desk', 'operations-wall', 'focus'];
const themes = ['dark', 'light', 'arc-reactor', 'chroma-rgb', 'matrix-mainframe', 'synthwave-grid', 'hologram-prism', 'plasma-forge'];
async function until(check, description, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!(await check())) { if (Date.now() >= end) throw new Error('Timed out: ' + description); await pause(25); }
}
async function runWorkspaceLayoutUiTests(test) {
  await test('workspace layouts: real SSH targeting, preserved capture/editor/incident drafts, theme matrix, close guards and saved layout restart', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-layout-ui-'));
    const sockets = new Set(); let server, child;
    try {
      const { startServer } = require('./ssh-test-server');
      const ssh = await startServer({ port: 0, root, hostname: 'layout-fixture' }); server = ssh.server;
      server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      fs.mkdirSync(path.join(root, 'profile'));
      fs.writeFileSync(path.join(root, 'profile', 'settings.json'), JSON.stringify({ uiLayout: 'future-layout', uiTheme: 'arc-reactor', colorScheme: 'solarized', themeAnimations: false, copyOnSelect: false }));
      for (const phase of ['exercise', 'restart']) {
        let output = '';
        const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_LAYOUT_TEST_ROOT: root, KONX_LAYOUT_TEST_PHASE: phase,
          KONX_LAYOUT_TEST_PORT: String(ssh.port), KONX_CAPTURE: '', KONX_DEMO: '' };
        delete env.ELECTRON_RUN_AS_NODE;
        child = spawn(require('electron'), [__filename, '--layout-ui-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const collect = data => { output = (output + data).slice(-1024 * 1024); }; child.stdout.on('data', collect); child.stderr.on('data', collect);
        const code = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('Layout fixture timed out\n' + output)); }, 150000);
          child.once('error', e => { clearTimeout(timer); reject(e); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
        });
        assert.equal(code, 0, output); assert.match(output, new RegExp('LAYOUT_UI_PASS ' + phase));
      }
      const saved = JSON.parse(fs.readFileSync(path.join(root, 'profile', 'settings.json'), 'utf8'));
      assert.equal(saved.uiLayout, 'focus'); assert.equal(saved.uiTheme, 'plasma-forge'); assert.equal(saved.colorScheme, 'solarized');
      assert.equal(saved.themeAnimations, false);
    } finally {
      if (child && child.exitCode == null) child.kill();
      for (const socket of sockets) socket.destroy();
      if (server) await new Promise(resolve => server.close(resolve));
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-layout-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
async function fixture() {
  const { app, BrowserWindow, dialog, shell } = require('electron');
  const root = path.resolve(process.env.KONX_LAYOUT_TEST_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-layout-ui-'));
  const phase = process.env.KONX_LAYOUT_TEST_PHASE, port = Number(process.env.KONX_LAYOUT_TEST_PORT);
  let screenshots = null;
  if (process.env.KONX_LAYOUT_SCREENSHOT_DIR) {
    const review = fs.realpathSync(path.join(__dirname, '../review')), requested = path.resolve(process.env.KONX_LAYOUT_SCREENSHOT_DIR);
    const rel = path.relative(review, requested); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    fs.mkdirSync(requested, { recursive: true }); assert.equal(fs.realpathSync(requested), requested); screenshots = requested;
  }
  const unexpected = action => { throw new Error('Layout fixture unexpectedly invoked ' + action); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, engine: null, missing: false,
    error: 'Offline layout fixture', npcap: { available: false }, builtin: { available: false } });
  require('../src/main/ai').AIClient.prototype.run = async () => unexpected('AI provider');
  shell.openExternal = async () => unexpected('external browser');
  dialog.showOpenDialog = async () => unexpected('native open'); dialog.showSaveDialog = async () => unexpected('native save');
  dialog.showErrorBox = (title, message) => unexpected(title + ': ' + message);
  let finished = false;
  const finish = (code, error) => { if (finished) return; finished = true; if (error) console.error(error.stack || error);
    for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code); };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.setBackgroundThrottling(false);
    win.webContents.once('did-finish-load', async () => {
      const run = code => win.webContents.executeJavaScript(code).catch(error => { throw new Error(error.message + '\nExpression: ' + code.slice(0, 500)); });
      const click = async expression => {
        let point;
        await until(async () => { point = await run(`(()=>{const e=${expression};if(!e)return {ready:false};e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return{x,y,ready:!e.disabled&&r.width>0&&r.height>0&&(hit===e||e.contains(hit))};})()`); return point.ready; }, 'reachable control ' + expression);
        delete point.ready; win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(30);
      };
      const save = async patch => { await run(`window.__app.saveSettings(${JSON.stringify(patch)}).then(()=>undefined)`); await pause(60); };
      const capture = async name => { if (screenshots) { await pause(250); fs.writeFileSync(path.join(screenshots, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG()); } };
      const settings = async () => {
        await click(`document.querySelector('#toolbar button[title="Settings"]')`);
        await until(() => run(`Boolean(document.querySelector('input[name="uiLayout"]'))`), 'layout settings choices');
      };
      const text = name => run(String.raw`(()=>{const b=window.${name}.term.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString()||'').join('\n');})()`);
      try {
        await until(() => run('Boolean(window.__app?.workspaceLayout)'), 'workspace owner ready');
        if (phase === 'restart') {
          assert.equal(await run('window.__app.workspaceLayout.get().layout'), 'focus');
          assert.equal(await run('document.documentElement.dataset.theme'), 'plasma-forge');
          assert.equal(await run('window.__app.settings.colorScheme'), 'solarized');
          assert.equal(await run('window.__app.settings.themeAnimations'), false);
          assert.equal(await run('window.__app.tabs.filter(t=>t.kind==="terminal").length'), 0);
          assert.equal(await run('window.__app.jobs.size'), 0);
          console.log('LAYOUT_UI_PASS restart'); finish(0); return;
        }
        assert.equal(await run('window.__app.workspaceLayout.get().layout'), 'classic', 'Unknown layout should fall back');
        await setViewport(win, run, 1400, 880);
        await settings();
        assert.equal(await run('document.querySelectorAll("input[name=uiLayout]").length'), 5);
        await capture('appearance-1400');
        await setViewport(win, run, 900, 560); await capture('appearance-900');
        await setViewport(win, run, 1400, 880);
        await click(`document.querySelector('input[name="uiLayout"][value="workbench"]')`);
        assert.equal(await run('window.__app.workspaceLayout.get().layout'), 'classic', 'Settings choice must wait for Save');
        await click(`[...document.querySelectorAll('.modal footer button')].find(b=>b.textContent==='Cancel')`);
        assert.equal(await run('window.__app.workspaceLayout.get().layout'), 'classic');
        await settings(); await click(`document.querySelector('input[name="uiLayout"][value="workbench"]')`);
        await click(`[...document.querySelectorAll('.modal footer button')].find(b=>b.textContent==='Save')`);
        await until(() => run('window.__app.workspaceLayout.get().layout==="workbench"'), 'saved workbench');
        assert.equal(await run('document.documentElement.dataset.theme'), 'arc-reactor');
        assert.equal(await run('window.__app.settings.colorScheme'), 'solarized');
        await run(`window.__app.handlePrompt=async p=>{if(p.kind==='hostkey'&&p.host==='127.0.0.1')return 'once';throw new Error('Unexpected connection prompt '+p.kind);};
          window.__a=window.__app.openTerminal({protocol:'ssh',host:'127.0.0.1',port:${port},username:'test',password:'test',auth:'password'},{name:'Layout SSH A',protocol:'ssh'});true;`);
        await until(() => run('window.__a.state==="connected"'), 'first loopback SSH connection');
        await run(`window.__b=window.__app.openTerminal({protocol:'ssh',host:'127.0.0.1',port:${port},username:'test',password:'test',auth:'password'},{name:'Layout SSH B',protocol:'ssh'});true;`);
        await until(() => run('window.__b.state==="connected"'), 'second loopback SSH connection');
        await run(String.raw`(async()=>{const {createComparisonDemo}=await import('./js/capture/sample-compare.mjs');const demo=createComparisonDemo();
          window.__cap=window.__app.openTool('capture');await window.__cap.loadBytes(demo.before.bytes,demo.before.name);
          window.__capturePackets=window.__cap.packets;window.__captureFirst=window.__cap.packets[0];window.__cap.setFilter('tcp');
          window.__np=await window.__app.openNotepad();window.__draft=window.__np.newDoc({title:'Layout preservation.ios',text:'hostname layout-fixture\ninterface Gi1/0/18\n description draft retained\n',language:'ios'});
          window.__np.editor.setSelection({startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:9});
          window.__inc=window.__app.addToIncident(window.__cap);await window.__inc.ready;
          window.__pendingEvidence=window.__inc.pending;window.__pendingBytes=[...window.__inc.pending.bytes].join(',');
          window.__rb=window.__app.openTool('runbook');await window.__rb.ready;window.__rb.editor.value+='\n ';window.__rb.editor.dispatchEvent(new Event('input'));
          window.__initialTabs=[...window.__app.tabs];window.__app.activate(window.__a);window.__app.workspaceLayout.pin('companion',window.__b.id);window.__app.activate(window.__a);return true;})()`);
        assert.equal(await run('window.__app.active===window.__a'), true);
        await click(`document.querySelector('.workspace-pane[data-slot="companion"] .workspace-pane-focus')`);
        assert.equal(await run('window.__app.active===window.__b'), true);
        await run(String.raw`window.__app.sendToTerminals('show version\r',false);true;`);
        await until(async () => (await text('__b')).includes('KonX Test Switch Software'), 'focused terminal command');
        assert.ok(!(await text('__a')).includes('KonX Test Switch Software'), 'Single-target command reached another visible terminal');
        await run(`window.__app.workspaceLayout.pin('companion',window.__b.id);window.__app.activate(window.__a);true;`);
        assert.equal(await run('window.__app.active===window.__a'), true);
        const beforeFocus = await run('window.__app.workspaceLayout.get().visibleIds.slice().sort()');
        await click(`document.querySelector('.workspace-pane[data-slot="companion"] .workspace-pane-focus')`);
        assert.equal(await run('window.__app.active===window.__b'), true);
        assert.deepEqual(await run('window.__app.workspaceLayout.get().visibleIds.slice().sort()'), beforeFocus, 'Focus should not replace visible panes');
        await run(String.raw`window.__app.sendToTerminals('show ip interface brief\r',true);true;`);
        await until(async () => (await text('__a')).includes('TenGigabitEthernet1/1/1') && (await text('__b')).includes('TenGigabitEthernet1/1/1'), 'explicit broadcast to both SSH sessions');
        const geometry = async (layout, width, height) => {
          await setViewport(win, run, width, height); await pause(75);
          const g = await run(`(()=>{const w=window.__app.workspaceLayout.get(),v=document.querySelector('#views').getBoundingClientRect(),grid=document.querySelector('.workspace-panes');grid.scrollTop=0;grid.scrollLeft=0;return {layout:w.layout,width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,verticalRange:grid.scrollHeight-grid.clientHeight,
            panes:[...document.querySelectorAll('.workspace-pane')].filter(e=>getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width).map(e=>{const r=e.getBoundingClientRect();return {slot:e.dataset.slot,left:r.left,top:r.top,right:r.right,bottom:r.bottom};}),
            views:{left:v.left,top:v.top,right:v.right,bottom:v.bottom},ids:w.visibleIds,
            update:(()=>{const b=document.querySelector('#toolbar [data-action="update-konx"]'),r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,reachable:b===hit||b.contains(hit)}})()};})()`);
          assert.equal(g.layout, layout); assert.ok(g.scroll <= width + 2, JSON.stringify(g));
          assert.ok(g.update.reachable && g.update.left >= 0 && g.update.right <= g.width && g.update.bottom <= 48, 'Header updater must stay visible in ' + layout + ': ' + JSON.stringify(g.update));
          if (['workbench', 'focus'].includes(layout) && width === 900) {
            await run(`window.__app.workspaceLayout.contextHidden[${JSON.stringify(layout)}]=false;window.__app.workspaceLayout.refresh();true;`);
            const context = await run(`(()=>{const e=document.querySelector('.workspace-context'),r=e.getBoundingClientRect(),v=document.querySelector('#views').getBoundingClientRect();return {visible:getComputedStyle(e).display!=='none',inside:r.width>0&&r.left>=v.left-2&&r.right<=v.right+2&&r.top>=v.top-2&&r.bottom<=v.bottom+2};})()`);
            assert.deepEqual(context, {visible:true,inside:true}, 'Context rail must be reachable');
            await click(`window.__app.workspaceLayout.contextToggle`);
            assert.equal(await run(`getComputedStyle(document.querySelector('.workspace-context')).display`), 'none');
          }
          assert.equal(new Set(g.ids).size, g.ids.length, 'A tab must not appear in two panes');
          for (const p of g.panes) assert.ok(p.left >= g.views.left - 2 && p.right <= g.views.right + 2 && p.top >= g.views.top - 2 && p.bottom <= g.views.bottom + g.verticalRange + 2 && p.right > p.left && p.bottom > p.top, JSON.stringify(g));
          if (g.verticalRange > 0) {
            const reachable = await run(`(()=>{const panes=[...document.querySelectorAll('.workspace-pane')].filter(e=>getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width),head=panes.at(-1).querySelector('.workspace-pane-head');head.scrollIntoView({block:'nearest'});const r=head.getBoundingClientRect(),v=document.querySelector('#views').getBoundingClientRect();return r.top>=v.top-2&&r.bottom<=v.bottom+2;})()`);
            assert.equal(reachable, true, 'Last pane cannot be reached by scrolling');
            await run(`document.querySelector('.workspace-panes').scrollTop=0;true;`);
          }
        };
        for (const layout of layouts) {
          await save({ uiLayout: layout });
          await run(`window.__app.activate(window.__cap);true;`);
          if (layout === 'workbench') await run(`window.__app.workspaceLayout.pin('companion',window.__a.id);true;`);
          if (layout === 'incident-desk') await run(`window.__app.workspaceLayout.pin('dossier',window.__inc.id);true;`);
          if (layout === 'operations-wall') await run(`[window.__cap,window.__a,window.__np,window.__rb].forEach((t,i)=>window.__app.workspaceLayout.pin('wall-'+i,t.id));true;`);
          for (const theme of themes) {
            await save({ uiTheme: theme }); await geometry(layout, 1400, 880);
            assert.equal(await run('document.documentElement.dataset.theme'), theme);
            assert.equal(await run('window.__a.term.options.theme.background'), '#002b36', 'Explicit terminal palette changed');
          }
          await geometry(layout, 900, 560); await capture(layout + '-900');
          await geometry(layout, 1400, 880); await capture(layout + '-1400');
          assert.equal(await run(`window.__initialTabs.every(t=>window.__app.tabs.includes(t)&&window.__app.byId.get(t.id)===t)`), true);
          assert.equal(await run(`window.__cap.packets===window.__capturePackets&&window.__cap.packets[0]===window.__captureFirst&&window.__cap.packets.length===11&&window.__cap.dfilter.value==='tcp'`), true);
          assert.equal(await run(`window.__np.current===window.__draft&&window.__draft.model.getValue().includes('draft retained')&&window.__np.isDirty(window.__draft)`), true);
          assert.equal(await run('window.__rb.isDirty()'), true); assert.equal(await run('window.__inc.report'), null);
          assert.equal(await run(`window.__inc.pending===window.__pendingEvidence&&[...window.__inc.pending.bytes].join(',')===window.__pendingBytes&&window.__inc.incidents.length===0`), true, 'Layout saved or changed pending incident evidence');
          assert.equal(await run('window.__a.state==="connected"&&window.__b.state==="connected"'), true);
          assert.equal(await run('window.__app.jobs.size'), 0);
          const blockers = await run(`(async()=>{const {updateBlockers}=await import('./js/updates.js');return updateBlockers(window.__app);})()`);
          assert.ok(blockers.some(x=>x.includes('Layout preservation.ios'))); assert.ok(blockers.some(x=>x.includes('runbook')));
          assert.ok(blockers.some(x=>x.includes('unsaved evidence')));
        }
        assert.equal(await run(`(async()=>{const {api}=await import('./js/ui.js');return (await api.invoke('tools:incidentList')).incidents.length;})()`), 0, 'Layout created a saved incident');
        await save({ uiLayout: 'operations-wall' });
        await run(`window.__app.workspaceLayout.pin('wall-0',window.__cap.id);window.__app.workspaceLayout.pin('wall-1',window.__a.id);true;`);
        await click(`document.querySelector('.workspace-pane[data-slot="wall-0"] .workspace-pane-expand')`);
        assert.equal(await run('window.__app.workspaceLayout.get().expandedSlot'), 'wall-0');
        await click(`document.querySelector('.workspace-pane[data-slot="wall-0"] .workspace-pane-expand')`);
        assert.equal(await run('window.__app.workspaceLayout.get().expandedSlot'), null);
        // A vetoed close preserves the same draft and assigned pane.
        await run(`window.__closePromise=window.__app.closeTab(window.__rb);true;`);
        await until(() => run('Boolean(document.querySelector(".modal"))'), 'unsaved runbook close dialog');
        await click(`[...document.querySelectorAll('.modal footer button')].find(b=>b.textContent==='Cancel')`);
        await run('window.__closePromise.then(()=>true)');
        assert.equal(await run('window.__app.tabs.includes(window.__rb)&&window.__rb.isDirty()'), true);
        // Closing an assigned tab clears that identity without closing the other panes.
        await run(`window.__app.workspaceLayout.pin('wall-2',window.__b.id);window.__app.closeTab(window.__b).then(()=>true)`);
        assert.equal(await run('window.__app.tabs.includes(window.__b)'), false);
        assert.equal(await run('window.__app.workspaceLayout.get().visibleIds.includes(window.__b.id)'), false);
        assert.equal(await run('window.__a.state'), 'connected');
        await save({ uiLayout: 'focus', uiTheme: 'plasma-forge', themeAnimations: false });
        await run(`window.__app.activate(window.__cap);window.__a.disconnect();true;`);
        await until(() => run('window.__a.state==="disconnected"'), 'fixture SSH cleanup');
        assert.equal(await run('window.__app.workspaceLayout.get().layout'), 'focus');
        console.log('LAYOUT_UI_PASS exercise: layout/theme matrix, real SSH, saved preference and retained work'); finish(0);
      } catch (error) { finish(1, error); }
    });
  });
  require('../src/main/main');
}
module.exports = { runWorkspaceLayoutUiTests };
if (process.versions.electron && process.argv.includes('--layout-ui-fixture')) fixture().catch(error => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runWorkspaceLayoutUiTests(async (name, run) => { await run(); console.log('PASS ' + name); }).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
