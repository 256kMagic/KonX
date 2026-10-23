'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) { if (Date.now() >= deadline) throw new Error('Timed out: ' + label); await pause(); }
}

async function runAiUiTests(test) {
  await test('real AI renderer, main IPC, encrypted credentials, local vector library, explicit context, five providers, cancellation and responsive layout', async () => {
    const tempRoot = path.resolve(os.tmpdir());
    const fixtureRoot = fs.mkdtempSync(path.join(tempRoot, 'konx-ai-ui-test-'));
    let child, output = '', passed = false;
    try {
      const env = { ...process.env, KONX_USERDATA: path.join(fixtureRoot, 'profile'), KONX_AI_TEST_ROOT: fixtureRoot, KONX_CAPTURE: '', KONX_DEMO: '' };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--electron-ai-fixture'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      const collect = (data) => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('AI UI fixture timed out\n' + output)); }, 55000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
      });
      const failure = path.join(fixtureRoot, 'failure.txt');
      assert.equal(code, 0, (fs.existsSync(failure) ? fs.readFileSync(failure, 'utf8') + '\n\nFixture output:\n' : '') + output);
      assert.match(output, /AI_UI_PASS/); passed = true;
    } finally {
      if (child && child.exitCode == null) child.kill();
      if (!passed) {
        const diagnostics = path.join(__dirname, '..', 'review', 'ai-ui-failure');
        fs.mkdirSync(diagnostics, { recursive: true });
        fs.writeFileSync(path.join(diagnostics, 'fixture.log'), output);
        const failure = path.join(fixtureRoot, 'failure.txt');
        if (fs.existsSync(failure)) fs.copyFileSync(failure, path.join(diagnostics, 'failure.txt'));
        console.error('AI UI failure diagnostics: ' + diagnostics);
      }
      assert.equal(path.dirname(path.resolve(fixtureRoot)), tempRoot);
      assert.ok(path.basename(fixtureRoot).startsWith('konx-ai-ui-test-'));
      fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function electronFixture() {
  const { app, BrowserWindow, dialog, safeStorage, shell } = require('electron');
  const fixtureRoot = path.resolve(process.env.KONX_AI_TEST_ROOT || '');
  assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixtureRoot).startsWith('konx-ai-ui-test-'));
  let screenshotRoot;
  if (process.env.KONX_AI_SCREENSHOT_DIR) {
    const reviewRoot = fs.realpathSync(path.join(__dirname, '..', 'review'));
    const requested = path.resolve(process.env.KONX_AI_SCREENSHOT_DIR);
    const contained = (value) => { const relative = path.relative(reviewRoot, value); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
    assert.ok(contained(requested), 'AI screenshots must be inside workspace/review');
    let ancestor = requested; while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    assert.ok(ancestor === reviewRoot || contained(fs.realpathSync(ancestor)), 'AI screenshot parent resolves outside workspace/review');
    fs.mkdirSync(requested, { recursive: true }); screenshotRoot = fs.realpathSync(requested);
    assert.ok(contained(screenshotRoot), 'AI screenshot directory resolves outside workspace/review');
  }
  const key = 'SyntheticFixtureAiKey_Only_For_Isolated_Offline_Test';
  const malicious = '<img src=x onerror="window.__aiInjected=true">';
  const requests = [], pending = new Set(), openedSources = [];
  let delay = false, failNext = false, cancelled = 0, instance, finished = false;
  const aiModule = require('../src/main/ai'), RealClient = aiModule.AIClient;
  // Replace only the provider's HTTPS transport. The real encrypted config,
  // validation, request construction, retrieval, parser and IPC remain in use.
  const request = (options, onResponse) => {
    const req = new EventEmitter(); let destroyed = false;
    req.setTimeout = () => req;
    req.destroy = () => { if (destroyed) return; destroyed = true; if (pending.delete(req)) cancelled++; };
    req.end = (body) => {
      const parsed = JSON.parse(body), message = parsed.input?.[0]?.content?.[0]?.text ?? parsed.messages?.find((item) => item.role === 'user')?.content ?? parsed.contents?.[0]?.parts?.[0]?.text;
      requests.push({ options, body: parsed, envelope: JSON.parse(message) });
      if (delay) { pending.add(req); return; }
      queueMicrotask(() => {
        if (destroyed) return;
        const res = new EventEmitter(); res.statusCode = failNext ? 503 : 200; failNext = false; res.headers = { 'content-type': 'application/json' }; res.destroy = () => {};
        onResponse(res);
        const answer = `${malicious}\nRSSI needs context and corroboration. [K1]`;
        const value = options.hostname === 'api.openai.com' ? { output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }] } :
          options.hostname === 'api.anthropic.com' ? { content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' } :
          options.hostname === 'generativelanguage.googleapis.com' ? { candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }] } :
          { choices: [{ message: { content: answer }, finish_reason: 'stop' }], model: 'fixture/model' };
        res.emit('data', Buffer.from(JSON.stringify(value))); res.emit('end');
      });
    };
    return req;
  };
  aiModule.AIClient = class extends RealClient { constructor(options) { super({ ...options, request }); instance = this; } };
  // Opening capture for its Explain button must not query host drivers.
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, engine: null, missing: false, error: 'Synthetic unavailable capture fixture', npcap: { available: false }, builtin: { available: false } });
  shell.openExternal = async (url) => { openedSources.push(url); };
  dialog.showErrorBox = (title, message) => { throw new Error(`Unexpected native JavaScript error: ${title}: ${message}`); };
  dialog.showOpenDialog = async () => { throw new Error('The AI fixture must not open user files'); };
  const finish = (code, error) => {
    if (finished) return; finished = true;
    if (error) { fs.writeFileSync(path.join(fixtureRoot, 'failure.txt'), String(error.stack || error)); console.error('AI_UI_FAILURE: ' + (error.stack || error)); }
    for (const req of [...pending]) req.destroy();
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.exit(code);
  };
  process.on('uncaughtException', (error) => finish(1, error));
  process.on('unhandledRejection', (error) => finish(1, error));
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.once('did-finish-load', async () => {
      try {
        const run = (code) => win.webContents.executeJavaScript(code).catch((error) => { throw new Error(error.message + '\nFixture expression: ' + code.slice(0, 450)); });
        const click = async (expression) => {
          let point;
          await until(async () => {
            point = await run(`(() => { const el=${expression}; if(!el) throw new Error('Missing AI fixture control'); el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect();if(!r.width||!r.height||el.disabled)return{ready:false}; const x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return{x,y,ready:el===hit||el.contains(hit)};})()`);
            return point.ready;
          }, 'reachable AI control ' + expression, 7000);
          delete point.ready; win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
          win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(25);
        };
        const input = (expression, value, event = 'input') => run(`${expression}.value=${JSON.stringify(value)};${expression}.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));void 0;`);
        const choose = async (label) => {
          const expression = `Array.from(document.querySelectorAll('.modal footer button')).find(el=>el.textContent===${JSON.stringify(label)})`;
          await until(() => run(`Boolean(${expression})`), 'AI dialog option ' + label); await click(expression);
        };
        const close = async (tab, choice) => {
          await run(`window.__closeAttempt=window.__app.closeTab(window.${tab});void 0;`);
          if (choice) await choose(choice);
          await run('window.__closeAttempt');
        };
        const blockers = (tab = '__ai') => run(`import('./js/updates.js').then(m=>m.updateBlockers({tabs:[window.${tab}]}))`);
        const ready = (tab = '__ai') => until(() => run(`Boolean(window.${tab}?.config && !window.${tab}.configBusy)`), 'AI settings ' + tab);
        const idle = (tab = '__ai') => until(() => run(`!window.${tab}.jobId`), 'AI completion ' + tab);
        const ask = async () => {
          const before = requests.length; await click('window.__ai.askButton');
          await until(() => requests.length === before + 1, 'synthetic AI request'); await idle();
          assert.equal(await run('Boolean(window.__ai.report)'), true, await run('window.__ai.status.textContent'));
        };
        await until(() => run('Boolean(window.__app)'), 'application initialization');
        assert.equal(safeStorage.isEncryptionAvailable(), true, 'Windows secure storage must be available for this integration test');
        await run('window.__ai=window.__app.openTool("ai");void 0;'); await ready();
        const previewSources = [], realPreview = instance.preview.bind(instance);
        instance.preview = (context) => { previewSources.push(context); return realPreview(context); };
        await until(() => run('window.__ai.libraryList.querySelectorAll("button").length>0'), 'built-in offline references');
        assert.equal(requests.length, 0); assert.equal(await run('window.__app.jobs.size'), 0);
        assert.deepEqual(await run('[...window.__ai.provider.options].map(item=>item.value)'), ['openai', 'anthropic', 'gemini', 'nyquest', 'custom']);
        assert.equal(await run('window.__ai.key.type'), 'password'); assert.equal(await run('window.__ai.askButton.disabled'), true);
        assert.match(await run('window.__ai.libraryStatus.textContent'), /TF-IDF/);
        const baselineStatus = await instance.knowledge.status(); assert.ok(baselineStatus.documents >= 10); assert.ok(baselineStatus.chunks > 0);
        assert.deepEqual(await blockers(), [], 'blank AI view has no draft blocker');

        // Failed validation retains the unsaved key for correction and retry.
        await input('window.__ai.key', 'not a valid key'); await click('window.__ai.saveButton'); await ready();
        assert.equal(await run('window.__ai.key.value'), 'not a valid key'); assert.equal(await run('window.__ai.config.hasKey'), false);
        await input('window.__ai.key', key); await click('window.__ai.saveButton'); await ready();
        assert.equal(await run('window.__ai.config.hasKey'), true); assert.equal(await run('window.__ai.key.value'), '');
        const storedPath = path.join(fixtureRoot, 'profile', 'ai.json');
        const stored = fs.readFileSync(storedPath, 'utf8'); assert.ok(!stored.includes(key)); assert.ok(JSON.parse(stored).providers.openai.keyEnc);
        assert.equal(await run(`JSON.stringify(window.__ai.config).includes(${JSON.stringify(key)})`), false);
        assert.equal(await run(`Object.values(localStorage).join('').includes(${JSON.stringify(key)})`), false);
        assert.equal(requests.length, 0, 'saving a key must not contact an AI provider');

        await input('window.__ai.question', 'Explain RSSI and wireless channel contention');
        await input('window.__ai.context', `Private fixture context\npassword=SECRET_FIXTURE_PASSWORD\nkey=${key}\nrssi=-67`);
        assert.equal(await run('window.__ai.shareContext.checked'), false); assert.equal(await run('window.__ai.shareContext.disabled'), true);
        await ask(); assert.equal(Object.hasOwn(requests.at(-1).envelope, 'toolContext'), false);
        assert.equal(await run('window.__ai.assistantDirty()'), true, 'successful unshared request preserves local context draft');
        assert.match((await blockers()).join(' '), /unsent AI/);
        assert.equal(await run('Boolean(window.__aiInjected)'), false); assert.equal(await run('window.__ai.answer.querySelector("img")'), null);
        assert.ok((await run('window.__ai.answer.textContent')).includes(malicious));
        assert.ok(requests.at(-1).envelope.references.length > 0); assert.ok(await run('window.__ai.sourceList.querySelectorAll("button").length>0'));
        assert.match(await run('window.__ai.sourceList.textContent'), /\[K1\]/);
        await click('window.__ai.sourceList.querySelector("button")');
        await until(() => run('Boolean(window.__ai.currentDocument)'), 'citation article');
        assert.ok(await run('window.__ai.documentContent.textContent.length>50'));
        await click('window.__ai.documentSourceButton'); assert.equal(openedSources.length, 1); assert.match(openedSources[0], /^https:\/\//);
        const beforeArticle = await run('[window.__ai.question.value,window.__ai.context.value]');
        await click('window.__ai.documentAskButton'); await choose('Cancel');
        assert.deepEqual(await run('[window.__ai.question.value,window.__ai.context.value]'), beforeArticle);
        await click('window.__ai.documentAskButton'); await choose('Replace draft');
        await until(() => run('!window.__ai.previewBusy && window.__ai.previewValue!==null'), 'article preview');
        assert.equal(await run('window.__ai.shareContext.checked'), false); assert.equal(requests.length, 1);

        await input('window.__ai.context', `password=SECRET_FIXTURE_PASSWORD\nkey=${key}\nrssi=-67`);
        await click('window.__ai.previewButton');
        await until(() => run('!window.__ai.previewBusy && window.__ai.previewValue!==null'), 'redacted context preview');
        assert.equal(await run('window.__ai.shareContext.checked'), false);
        assert.equal(await run('window.__ai.context.value.includes("SECRET_FIXTURE_PASSWORD")'), false);
        assert.equal(await run(`window.__ai.preview.textContent.includes(${JSON.stringify(key)})`), false);
        await click('window.__ai.shareContext'); await ask();
        assert.match(requests.at(-1).envelope.toolContext, /\[Redacted\]/); assert.ok(!requests.at(-1).envelope.toolContext.includes(key));
        assert.equal(await run('window.__ai.assistantDirty()'), false, 'successful shared request establishes exact draft baseline');
        assert.deepEqual(await blockers(), []);
        await input('window.__ai.context', 'changed context rssi=-71');
        assert.equal(await run('window.__ai.shareContext.checked'), false); assert.equal(await run('window.__ai.shareContext.disabled'), true);

        // Every provider goes through real request construction and parsing.
        for (const provider of ['anthropic', 'gemini', 'nyquest', 'custom']) {
          await input('window.__ai.provider', provider, 'change');
          assert.equal(await run('window.__ai.baseUrlField.classList.contains("hidden")'), provider !== 'custom');
          if (provider === 'custom') { await input('window.__ai.model', 'fixture/model'); await input('window.__ai.baseUrl', 'https://offline-ai-fixture.invalid/v1'); }
          await input('window.__ai.key', key + '_' + provider); await click('window.__ai.saveButton'); await ready();
          assert.equal(await run('window.__ai.key.value'), ''); await ask();
          assert.equal(await run('window.__ai.report.provider'), provider);
        }
        assert.deepEqual(requests.slice(-4).map((item) => item.options.hostname), ['api.anthropic.com', 'generativelanguage.googleapis.com', 'api.nyquest.ai', 'offline-ai-fixture.invalid']);
        assert.equal(requests.at(-2).options.path, '/v1/chat/completions');
        await input('window.__ai.provider', 'openai', 'change'); await click('window.__ai.saveButton'); await ready();
        await input('window.__ai.provider', 'custom', 'change');
        assert.equal(await run('window.__ai.baseUrl.value'), 'https://offline-ai-fixture.invalid/v1');
        assert.equal(await run('window.__ai.model.value'), 'fixture/model');
        await click('window.__ai.saveButton'); await ready();

        // Real note CRUD updates SQLite and vectors; renderer handles HTML as text.
        const requestCount = requests.length;
        await click('window.__ai.newDocumentButton');
        assert.equal(await run('window.__ai.noteDirty()'), false, 'empty new editor is not a draft');
        assert.equal((await blockers()).some(reason => /note/i.test(reason)), false);
        await input('window.__ai.noteTitle', 'Failed note stays here');
        await input('window.__ai.noteSource', 'not-an-https-url'); await input('window.__ai.noteContent', 'Uncommitted local fixture content');
        assert.equal(await run('window.__ai.noteDirty()'), true); assert.match((await blockers()).join(' '), /unsaved knowledge note/);
        await click('window.__ai.noteSaveButton'); await until(() => run('!window.__ai.libraryBusy'), 'rejected note save');
        assert.equal(await run('window.__ai.noteContent.value'), 'Uncommitted local fixture content');
        assert.equal(await run('window.__ai.noteDirty()'), true);
        assert.equal((await instance.knowledge.status()).documents, baselineStatus.documents, 'failed note was not persisted');
        await click('window.__ai.noteCancelButton'); await choose('Cancel');
        assert.equal(await run('window.__ai.noteDirty()'), true);
        await click('window.__ai.newDocumentButton'); await choose('Cancel');
        assert.equal(await run('window.__ai.noteTitle.value'), 'Failed note stays here', 'opening another note cannot silently replace a draft');
        await click('window.__ai.noteCancelButton'); await choose('Discard changes');
        assert.equal(await run('window.__ai.noteDirty()'), false);
        await click('window.__ai.newDocumentButton');
        await input('window.__ai.noteTitle', 'Fixture operational explanation'); await input('window.__ai.noteVendor', 'Fixture vendor');
        await input('window.__ai.noteSource', 'https://example.invalid/documentation');
        await input('window.__ai.noteContent', `Fixture RSSI reference. ${malicious}`); await click('window.__ai.noteSaveButton');
        await until(() => run('!window.__ai.libraryBusy && window.__ai.currentDocument?.builtin===false'), 'saved custom note');
        const noteId = await run('window.__ai.currentDocument.id');
        assert.equal(await run('window.__ai.noteDirty()'), false, 'successful note save clears its draft baseline');
        assert.equal((await instance.knowledge.get(noteId)).title, 'Fixture operational explanation');
        assert.equal(await run('window.__ai.documentContent.querySelector("img")'), null);
        await input('window.__ai.librarySearch', 'Fixture');
        try { await until(() => run('window.__ai.libraryList.querySelectorAll("button").length===1'), 'offline note filtering'); }
        catch (error) { throw new Error(error.message + '\n' + JSON.stringify(await run('({query:window.__ai.librarySearch.value,status:window.__ai.libraryStatus.textContent,list:window.__ai.libraryList.textContent,title:window.__ai.currentDocument?.title})'))); }
        await click('window.__ai.documentEditButton');
        assert.equal(await run('window.__ai.noteDirty()'), false, 'opening saved note does not create a draft');
        assert.equal((await blockers()).some(reason => /note/i.test(reason)), false);
        await input('window.__ai.noteTitle', 'Fixture operational explanation updated');
        await click('window.__ai.noteSaveButton'); await until(() => run('!window.__ai.libraryBusy'), 'edited note');
        assert.match((await instance.knowledge.get(noteId)).title, /updated$/);
        await click('window.__ai.documentRemoveButton');
        await until(() => run('Boolean(document.querySelector(".modal .btn.danger"))'), 'remove note dialog');
        await click('document.querySelector(".modal .btn.danger")');
        await until(() => run('!window.__ai.libraryBusy && window.__ai.currentDocument===null'), 'removed note');
        assert.equal(await instance.knowledge.get(noteId), null);
        await input('window.__ai.librarySearch', ''); await click('window.__ai.rebuildButton');
        await until(() => run('!window.__ai.libraryBusy'), 'local vector rebuild');
        assert.equal((await instance.knowledge.status()).documents, baselineStatus.documents);
        assert.equal(requests.length, requestCount, 'library actions must not contact an AI provider');

        // Prepared source must reach the main redactor whole, even across the old
        // 24k renderer boundary. Rejections retain the complete local draft.
        const boundaryContext = 'Fixture source '.padEnd(23980, '.') + key + '\n' + 'readable remainder '.repeat(500);
        await run(`window.__draftAi=window.__app.openTool('ai',{question:'q'.repeat(8001),context:${JSON.stringify(boundaryContext)}});void 0;`); await ready('__draftAi');
        assert.equal(await run('window.__draftAi.question.value.length'), 8001);
        assert.equal(await run('window.__draftAi.context.value.length'), boundaryContext.length);
        await click('window.__draftAi.askButton'); assert.equal(requests.length, requestCount, 'oversized question is rejected without a provider call');
        assert.equal(await run('window.__draftAi.question.value.length'), 8001);
        await click('window.__draftAi.previewButton'); await until(() => run('!window.__draftAi.previewBusy'), 'whole-source preview');
        assert.equal(previewSources.at(-1), boundaryContext);
        const safeBoundary = await run('window.__draftAi.context.value');
        assert.ok(safeBoundary.length <= 24000); assert.ok(!safeBoundary.includes(key.slice(0, 20))); assert.match(safeBoundary, /truncat|partial/i);
        const tooLarge = 'x'.repeat(256 * 1024 + 1);
        await input('window.__draftAi.context', tooLarge); await click('window.__draftAi.previewButton');
        await until(() => run('!window.__draftAi.previewBusy'), 'oversized context rejection');
        assert.equal(await run('window.__draftAi.context.value.length'), tooLarge.length); assert.equal(await run('window.__draftAi.previewValue'), null);
        assert.equal(await run('window.__draftAi.shareContext.checked'), false); assert.equal(requests.length, requestCount);
        await close('__draftAi', 'Cancel');
        assert.equal(await run('window.__app.tabs.includes(window.__draftAi)'), true);
        assert.equal(await run('window.__draftAi.context.value.length'), tooLarge.length);
        await close('__draftAi', 'Discard drafts and close');
        assert.equal(await run('window.__app.tabs.includes(window.__draftAi)'), false);

        const longArticle = 'Reference title\n\n' + boundaryContext;
        await run(`window.__draftAi=window.__app.openTool('ai');void 0;`); await ready('__draftAi');
        await run(`window.__draftAi.currentDocument={id:'fixture-long',title:'Reference title',content:${JSON.stringify(boundaryContext)}};window.__draftAi.updateControls();void 0;`);
        await click('window.__draftAi.documentAskButton'); await until(() => run('!window.__draftAi.previewBusy'), 'whole article preview');
        assert.equal(previewSources.at(-1), longArticle);
        assert.ok((await run('window.__draftAi.context.value')).length <= 24000);
        assert.equal(await run(`window.__draftAi.context.value.includes(${JSON.stringify(key.slice(0, 20))})`), false);
        const preparedArticle = await run('[window.__draftAi.question.value,window.__draftAi.context.value]');
        await run(`window.__draftAi.currentDocument={id:'fixture-oversize',title:'Rejected article',content:${JSON.stringify(tooLarge)}};window.__draftAi.updateControls();void 0;`);
        await click('window.__draftAi.documentAskButton'); await choose('Replace draft');
        await until(() => run('!window.__draftAi.previewBusy'), 'rejected article preparation');
        assert.deepEqual(await run('[window.__draftAi.question.value,window.__draftAi.context.value]'), preparedArticle);
        assert.equal(requests.length, requestCount, 'preparing/rejecting source never starts a request');
        await close('__draftAi', 'Discard drafts and close');
        await run('window.__app.activate(window.__ai);void 0;'); await ready();

        // Supported tools now attach explicitly selected evidence to KonX-AI.
        // Standalone AI provider/draft coverage above remains independent.
        const attachEvidence = async (tab, label, kind, count) => {
          await click(`window.${tab}.el.querySelector('[aria-label="Ask KonX-AI about this evidence"]')`);
          assert.equal(requests.length, requestCount, 'opening an evidence chooser must not send anything');
          await click(`Array.from(document.querySelectorAll('.ctx .item')).find(el=>el.textContent.trim()===${JSON.stringify(label)})`);
          await until(() => run(`window.__app.copilot?.conversation?.attachments.length===${count} && !window.__app.copilot.busy && window.__app.tabs.includes(window.__app.copilot.panel)`), 'explicit ' + kind + ' attachment');
          const snapshot = await run('window.__app.copilot.conversation.attachments.at(-1).snapshot');
          assert.equal(snapshot.kind, kind); assert.equal(snapshot.source.tabId, await run(`window.${tab}.id`));
          assert.equal(requests.length, requestCount); assert.equal(await run('window.__app.jobs.size'), 0);
          assert.equal(await run('window.__app.copilot.prepared'), null);
          return snapshot;
        };
        await run('window.__wifi=window.__app.openTool("wifi");window.__wifi.report={schemaVersion:1,kind:"wifi",collectedAt:"2026-10-23T12:00:00Z",adapters:[],networks:[],channels:[],findings:[{id:"weak",title:"Fixture weak signal",status:"warning",evidence:"Observed -75 dBm",remediation:"Check coverage"}],limitations:["Synthetic cached survey"],password:"DO_NOT_SHARE"};window.__wifi.renderReport();void 0;');
        const wifiSnapshot = await attachEvidence('__wifi', 'Retained Wi-Fi survey', 'wifi', 1);
        assert.match(JSON.stringify(wifiSnapshot), /Fixture weak signal/); assert.ok(!JSON.stringify(wifiSnapshot).includes('DO_NOT_SHARE'));
        await run('window.__security=window.__app.openTool("security");window.__security.report={schemaVersion:1,kind:"windows",title:"Fixture assessment",target:"Fixture host",scannedAt:"2026-10-23T12:00:00Z",checks:[{id:"firewall",title:"Fixture firewall finding",status:"unknown",severity:"info",confidence:"low",evidence:"Unavailable",remediation:"",reference:""}],limitations:["Synthetic assessment"]};window.__security.renderReport();void 0;');
        const securitySnapshot = await attachEvidence('__security', 'Retained assessment checks', 'security', 2);
        assert.equal(securitySnapshot.facts.rows[0].status, 'unknown'); assert.match(JSON.stringify(securitySnapshot), /Fixture firewall finding/);
        await run('(async()=>{window.__capture=window.__app.openTool("capture");const {createComparisonDemo}=await import("./js/capture/sample-compare.mjs");const demo=createComparisonDemo();await window.__capture.loadBytes(demo.before.bytes,demo.before.name);window.__capture.select(5);window.__capture.sideBody.append(document.createTextNode("DOM_TEXT_MUST_NOT_BE_READ"));})()');
        const packetSnapshot = await attachEvidence('__capture', 'Selected packet · decoded fields', 'capture-packet', 3);
        assert.equal(packetSnapshot.facts.rows[0].no, 6); assert.ok(packetSnapshot.facts.rows[0].fields['tcp.srcport']);
        assert.ok(!JSON.stringify(packetSnapshot).includes('DOM_TEXT_MUST_NOT_BE_READ')); assert.equal(Object.hasOwn(packetSnapshot.facts.rows[0], 'data'), false);
        await run('window.__copilotPanel=window.__app.copilot.panel;void 0;'); await close('__copilotPanel', 'Discard draft');

        // Re-activating another AI tab reloads the revision and invalidates previews.
        await run('window.__app.activate(window.__ai);void 0;'); await ready();
        await input('window.__ai.context', 'rssi=-69'); await click('window.__ai.previewButton');
        await until(() => run('window.__ai.previewValue!==null'), 'preview before another tab changes settings');
        await click('window.__ai.shareContext');
        await run('window.__otherAi=window.__app.openTool("ai");void 0;'); await ready('__otherAi');
        await input('window.__otherAi.provider', 'openai', 'change'); await click('window.__otherAi.saveButton'); await ready('__otherAi');
        await run('window.__app.activate(window.__ai);void 0;'); await ready();
        assert.equal(await run('window.__ai.config.revision===window.__otherAi.config.revision'), true);
        assert.equal(await run('window.__ai.shareContext.checked'), false); assert.equal(await run('window.__ai.shareContext.disabled'), true);
        assert.equal(requests.length, requestCount);

        for (const [width, height] of [[900, 560], [1400, 880]]) {
          await setViewport(win, run, width, height); await pause(50);
          const bounds = await run('(() => {const el=window.__ai.el,r=el.getBoundingClientRect(),content=el.querySelector(".ai-workspace");return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,view:[r.left,r.top,r.right,r.bottom],content:[content.clientHeight,content.scrollHeight,content.clientWidth,content.scrollWidth]};})()');
          assert.ok(bounds.documentWidth <= bounds.width + 2, JSON.stringify(bounds));
          assert.ok(bounds.view[0] >= -2 && bounds.view[2] <= bounds.width + 2 && bounds.view[3] <= bounds.height + 2, JSON.stringify(bounds));
          assert.ok(bounds.content[0] >= 150 && bounds.content[1] > bounds.content[0], JSON.stringify(bounds));
          assert.ok(bounds.content[3] <= bounds.content[2] + 2, JSON.stringify(bounds));
          for (const name of ['provider', 'key', 'question', 'previewButton', 'askButton', 'librarySearch', 'newDocumentButton']) {
            const rect = await run(`(() => {const el=window.__ai.${name};el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom,innerWidth,innerHeight];})()`);
            assert.ok(rect[0] >= -2 && rect[1] >= -2 && rect[2] <= rect[4] + 2 && rect[3] <= rect[5] + 2, `${name} unreachable at ${width}: ${JSON.stringify(rect)}`);
          }
          assert.equal(await run('[window.__ai.provider,window.__ai.model,window.__ai.key,window.__ai.question,window.__ai.context,window.__ai.librarySearch].every(el=>el.getAttribute("aria-label"))'), true);
          if (screenshotRoot) {
            await until(() => run('!document.querySelector("#toasts .toast")'), 'AI fixture toasts expire before screenshots', 8500);
            await run('window.__ai.el.querySelector(".ai-workspace").scrollTop=0;void 0;'); await pause(60);
            fs.writeFileSync(path.join(screenshotRoot, `ai-${width}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
            await run('window.__ai.librarySearch.scrollIntoView({block:"start"});void 0;'); await pause(60);
            fs.writeFileSync(path.join(screenshotRoot, `ai-library-${width}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
          }
        }

        // Cancellation, tab disposal and configuration replacement stop transport.
        failNext = true; await input('window.__ai.question', 'A failed request keeps this new question');
        await ask(); assert.equal(await run('window.__ai.assistantDirty()'), true);
        assert.equal(await run('window.__ai.question.value'), 'A failed request keeps this new question');
        delay = true; await click('window.__ai.askButton'); await until(() => pending.size === 1, 'pending AI request');
        await click('window.__ai.cancelButton'); await idle(); assert.equal(cancelled, 1); assert.equal(await run('window.__app.jobs.size'), 0);
        assert.equal(await run('window.__ai.assistantDirty()'), true, 'cancelled request does not consume its draft');
        await click('window.__ai.askButton'); await until(() => pending.size === 1, 'AI request before closing tab');
        await click('window.__app.tabbar.children[window.__app.tabs.indexOf(window.__ai)].querySelector("button.close")');
        await choose('Cancel'); assert.equal(pending.size, 1); assert.equal(await run('window.__app.tabs.includes(window.__ai)'), true);
        await close('__ai', 'Cancel request and close');
        await until(() => pending.size === 0, 'AI tab disposal cancels transport'); assert.equal(cancelled, 2); assert.equal(await run('window.__app.jobs.size'), 0);
        await run('window.__ai=window.__app.openTool("ai");void 0;'); await ready();
        await input('window.__ai.question', 'Explain RSSI'); await click('window.__ai.askButton'); await until(() => pending.size === 1, 'AI request before configuration replacement');
        instance.configure({ provider: 'openai', key });
        // Main IPC is responsible for cancelling existing jobs on configure.
        await run('window.__app.activate(window.__otherAi);void 0;'); await ready('__otherAi');
        await click('window.__otherAi.saveButton'); await ready('__otherAi'); await idle();
        assert.equal(cancelled, 3); assert.equal(await run('window.__app.jobs.size'), 0);
        await click('window.__otherAi.forgetButton'); await ready('__otherAi');
        assert.equal(await run('window.__otherAi.config.hasKey'), false); assert.equal(await run('window.__otherAi.key.value'), '');
        // Failed storage must offer an explicit Forget repair even with no key.
        instance.storageError = 'Synthetic unreadable AI settings'; instance.revision = 'fixture-storage-warning';
        await run('window.__otherAi.loadConfig()'); await ready('__otherAi');
        assert.equal(await run('window.__otherAi.config.hasKey'), false);
        assert.equal(await run('window.__otherAi.forgetButton.disabled'), false);
        await click('window.__otherAi.forgetButton'); await ready('__otherAi');
        assert.equal(await run('Boolean(window.__otherAi.config.warning)'), false);
        // A fulfilled error status cannot be displayed as a healthy index.
        const realStatus = instance.knowledge.status.bind(instance.knowledge);
        instance.knowledge.status = async () => ({ state: 'error', error: 'Synthetic index failure', algorithm: 'Local TF-IDF cosine vectors' });
        await run('window.__otherAi.loadLibrary()');
        assert.match(await run('window.__otherAi.libraryStatus.textContent'), /Synthetic index failure/);
        assert.equal(await run('window.__otherAi.libraryStatus.textContent.includes("Local TF-IDF vector index")'), false);
        instance.knowledge.status = realStatus;
        console.log('AI_UI_PASS: five real provider adapters with synthetic transport, encrypted keys, offline SQLite/vector CRUD, full-source redaction, draft close/update protection, failed/cancelled work retention, escaped answers, citation reading, explicit KonX-AI evidence routing, 900x560 layout, revision refresh and cancellation');
        finish(0);
      } catch (error) { finish(1, error); }
    });
  });
  require('../src/main/main');
}

module.exports = { runAiUiTests };
if (process.versions.electron && process.argv.includes('--electron-ai-fixture')) electronFixture().catch((error) => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runAiUiTests(async (name, test) => { await test(); console.log('PASS ' + name); }).catch((error) => { console.error(error); process.exitCode = 1; });
