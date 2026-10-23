'use strict';

// Simulated Chromium scale and viewport coverage, not a physical multi-monitor
// test. Each process owns its profile, windows and one loopback console peer.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 12000;
  while (!await check()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await pause(25); }
}

async function runWorkspaceDpiUiTests(test) {
  for (const scale of [1, 1.25, 1.5, 2]) await test(`workspace scale ${scale * 100}%: compact/large popouts, floating bounds, keyboard split and retained contents`, async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-workspace-dpi-'));
    let child;
    try {
      const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_DPI_ROOT: root, KONX_DPI_SCALE: String(scale), KONX_CAPTURE: '', KONX_DEMO: '' };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--workspace-dpi-fixture', `--force-device-scale-factor=${scale}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const collect = bytes => { output = (output + bytes).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('DPI fixture timed out\n' + output)); }, 90000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0, output); assert.match(output, new RegExp(`WORKSPACE_DPI_PASS ${scale}`));
      if (process.env.KONX_DPI_UI_SCREENSHOTS) {
        const destination = path.resolve(process.env.KONX_DPI_UI_SCREENSHOTS); fs.mkdirSync(destination, { recursive: true });
        for (const filename of fs.readdirSync(root).filter(name => name.endsWith('.png') || name.endsWith('.json'))) fs.copyFileSync(path.join(root, filename), path.join(destination, filename));
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; }
      const resolved = fs.realpathSync(root);
      assert.equal(path.dirname(resolved).toLowerCase(), base.toLowerCase()); assert.ok(path.basename(resolved).startsWith('konx-workspace-dpi-'));
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, dialog, shell, screen } = require('electron');
  const root = fs.realpathSync(process.env.KONX_DPI_ROOT), scale = Number(process.env.KONX_DPI_SCALE);
  assert.equal(path.dirname(root).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(root).startsWith('konx-workspace-dpi-')); assert.ok([1, 1.25, 1.5, 2].includes(scale));
  assert.equal(path.resolve(process.env.KONX_USERDATA), path.join(root, 'profile'));
  const peers = new Set(); let connections = 0, closes = 0, input = '', main, finished = false;
  const server = net.createServer(socket => {
    connections++; peers.add(socket); socket.on('error', () => {});
    socket.on('close', () => { closes++; peers.delete(socket); });
    socket.on('data', bytes => { input += bytes.toString(); socket.write(bytes); });
    socket.write('DPI_RETAINED_BUFFER\r\nRouter# ');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const unexpected = operation => { throw new Error('Unexpected DPI fixture operation: ' + operation); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, error: 'Isolated DPI fixture', builtin: { available: false } });
  shell.openExternal = async () => unexpected('external browser');
  dialog.showOpenDialog = dialog.showSaveDialog = async () => unexpected('native file dialog');
  dialog.showMessageBoxSync = () => 1;
  const finish = async (code, error) => {
    if (finished) return; finished = true;
    if (error) console.error(error.stack || error);
    for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve));
    for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code);
  };
  const fail = error => { void finish(1, error instanceof Error ? error : new Error(String(error))).catch(error => { console.error(error); app.exit(1); }); };
  process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
  app.on('browser-window-created', (_event, win) => {
    try {
      if (win.isDestroyed()) return;
      win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true); win.webContents.setBackgroundThrottling(false);
      if (main) return;
      main = win;
      main.webContents.once('did-finish-load', () => { void exercise().catch(fail); });
    } catch (error) { fail(error); }
  });
  async function exercise() {
    const runIn = async (win, expression) => {
      let timer;
      try { return await Promise.race([win.webContents.executeJavaScript(expression), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer command timeout')), 15000); })]); }
      catch (error) { throw new Error(error.message + '\nExpression: ' + expression.slice(0, 1000)); }
      finally { clearTimeout(timer); }
    };
    const run = expression => runIn(main, expression);
    const popup = () => BrowserWindow.getAllWindows().find(win => win !== main);
    const click = async (win, expression) => {
      let point, prior;
      await until(async () => {
        point = await runIn(win, `(()=>{const e=${expression};if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);return{x,y,ready:!e.disabled&&r.width>0&&r.height>0&&x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&(hit===e||e.contains(hit))};})()`);
        // Native minimum-size and DPI changes can continue relaying resize
        // events after getBounds settles. Wait for a stable reachable target.
        const stable = point?.ready && prior?.x === point.x && prior?.y === point.y;
        prior = point; return stable;
      }, 'reachable control ' + expression);
      delete point.ready;
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(30);
    };
    const controlsReachable = win => runIn(win, `(()=>{const buttons=[...document.querySelectorAll('.popout-header button')];return buttons.length===3&&buttons.every(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&r.x>=-1&&r.y>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&(hit===e||e.contains(hit));});})()`);
    const floatWithin = () => run(`(()=>{const e=__app.workspaceLayout.floating.get(__t),r=e?.bounds,v=__app.views;return !!r&&r.x>=0&&r.y>=0&&r.x+r.width<=v.clientWidth+1&&r.y+r.height<=v.clientHeight+1;})()`);
    const bufferIntact = () => run(String.raw`(()=>{const b=__t.term.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\n').includes('DPI_RETAINED_BUFFER');})()`);
    const report = { scale, coverage: 'Simulated Chromium scale, viewport and display-change event; no physical monitor reconfiguration', viewports: [] };
    await until(() => run('Boolean(window.__app?.popouts)'), 'application ready');
    assert.ok(Math.abs(await run('devicePixelRatio') - scale) < 0.01, 'requested scale actually applied');
    await run(`window.__t=__app.openTerminal({protocol:'raw',host:'127.0.0.1',port:${server.address().port}},{name:'DPI console',protocol:'raw'});window.__originalTerminal=__t.term;true;`);
    await until(() => run('__t.state==="connected"'), 'loopback connected'); await until(bufferIntact, 'retained banner');
    await run(`(async()=>{window.__np=await __app.openNotepad();window.__draft=__np.newDoc({title:'DPI draft',text:'Retained unsaved text at every scale'});window.__model=__draft.model;__app.showHome();window.__home=__app.active;await __app.saveSettings({uiLayout:'workbench'});__app.activate(__t);return true;})()`);
    for (const [width, height] of [[900, 560], [1280, 800]]) {
      const dimensions = await setViewport(main, run, width, height);
      await run(`__app.workspaceLayout.pin('primary',__t.id);__app.workspaceLayout.pin('companion',__home.id);__app.activate(__t);true;`);
      const axis = width <= 1150 ? 'rows' : 'columns';
      const before = await run(`__app.workspaceLayout.get().geometry.ratios.workbench.${axis}`);
      await click(main, `document.querySelector('.workspace-splitter[data-axis="${axis}"]')`);
      await run(`document.querySelector('.workspace-splitter[data-axis="${axis}"]').focus();true;`);
      main.webContents.sendInputEvent({ type: 'keyDown', keyCode: axis === 'rows' ? 'Down' : 'Right' });
      main.webContents.sendInputEvent({ type: 'keyUp', keyCode: axis === 'rows' ? 'Down' : 'Right' });
      await until(async () => await run(`__app.workspaceLayout.get().geometry.ratios.workbench.${axis}`) > before, 'native keyboard split adjustment');
      await run(`__app.workspaceLayout.float(__t,{x:50000,y:50000,width:5000,height:5000});true;`);
      await until(floatWithin, 'oversized/offscreen floating bounds clamped');
      await click(main, `document.querySelector('button[aria-label="Dock floating panel"]')`);
      await until(() => run('__app.workspaceLayout.placement(__t)==="docked"'), 'floating panel docks');
      assert.equal(await run('__app.popouts.open(__t)'), true);
      await until(() => !!popup(), 'native console popup'); const child = popup();
      await setViewport(child, expression => runIn(child, expression), width, height);
      await until(() => controlsReachable(child), 'popup header controls fit viewport');
      await until(() => run(`(()=>{const expected=__t.fit.proposeDimensions();return expected&&__t.term.cols===expected.cols&&__t.term.rows===expected.rows&&__t.term.cols>40&&__t.term.rows<100;})()`), 'scaled terminal fits actual popup content');
      await until(() => run(`(()=>{const entry=__app.popouts.entries.get(__t.id);return entry.status.textContent===__t.statusSegments().map(s=>s.text).filter(Boolean).join(' · ');})()`), 'popup footer follows actual fitted terminal dimensions');
      assert.ok(Math.abs(await runIn(child, 'devicePixelRatio') - scale) < 0.01);
      assert.equal(child.isClosable(), true); assert.equal(child.isMinimizable(), true); assert.equal(child.isMaximizable(), true);
      const inputStart = input.length;
      await run('__t.term.focus();true;'); child.webContents.sendInputEvent({ type: 'char', keyCode: 'D' });
      await until(() => input.slice(inputStart).includes('D'), 'native scaled console input');
      fs.writeFileSync(path.join(root, `dpi-${scale * 100}-${width}-popup.png`), (await child.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
      const id = child.id;
      child.setBounds({ x: 50000, y: 50000, width: 600, height: 420 });
      // Exercise the real owner listener with a simulated display change. This
      // emits no OS operation and does not change the machine's monitor setup.
      screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea', 'scaleFactor']);
      await until(() => {
        const bounds = child.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
        return bounds.x >= area.x - 3 && bounds.y >= area.y - 3 && bounds.x + bounds.width <= area.x + area.width + 3 && bounds.y + bounds.height <= area.y + area.height + 3;
      }, 'native offscreen popup recovered to work area');
      assert.equal(child.id, id); assert.equal(await run('__t.term===__originalTerminal&&__t.state==="connected"'), true);
      // Native minimum sizes include the caption/frame; Windows may enforce a
      // different content size at fractional DPI. Inspect the actual minimum
      // instead of pretending it is a prescribed CSS viewport.
      const minimum = child.getMinimumSize(); child.setSize(...minimum);
      await until(() => { const bounds = child.getBounds(); return Math.abs(bounds.width - minimum[0]) <= 3 && Math.abs(bounds.height - minimum[1]) <= 3; }, 'native minimum resize settles');
      await until(() => controlsReachable(child), 'minimum popup controls reachable');
      await click(child, `[...document.querySelectorAll('.popout-header button')].find(e=>e.textContent==='Float in KonX')`);
      await until(() => !popup(), 'scaled popup floats into main').catch(async error => {
        throw new Error(error.message + ' ' + JSON.stringify({ windows: BrowserWindow.getAllWindows().map(win => ({ id: win.id, bounds: win.getBounds(), content: win.getContentBounds() })),
          renderer: await run(`({placement:__app.workspaceLayout.placement(__t),external:__app.popouts.entries.size,closing:__app.popouts.closing.size})`) }));
      });
      await until(floatWithin, 'returned float remains on canvas').catch(async error => {
        throw new Error(error.message + ' ' + JSON.stringify(await run(`({width:${width},placement:__app.workspaceLayout.placement(__t),bounds:__app.workspaceLayout.floating.get(__t)?.bounds,viewport:{width:__app.views.clientWidth,height:__app.views.clientHeight},tabs:__app.tabs.map(t=>({id:t.id,title:t.title}))})`)));
      });
      await click(main, `document.querySelector('button[aria-label="Dock floating panel"]')`);
      assert.equal(await bufferIntact(), true);
      assert.equal(await run('__app.popouts.open(__np)'), true); await until(() => !!popup(), 'editor popup');
      await setViewport(popup(), expression => runIn(popup(), expression), width, height);
      await until(() => controlsReachable(popup()), 'editor popup controls reachable');
      await click(popup(), `document.querySelector('button[aria-label="Dock back to KonX"]')`);
      await until(() => !popup(), 'editor docks');
      assert.equal(await run('__np.current.model===__model&&__model.getValue()==="Retained unsaved text at every scale"&&__np.el.ownerDocument===document'), true);
      assert.equal(await run('__t.term===__originalTerminal&&__t.state==="connected"'), true);
      report.viewports.push({ requested: { width, height }, actual: dimensions, devicePixelRatio: await run('devicePixelRatio'), recoveredNativeWindow: true });
    }
    assert.equal(connections, 1); assert.equal(closes, 0);
    fs.writeFileSync(path.join(root, `dpi-${scale * 100}-evidence.json`), JSON.stringify(report, null, 2));
    await run('__app.closeTab(__t)'); await until(() => closes === 1, 'owned connection cleanup');
    console.log('WORKSPACE_DPI_PASS ' + scale); await finish(0);
  }
  require('../src/main/main');
}

module.exports = { runWorkspaceDpiUiTests };
if (process.argv.includes('--workspace-dpi-fixture')) fixture().catch(error => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) {
  let failed = 0;
  runWorkspaceDpiUiTests(async (name, run) => { try { await run(); console.log('PASS ' + name); } catch (error) { failed++; console.error(error.stack || error); } })
    .then(() => { process.exitCode = failed ? 1 : 0; }).catch(error => { console.error(error); process.exitCode = 1; });
}
