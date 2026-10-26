'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');

const themeIds = ['arc-reactor', 'chroma-rgb', 'matrix-mainframe', 'synthwave-grid', 'hologram-prism', 'plasma-forge'];
const staticIds = ['obsidian-gold', 'arctic-glass', 'deep-ocean', 'sandstone', 'crimson-circuit'];
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error('Timed out: ' + description);
    await pause();
  }
}

async function runFixture(reduced) {
  const tempRoot = path.resolve(os.tmpdir());
  const fixtureRoot = fs.mkdtempSync(path.join(tempRoot, 'konx-theme-ui-test-'));
  let child, output = '';
  try {
    const env = { ...process.env, KONX_USERDATA: path.join(fixtureRoot, 'profile'),
      KONX_THEME_TEST_ROOT: fixtureRoot, KONX_THEME_TEST_REDUCED: reduced ? '1' : '',
      KONX_CAPTURE: '', KONX_DEMO: '' };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(require('electron'), [__filename, '--electron-theme-fixture'], {
      windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = (data) => { output = (output + data).slice(-1024 * 1024); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Theme UI fixture timed out\n' + output)); }, 85000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
    });
    assert.equal(code, 0, output);
    assert.match(output, reduced ? /THEME_REDUCED_UI_PASS/ : /THEME_UI_PASS/);
    const saved = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'profile', 'settings.json'), 'utf8'));
    assert.equal(saved.uiTheme, reduced ? 'arc-reactor' : 'plasma-forge');
    assert.equal(saved.colorScheme, 'app');
    assert.equal(saved.themeAnimations, reduced);
  } finally {
    if (child && child.exitCode == null) child.kill();
    assert.equal(path.dirname(path.resolve(fixtureRoot)), tempRoot);
    assert.ok(path.basename(fixtureRoot).startsWith('konx-theme-ui-test-'));
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function runThemeUiTests(test) {
  await test('real theme UI: eleven custom themes, picker save, terminal/editor output, compact toolbar, pause persistence and classic palettes', () => runFixture(false));
  await test('real theme UI: Windows reduced motion stops effects and disables the motion toggle', () => runFixture(true));
}

function screenshotDirectory() {
  if (!process.env.KONX_THEME_SCREENSHOT_DIR) return null;
  const reviewRoot = fs.realpathSync(path.join(__dirname, '..', 'review'));
  const requested = path.resolve(process.env.KONX_THEME_SCREENSHOT_DIR);
  const contained = (value) => {
    const relative = path.relative(reviewRoot, value);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  assert.ok(contained(requested), 'Theme screenshots must be inside workspace/review');
  let ancestor = requested;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  assert.ok(ancestor === reviewRoot || contained(fs.realpathSync(ancestor)), 'Theme screenshot parent resolves outside workspace/review');
  fs.mkdirSync(requested, { recursive: true });
  const result = fs.realpathSync(requested);
  assert.ok(contained(result), 'Theme screenshot directory resolves outside workspace/review');
  return result;
}

async function electronFixture() {
  const { app, BrowserWindow, dialog, shell } = require('electron');
  const fixtureRoot = path.resolve(process.env.KONX_THEME_TEST_ROOT || '');
  assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixtureRoot).startsWith('konx-theme-ui-test-'));
  const reduced = process.env.KONX_THEME_TEST_REDUCED === '1';
  if (reduced) app.commandLine.appendSwitch('force-prefers-reduced-motion');
  const screenshots = screenshotDirectory();
  let finished = false;
  const failures = [];
  // Themes must never initiate transport, capture, an external link, or a native file dialog.
  const failUnexpected = (kind) => { throw new Error('Theme fixture unexpectedly invoked ' + kind); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, engine: null,
    missing: false, error: 'Synthetic unavailable capture fixture', npcap: { available: false }, builtin: { available: false } });
  require('../src/main/ai').AIClient.prototype.run = async () => failUnexpected('AI provider request');
  require('../src/main/connections').ConnectionManager.prototype.open = async () => failUnexpected('remote connection');
  shell.openExternal = async () => failUnexpected('external browser');
  dialog.showOpenDialog = async () => failUnexpected('open dialog');
  dialog.showSaveDialog = async () => failUnexpected('save dialog');
  dialog.showErrorBox = (title, message) => failUnexpected('native error: ' + title + ': ' + message);
  const finish = (code, error) => {
    if (finished) return; finished = true;
    if (error) console.error(error.stack || error);
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.exit(code);
  };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) failures.push(message); });
    win.webContents.once('did-finish-load', async () => {
      try {
        const run = (code) => win.webContents.executeJavaScript(code).catch((error) => {
          throw new Error(error.message + '\nFixture expression: ' + code.slice(0, 500));
        });
        const click = async (expression) => {
          let point;
          await until(async () => {
            point = await run(`(() => { const el=${expression}; if(!el) throw new Error('Missing theme fixture control'); el.scrollIntoView({block:'nearest',inline:'nearest'}); const r=el.getBoundingClientRect();
              if(!r.width||!r.height||el.disabled)return{ready:false}; const x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);
              return{x,y,ready:el===hit||el.contains(hit)};})()`);
            return point.ready;
          }, 'reachable theme control ' + expression, 7000);
          delete point.ready;
          win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
          win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
          await pause(25);
        };
        const save = async (patch) => { await run(`window.__app.saveSettings(${JSON.stringify(patch)}).then(()=>undefined)`); await pause(35); };
        const picker = `[...document.querySelectorAll('.modal select')].find(el=>[...el.options].some(option=>option.value==='obsidian-gold'))`;
        const chooseTheme = async (id) => {
          await click(`document.querySelector('#toolbar button[title="Settings"]')`);
          await until(() => run(`Boolean(${picker})`), 'application theme picker');
          assert.deepEqual(await run(`[...(${picker}).options].map(option=>option.value)`), ['dark', 'light', ...themeIds, ...staticIds]);
          // Select a real option after verifying that the form control is
          // reachable, then use native input for Save. The form owns persistence.
          assert.equal(await run(`(()=>{const e=${picker};e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===e;})()`), true);
          await run(`(()=>{const choice=${picker};choice.value=${JSON.stringify(id)};choice.dispatchEvent(new Event('change',{bubbles:true}));})()`);
          assert.notEqual(await run('document.documentElement.dataset.theme'), id, 'Choosing a theme must wait for Save');
          await click(`[...document.querySelectorAll('.modal footer button')].find(button=>button.textContent==='Save')`);
          await until(() => run(`document.documentElement.dataset.theme===${JSON.stringify(id)}`), 'theme saved from Appearance');
          assert.equal(JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'profile', 'settings.json'), 'utf8')).uiTheme, id);
        };
        const capture = async (name) => {
          if (!screenshots) return;
          // DOM/xterm render completion can precede Chromium's compositor. Wait
          // through two paint opportunities before capturing this inactive window.
          await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          await pause(100);
          fs.writeFileSync(path.join(screenshots, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
        };
        const readable = async (expression, label) => {
          const result = await run(`(()=>{
            const element=${expression};if(!element)throw Error('Missing contrast target');
            const ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
            const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].map(v=>v/255);};
            const over=(a,b)=>[0,1,2].map(i=>a[i]*a[3]+b[i]*(1-a[3]));
            const ancestors=[];for(let e=element;e;e=e.parentElement)ancestors.unshift(e);
            let background=[1,1,1];for(const e of ancestors)background=over(rgba(getComputedStyle(e).backgroundColor),background);
            const color=getComputedStyle(element).color,foreground=over(rgba(color),background);
            const luminance=rgb=>rgb.map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
            const a=luminance(foreground),b=luminance(background);
            return{color,background,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
          })()`);
          assert.ok(result.ratio >= 4.5, label + ': ' + JSON.stringify(result));
        };
        await until(() => run('Boolean(window.__app)'), 'application initialization');
        await until(() => run('!document.hidden'), 'visible but transparent fixture');
        assert.equal(await run("document.querySelectorAll('[data-action=\"update-konx\"]').length"), 1);
        assert.equal(await run("[...document.querySelectorAll('.welcome button')].some(button=>button.textContent.includes('Update KonX'))"), false);
        await click(`document.querySelector('#toolbar [data-action="update-konx"]')`);
        await until(() => run("!!document.querySelector('.update-status')?.textContent.includes('packaged')"), 'header opens development update status');
        await click(`document.querySelector('.modal footer button')`);
        await until(() => run("!document.querySelector('.update-panel')"), 'header update dialog closes');
        await save({ copyOnSelect: false, colorScheme: 'app', themeAnimations: true });
        await run(`(async()=>{
          window.__themeModule=await import('./js/themes.js');
          window.__np=await window.__app.openNotepad();
          window.__np.newDoc({title:'Theme fixture.ios',text:'hostname theme-fixture\\ninterface GigabitEthernet1/0/1\\n description Synthetic preview\\n ip address 192.0.2.1 255.255.255.0\\n!',language:'ios'});
          const {TerminalTab}=await import('./js/terminal.js');
          window.__term=new TerminalTab(window.__app,{}, {name:'Theme fixture',protocol:'ssh'});
          window.__app.addTab(window.__term);
          await new Promise(resolve=>window.__term.term.write('KonX theme fixture\\r\\n\\x1b[32mSynthetic output only\\x1b[0m\\r\\nrouter# show interfaces\\r\\n',resolve));
        })()`);
        assert.equal(await run('window.__app.jobs.size'), 0);
        assert.equal(await run('window.__term.term.options.allowTransparency'), true);
        if (!reduced) await run(`(async()=>{const {makeRtpDemo}=await import('./js/capture/sample-rtp.mjs');
          const {createComparisonDemo}=await import('./js/capture/sample-compare.mjs');const {readCapture,writePcapng}=await import('./js/capture/pcapfile.mjs');
          const sip=readCapture(makeRtpDemo().bytes).packets.slice(0,2),tcp=readCapture(createComparisonDemo().after.bytes).packets;
          window.__cap=window.__app.openTool('capture');await window.__cap.loadBytes(writePcapng([...sip,...tcp]),'theme-sip-and-tcp.pcapng');return true;})()`);
        const geometry = async (width, height) => {
          await setViewport(win, run, width, height); await pause(60);
          const bounds = await run(`(() => { const toolbar=document.querySelector('#toolbar'),r=toolbar.getBoundingClientRect();
            const controls=[...toolbar.querySelectorAll('button')].filter(el=>getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().width);
            return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,toolbar:[r.left,r.top,r.right,r.bottom],
              controls:controls.map(el=>({name:el.title||el.textContent,rect:(()=>{const b=el.getBoundingClientRect();return[b.left,b.top,b.right,b.bottom]})()})),
              headerInside:window.__app.themeHeader.parentElement===toolbar,viewTop:window.__term.wrap.getBoundingClientRect().top,
              updateAtRight:toolbar.lastElementChild.matches('[data-action="update-konx"]'),
              updateReachable:(()=>{const b=toolbar.lastElementChild,r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return b===hit||b.contains(hit)})()};})()`);
          assert.ok(bounds.documentWidth <= bounds.width + 2, JSON.stringify(bounds));
          assert.ok(bounds.toolbar[3] - bounds.toolbar[1] <= 48, 'The theme must retain a compact toolbar: ' + JSON.stringify(bounds));
          assert.equal(bounds.headerInside, true);
          assert.equal(bounds.updateAtRight, true);
          assert.equal(bounds.updateReachable, true, 'Header updater must remain reachable at ' + width + ': ' + JSON.stringify(bounds));
          assert.ok(bounds.viewTop < 180, 'A hero banner must not push terminal output down: ' + JSON.stringify(bounds));
          for (const control of bounds.controls) {
            assert.ok(control.rect[0] >= -2 && control.rect[2] <= bounds.width + 2 && control.rect[1] >= -2 && control.rect[3] <= bounds.toolbar[3] + 2,
              'Toolbar control clipped at ' + width + ': ' + JSON.stringify(control));
          }
        };
        for (const id of reduced ? ['arc-reactor'] : [...themeIds, ...staticIds]) {
          const animated = themeIds.includes(id);
          if (animated) await save({ uiTheme: id, colorScheme: 'app', themeAnimations: true });
          else await chooseTheme(id);
          await run('window.__app.activate(window.__term);void 0;');
          const terminal = await run(`(() => { const fx=window.__term.wrap.querySelector('.theme-output-fx'),root=document.documentElement;
            window.__term.term.selectAll(); return {theme:root.dataset.theme,animated:root.classList.contains('theme-animated'),
            header:window.__app.themeName.textContent,headerHidden:window.__app.themeHeader.classList.contains('hidden'),motionHidden:getComputedStyle(window.__app.themeMotion).display==='none',
            background:window.__term.term.options.theme.background,foreground:window.__term.term.options.theme.foreground,
            fxCount:window.__term.wrap.querySelectorAll(':scope > .theme-output-fx').length,display:getComputedStyle(fx).display,pointer:getComputedStyle(fx).pointerEvents,
            aria:fx.getAttribute('aria-hidden'),selection:window.__term.term.getSelection()};})()`);
          assert.equal(terminal.theme, id); assert.equal(terminal.animated, animated);
          assert.equal(terminal.header, await run(`window.__themeModule.applicationTheme(${JSON.stringify(id)}).label`));
          assert.equal(terminal.headerHidden, false); assert.equal(terminal.motionHidden, !animated);
          assert.equal(terminal.background, animated ? '#00000000' : await run(`window.__themeModule.scheme('app',${JSON.stringify(id)}).background`));
          assert.equal(terminal.foreground, await run(`window.__themeModule.applicationTheme(${JSON.stringify(id)}).foreground`));
          assert.equal(terminal.fxCount, 1); assert.equal(terminal.display, animated ? 'block' : 'none');
          if (animated) assert.equal(terminal.pointer, 'none');
          assert.equal(terminal.aria, 'true');
          assert.ok(terminal.selection.includes('Synthetic output only')); assert.ok(!terminal.selection.includes('01010'));
          await until(() => run('window.__term.term.element.querySelector(".xterm-selection").childElementCount>0'), 'terminal selection painted');
          // Wait for xterm's render event after clearing the temporary selection.
          // A transparent inactive fixture can otherwise be captured before its
          // old selection canvas has been repainted.
          await run(`new Promise(resolve=>{const listener=window.__term.term.onRender(()=>{listener.dispose();resolve();});
            window.__term.term.clearSelection();window.__term.term.refresh(0,window.__term.term.rows-1);})`);
          assert.equal(await run('window.__term.term.getSelection()'), '');
          await until(() => run('window.__term.term.element.querySelector(".xterm-selection").childElementCount===0'), 'terminal selection paint cleared');
          await geometry(1400, 880); await capture(id + '-terminal-1400');
          await geometry(1101, 560);
          await geometry(1361, 560);
          await geometry(1401, 560);
          await geometry(900, 560); await capture(id + '-terminal-900');
          await run('window.__app.activate(window.__np);void 0;'); await pause(60);
          const editor = await run(`(() => { const editor=window.__np.host.querySelector('.monaco-editor'),fx=window.__np.host.querySelector('.theme-output-fx');
            window.__np.editor.setSelection({startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:9});
            const desired=document.createElement('span');desired.style.color=window.__themeModule.applicationTheme(document.documentElement.dataset.theme).foreground;
            document.body.append(desired);const expected=getComputedStyle(desired).color;desired.remove();
            desired.style.color=window.__themeModule.scheme('app',document.documentElement.dataset.theme).background;document.body.append(desired);
            const expectedBackground=getComputedStyle(desired).color;desired.remove();
            return {name:window.__np.theme(),background:getComputedStyle(editor).backgroundColor,foreground:getComputedStyle(editor).color,expected,expectedBackground,
              display:getComputedStyle(fx).display,pointer:getComputedStyle(fx).pointerEvents,fxCount:window.__np.host.querySelectorAll(':scope > .theme-output-fx').length,
              selection:window.__np.current.model.getValueInRange(window.__np.editor.getSelection())};})()`);
          assert.equal(editor.name, 'konx-' + id); assert.equal(editor.background, animated ? 'rgba(0, 0, 0, 0)' : editor.expectedBackground);
          assert.equal(editor.foreground, editor.expected); assert.equal(editor.display, animated ? 'block' : 'none');
          if (animated) assert.equal(editor.pointer, 'none');
          assert.equal(editor.fxCount, 1); assert.equal(editor.selection, 'hostname');
          await setViewport(win, run, 1400, 880); await pause(60); await capture(id + '-notepad-1400');
          if (!animated) {
            await run('window.__app.activate(window.__cap);window.__cap.select(0);void 0;');
            await until(() => run('Boolean(window.__cap.el.querySelector(".prows .prow.sel"))'), 'selected packet row');
            await readable('window.__cap.el.querySelector(".prows .prow.sel")', id + ' selected packet');
            await readable('window.__cap.el.querySelector(".prows .prow.c-expert:not(.sel)")', id + ' unselected TCP expert packet');
            await capture(id + '-capture-1400');
            await click('window.__cap.sipButton');
            await until(() => run('Boolean(document.querySelector(".sip-call-row.active"))'), 'sample SIP call');
            await readable('document.querySelector(".sip-call-row.active .sip-call-id")', id + ' selected SIP call ID');
            await readable('document.querySelector(".sip-call-row.active .sip-call-meta")', id + ' selected SIP call metadata');
            await readable('document.querySelector(".sip-message-detail")', id + ' SIP message detail');
            await capture(id + '-sip-1400');
            await click(`[...document.querySelectorAll('.modal footer button')].find(button=>button.textContent==='Close')`);
            await until(() => run('!document.querySelector(".sip-workspace")'), 'SIP dialog closes');
          }
        }
        if (reduced) {
          assert.equal(await run('matchMedia("(prefers-reduced-motion: reduce)").matches'), true);
          assert.equal(await run('window.__app.themeMotion.disabled'), true);
          assert.equal(await run('window.__app.themeMotion.textContent'), 'Reduced motion');
          assert.equal(await run('getComputedStyle(document.querySelector("#app"),"::after").animationName'), 'none');
          assert.equal(await run('getComputedStyle(window.__np.host.querySelector(".theme-orbit")).animationName'), 'none');
          assert.deepEqual(failures, []);
          console.log('THEME_REDUCED_UI_PASS'); finish(0); return;
        }
        await run('window.__app.activate(window.__term);void 0;');
        await save({ uiTheme: 'arc-reactor', themeAnimations: true });
        assert.equal(await run('getComputedStyle(document.querySelector("#app"),"::after").animationPlayState'), 'running');
        await click('window.__app.themeMotion');
        await until(() => run('window.__app.settings.themeAnimations===false&&!window.__app.savingThemeMotion'), 'saved pause setting');
        assert.equal(await run('document.documentElement.dataset.themeMotion'), 'paused');
        assert.equal(await run('window.__app.themeMotion.textContent'), 'Resume effects');
        assert.equal(await run('getComputedStyle(document.querySelector("#app"),"::after").animationPlayState'), 'paused');
        assert.equal(await run('getComputedStyle(window.__term.wrap.querySelector(".theme-orbit")).animationPlayState'), 'paused');
        assert.equal(JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'profile', 'settings.json'), 'utf8')).themeAnimations, false);
        await click('window.__app.themeMotion');
        await until(() => run('window.__app.settings.themeAnimations===true&&!window.__app.savingThemeMotion'), 'saved resume setting');
        assert.equal(await run('getComputedStyle(document.querySelector("#app"),"::after").animationPlayState'), 'running');
        for (const id of ['dark', 'light']) {
          await save({ uiTheme: id, colorScheme: 'app' });
          assert.equal(await run('window.__app.themeHeader.classList.contains("hidden")'), true);
          assert.equal(await run('document.documentElement.classList.contains("theme-animated")'), false);
          assert.equal(await run('getComputedStyle(window.__term.wrap.querySelector(".theme-output-fx")).display'), 'none');
          assert.equal(await run('getComputedStyle(window.__np.host.querySelector(".theme-output-fx")).display'), 'none');
          assert.equal(await run('window.__np.theme()'), 'konx-' + id);
          await geometry(900, 560);
          await geometry(1101, 560);
          await geometry(1361, 560);
          await geometry(1401, 560);
        }
        await save({ uiTheme: 'chroma-rgb', colorScheme: 'solarized' });
        assert.equal(await run('window.__term.term.options.theme.background'), '#002b36');
        assert.equal(await run('getComputedStyle(window.__term.wrap.querySelector(".theme-output-fx")).display'), 'none');
        await run('window.__term.meta.colorScheme="classic";void 0;');
        await save({ uiTheme: 'plasma-forge', colorScheme: 'app', themeAnimations: false });
        assert.equal(await run('window.__term.term.options.theme.background'), '#000000');
        assert.equal(await run('getComputedStyle(window.__term.wrap.querySelector(".theme-output-fx")).display'), 'none');
        assert.equal(await run('window.__app.jobs.size'), 0);
        assert.deepEqual(failures, []);
        console.log('THEME_UI_PASS: eleven custom themes, Appearance save, static/animated xterm and Monaco, text selection, compact header, five viewport sizes, pause/resume persistence and classic overrides');
        finish(0);
      } catch (error) { finish(1, error); }
    });
  });
  require('../src/main/main');
}

module.exports = { runThemeUiTests };
if (process.versions.electron && process.argv.includes('--electron-theme-fixture')) {
  electronFixture().catch((error) => { console.error(error.stack || error); require('electron').app.exit(1); });
} else if (require.main === module) {
  runThemeUiTests(async (name, test) => { await test(); console.log('PASS ' + name); })
    .catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
}
