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
    let child, output = '';
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
      assert.equal(code, 0, output); assert.match(output, /AI_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) child.kill();
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
  let delay = false, cancelled = 0, instance, finished = false;
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
        const res = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'application/json' }; res.destroy = () => {};
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
    if (error) console.error(error.stack || error);
    for (const req of [...pending]) req.destroy();
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.exit(code);
  };
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
        await until(() => run('window.__ai.libraryList.querySelectorAll("button").length>0'), 'built-in offline references');
        assert.equal(requests.length, 0); assert.equal(await run('window.__app.jobs.size'), 0);
        assert.deepEqual(await run('[...window.__ai.provider.options].map(item=>item.value)'), ['openai', 'anthropic', 'gemini', 'nyquest', 'custom']);
        assert.equal(await run('window.__ai.key.type'), 'password'); assert.equal(await run('window.__ai.askButton.disabled'), true);
        assert.match(await run('window.__ai.libraryStatus.textContent'), /TF-IDF/);
        const baselineStatus = await instance.knowledge.status(); assert.ok(baselineStatus.documents >= 10); assert.ok(baselineStatus.chunks > 0);

        // A failed save clears the password field too; use real validation failure.
        await input('window.__ai.key', 'not a valid key'); await click('window.__ai.saveButton'); await ready();
        assert.equal(await run('window.__ai.key.value'), ''); assert.equal(await run('window.__ai.config.hasKey'), false);
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
        assert.equal(await run('Boolean(window.__aiInjected)'), false); assert.equal(await run('window.__ai.answer.querySelector("img")'), null);
        assert.ok((await run('window.__ai.answer.textContent')).includes(malicious));
        assert.ok(requests.at(-1).envelope.references.length > 0); assert.ok(await run('window.__ai.sourceList.querySelectorAll("button").length>0'));
        assert.match(await run('window.__ai.sourceList.textContent'), /\[K1\]/);
        await click('window.__ai.sourceList.querySelector("button")');
        await until(() => run('Boolean(window.__ai.currentDocument)'), 'citation article');
        assert.ok(await run('window.__ai.documentContent.textContent.length>50'));
        await click('window.__ai.documentSourceButton'); assert.equal(openedSources.length, 1); assert.match(openedSources[0], /^https:\/\//);
        await click('window.__ai.documentAskButton');
        assert.equal(await run('window.__ai.shareContext.checked'), false); assert.equal(requests.length, 1);

        await input('window.__ai.context', `password=SECRET_FIXTURE_PASSWORD\nkey=${key}\nrssi=-67`);
        await click('window.__ai.previewButton');
        await until(() => run('!window.__ai.previewBusy && window.__ai.previewValue!==null'), 'redacted context preview');
        assert.equal(await run('window.__ai.shareContext.checked'), false);
        assert.equal(await run('window.__ai.context.value.includes("SECRET_FIXTURE_PASSWORD")'), false);
        assert.equal(await run(`window.__ai.preview.textContent.includes(${JSON.stringify(key)})`), false);
        await click('window.__ai.shareContext'); await ask();
        assert.match(requests.at(-1).envelope.toolContext, /\[Redacted\]/); assert.ok(!requests.at(-1).envelope.toolContext.includes(key));
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
        await input('window.__ai.noteTitle', 'Fixture operational explanation'); await input('window.__ai.noteVendor', 'Fixture vendor');
        await input('window.__ai.noteSource', 'https://example.invalid/documentation');
        await input('window.__ai.noteContent', `Fixture RSSI reference. ${malicious}`); await click('window.__ai.noteSaveButton');
        await until(() => run('!window.__ai.libraryBusy && window.__ai.currentDocument?.builtin===false'), 'saved custom note');
        const noteId = await run('window.__ai.currentDocument.id');
        assert.equal((await instance.knowledge.get(noteId)).title, 'Fixture operational explanation');
        assert.equal(await run('window.__ai.documentContent.querySelector("img")'), null);
        await input('window.__ai.librarySearch', 'Fixture');
        try { await until(() => run('window.__ai.libraryList.querySelectorAll("button").length===1'), 'offline note filtering'); }
        catch (error) { throw new Error(error.message + '\n' + JSON.stringify(await run('({query:window.__ai.librarySearch.value,status:window.__ai.libraryStatus.textContent,list:window.__ai.libraryList.textContent,title:window.__ai.currentDocument?.title})'))); }
        await click('window.__ai.documentEditButton'); await input('window.__ai.noteTitle', 'Fixture operational explanation updated');
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

        // The real tool result button offers a preview; it never starts a job.
        await run('window.__wifi=window.__app.openTool("wifi");window.__wifi.report={kind:"wifi",findings:[{title:"Fixture weak signal",rssi:-75}],password:"DO_NOT_SHARE"};void 0;');
        await click('window.__wifi.el.querySelector(".tool-title button")');
        await until(() => run('window.__app.activeTab?.toolKind==="ai" || window.__app.tabs.at(-1)?.toolKind==="ai"'), 'explain result AI tab');
        await run('window.__explained=window.__app.tabs.at(-1);void 0;'); await ready('__explained');
        assert.match(await run('window.__explained.context.value'), /Fixture weak signal/);
        assert.equal(await run('window.__explained.context.value.includes("DO_NOT_SHARE")'), false);
        assert.equal(await run('window.__explained.shareContext.checked'), false); assert.equal(await run('window.__app.jobs.size'), 0);
        assert.equal(requests.length, requestCount);
        await run('window.__security=window.__app.openTool("security");window.__security.report={kind:"windows",checks:[{title:"Fixture firewall finding",status:"unknown"}]};void 0;');
        await click('window.__security.el.querySelector(".tool-title button")');
        await until(() => run('window.__app.tabs.at(-1).toolKind==="ai"'), 'Security Explain result tab');
        assert.match(await run('window.__app.tabs.at(-1).context.value'), /Fixture firewall finding/);
        await run('window.__capture=window.__app.openTool("capture");window.__capture.statsEl.textContent="Fixture packet statistics: 12 packets";window.__capture.sideBody.textContent="Fixture retransmission observation";window.__capture.packets=[{data:"PRIVATE_PACKET_BYTES_MUST_NOT_BE_READ"}];void 0;');
        assert.equal(await run('window.__capture.el.querySelectorAll("button[title]").length>0'), true);
        const captureExplain = 'Array.from(window.__capture.el.querySelectorAll("button")).find(el=>el.textContent.includes("Explain with AI"))';
        await click(captureExplain);
        await until(() => run('window.__app.tabs.at(-1).toolKind==="ai"'), 'Packet Capture Explain result tab');
        assert.match(await run('window.__app.tabs.at(-1).context.value'), /Fixture packet statistics/);
        assert.equal(await run('window.__app.tabs.at(-1).context.value.includes("PRIVATE_PACKET_BYTES_MUST_NOT_BE_READ")'), false);
        assert.equal(requests.length, requestCount); assert.equal(await run('window.__app.jobs.size'), 0);

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
        delay = true; await click('window.__ai.askButton'); await until(() => pending.size === 1, 'pending AI request');
        await click('window.__ai.cancelButton'); await idle(); assert.equal(cancelled, 1); assert.equal(await run('window.__app.jobs.size'), 0);
        await click('window.__ai.askButton'); await until(() => pending.size === 1, 'AI request before closing tab');
        await click('window.__app.tabbar.children[window.__app.tabs.indexOf(window.__ai)].querySelector("button.close")');
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
        console.log('AI_UI_PASS: five real provider adapters with synthetic transport, encrypted keys, offline SQLite/vector CRUD, explicit redacted context, escaped answers, citation reading, Explain with AI, 900x560 layout, revision refresh and cancellation');
        finish(0);
      } catch (error) { finish(1, error); }
    });
  });
  require('../src/main/main');
}

module.exports = { runAiUiTests };
if (process.versions.electron && process.argv.includes('--electron-ai-fixture')) electronFixture().catch((error) => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runAiUiTests(async (name, test) => { await test(); console.log('PASS ' + name); }).catch((error) => { console.error(error); process.exitCode = 1; });
