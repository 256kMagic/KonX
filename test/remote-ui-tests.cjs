'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const { setViewport } = require(path.join(repo, 'test/lib/electron-viewport.cjs'));
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) { const end = Date.now() + timeout; while (!(await check())) { if (Date.now() >= end) throw new Error('Timed out: ' + label); await pause(); } }

async function runRemoteUiTests(test) {
  await test('Remote capture real Electron and local SSH workflow, retained file, partial stop, borrowed terminal and close safeguards', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-remote-ui-'));
    let child, output = '';
    try {
      child = spawn(require('electron'), [__filename, '--remote-ui-fixture'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_REMOTE_UI_ROOT: root, KONX_CAPTURE: '', KONX_DEMO: '' } });
      const collect = (data) => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Remote UI fixture timed out\n' + output)); }, 90000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); }); child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
      });
      assert.equal(code, 0, output); assert.match(output, /REMOTE_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) child.kill();
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-remote-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
async function fixture() {
  const { app, BrowserWindow, dialog } = require('electron');
  const { startRemoteSshFixture } = require('./lib/remote-fixture.cjs');
  const normal = await startRemoteSshFixture(), slow = await startRemoteSshFixture({ slow: true });
  const root = path.resolve(process.env.KONX_REMOTE_UI_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-remote-ui-'));
  const exportPath = path.join(root, 'collection-report.json'); let finished = false;
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
  dialog.showOpenDialog = async () => { throw new Error('Remote fixture must use owned capture IDs'); };
  dialog.showErrorBox = (title, message) => { throw new Error(title + ': ' + message); };
  const finish = async (code, error) => { if (finished) return; finished = true; if (error) console.error(error.stack || error); await Promise.allSettled([normal.close(), slow.close()]); for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code); };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.once('did-finish-load', async () => {
      const run = (code) => win.webContents.executeJavaScript(code);
      const click = async (expression) => {
        let point;
        await until(async () => {
          point = await run(`(() => {const el=${expression};if(!el)return {ready:false};el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return {x,y,ready:!el.disabled&&r.width>0&&r.height>0&&(hit===el||el.contains(hit)),debug:{rect:[r.left,r.top,r.width,r.height],hit:hit?.tagName,hitClass:hit?.className}};})()`);
          return point.ready;
        }, 'clickable ' + expression).catch((error) => { throw new Error(error.message + ' ' + JSON.stringify(point)); });
        delete point.ready; delete point.debug;
        win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(30);
      };
      const connect = async (connection, key) => {
        await run(`window.${key}=window.__app.openTerminal(${JSON.stringify({ ...connection, protocol: 'ssh', auth: 'password' })},{name:${JSON.stringify(connection.name)},protocol:'ssh'});true;`);
        await until(() => run('Boolean(document.querySelector(".modal"))'), 'local fixture host-key prompt');
        await click('[...document.querySelectorAll(".modal footer button")].find(button=>button.textContent==="Accept once")');
        await until(() => run(`window.${key}.state==="connected"`), 'local SSH terminal connected');
      };
      try {
        await until(() => run('Boolean(window.__app)'), 'app');
        await run(`(async()=>{window.__remote=window.__app.openTool('remote-capture');await window.__remote.ready;window.__updateBlockers=(await import('./js/updates.js')).updateBlockers;return true;})()`);
        assert.equal(await run('window.__remote.connections.length'), 0); assert.equal(await run('window.__remote.startButton.disabled'), true);
        assert.equal(normal.commands.length + slow.commands.length, 0);
        await connect(normal.connection, '__terminal');
        await run('window.__app.activate(window.__remote);window.__remote.refreshConnections(window.__terminal.id).then(()=>true)');
        assert.equal(await run('window.__remote.startButton.disabled'), false);
        assert.equal(normal.commands.length, 0, 'Refreshing sessions must not execute capture commands');
        await run('window.__remote.duration.value="301";window.__remote.start().then(()=>true)'); assert.equal(normal.commands.length, 0, 'Invalid limits must fail before remote execution');
        await run('window.__remote.duration.value="30";window.__remote.filter.value="udp";true;');
        await click('window.__remote.startButton');
        await until(() => run('!window.__remote.jobId&&Boolean(window.__remote.report)'), 'complete remote capture');
        assert.equal(normal.commands.length, 1); assert.match(normal.commands[0], /tcpdump/);
        assert.equal(await run('window.__remote.report.packets'), 2); assert.equal(await run('window.__remote.report.complete'), true);
        assert.equal(await run('window.__remote.progress.textContent'), '', 'Completion clears stale in-progress packet counts');
        assert.equal(await run('Object.hasOwn(window.__remote.report,"file")'), false, 'Privileged absolute file paths must not cross the renderer boundary');
        assert.ok(await run('Boolean(window.__remote.report.captureId)'));
        await click('window.__remote.openButton'); await until(() => run('window.__app.active.kind==="capture"&&window.__app.active.packets.length===2'), 'retained PCAP opened');
        await until(() => run('!window.__remote.busy'), 'file load finished'); await run('window.__app.closeTab(window.__app.active).then(()=>true)'); await run('window.__app.activate(window.__remote);true;');
        await click('window.__remote.exportButton'); await until(() => fs.existsSync(exportPath), 'collection report export');
        assert.equal(JSON.parse(fs.readFileSync(exportPath, 'utf8')).kind, 'remote-capture');
        await run('window.__terminal.sendText("terminal still alive after capture\\r");true;');
        await until(() => run('(()=>{const buffer=window.__terminal.term.buffer.active;return Array.from({length:buffer.length},(_,index)=>buffer.getLine(index)?.translateToString()).join(" ").includes("terminal still alive after capture");})()'), 'borrowed terminal echo');
        assert.equal(await run('window.__terminal.state'), 'connected');
        for (const [width, height] of [[1400, 880], [900, 560]]) {
          await setViewport(win, run, width, height); await run('window.__remote.content.scrollTop=0;true;'); await pause(50);
          const geometry = await run('(()=>{const r=window.__remote.content.getBoundingClientRect();return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bottom:r.bottom,contentHeight:r.height};})()');
          assert.ok(geometry.documentWidth<=geometry.width+2&&geometry.bottom<=geometry.height+2&&geometry.contentHeight>90, JSON.stringify(geometry));
          if (process.env.KONX_REMOTE_SCREENSHOTS === '1') {
            const target = path.join(repo, 'review/release-0.11.0'); fs.mkdirSync(target, { recursive: true }); assert.ok(fs.realpathSync(target).startsWith(fs.realpathSync(path.join(repo, 'review')) + path.sep));
            fs.writeFileSync(path.join(target, `remote-${width}x${height}-${Date.now()}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG(), { flag: 'wx' });
          }
        }
        await click('window.__remote.deleteButton'); await until(() => run('Boolean(document.querySelector(".modal"))'), 'delete retained capture prompt');
        await click('document.querySelector(".modal footer button:not(.danger)")'); assert.equal(await run('Boolean(window.__remote.report.captureUnavailable)'), false);
        await click('window.__remote.deleteButton'); await until(() => run('Boolean(document.querySelector(".modal"))'), 'confirm deletion prompt');
        await click('document.querySelector(".modal footer .danger")'); await until(() => run('!window.__remote.busy&&window.__remote.report.captureUnavailable'), 'retained capture deleted');
        assert.equal(await run('window.__remote.openButton.disabled'), true); assert.equal(await run('window.__remote.report.packets'), 2, 'Removing bytes keeps collection metadata');
        await connect(slow.connection, '__slowTerminal');
        await run('window.__app.activate(window.__remote);window.__remote.refreshConnections(window.__slowTerminal.id).then(()=>true)');
        await click('window.__remote.startButton'); await until(() => slow.commands.length === 1 && run('Boolean(window.__remote.jobId)'), 'slow collection started');
        assert.ok(await run('window.__updateBlockers(window.__app).some(reason=>reason.includes("remote capture"))'));
        await run('window.__app.closeTab(window.__remote).then(()=>true)');
        assert.equal(await run('window.__app.byId.has(window.__remote.id)'), true, 'Closing while collecting requests Stop and retains tab through cleanup');
        await until(() => run('!window.__remote.jobId&&window.__remote.report.stopped'), 'partial capture cleanup');
        assert.equal(await run('window.__remote.report.packets'), 1); assert.equal(await run('window.__remote.report.complete'), false); assert.ok(slow.signals.includes('INT'));
        assert.equal(await run('window.__slowTerminal.state'), 'connected');
        await click('window.__remote.openButton'); await until(() => run('window.__app.active.kind==="capture"&&window.__app.active.packets.length===1'), 'partial complete packet prefix opens');
        assert.equal(await run('window.__app.jobs.size'), 0);
        console.log('REMOTE_UI_PASS: real loopback SSH terminal and exec channel, explicit selection/start, bounded parameters, complete and partial PCAP import, owned capture-ID reads/deletion, report export, terminal survives, close/updater cancellation safeguards and responsive layout. Synthetic SSH peer only; no real Linux tcpdump or network device verified.'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require(path.join(repo, 'src/main/main'));
}
module.exports = { runRemoteUiTests };
if (process.versions.electron && process.argv.includes('--remote-ui-fixture')) fixture().catch((error) => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runRemoteUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch((error) => { console.error(error); process.exitCode = 1; });
