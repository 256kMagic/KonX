'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const { setViewport } = require(path.join(repo, 'test/lib/electron-viewport.cjs'));
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) { const end = Date.now() + timeout; while (!(await check())) { if (Date.now() >= end) throw new Error('Timed out: ' + label); await pause(); } }

async function runComparisonUiTests(test) {
  await test('Capture comparison real Electron imports/demo, immutable source navigation, explicit pairing, unknown timestamps and bounded responsive UI', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-compare-ui-'));
    let child, output = '';
    try {
      child = spawn(require('electron'), [__filename, '--compare-ui-fixture'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_COMPARE_UI_ROOT: root, KONX_CAPTURE: '', KONX_DEMO: '' } });
      const collect = data => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Comparison UI fixture timed out\n' + output)); }, 90000);
        child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', value => { clearTimeout(timer); resolve(value); });
      });
      assert.equal(code, 0, output); assert.match(output, /COMPARE_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) child.kill();
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-compare-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
async function fixture() {
  const { app, BrowserWindow, dialog } = require('electron');
  const root = path.resolve(process.env.KONX_COMPARE_UI_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-compare-ui-'));
  const { createComparisonDemo } = await import(pathToFileURL(path.join(repo, 'src/renderer/js/capture/sample-compare.mjs')).href);
  const demo = createComparisonDemo(), imports = [], exported = path.join(root, 'comparison.json'); let finished = false;
  for (const side of ['before', 'after']) { const file = path.join(root, demo[side].name); fs.writeFileSync(file, demo[side].bytes); imports.push(file); }
  dialog.showOpenDialog = async () => { const filePath = imports.shift(); if (!filePath) throw new Error('Unexpected comparison file prompt'); return { canceled: false, filePaths: [filePath] }; };
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: exported });
  dialog.showErrorBox = (title, message) => { throw new Error(title + ': ' + message); };
  const finish = async (code, error) => { if (finished) return; finished = true; if (error) console.error(error.stack || error); for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code); };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.once('did-finish-load', async () => {
      const run = code => win.webContents.executeJavaScript(code);
      const click = async expression => {
        let point;
        await until(async () => {
          point = await run(`(() => {const el=${expression};if(!el)return {ready:false};el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return {x,y,ready:!el.disabled&&r.width>0&&r.height>0&&(hit===el||el.contains(hit)),debug:{rect:[r.left,r.top,r.width,r.height],hit:hit?.tagName}};})()`);
          return point.ready;
        }, 'clickable ' + expression).catch(error => { throw new Error(error.message + ' ' + JSON.stringify(point)); });
        delete point.ready; delete point.debug;
        win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(30);
      };
      const ready = () => until(() => run('!window.__compare.busy'), 'comparison idle');
      try {
        await until(() => run('Boolean(window.__app)'), 'app');
        await run(`(async()=>{window.__compare=window.__app.openTool('capture-compare');await window.__compare.ready;window.__updateBlockers=(await import('./js/updates.js')).updateBlockers;return true;})()`);
        assert.equal(await run('window.__compare.compareButton.disabled'), true); assert.equal(await run('window.__app.jobs.size'), 0);
        await click('window.__compare.sourceControls.before.file'); await ready();
        assert.equal(await run('window.__compare.sources.before.packets.length'), 11);
        await click('window.__compare.sourceControls.after.file'); await ready(); await click('window.__compare.compareButton'); await ready();
        assert.equal(await run('window.__compare.report.summary.matchedServices'), 2); assert.ok(await run('window.__compare.report.summary.changed>0'));
        assert.equal(await run('window.__compare.report.before.coverage.sourceRecordsComplete'), true);
        const context = await run('(async()=>{const {toolContext}=await import("./js/tool-context.mjs");return toolContext(window.__compare);})()');
        assert.match(context, /matchedServices/); assert.ok(!context.includes('app.example.test'), 'AI context retains counts and coverage without application observations');
        await click('[...window.__compare.table.tbody.querySelectorAll("tr")].find(row=>row.textContent.includes("observed status codes"))');
        await run('window.__metric=window.__compare.selectedChange;true;');
        assert.equal(await run('window.__metric.category'), 'http');
        const expectedAfterFrame = await run('window.__metric.afterSources[0].frame');
        await click('window.__compare.detail.querySelectorAll(".compare-evidence")[1].querySelector("button")');
        await until(() => run('window.__app.active.kind==="capture"'), 'after source tab'); await ready();
        assert.equal(await run('window.__app.active.selected'), expectedAfterFrame - 1); assert.match(await run('window.__app.active.title'), /^after:/);
        assert.equal(await run('window.__app.active.packets.length'), 11);
        await run('window.__app.closeTab(window.__app.active).then(()=>true)'); await run('window.__app.activate(window.__compare);true;');
        await click('window.__compare.exportButton'); await ready();
        const report = JSON.parse(fs.readFileSync(exported, 'utf8')); assert.equal(report.kind, 'capture-comparison'); assert.equal(report.before.services.length, 2);
        assert.ok(!fs.readFileSync(exported, 'utf8').includes('GET /status HTTP/'), 'Report exports observations, never raw packet bodies');
        for (const [width, height] of [[1400, 880], [900, 560]]) {
          await setViewport(win, run, width, height); await run('window.__compare.content.scrollTop=0;true;'); await pause(50);
          const geometry = await run('(()=>{const r=window.__compare.content.getBoundingClientRect();return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bottom:r.bottom,contentHeight:r.height};})()');
          assert.ok(geometry.documentWidth<=geometry.width+2&&geometry.bottom<=geometry.height+2&&geometry.contentHeight>100, JSON.stringify(geometry));
          if (process.env.KONX_COMPARE_SCREENSHOTS === '1') {
            const target = path.join(repo, 'review/release-0.13.0'); fs.mkdirSync(target, { recursive: true }); assert.ok(fs.realpathSync(target).startsWith(fs.realpathSync(path.join(repo, 'review')) + path.sep));
            fs.writeFileSync(path.join(target, `compare-${width}x${height}-${Date.now()}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG(), { flag: 'wx' });
          }
        }
        // Use the actual source chooser, then mutate and close its original tab.
        await run(`(async()=>{const {createComparisonDemo}=await import('./js/capture/sample-compare.mjs');window.__original=window.__app.openTool('capture');await window.__original.loadBytes(createComparisonDemo().before.bytes,'<img src=x onerror=window.__xss=1>');window.__app.activate(window.__compare);return true;})()`);
        await run('window.__compare.sourcePanel.open=true;true;');
        await click('window.__compare.sourceControls.before.existing'); await until(() => run('Boolean(document.querySelector(".modal"))'), 'source chooser');
        await click('document.querySelector(".modal footer .primary")'); assert.equal(await run('Boolean(document.querySelector(".modal"))'), true, 'Source selection is explicit');
        await run('document.querySelector(".modal select").value=window.__original.id;true;'); await click('document.querySelector(".modal footer .primary")');
        await until(() => run('!document.querySelector(".modal")'), 'source retained');
        await run('window.__original.packets[0].data.fill(0);window.__original.clear(false);window.__app.closeTab(window.__original).then(()=>true)');
        assert.notEqual(await run('window.__compare.sources.before.packets[0].data[12]'), 0);
        assert.equal(await run('window.__xss'), undefined); assert.equal(await run('window.__compare.el.querySelectorAll("img").length'), 0);
        await click('window.__compare.compareButton'); await ready(); assert.equal(await run('window.__compare.report.summary.matchedServices'), 2);
        // Different client address: no automatic guess; explicit one-to-one pairs restore matching.
        await run(`(()=>{const source=window.__compare.sources.after;const changed=source.packets.map(packet=>({...packet,data:new Uint8Array(packet.data)}));for(const packet of changed){for(const offset of [26,30]){const data=packet.data;if(data[offset]===192&&data[offset+1]===0&&data[offset+2]===2&&data[offset+3]===10)data[offset+3]=11;}}window.__compare.acceptSource('after',window.__compare.sourceFromPackets(changed,'changed-address.pcapng',source.coverage));return true;})()`);
        await click('window.__compare.compareButton'); await ready(); assert.equal(await run('window.__compare.report.summary.matchedServices'), 0);
        await run('window.__compare.pairDetails.open=true;window.__compare.pairBefore.value=window.__compare.report.before.services.find(service=>service.identity.transport==="TCP").id;window.__compare.pairAfter.value=window.__compare.report.after.services.find(service=>service.identity.transport==="TCP").id;true;');
        await click('window.__compare.pairButton'); await ready(); assert.equal(await run('window.__compare.report.summary.matchedServices'), 1);
        assert.ok(await run('window.__compare.report.services.some(service=>service.warnings.some(value=>value.includes("caller choice")))'));
        // Reader uncertainty remains unknown; original non-sequential frame numbers navigate by retained index.
        await click('window.__compare.demoButton'); await ready();
        await run(`(()=>{const source=window.__compare.sources.before;const packets=source.packets.map((packet,index)=>({...packet,no:index+101,timestampKnown:false}));window.__compare.acceptSource('before',window.__compare.sourceFromPackets(packets,'unknown-times.pcapng',{...source.coverage,examinedAllRecords:false,truncated:true}));return true;})()`);
        await click('window.__compare.compareButton'); await ready();
        assert.ok(await run('window.__compare.report.summary.unknown>0')); assert.equal(await run('window.__compare.report.before.coverage.missingTimestamps'), 11);
        await run('window.__compare.openSource("before",106).then(()=>true)');
        assert.equal(await run('window.__app.active.selected'), 5); assert.equal(await run('window.__app.active.packets[5].timestampKnown'), false);
        assert.equal(await run('window.__app.active.captureCoverage.truncated'), true);
        await run('window.__app.closeTab(window.__app.active).then(()=>true)'); await run('window.__app.activate(window.__compare);true;');
        assert.equal(await run('(()=>{const tiny={data:new Uint8Array([0]),ts:0};const source=window.__compare.sourceFromPackets(Array(50001).fill(tiny),"bounded");return source.packets.length===50000&&source.omitted===1&&source.coverage.limited&&source.coverage.examinedAllRecords===false;})()'), true);
        assert.equal(await run('window.__updateBlockers(window.__app).length'), 0); assert.equal(await run('window.__app.jobs.size'), 0);
        console.log('COMPARE_UI_PASS: real native-file IPC, offline demo, changed/unknown observations, explicit identity mapping, source snapshot survives reset/close, correct side/frame navigation, unknown timestamps, bounded copies, report export and responsive layout. Synthetic captures only; no network probes.'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require(path.join(repo, 'src/main/main'));
}
module.exports = { runComparisonUiTests };
if (process.versions.electron && process.argv.includes('--compare-ui-fixture')) fixture().catch(error => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runComparisonUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
