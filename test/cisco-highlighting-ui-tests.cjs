'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setViewport } = require('./lib/electron-viewport.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 12000;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await pause(25); }
}
const SAMPLE = 'router#show ip interface brief\r\nGi0/1 192.0.2.1 YES manual up up\r\nGi0/2 unassigned YES unset administratively down down\r\n% Invalid input detected at marker.\r\nNative café 😀\r\nSAMPLE_DONE\r\n';
const CLEAR = '\x1b[3J\x1b[2J\x1b[H';

async function peer() {
  const sockets = new Set(), pending = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let input = '';
    socket.on('data', bytes => {
      input += bytes.toString('ascii');
      let newline;
      while ((newline = input.indexOf('\n')) !== -1) {
        const command = input.slice(0, newline).trim(); input = input.slice(newline + 1);
        let chunks;
        if (command === 'sample') {
          const bytes = Buffer.from(CLEAR + SAMPLE), ip = bytes.indexOf('192.0.2.1') + 5, utf8 = bytes.indexOf(Buffer.from('é')) + 1;
          chunks = [bytes.subarray(0, ip), bytes.subarray(ip, utf8), bytes.subarray(utf8)];
        } else if (command === 'ansi') chunks = [CLEAR + '\x1b[35mGi0/1 192.0.2.9 down down\x1b[0m\r\nANSI_DONE\r\n'];
        else if (command === 'rewrite') chunks = [CLEAR + 'Gi0/1 192.0.2.1 down down\r', '\x1b[2Kplain rewritten output\r\nREWRITE_DONE\r\n'];
        else if (command === 'alternate') chunks = ['\x1b[?1049h\x1b[2J\x1b[H% Invalid input 192.0.2.33 down\r\nALT_DONE\r\n'];
        else if (command === 'normal') chunks = ['\x1b[?1049l'];
        else if (/^wrap:\d+$/.test(command)) {
          const columns = Math.max(8, Math.min(500, Number(command.slice(5))));
          chunks = [CLEAR + ' '.repeat(columns - 4) + '192.0.2.123 up\r\nWRAP_DONE\r\n'];
        } else if (command === 'scroll') chunks = [CLEAR + Array.from({ length: 180 }, (_, i) => `Gi0/1 192.0.2.${i % 250 + 1} up up\r\n`).join('') + 'SCROLL_DONE\r\n'];
        else { socket.destroy(new Error('Unexpected owned console command')); continue; }
        const operation = (async () => { for (const chunk of chunks) { if (socket.destroyed) return; socket.write(chunk); await pause(45); } })();
        pending.add(operation); operation.finally(() => pending.delete(operation));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, close: async () => {
    for (const socket of sockets) socket.destroy(); await Promise.allSettled([...pending]);
    await new Promise(resolve => server.close(resolve));
  } };
}

async function runCiscoHighlightingUiTests(test) {
  await test('Cisco highlighting: real renderer preserves console, copy and log data while decorating; saved preferences survive restart', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-cisco-ui-'));
    let consolePeer, child;
    try {
      consolePeer = await peer();
      for (const phase of ['exercise', 'restart']) {
        let output = '';
        const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_CISCO_UI_ROOT: root,
          KONX_CISCO_UI_PHASE: phase, KONX_CISCO_UI_PORT: String(consolePeer.port), KONX_CAPTURE: '', KONX_DEMO: '' };
        delete env.ELECTRON_RUN_AS_NODE;
        child = spawn(require('electron'), [__filename, '--cisco-ui-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const collect = bytes => { output = (output + bytes).slice(-1024 * 1024); };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        const code = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('Cisco UI fixture timed out\n' + output)); }, 90000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); resolve(code); });
        });
        assert.equal(code, 0, output); assert.match(output, new RegExp('CISCO_UI_PASS ' + phase));
      }
      const log = fs.readFileSync(path.join(root, 'console.txt'), 'utf8');
      assert.ok(log.includes(SAMPLE.replace(/\r\n/g, '\n')), 'raw readable transcript must remain unchanged in its log');
      assert.equal(log.includes('\x1b'), false); assert.equal(log.includes('konx-cisco-highlight'), false);
      if (process.env.KONX_CISCO_UI_SCREENSHOTS) {
        const destination = path.resolve(process.env.KONX_CISCO_UI_SCREENSHOTS); fs.mkdirSync(destination, { recursive: true });
        for (const file of fs.readdirSync(root).filter(file => file.endsWith('.png'))) fs.copyFileSync(path.join(root, file), path.join(destination, file));
      }
    } finally {
      if (child && child.exitCode == null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
      await consolePeer?.close();
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-cisco-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, dialog, shell, clipboard } = require('electron');
  const root = path.resolve(process.env.KONX_CISCO_UI_ROOT || ''), phase = process.env.KONX_CISCO_UI_PHASE, port = Number(process.env.KONX_CISCO_UI_PORT);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-cisco-ui-'));
  assert.equal(path.resolve(process.env.KONX_USERDATA), path.join(root, 'profile')); assert.ok(['exercise', 'restart'].includes(phase));
  const unexpected = action => { throw new Error('Cisco fixture unexpectedly invoked ' + action); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, engine: null, missing: false,
    error: 'Offline Cisco fixture', npcap: { available: false }, builtin: { available: false } });
  require('../src/main/ai').AIClient.prototype.run = async () => unexpected('AI');
  shell.openExternal = async () => unexpected('external browser');
  dialog.showOpenDialog = async () => unexpected('native open'); dialog.showSaveDialog = async () => unexpected('native save');
  dialog.showErrorBox = (title, message) => unexpected(title + ': ' + message);
  let copied = null; clipboard.writeText = text => { copied = text; };
  let finished = false;
  const finish = async (code, error) => {
    if (finished) return; finished = true; if (error) console.error(error.stack || error);
    for (const window of BrowserWindow.getAllWindows()) { await window.webContents.session.flushStorageData(); window.destroy(); }
    app.exit(code);
  };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true); win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') console.error('Renderer: ' + details.message); });
    win.webContents.once('did-finish-load', async () => {
      const run = code => win.webContents.executeJavaScript(code);
      const click = async expression => {
        let point;
        await until(async () => {
          point = await run(`(()=>{const e=${expression};if(!e)return {ready:false};e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return {x,y,ready:!e.disabled&&r.width>0&&r.height>0&&(hit===e||e.contains(hit))};})()`);
          return point.ready;
        }, 'reachable ' + expression); delete point.ready;
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(25);
      };
      const fill = (expression, value) => run(`(()=>{const e=${expression};if(!e)throw new Error('Missing fixture input');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
      const footer = label => `[...document.querySelectorAll('.modal footer button')].find(e=>e.textContent===${JSON.stringify(label)})`;
      const field = label => `[...document.querySelectorAll('.modal .mpane.active label.field')].find(e=>e.querySelector('span')?.textContent===${JSON.stringify(label)})?.querySelector('input,select')`;
      const modeSelect = `document.querySelector('.modal select[name="terminalHighlighting"][aria-label="Output highlighting"]')`;
      const bufferText = () => run(`(()=>{const b=window.__ciscoTab.term.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\\n');})()`);
      const decorations = () => run(`window.__decorations.filter(d=>d.term===window.__ciscoTab.term&&!d.disposed&&d.decoration.element?.isConnected).map(d=>({kind:d.decoration.element.dataset.kind,color:d.options.foregroundColor,line:d.options.marker.line,x:d.options.x,width:d.options.width}))`);
      const command = async (name, marker) => {
        await run(`window.__ciscoTab.sendText(${JSON.stringify(name + '\n')});true;`);
        if (marker) await until(async () => (await bufferText()).includes(marker), marker);
      };
      const expectKinds = async () => until(async () => {
        const kinds = (await decorations()).map(d => d.kind); return ['error', 'down', 'up', 'ip'].every(kind => kinds.includes(kind));
      }, 'rendered Cisco error/down/up/IP decorations');
      const expectPaintedGlyphs = async () => {
        const active = await decorations();
        const expected = [['192.0.2.1', 'ip'], ['up up', 'up'], ['administratively down', 'down'], ['% Invalid input', 'error']].map(([text, kind]) => {
          const hex = active.find(d => d.kind === kind)?.color;
          assert.match(hex || '', /^#[0-9a-f]{6}$/i);
          return { text, color: 'rgb(' + [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ') + ')' };
        });
        await until(() => run(`(()=>{const rows=[...window.__ciscoTab.wrap.querySelectorAll('.xterm-rows > div')];return ${JSON.stringify(expected)}.every(({text,color})=>{const row=rows.find(row=>row.textContent.includes(text));if(!row)return false;const start=row.textContent.indexOf(text),glyphColors=[...row.children].flatMap(span=>Array(span.textContent.length).fill(getComputedStyle(span).color));return glyphColors.slice(start,start+text.length).every((actual,index)=>text[index]===' '||actual===color);});})()`), 'actual xterm glyph foreground matches requested Cisco decoration colors');
      };
      const saveGlobal = async mode => {
        await click(`document.querySelector('#toolbar button[title="Settings"]')`);
        await until(() => run(`Boolean(${modeSelect})`), 'global Output highlighting selector');
        await fill(modeSelect, mode); await click(footer('Save'));
        await until(() => run('!document.querySelector(".modal")'), 'Settings saved');
        assert.equal(await run('window.__app.settings.terminalHighlighting'), mode);
      };
      const saveSession = async (name, mode) => {
        await click(`document.querySelector('button[title="New session"]')`);
        await fill(field('Name'), name); await fill(field('Protocol'), 'raw');
        await fill(field('Hostname or IP'), '127.0.0.1'); await fill(field('Port'), port);
        await click(`[...document.querySelectorAll('.modal .mtabs button')].find(e=>e.textContent==='Terminal & Log')`);
        assert.equal(await run(`${modeSelect}.value`), '');
        await fill(modeSelect, mode); await click(footer('Save'));
        await until(() => run('!document.querySelector(".modal")'), 'session override saved');
      };
      const openSaved = async name => {
        await run(`window.__ciscoTab=window.__app.connectSession(window.__app.sessions.data.sessions.find(s=>s.name===${JSON.stringify(name)}));true;`);
        await until(() => run('window.__ciscoTab.state==="connected"'), 'saved raw console connected');
      };
      try {
        await until(() => run('Boolean(window.__app?.workspaceLayout)'), 'app initialized'); await setViewport(win, run, 1100, 700);
        // Observe only xterm's public decoration API and actual rendered DOM.
        await run(`(async()=>{const {Terminal}=await import('./js/vendor.js'),original=Terminal.prototype.registerDecoration;window.__decorations=[];Terminal.prototype.registerDecoration=function(options){const decoration=original.call(this,options);if(decoration){const record={term:this,options,decoration,disposed:false};window.__decorations.push(record);decoration.onDispose(()=>record.disposed=true);}return decoration;};return true;})()`);
        if (phase === 'restart') {
          assert.equal(await run('window.__app.settings.terminalHighlighting'), 'off');
          const sessions = await run(`window.api.invoke('sessions:list')`);
          assert.equal(sessions.sessions.find(s => s.name === 'Cisco enabled fixture').terminalHighlighting, 'cisco');
          assert.equal(sessions.sessions.find(s => s.name === 'Cisco disabled fixture').terminalHighlighting, 'off');
          await openSaved('Cisco enabled fixture'); await command('sample', 'SAMPLE_DONE'); await expectKinds();
          await openSaved('Cisco disabled fixture'); await command('sample', 'SAMPLE_DONE'); await pause(100);
          assert.equal((await decorations()).length, 0); assert.equal(await run(`window.__ciscoTab.ciscoSwitch.getAttribute('aria-checked')`), 'false');
          console.log('CISCO_UI_PASS restart'); await finish(0); return;
        }
        assert.equal(await run('window.__app.settings.terminalHighlighting'), 'cisco');
        await run(`window.__ciscoTab=window.__app.openTerminal({protocol:'raw',host:'127.0.0.1',port:${port},logging:{enabled:true,path:${JSON.stringify(path.join(root, 'console.txt'))},timestamps:false}},{name:'Cisco live fixture',protocol:'raw'});true;`);
        await until(() => run('window.__ciscoTab.state==="connected"'), 'real raw console');
        assert.equal(await run(`window.__ciscoTab.ciscoSwitch.getAttribute('aria-checked')`), 'true');
        assert.equal(await run('window.__ciscoTab.cloneMeta().terminalHighlighting'), undefined, 'untoggled clones must retain inheritance');
        await run(`window.__app.saveSettings({terminalHighlighting:null})`);
        assert.equal(await run(`window.__ciscoTab.ciscoSwitch.getAttribute('aria-checked')`), 'false', 'explicit unknown global choice stays off');
        await run(`window.__app.saveSettings({terminalHighlighting:'cisco'})`);
        await run(`window.__nullTab=window.__app.openTerminal({protocol:'raw',host:'127.0.0.1',port:${port}},{name:'Explicit unknown fixture',protocol:'raw',terminalHighlighting:null});true;`);
        assert.equal(await run(`window.__nullTab.ciscoSwitch.getAttribute('aria-checked')`), 'false', 'explicit unknown session choice stays off');
        await run(`window.__app.closeTab(window.__nullTab)`);
        await run(`window.__cloneTab=window.__app.openTerminal(window.__ciscoTab.spec,window.__ciscoTab.cloneMeta());true;`);
        await run(`window.__app.saveSettings({terminalHighlighting:'off'})`);
        assert.equal(await run(`window.__cloneTab.ciscoSwitch.getAttribute('aria-checked')`), 'false', 'inherited clone follows changed global choice');
        await run(`window.__app.saveSettings({terminalHighlighting:'cisco'})`);
        assert.equal(await run(`window.__cloneTab.ciscoSwitch.getAttribute('aria-checked')`), 'true');
        await run(`window.__app.closeTab(window.__cloneTab)`);
        await run(`window.__app.activate(window.__ciscoTab);true;`);
        await command('sample', 'SAMPLE_DONE'); await expectKinds();
        const originalText = await bufferText();
        assert.ok(originalText.includes(SAMPLE.replace(/\r\n/g, '\n').trimEnd()));
        assert.equal(originalText.includes('\ufffd'), false, 'fragmented UTF8 must survive unchanged');
        const dark = await decorations(); assert.ok(dark.every(d => /^#[0-9a-f]{6}$/i.test(d.color)));
        await expectPaintedGlyphs();
        await run('window.__ciscoTab.term.selectAll();window.__ciscoTab.copy();true;');
        await until(() => copied !== null, 'copy through real renderer/IPC boundary');
        assert.equal(copied, await run('window.__ciscoTab.term.getSelection()')); assert.equal(copied.includes('\x1b'), false);
        assert.ok(copied.includes('Native café 😀')); await run('window.__ciscoTab.term.clearSelection();true;');
        fs.writeFileSync(path.join(root, 'cisco-dark.png'), (await win.webContents.capturePage()).toPNG());
        await click('window.__ciscoTab.ciscoSwitch'); await until(async () => !(await decorations()).length, 'live toggle clears decorations');
        assert.equal(await bufferText(), originalText);
        assert.equal(await run('window.__ciscoTab.cloneMeta().terminalHighlighting'), 'off', 'clone keeps explicit live override');
        await click('window.__ciscoTab.ciscoSwitch'); await expectKinds(); await expectPaintedGlyphs(); assert.equal(await bufferText(), originalText);
        await run(`window.__app.saveSettings({colorScheme:'light'})`); await expectKinds();
        await until(async () => (await decorations()).some(d => d.color !== dark.find(old => old.kind === d.kind)?.color), 'light theme changes contrast palette');
        await expectPaintedGlyphs();
        assert.equal(await bufferText(), originalText);
        fs.writeFileSync(path.join(root, 'cisco-light.png'), (await win.webContents.capturePage()).toPNG());
        await command('ansi', 'ANSI_DONE'); await until(async () => !(await decorations()).length, 'native ANSI foreground preserved');
        const cell = await run(`(()=>{const b=window.__ciscoTab.term.buffer.active;for(let i=0;i<b.length;i++){const line=b.getLine(i),at=line?.translateToString(true).indexOf('192.0.2.9');if(at>=0){const cell=line.getCell(at);return {default:cell.isFgDefault(),color:cell.getFgColor()};}}})()`);
        assert.deepEqual(cell, { default: false, color: 5 });
        await command('rewrite', 'REWRITE_DONE'); await until(async () => !(await decorations()).length, 'erase/rewrite removes stale decorations');
        await command('sample', 'SAMPLE_DONE'); await expectKinds();
        await command('alternate', 'ALT_DONE'); await until(() => run('window.__ciscoTab.term.buffer.active.type==="alternate"'), 'alternate buffer');
        await until(async () => !(await decorations()).length, 'alternate screen bypass');
        await command('normal'); await until(() => run('window.__ciscoTab.term.buffer.active.type==="normal"'), 'normal buffer restored'); await expectKinds();
        const columns = await run('window.__ciscoTab.term.cols'); await command('wrap:' + columns, 'WRAP_DONE');
        await until(async () => new Set((await decorations()).filter(d => d.kind === 'ip').map(d => d.line)).size >= 2, 'IP decoration spans wrapped physical rows');
        await run(`window.__app.saveSettings({scrollback:100})`); await command('scroll', 'SCROLL_DONE');
        await until(async () => (await decorations()).some(d => d.kind === 'ip'), 'scrollback visible decorations');
        await run('window.__ciscoTab.term.scrollToTop();true;'); await pause(100);
        assert.ok((await decorations()).some(d => d.kind === 'ip'));
        await setViewport(win, run, 900, 560); await run('window.__ciscoTab.term.scrollToBottom();true;');
        await until(async () => (await bufferText()).includes('SCROLL_DONE') && (await decorations()).some(d => d.kind === 'ip'), 'resize/reflow preserves current highlights');
        await run(`window.api.invoke('conn:close',window.__ciscoTab.id)`);
        await until(() => fs.existsSync(path.join(root, 'console.txt')) && fs.readFileSync(path.join(root, 'console.txt'), 'utf8').includes('Session closed'), 'log flush after disconnect');
        await saveGlobal('off');
        await saveSession('Cisco enabled fixture', 'cisco'); await saveSession('Cisco disabled fixture', 'off');
        await openSaved('Cisco enabled fixture'); await command('sample', 'SAMPLE_DONE'); await expectKinds();
        await openSaved('Cisco disabled fixture'); await command('sample', 'SAMPLE_DONE'); await pause(100); assert.equal((await decorations()).length, 0);
        console.log('CISCO_UI_PASS exercise'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require('../src/main/main');
}

module.exports = { runCiscoHighlightingUiTests };
if (process.versions.electron && process.argv.includes('--cisco-ui-fixture')) fixture().catch(error => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) runCiscoHighlightingUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
