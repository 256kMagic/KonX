'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
let REPO = __dirname;
while (!fs.existsSync(path.join(REPO, 'src/main/main.js'))) { const parent = path.dirname(REPO); if (parent === REPO) throw new Error('KonX source checkout required'); REPO = parent; }
const MAIN = path.join(REPO, 'src/main');
const UI = path.join(REPO, 'src/renderer');
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 12000) { const stop = Date.now() + timeout; while (!await check()) { if (Date.now() >= stop) throw new Error('Timed out: ' + label); await pause(); } }

async function runCopilotUiTests(test) {
  await test('Copilot real Electron UI with canonical workspace ownership, actual store/prepare/provider transport, explicit evidence and guarded drafts', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'konx-copilot-ui-')); let child, output = '';
    try {
      const env = { ...process.env, KONX_COPILOT_UI_ROOT: temp }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require(path.join(REPO, 'node_modules/electron')), [__filename, '--copilot-ui-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = value => { output = (output + value).slice(-1024 * 1024); }; child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Copilot UI timeout\n' + output)); }, 70000);
        child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', value => { clearTimeout(timer); resolve(value); });
      });
      if (code !== 0) {
        const evidence = path.join(REPO, 'review/copilot-ui'); fs.mkdirSync(evidence, { recursive: true });
        fs.writeFileSync(path.join(evidence, 'last-failure.log'), output);
        assert.fail('Copilot UI fixture failed: ' + output.trim().split(/\r?\n/).slice(-8).join('\n'));
      }
      assert.match(output, /COPILOT_UI_PASS/);
    } finally {
      if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
      assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); assert.match(path.basename(temp), /^konx-copilot-ui-/);
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
  const temp = path.resolve(process.env.KONX_COPILOT_UI_ROOT || '');
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); assert.match(path.basename(temp), /^konx-copilot-ui-/);
  app.setPath('userData', path.join(temp, 'profile'));
  let done = false, service, win; const jobs = new Map(), requests = [], waiting = new Set(); let hold = false, fail = false, forcedDiscardFailure = false;
  const finish = async (code, error) => {
    if (done) return; done = true; if (error) console.error(error.stack || error);
    for (const { signal } of jobs.values()) { signal.stopped = true; signal.onStop?.(); }
    await Promise.allSettled([...jobs.values()].map(job => job.task));
    try { await service?.close(); } catch (cleanup) { console.error(cleanup); code = 1; }
    for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.exit(code);
  };
  process.on('uncaughtException', error => void finish(1, error)); process.on('unhandledRejection', error => void finish(1, error));
  dialog.showErrorBox = (title, body) => { throw new Error(`${title}: ${body}`); };
  await app.whenReady();
  fs.mkdirSync(path.join(temp, 'profile'), { recursive: true }); fs.mkdirSync(path.join(temp, 'js'));
  for (const file of ['ui.js', 'workspace-layout.js', 'workspace-layouts.mjs', 'workspace-panels-model.mjs']) fs.copyFileSync(path.join(REPO, 'src/renderer/js', file), path.join(temp, 'js', file));
  fs.copyFileSync(path.join(UI, 'js/copilot.js'), path.join(temp, 'js/copilot.js'));
  for (const file of ['styles.css', 'workspace-layout.css', 'workspace-popouts.css']) fs.copyFileSync(path.join(REPO, 'src/renderer', file), path.join(temp, file));
  fs.copyFileSync(path.join(UI, 'copilot.css'), path.join(temp, 'copilot.css'));
  fs.writeFileSync(path.join(temp, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{invoke:(...args)=>ipcRenderer.invoke(...args),on:(name,cb)=>{const listener=(_e,...args)=>cb(...args);ipcRenderer.on(name,listener);return()=>ipcRenderer.removeListener(name,listener);}});`);
  const css = '<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="workspace-layout.css"><link rel="stylesheet" href="workspace-popouts.css"><link rel="stylesheet" href="copilot.css">';
  fs.writeFileSync(path.join(temp, 'child.html'), `<!doctype html><html><head>${css}</head><body style="margin:0;height:100vh"><main id="child-host" style="height:100%;display:flex"></main></body></html>`);
  fs.writeFileSync(path.join(temp, 'index.html'), `<!doctype html><html><head>${css}<style>#app{display:flex;height:100vh;flex-direction:column}#main{display:flex;flex:1;min-height:0;flex-direction:column}#views{flex:1;min-height:0;position:relative}#toolbar{height:42px;display:flex}.fixture-source{padding:20px}#child-host>.copilot-view{height:100%;width:100%}</style></head><body><script type="module" src="js/fixture.js"></script></body></html>`);
  fs.writeFileSync(path.join(temp, 'js/fixture.js'), `
import {h,api,registerUiWindow,returnUiToMain} from './ui.js';
import {WorkspaceLayout} from './workspace-layout.js'; import {CopilotController} from './copilot.js';
const app={tabs:[],byId:new Map(),jobs:new Map(),settings:{uiLayout:'workbench'},root:h('div#app'),toolbar:h('div#toolbar'),themeHeader:h('div'),main:h('main#main'),tabstrip:h('div#tabstrip'),views:h('div#views'),active:null,
scheduleTabLayout(){},updateStatus(tab){window.__statusTab=tab.id;},renderTabs(){},toggleSidebar(){},saveSettings:async()=>{},openTool(kind){window.__openedSettings=kind;},
registerJob(id,owner){this.jobs.set(id,owner);},unregisterJob(id){this.jobs.delete(id);},
activate(tab,{focus=false}={}){this.active=tab;this.workspaceLayout.activate(tab);this.updateStatus(tab);if(focus)tab.focus?.();},
addTab(tab){this.tabs.push(tab);this.byId.set(tab.id,tab);this.workspaceLayout.mount(tab);return tab;},
async closeTab(tab){if(!await tab.requestClose())return;this.workspaceLayout.detach(tab);this.tabs=this.tabs.filter(t=>t!==tab);this.byId.delete(tab.id);tab.el.remove();tab.dispose();this.activate(source);}};
app.toolbar.append(app.themeHeader);app.main.append(app.tabstrip,app.views);app.root.append(app.toolbar,app.main);document.body.append(app.root,h('div#toasts'));
app.workspaceLayout=new WorkspaceLayout(app);
const source={id:'fixture-source',kind:'tool',toolKind:'dns',title:'DNS fixture',state:'idle',copilot:{revision:1,runId:'fixture-run'},el:h('div.view.fixture-source','Owned DNS result stays here'),show(){},hide(){},focus(){},refit(){},statusSegments(){return[{text:'DNS fixture'}];}};
app.addTab(source);app.activate(source);const controller=new CopilotController(app);app.copilot=controller;
api.on('tools:event',(id,type,data)=>app.jobs.get(id)?.onJobEvent(type,data));
window.__app=app;window.__source=source;window.__c=controller;window.__p=controller.panel;
window.__open=async()=>{const panel=await controller.open({sourceTab:source});if(!app.tabs.includes(panel))app.addTab(panel);app.workspaceLayout.dock(panel,'companion');app.activate(source);return panel.id;};
window.__pop=()=>{window.__child=window.open('child.html','copilot-ui-child','width=580,height=650');};
window.__attachChild=()=>{window.__unregisterChild=registerUiWindow(window.__child);app.workspaceLayout.attachExternal(controller.panel,{body:window.__child.document.getElementById('child-host'),window:window.__child});controller.panel.onHostWindowChanged(window.__child,window);};
window.__dock=()=>{returnUiToMain(window.__child);window.__unregisterChild?.();app.workspaceLayout.releaseExternal(controller.panel);app.workspaceLayout.dock(controller.panel,'companion');window.__child.close();window.__child=null;};
await window.__open();window.__ready=true;`);
  const { AIClient } = require(path.join(MAIN, 'ai'));
  const { CopilotStore } = require(path.join(MAIN, 'copilot-store'));
  const { CopilotService } = require(path.join(MAIN, 'copilot'));
  const { registerCopilot } = require(path.join(MAIN, 'copilot-ipc'));
  const key = 'SyntheticOnlyCopilotUiKey_0123456789';
  const transport = (_options, response) => {
    const req = new EventEmitter(); let destroyed = false;
    req.setTimeout = () => req; req.destroy = () => { if (destroyed) return; destroyed = true; waiting.delete(req); };
    req.end = body => { requests.push(body); if (hold) { waiting.add(req); return; }
      queueMicrotask(() => { if (destroyed) return; const res = new EventEmitter(); res.headers = {}; res.statusCode = fail ? 503 : 200; fail = false; res.destroy = () => {}; response(res);
        res.emit('data', Buffer.from(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '<img src=x onerror="window.__unsafe=true">\nObserved fixture result. ' + key }] }], usage: { input_tokens: 123, output_tokens: 17, total_tokens: 140 } }))); res.emit('end'); }); };
    return req;
  };
  const ai = new AIClient({ dir: path.join(temp, 'profile'), crypt: { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value).toString('base64'), decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64')) }, request: transport, knowledge: { search: async () => [] } });
  ai.configure({ provider: 'openai', key }); service = new CopilotService({ store: new CopilotStore(path.join(temp, 'profile')), ai });
  const handle = (name, fn) => ipcMain.handle(name, async (event, ...args) => {
    assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame);
    if (name === 'tools:copilotDiscardPrepared' && forcedDiscardFailure) throw new Error('Synthetic cleanup failure'); return fn(...args);
  });
  registerCopilot(handle, { copilot: service, isClosing: () => false });
  handle('settings:set', () => ({}));
  handle('tools:start', (kind, params, id) => {
    assert.equal(kind, 'copilot'); assert.equal(jobs.has(id), false);
    const signal = { stopped: false }, emit = (type, data) => win.webContents.send('tools:event', id, type, data);
    const task = Promise.resolve().then(() => service.run(params, emit, signal)).then(() => emit('done', { stopped: signal.stopped }), error => emit('error', { message: error.message })).finally(() => jobs.delete(id));
    jobs.set(id, { signal, task }); return id;
  });
  handle('tools:stop', id => { const job = jobs.get(id); if (job) { job.signal.stopped = true; job.signal.onStop?.(); } });
  win = new BrowserWindow({ width: 1280, height: 860, show: false, focusable: false, skipTaskbar: true, webPreferences: { preload: path.join(temp, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, focusable: false, skipTaskbar: true, webPreferences: { contextIsolation: true, nodeIntegration: false } } }));
  await win.loadFile(path.join(temp, 'index.html'));
  const run = code => win.webContents.executeJavaScript(code);
  const click = async (expression, target = win) => {
    let point; await until(async () => { point = await run(`(()=>{const e=${expression};if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),d=e.ownerDocument,x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);return r.width&&r.height&&(d.elementFromPoint(x,y)===e||e.contains(d.elementFromPoint(x,y)))?{x,y}:null;})()`); return point; }, 'reachable ' + expression);
    target.webContents.sendInputEvent({ type: 'mouseMove', ...point }); target.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); target.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(30);
  };
  const input = (expression, value) => run(`${expression}.value=${JSON.stringify(value)};${expression}.dispatchEvent(new Event('input',{bubbles:true}));void 0;`);
  const choice = async label => { const expression = `Array.from(document.querySelectorAll('.modal footer button')).find(e=>e.textContent===${JSON.stringify(label)})`; await until(() => run(`Boolean(${expression})`), label); await click(expression); };
  const idle = () => until(() => run('!__c.busy&&!__c.jobId&&!__c.prompting'), 'Copilot idle');
  try {
    await until(() => run('Boolean(window.__ready)'), 'Copilot module ready');
    assert.equal(requests.length, 0); assert.equal((await service.list()).conversations.length, 0); assert.deepEqual(await run('__c.updateBlockers()'), []);
    await click('__p.newButton'); await input('document.querySelector(".modal input")', 'Fixture conversation'); await choice('Save name'); await idle();
    const id = await run('__c.conversation.id'); assert.equal((await service.get(id)).name, 'Fixture conversation');
    await click('__p.connectionDetails.querySelector("summary")');
    await run('__p.transportSelect.value="buffered";__p.transportSelect.dispatchEvent(new Event("change",{bubbles:true}));void 0;');
    const snapshot = { schemaVersion: 1, kind: 'dns', title: 'Synthetic DNS observation', capturedAt: new Date().toISOString(), source: { tabId: 'fixture-source', runId: 'fixture-run', revision: 1 }, state: 'complete', scope: { name: 'example.invalid', recordType: 'A' }, selection: { mode: 'all', ids: [] }, facts: { addresses: ['192.0.2.42'], note: key }, coverage: { observed: 1, total: 1, complete: true }, omissions: ['Synthetic fixture; no live lookup occurred.'] };
    await run('__app.activate(__source,{focus:false});void 0;');
    await run(`__c.attach(${JSON.stringify(snapshot)})`); await idle(); assert.equal(requests.length, 0);
    assert.equal(await run('window.__statusTab'), 'fixture-source', 'background Copilot changes preserve the focused source footer');
    assert.equal((await service.get(id)).attachments.length, 1); assert.equal((await run('__p.evidence.textContent')).includes(key), false);
    await input('__p.question', 'Explain this DNS evidence'); await click('__p.prepareButton'); await idle();
    const first = await run('__c.prepared'); assert.equal(await run('__p.requestBody.textContent'), first.body); assert.equal(requests.length, 0); assert.ok(first.body.includes('192.0.2.42'));
    await run('__source.copilot.revision++;__c.sourceChanged(__source);void 0;'); assert.equal(await run('__c.prepared.digest'), first.digest); assert.match(await run('__p.evidence.textContent'), /source view has changed/);
    await click('__p.sendButton'); await idle(); assert.equal(requests.length, 1); assert.equal(requests[0], first.body);
    assert.equal(await run('Boolean(window.__unsafe)'), false); assert.equal(await run('__p.turns.querySelector("img")'), null);
    assert.equal(await run('__p.turns.textContent.includes("SyntheticOnlyCopilotUiKey")'), false); assert.match(await run('__p.turns.textContent'), /Input tokens: 123/);
    assert.equal(await run('__c.hasUnsavedInput()'), false); assert.equal((await service.get(id)).turns.length, 1);
    await input('__p.question', 'Follow up using the previous reply'); await click('__p.prepareButton'); await idle();
    const second = await run('__c.prepared'); assert.equal(second.historyTurnIds.length, 1); assert.ok(second.body.includes('Observed fixture result'));
    await run('__p.transportSelect.value="stream";__p.transportSelect.dispatchEvent(new Event("change",{bubbles:true}));void 0;');
    assert.equal(await run('__c.prepared'), null, 'transport selection invalidates reviewed body');
    await run('__p.transportSelect.value="buffered";__p.transportSelect.dispatchEvent(new Event("change",{bubbles:true}));void 0;');
    await click('__p.prepareButton'); await idle();
    await input('__p.question', 'Edited follow up'); await until(() => service.preparations.size === 0, 'invalidated review discarded'); assert.equal(await run('__c.prepared'), null);
    assert.equal(requests.length, 1); assert.equal(await run('__p.sendButton.disabled'), true);
    await click('__p.prepareButton'); await idle(); ai.configure({ provider: 'openai', model: 'fixture-changed-model' });
    await click('__p.sendButton'); await idle(); assert.equal(requests.length, 1); assert.equal(await run('__c.prepared'), null); assert.match(await run('__c.message'), /connection changed/);
    await click('__p.prepareButton'); await idle(); forcedDiscardFailure = true; await click('__p.discardButton');
    await until(() => run('Boolean(__c.cleanupError)'), 'retained cleanup failure'); assert.match((await run('__c.updateBlockers()')).join(' '), /Retry discarding/);
    forcedDiscardFailure = false; await click('__p.cleanupButton'); await until(() => run('!__c.cleanupError'), 'cleanup retry'); assert.equal(service.preparations.size, 0);
    await run('window.__closing=__app.closeTab(__p);void 0;'); await choice('Keep draft'); await run('__closing'); assert.equal(await run('__app.tabs.includes(__p)'), true); assert.equal(await run('__c.question'), 'Edited follow up');
    await run('__p.connectionDetails.open=false;void 0;');

    // Use the production workspace owner for every layout and native DOM adoption.
    const { setViewport } = require(path.join(REPO, 'test/lib/electron-viewport.cjs'));
    const shots = path.join(REPO, 'review/copilot-ui'); fs.mkdirSync(shots, { recursive: true });
    for (const layout of ['workbench', 'classic', 'incident-desk', 'operations-wall', 'focus']) {
      for (const [width, height] of [[900, 560], [1400, 880]]) {
        await setViewport(win, run, width, height);
        await run(`__app.workspaceLayout.set(${JSON.stringify(layout)});${layout === 'workbench' ? '__app.workspaceLayout.dock(__p,"companion");__app.activate(__source);' : '__app.workspaceLayout.float(__p,{x:250,y:20,width:500,height:460});'}void 0;`); await pause(60);
        const rect = await run('(()=>{const e=__p.el,r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight,c:e.clientWidth,s:e.scrollWidth};})()');
        // Existing narrow Workbench stacks its panes inside a scrollable owner.
        // Require width containment and actual reachability after native scroll.
        assert.ok(rect.left >= -2 && rect.right <= rect.w + 2 && rect.s <= rect.c + 2, layout + JSON.stringify(rect));
        for (const control of ['question', 'prepareButton', 'conversationSelect', 'settingsButton']) {
          const reachable = await run(`(()=>{const e=__p.${control};e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+2&&r.top>=0&&r.bottom<=innerHeight+2;})()`);
          assert.equal(reachable, true, `${layout} ${width} ${control}`);
        }
        if (layout === 'workbench' && width === 1400 || layout === 'classic' && width === 900) { await run('__p.el.querySelector(".copilot-scroll").scrollTop=0;__p.el.scrollIntoView({block:"nearest"});void 0;'); fs.writeFileSync(path.join(shots, `copilot-${layout}-${width}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG()); }
      }
    }
    await run('__app.workspaceLayout.set("workbench");__app.workspaceLayout.dock(__p,"companion");window.__samePanel=__p;__pop();void 0;');
    await until(() => run('Boolean(__child?.document.getElementById("child-host"))'), 'native child document ready');
    await run('__attachChild();void 0;');
    await until(() => run('Boolean(__child?.document.querySelector(".copilot-view"))'), 'native child owns canonical panel');
    const child = BrowserWindow.getAllWindows().find(candidate => candidate !== win); assert.ok(child);
    assert.equal(await run('__p===__samePanel'), true); assert.equal(requests.length, 1);
    await click('__p.prepareButton', child); await idle(); const poppedReview = await run('__c.prepared'); await click('__p.sendButton', child); await idle(); assert.equal(requests.at(-1), poppedReview.body);
    await run('__dock();void 0;'); assert.equal(await run('__p===__samePanel && __p.el.ownerDocument===document'), true); assert.equal((await service.get(id)).turns.length, 2);
    fail = true; await input('__p.question', 'Preserve this failed request'); await click('__p.prepareButton'); await idle(); await click('__p.sendButton'); await idle();
    assert.equal((await service.get(id)).turns.at(-1).status, 'failed'); assert.equal(await run('__c.question'), 'Preserve this failed request'); assert.equal(await run('__c.hasUnsavedInput()'), true);
    // Hiding does not cancel; confirmed closing cancels and holds registration
    // until the real service persists the cancelled outcome and emits terminal.
    hold = true; await input('__p.question', 'Keep this cancelled draft'); await click('__p.prepareButton'); await idle(); await click('__p.sendButton');
    await until(() => waiting.size === 1, 'held provider'); await run('__p.hide();__p.show();void 0;'); assert.equal(waiting.size, 1);
    await run('window.__closing=__app.closeTab(__p);void 0;'); await choice('Keep open'); await run('__closing'); assert.equal(waiting.size, 1);
    await run('window.__closing=__app.closeTab(__p);void 0;'); await choice('Cancel request and close'); await run('__closing');
    await until(() => jobs.size === 0, 'cancelled outcome settled'); await until(() => run('__app.jobs.size===0'), 'renderer owner released');
    assert.equal((await service.get(id)).turns.at(-1).status, 'cancelled'); hold = false;
    await run('__open()'); assert.equal(await run('__p===__samePanel'), true); await idle();
    await click('__p.connectionDetails.querySelector("summary")');
    await click('__p.testButton'); await idle(); assert.equal(requests.length, 4); const testPreview = await run('__c.prepared'); assert.equal(testPreview.question, 'Reply with OK.'); assert.equal(testPreview.conversationId, null);
    await click('__p.sendButton'); await idle(); assert.equal(requests.at(-1), testPreview.body); assert.match(await run('__p.providerStatus.textContent'), /Last test: succeeded/);
    const beforeRestartRequests = requests.length; await win.reload(); await until(() => run('Boolean(window.__ready)'), 'fixture reload');
    await run(`__c.selectConversation(${JSON.stringify(id)})`); await idle(); assert.equal(await run('__c.conversation.turns.length'), 4); assert.equal(requests.length, beforeRestartRequests, 'restoring a saved conversation never resends');
    await click('__p.renameButton'); await input('document.querySelector(".modal input")', 'Renamed local discussion'); await choice('Save name'); await idle(); assert.equal((await service.get(id)).name, 'Renamed local discussion');
    await click('__p.deleteButton'); await choice('Cancel'); assert.equal((await service.list()).conversations.length, 1);
    await click('__p.deleteButton'); await choice('Delete conversation'); await idle(); assert.equal((await service.list()).conversations.length, 0);
    console.log('COPILOT_UI_PASS: real local store, exact reviewed body, synthetic provider, explicit attachments/history, dirty/stale/cleanup guards, five layouts, native popout/dock, cancellation and reload without resend');
    await finish(0);
  } catch (error) { await finish(1, error); }
}
module.exports = { runCopilotUiTests };
if (process.versions.electron && process.argv.includes('--copilot-ui-fixture')) fixture().catch(error => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) runCopilotUiTests(async (name, check) => { await check(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
