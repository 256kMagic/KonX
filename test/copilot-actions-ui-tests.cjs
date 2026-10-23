'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'src');
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 12000) { const end = Date.now() + ms; while (!await fn()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await pause(); } }

async function runCopilotActionsUiTests(test) {
  await test('Reviewed actions real Electron UI: exact effects, explicit admission, stale/cancel/replay protection and retained editor/note outcomes', async () => {
    const parent = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'konx-actions-ui-'));
    let child, output = '';
    try {
      const env = { ...process.env, KONX_ACTION_UI_ROOT: dir }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require(path.join(ROOT, 'node_modules/electron')), [__filename, '--action-ui-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = data => { output = (output + data).slice(-1024 * 1024); }; child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Action UI fixture timeout\n' + output)); }, 90000);
        child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
      assert.equal(code, 0, output); assert.match(output, /COPILOT_ACTION_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
      assert.equal(path.dirname(dir), parent); assert.ok(path.basename(dir).startsWith('konx-actions-ui-'));
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, ipcMain, dialog } = require('electron');
  const dir = path.resolve(process.env.KONX_ACTION_UI_ROOT || '');
  assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(dir).startsWith('konx-actions-ui-'));
  app.setPath('userData', path.join(dir, 'profile'));
  let win, service, actions, store, knowledge, finished = false, releaseCancelledDiagnostic, cancellationHeld = false;
  const jobs = new Map(), effects = [], calls = [], dispatched = [];
  const finish = async (code, error) => {
    if (finished) return; finished = true; if (error) console.error(error.stack || error);
    for (const { signal } of jobs.values()) { signal.stopped = true; signal.onStop?.(); }
    releaseCancelledDiagnostic?.();
    await Promise.allSettled([...jobs.values()].map(job => job.task));
    for (const owner of [actions, service, store, knowledge]) try { await owner?.close(); } catch (cleanup) { console.error(cleanup); code = 1; }
    if (win && !win.isDestroyed()) win.destroy(); app.exit(code);
  };
  process.on('uncaughtException', error => void finish(1, error)); process.on('unhandledRejection', error => void finish(1, error));
  dialog.showErrorBox = (title, body) => { throw new Error(title + ': ' + body); };
  try {
    await app.whenReady();
    fs.cpSync(path.join(ROOT, 'src/renderer'), path.join(dir, 'src/renderer'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src/main'), { recursive: true });
    for (const name of ['knowledge.js', 'knowledge-worker.js']) fs.copyFileSync(path.join(SOURCE, 'main', name), path.join(dir, 'src/main', name));
    fs.copyFileSync(path.join(ROOT, 'src/main/ai-redaction.js'), path.join(dir, 'src/main/ai-redaction.js'));
    fs.cpSync(path.join(ROOT, 'src/knowledge'), path.join(dir, 'src/knowledge'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'node_modules/monaco-editor/min/vs'), path.join(dir, 'node_modules/monaco-editor/min/vs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{platform:'win32',invoke:(...args)=>ipcRenderer.invoke(...args),send:(...args)=>ipcRenderer.send(...args),on:(name,cb)=>{const listener=(_event,...args)=>cb(...args);ipcRenderer.on(name,listener);return()=>ipcRenderer.removeListener(name,listener)}});`);
    fs.writeFileSync(path.join(dir, 'src/renderer/action-fixture.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="workspace-layout.css"><link rel="stylesheet" href="animated-themes.css"><link rel="stylesheet" href="copilot.css"><style>body{margin:0}#fixture{display:flex;height:100vh;gap:8px}#editor-host{width:45%}#copilot-host{flex:1}</style><main id="fixture"><section id="editor-host" class="workspace-pane"><div id="editor-pane" class="workspace-pane-body"></div></section><section id="copilot-host" class="workspace-pane"><div id="copilot-pane" class="workspace-pane-body"></div></section></main><div id="toasts"></div><script type="module" src="js/action-fixture.js"></script>');
    fs.writeFileSync(path.join(dir, 'src/renderer/js/action-fixture.js'), `
import {api} from './ui.js'; import {CopilotController} from './copilot.js'; import {NotepadTab} from './notepad/notepad.js';
import {applyReviewedEditorAction} from './copilot-editor-actions.mjs';
const app={tabs:[],byId:new Map(),jobs:new Map(),settings:{theme:'dark',fontFamily:'Consolas',fontSize:13,notepad:{}},active:null,
  registerJob(id,owner){this.jobs.set(id,owner)},unregisterJob(id){this.jobs.delete(id)},setTabTitle(tab,title){tab.title=title},updateStatus(){},tabStateChanged(){},saveSettings:async()=>{},workspaceLayout:{updateContext(){}},
  activate(tab){this.active=tab;this.copilot?.focusedTabChanged(tab)},addTab(tab){this.tabs.push(tab);this.byId.set(tab.id,tab)},openTool(){throw new Error('An action cannot auto-start a tool view')},
  async closeTab(tab){if(!await tab.requestClose())return false;tab.dispose();this.tabs=this.tabs.filter(item=>item!==tab);this.byId.delete(tab.id);tab.el.remove();return true}};
const controller=new CopilotController(app);app.copilot=controller;const np=new NotepadTab(app);app.addTab(np);np.el.classList.add('workspace-visible');document.querySelector('#editor-pane').append(np.el);app.active=np;await np.ready;np.refit();
const doc=np.newDoc({title:'Owned unsaved document',text:'original selected text\\nuntouched tail'});np.editor.setSelection(new np.monaco.Selection(1,1,1,doc.model.getLineMaxColumn(1)));
const panel=await controller.open({sourceTab:np});app.addTab(panel);panel.el.classList.add('workspace-visible');document.querySelector('#copilot-pane').append(panel.el);
api.on('tools:event',(id,type,data)=>app.jobs.get(id)?.onJobEvent(type,data));
api.on('fixture:editorAction',async request=>{const owner=app.byId.get(request.target.tabId);const ack=await applyReviewedEditorAction(owner,request);await api.invoke('tools:copilotActionEditorAck',ack)});
window.__app=app;window.__c=controller;window.__p=panel;window.__np=np;window.__doc=doc;
window.__reopen=async()=>{const reopened=await controller.open({sourceTab:np});if(!app.tabs.includes(reopened))app.addTab(reopened);document.querySelector('#copilot-pane').append(reopened.el);};
window.__ready=true;`);
    const { CopilotStore, emptyUsage } = require(path.join(SOURCE, 'main/copilot-store'));
    const { CopilotActions } = require(path.join(SOURCE, 'main/copilot-actions'));
    const { registerCopilotActions } = require(path.join(SOURCE, 'main/copilot-actions-ipc'));
    const { createActionDiagnostics } = require(path.join(SOURCE, 'main/copilot-action-diagnostics'));
    const { CopilotService } = require(path.join(ROOT, 'src/main/copilot'));
    const { registerCopilot } = require(path.join(ROOT, 'src/main/copilot-ipc'));
    const { AIClient } = require(path.join(ROOT, 'src/main/ai'));
    const { KnowledgeLibrary } = require(path.join(dir, 'src/main/knowledge'));
    const profile = path.join(dir, 'profile'); fs.mkdirSync(profile, { recursive: true });
    store = new CopilotStore(profile); knowledge = new KnowledgeLibrary({ dir: profile });
    const ai = new AIClient({ dir: profile, crypt: { available: () => false }, request: () => { throw new Error('Action UI test must never contact an AI provider'); }, knowledge });
    service = new CopilotService({ store, ai });
    const productionDiagnostics = createActionDiagnostics({ nettools: require(path.join(ROOT, 'src/main/nettools')) });
    const diagnostics = Object.fromEntries(['ping', 'dns', 'traceroute'].map(kind => [kind, async (params, emit, signal) => {
      assert.equal(kind, 'ping', 'Fixture authorizes loopback ping only'); assert.equal(params.host, '127.0.0.1'); effects.push({ kind, params });
      const saved = await store.get(conversation.id); assert.equal(saved.actions.at(-1).status, 'pending');
      try { return await productionDiagnostics[kind](params, emit, signal); }
      finally {
        if (effects.length === 2 && signal.aborted) {
          cancellationHeld = true;
          await new Promise(resolve => { releaseCancelledDiagnostic = resolve; });
        }
      }
    }]));
    actions = new CopilotActions({ store, knowledge, diagnostics, requestEditor: request => { dispatched.push(request); win.webContents.send('fixture:editorAction', request); return true; }, editorTimeoutMs: 3000 });
    let conversation = await store.create({ name: 'Owned reviewed action conversation' });
    const turn = { id: crypto.randomUUID(), status: 'pending', createdAt: new Date().toISOString(), completedAt: null, question: 'Explain the owned fixture', attachmentIds: [], historyTurnIds: [],
      request: { digest: 'a'.repeat(64), provider: 'fixture', model: 'offline', providerRevision: 'fixture', body: '{}', endpoint: 'https://example.test', references: [], evidence: [] }, answer: '', usage: emptyUsage(), limitations: [], error: '' };
    await store.beginTurn(conversation.id, conversation.revision, turn);
    const answer = 'Owned offline answer.\n\nSelected note \u{1F9EA} excerpt. Selected note \u{1F9EA} excerpt.\n\n' + '```konx-action\n{"kind":"diagnostic.ping","params":{"host":"127.0.0.1","count":1,"interval":250,"timeout":500}}\n```\n' + '```konx-action\n{"kind":"editor.replaceSelection","params":{"replacement":"replacement reviewed text"}}\n```\n' + '```konx-action\n{"kind":"terminal.command","params":{"command":"never execute"}}\n```';
    conversation = await store.finishTurn(conversation.id, turn.id, { status: 'complete', answer, usage: emptyUsage(), limitations: [], error: '' });
    const handle = (name, handler) => ipcMain.handle(name, async (event, ...args) => {
      assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame); calls.push({ name, args }); return handler(...args);
    });
    registerCopilot(handle, { copilot: service, isClosing: () => false }); registerCopilotActions(handle, { actions, isClosing: () => false });
    handle('np:session:get', () => ({ docs: [] }));
    for (const name of ['np:session:set', 'np:backup:write', 'np:backup:delete', 'np:watch']) handle(name, () => undefined);
    handle('tools:start', (kind, params, id) => {
      assert.equal(kind, 'copilot-action'); assert.equal(jobs.has(id), false); const signal = { stopped: false };
      const emit = (type, data) => win.webContents.send('tools:event', id, type, data);
      const task = Promise.resolve().then(() => actions.run(params, emit, signal)).then(() => emit('done', { stopped: signal.stopped }), error => emit('error', { message: error.message })).finally(() => jobs.delete(id));
      jobs.set(id, { signal, task }); return id;
    });
    handle('tools:stop', id => { const job = jobs.get(id); if (job) { job.signal.stopped = true; job.signal.onStop?.(); } });
    win = new BrowserWindow({ show: false, focusable: false, width: 1280, height: 900, webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(dir, 'preload.cjs'), backgroundThrottling: false } });
    await win.loadFile(path.join(dir, 'src/renderer/action-fixture.html'));
    const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch (error) { throw new Error(`Renderer evaluation failed (${code.slice(0, 160)}): ${error.message}`); } };
    await until(() => run('Boolean(window.__ready)'), 'renderer ready');
    await run(`__c.selectConversation(${JSON.stringify(conversation.id)})`);
    await runChecks({ run, win, store, actions, knowledge, conversation, turn, effects, calls, dispatched, jobs, answer,
      cancellationHeld: () => cancellationHeld, releaseCancelledDiagnostic: () => releaseCancelledDiagnostic?.() });
    await run('__np.dispose();__c.dispose()');
    console.log('COPILOT_ACTION_UI_PASS'); await finish(0);
  } catch (error) { await finish(1, error); }
}

async function runChecks(context) {
  const { run, win, store, actions, knowledge, conversation, effects, calls, dispatched, jobs } = context;
  const button = action => `document.querySelector('[data-action="${action}"]')`;
  const click = async expression => {
    let point;
    await until(async () => {
      point = await run(`(()=>{const e=${expression};if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=e.ownerDocument.elementFromPoint(x,y);return r.width&&r.height&&(hit===e||e.contains(hit))?{x,y}:null})()`);
      return point;
    }, 'reachable ' + expression);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause();
  };
  const input = (label, value, event = 'input') => run(`(()=>{const e=document.querySelector('[aria-label="${label}"]');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}))})()`);
  const idle = () => until(() => run('!__c.busy&&!__c.prompting&&!__c.actions.busy&&!__c.actions.jobId&&!__c.actions.discardPromise'), 'idle action owner');
  const open = async () => { await click(button('review-turn-actions')); await until(() => run('Boolean(__c.actions.draft)&&!__c.actions.busy'), 'action draft'); };
  const suggestion = async number => { await click(`Array.from(document.querySelectorAll('[data-action="use-action-suggestion"]'))[${number - 1}]`); };
  const prepare = async () => { await click(button('prepare-reviewed-action')); await until(() => run('Boolean(__c.actions.preview)&&!__c.actions.busy'), 'exact action review'); return run('__c.actions.preview'); };
  const execute = async () => { await click(button('execute-reviewed-action')); await idle(); await until(() => jobs.size === 0, 'main action job settled'); };
  const saved = () => store.get(conversation.id);
  const refresh = async () => { await run('__c.selectConversation(null)'); await run(`__c.selectConversation(${JSON.stringify(conversation.id)})`); await idle(); };
  const modalChoice = label => click(`Array.from(document.querySelectorAll('.modal footer button')).find(e=>e.textContent===${JSON.stringify(label)})`);

  assert.equal(effects.length, 0); assert.equal((await saved()).actions.length, 0);
  await open(); assert.equal(await run('__c.actions.candidates.length'), 2); assert.equal(await run('__c.actions.issues.length'), 1);
  await suggestion(1); const initial = await prepare();
  assert.deepEqual(JSON.parse(await run('__c.actions.previewText.textContent')), initial);
  assert.equal(initial.kind, 'diagnostic.ping'); assert.equal(initial.params.host, '127.0.0.1'); assert.equal(initial.params.count, 1);
  assert.equal(await run('__c.actions.technicalDetails.open'), false, 'technical metadata is initially collapsed');
  assert.deepEqual(await run('Array.from(__c.actions.previewSummary.querySelectorAll("dt")).map(label=>[label.textContent,label.nextElementSibling.textContent])'),
    [['Target', '127.0.0.1'], ['Echo requests', '1'], ['Interval', '250 ms'], ['Reply timeout', '500 ms'], ['Payload', '32 bytes']]);
  assert.match(await run('__c.actions.previewSummary.textContent'), /Send the displayed bounded diagnostic traffic/);
  assert.equal(effects.length, 0); assert.equal((await saved()).actions.length, 0);
  const { setViewport } = require(path.join(ROOT, 'test/lib/electron-viewport.cjs'));
  await setViewport(win, run, 900, 560); await run('__np.refit();void 0');
  const screenshots = path.join(ROOT, 'review/release-0.27.0'); fs.mkdirSync(screenshots, { recursive: true });
  await run('__c.actions.reviewEl.scrollIntoView({block:"nearest"});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  fs.writeFileSync(path.join(screenshots, 'reviewed-action-900.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  assert.equal(await run('document.documentElement.scrollWidth<=innerWidth+2'), true, 'Action form overflow at 900px');
  assert.ok((await run('__c.updateBlockers()')).some(text => /action draft/i.test(text)));
  await input('Ping count', 2); await until(() => actions.prepared.size === 0, 'edited review discarded');
  assert.equal(await run('__c.actions.preview'), null); assert.equal(effects.length, 0);
  await suggestion(1); await prepare();
  await run('window.__closing=__app.closeTab(__p);void 0'); await modalChoice('Keep draft'); assert.equal(await run('__closing'), false);
  assert.ok(await run('Boolean(__c.actions.preview)')); assert.equal(effects.length, 0);
  await run('window.__closing=__app.closeTab(__p);void 0'); await modalChoice('Discard draft'); assert.equal(await run('__closing'), true);
  await until(() => actions.prepared.size === 0, 'close discard cleanup'); assert.equal(effects.length, 0);
  await run('__reopen()'); await open(); await suggestion(1); await prepare();
  const beforeRename = await saved(); await store.rename(conversation.id, beforeRename.revision, 'Owned changed revision');
  await execute(); assert.equal(effects.length, 0); assert.equal((await saved()).actions.length, 0);
  assert.match(await run('__c.actions.status.textContent'), /changed|reopen/i);
  await refresh(); await open(); await suggestion(1); const used = await prepare(); await execute();
  assert.equal(effects.length, 1); assert.equal(effects[0].params.host, '127.0.0.1');
  const ping = (await saved()).actions.at(-1); assert.equal(ping.status, 'succeeded'); assert.ok(ping.result.observations.some(item => item.data.ip === '127.0.0.1'));
  await assert.rejects(actions.run({ preparationId: used.preparationId, digest: used.digest }, () => {}, {}), /already used/);
  assert.equal(effects.length, 1); assert.equal(await run('__c.actions.hasDraft()'), false);
  assert.equal(await run('document.querySelectorAll(".copilot-action-outcomes details").length'), 1);
  await click('document.querySelector(".copilot-action-outcomes summary")');
  await until(() => run('Boolean(document.querySelector(".copilot-action-outcomes pre").textContent)'), 'saved diagnostic details expanded');
  assert.match(await run('document.querySelector(".copilot-action-outcomes pre").textContent'), /127\.0\.0\.1/);

  await open(); await suggestion(1); await input('Ping count', 10); await input('Ping interval milliseconds', 500); await prepare();
  await click(button('execute-reviewed-action')); await until(() => effects.length === 2 && jobs.size > 0, 'active loopback diagnostic');
  assert.equal(await run('[...__app.jobs.values()][0].panel===__p'), true, 'Running Work points to the canonical panel');
  await run('window.__closing=__app.closeTab(__p);void 0'); await modalChoice('Keep open'); assert.equal(await run('__closing'), false);
  await run('window.__closing=__app.closeTab(__p);void 0'); await modalChoice('Cancel action and close'); assert.equal(await run('__closing'), true);
  await until(context.cancellationHeld, 'owned cancellation completion held');
  assert.equal(await run('!__app.tabs.includes(__p)&&__app.jobs.size===1&&[...__app.jobs.values()][0].panel===__p'), true, 'closed view stays discoverable through its running owner');
  await run('__reopen()');
  assert.equal(await run('__c.panel===__p&&__app.tabs.filter(tab=>tab===__p).length===1&&__app.jobs.size===1'), true, 'reopening reuses one panel and job owner');
  assert.equal(effects.length, 2); context.releaseCancelledDiagnostic();
  await until(() => jobs.size === 0, 'cancelled action cleanup'); await idle();
  const cancelled = (await saved()).actions.at(-1); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.result.coverage.complete, false);
  assert.equal(effects.length, 2); assert.equal(await run('__app.jobs.size'), 0);
  await refresh();

  await setViewport(win, run, 1280, 900);
  const editorDraft = async () => { await open(); await suggestion(2); assert.equal(await run('__c.actions.draft.target'), null); await input('Action editor document', 'notepad', 'change'); await click(button('capture-editor-selection')); await idle(); return prepare(); };
  const beforeText = await run('__doc.model.getValue()'); const editPreview = await editorDraft();
  assert.equal(editPreview.target.tabId, 'notepad'); assert.equal(editPreview.preview.before, 'original selected text'); assert.equal(editPreview.preview.replacement, 'replacement reviewed text');
  assert.equal(await run(`document.querySelector('[aria-label="Reviewed editor before text"]').textContent`), editPreview.preview.before);
  assert.equal(await run(`document.querySelector('[aria-label="Reviewed editor replacement text"]').textContent`), editPreview.preview.replacement);
  assert.equal(await run('__doc.model.getValue()'), beforeText); assert.equal(dispatched.length, 0);
  await run('__np.editor.setSelection(new __np.monaco.Selection(2,1,2,5));void 0'); await execute();
  assert.equal((await saved()).actions.at(-1).status, 'failed'); assert.equal(await run('__doc.model.getValue()'), beforeText);
  await run('__np.editor.setSelection(new __np.monaco.Selection(1,1,1,__doc.model.getLineMaxColumn(1)));void 0');
  await editorDraft();
  await run('window.__other=__np.newDoc({title:"Different current document",text:"do not alter this document"});__np.editor.setSelection(__other.model.getFullModelRange());void 0');
  await execute(); assert.equal((await saved()).actions.at(-1).status, 'failed'); assert.equal(await run('__other.model.getValue()'), 'do not alter this document'); assert.equal(await run('__doc.model.getValue()'), beforeText);
  await run('__np.activate(__doc);__np.editor.setSelection(new __np.monaco.Selection(1,1,1,__doc.model.getLineMaxColumn(1)));void 0');
  await editorDraft(); await execute();
  const edited = (await saved()).actions.at(-1); assert.equal(edited.status, 'succeeded'); assert.equal(edited.result.provenance, 'renderer-reported'); assert.equal(edited.result.saved, false); assert.equal(edited.result.uploaded, false);
  assert.equal(await run('__doc.model.getValue()'), 'replacement reviewed text\nuntouched tail');
  await run('__doc.model.undo()'); assert.equal(await run('__doc.model.getValue()'), beforeText);
  assert.equal(calls.some(call => ['np:write', 'np:save', 'sftp:write', 'xfer:start'].includes(call.name)), false);
  assert.equal(fs.readFileSync(store.file(conversation.id), 'utf8').includes('original selected text'), false);

  await open(); await input('Reviewed action kind', 'note.saveAnswer', 'change'); await input('Answer note title', 'Owned action UI note');
  const wholePreview = await prepare(); assert.ok(wholePreview.preview.article.content.startsWith(context.answer));
  const prepareCount = calls.filter(call => call.name === 'tools:copilotActionPrepare').length;
  const selectAnswer = async (start, end, mode = 'answer') => run(`(()=>{
    const answer=__c.actions.turnButtons.get(__c.actions.draft.turnId).closest('.copilot-turn').querySelector('.copilot-answer');
    const heading=answer.previousElementSibling, selection=answer.ownerDocument.defaultView.getSelection(),range=answer.ownerDocument.createRange();
    if(${JSON.stringify(mode)}==='outside'){range.selectNodeContents(heading)}
    else if(${JSON.stringify(mode)}==='mixed'){range.setStart(heading.firstChild,0);range.setEnd(answer.firstChild,${end})}
    else {range.setStart(answer.firstChild,${start});range.setEnd(answer.firstChild,${end})}
    selection.removeAllRanges();selection.addRange(range);
  })()`);
  for (const mode of ['outside', 'mixed']) {
    await selectAnswer(0, 5, mode); await click(button('use-selected-answer-text'));
    assert.equal(await run('__c.actions.draft.params.start'), undefined); assert.equal(await run('__c.actions.preview.preparationId'), wholePreview.preparationId);
    assert.match(await run('__c.actions.status.textContent'), /only within this completed answer/);
  }
  await run(`document.querySelector('.copilot-answer').textContent=${JSON.stringify(context.answer + ' rendered mismatch')};void 0`);
  await selectAnswer(0, 5); await click(button('use-selected-answer-text'));
  assert.equal(await run('__c.actions.preview.preparationId'), wholePreview.preparationId); assert.match(await run('__c.actions.status.textContent'), /displayed text must match/);
  await run(`document.querySelector('.copilot-answer').textContent=${JSON.stringify(context.answer)};void 0`);
  const selectedText = 'Selected note \u{1F9EA} excerpt.', selectedStart = context.answer.lastIndexOf(selectedText), selectedEnd = selectedStart + selectedText.length;
  assert.ok(selectedStart > context.answer.indexOf(selectedText), 'Fixture selects the second identical excerpt, not a string search match');
  await selectAnswer(selectedStart, selectedEnd); await click(button('use-selected-answer-text')); await idle();
  assert.deepEqual(await run('[__c.actions.draft.params.start,__c.actions.draft.params.end]'), [selectedStart, selectedEnd]);
  assert.equal(await run('__c.actions.preview'), null); await until(() => actions.prepared.size === 0, 'selection discards old exact review');
  assert.equal(calls.filter(call => call.name === 'tools:copilotActionPrepare').length, prepareCount, 'Selecting text must not prepare or execute an action');
  assert.equal((await saved()).actions.length, 5); assert.equal(effects.length, 2);
  await setViewport(win, run, 900, 560);
  await run('__np.refit();__c.actions.noteFields.scrollIntoView({block:"nearest"});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  fs.writeFileSync(path.join(screenshots, 'answer-excerpt-900.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  const notePreview = await prepare(); assert.equal(notePreview.preview.article.title, 'Owned action UI note');
  assert.equal(notePreview.params.start, selectedStart); assert.equal(notePreview.params.end, selectedEnd);
  assert.ok(notePreview.preview.article.content.startsWith(selectedText + '\n')); assert.equal(notePreview.preview.article.content.includes('Owned offline answer.'), false);
  assert.equal(await run(`document.querySelector('[aria-label="Reviewed answer note content"]').textContent`), notePreview.preview.article.content);
  const beforeActions = (await saved()).actions.length; assert.equal(beforeActions, 5); await execute();
  const note = (await saved()).actions.at(-1); assert.equal(note.status, 'succeeded'); assert.equal(note.result.provenance, 'knowledge-store');
  const article = await knowledge.get(note.result.articleId); assert.equal(article.content, notePreview.preview.article.content);
  assert.ok(article.content.includes(conversation.id)); assert.equal((await saved()).actions.filter(action => action.kind === 'note.saveAnswer').length, 1);
  const effectCount = effects.length, dispatchCount = dispatched.length, actionCount = (await saved()).actions.length;
  await run('__np.dispose();__c.dispose()');
  const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.reload(); await reloaded; await until(() => run('Boolean(window.__ready)'), 'reloaded renderer');
  await run(`__c.selectConversation(${JSON.stringify(conversation.id)})`); await idle();
  assert.equal(await run('__c.conversation.actions.length'), actionCount); assert.equal(effects.length, effectCount); assert.equal(dispatched.length, dispatchCount); assert.equal(await run('__c.actions.hasDraft()'), false);
  assert.equal(await run('document.querySelectorAll(".copilot-action-outcomes details").length'), actionCount);
}

if (process.argv.includes('--action-ui-fixture')) void fixture();
else if (require.main === module) runCopilotActionsUiTests(async(name,fn)=>{await fn();console.log('PASS '+name)}).catch(error=>{console.error(error);process.exitCode=1});
module.exports = { runCopilotActionsUiTests };
