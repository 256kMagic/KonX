'use strict';

// Real widgets and native Chromium input in an isolated profile. This fixture
// deliberately moves DOM directly: pop-out chrome/ownership is tested elsewhere.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 12000;
  while (!await check()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await pause(25); }
}

async function runWidgetHostUiTests(test) {
  await test('moved xterm and Monaco retain input, mouse reports, selection, models and undo across host changes', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-widget-host-'));
    let child;
    try {
      const env = { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_WIDGET_HOST_ROOT: root, KONX_CAPTURE: '', KONX_DEMO: '' };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--widget-host-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const collect = data => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Widget host fixture timed out\n' + output)); }, 90000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0, output); assert.match(output, /WIDGET_HOST_PASS/);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill(); await new Promise(resolve => child.once('exit', resolve));
      }
      const resolved = fs.realpathSync(root);
      assert.equal(path.dirname(resolved).toLowerCase(), base.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('konx-widget-host-'));
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, dialog, shell, clipboard } = require('electron');
  const root = path.resolve(process.env.KONX_WIDGET_HOST_ROOT || '');
  assert.equal(path.dirname(root).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(root).startsWith('konx-widget-host-'));
  assert.equal(path.resolve(process.env.KONX_USERDATA), path.join(root, 'profile'));
  const peers = new Set(); let connections = 0, closes = 0, input = '', copied = '', popup, finished = false;
  const server = net.createServer(socket => {
    connections++; peers.add(socket); socket.on('error', () => {});
    socket.on('close', () => { closes++; peers.delete(socket); });
    socket.on('data', bytes => { input += bytes.toString(); });
    socket.write('POPUP_SELECTION_TARGET\r\nGi0/1 192.0.2.1 up up\r\n' + Array.from({ length: 70 }, (_, i) => `retained line ${i}\r\n`).join('') + 'READY# ');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const unexpected = action => { throw new Error('Unexpected widget fixture operation: ' + action); };
  require('../src/main/capture').CaptureManager.prototype.status = () => ({ available: false, error: 'isolated widget fixture', builtin: { available: false } });
  shell.openExternal = async () => unexpected('external browser');
  dialog.showOpenDialog = dialog.showSaveDialog = async () => unexpected('native file dialog');
  clipboard.writeText = text => { copied = text; }; clipboard.readText = () => copied;
  const finish = async (code, error) => {
    if (finished) return; finished = true;
    if (error) console.error(error.stack || error);
    for (const socket of peers) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.exit(code);
  };
  // Turn asynchronous fixture failures into a failed test, never Electron's
  // user-visible "JavaScript error in the main process" dialog.
  const fail = error => { finish(1, error instanceof Error ? error : new Error(String(error))).catch(cleanup => { console.error(cleanup); app.exit(1); }); };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  app.once('browser-window-created', (_event, main) => {
    main.setOpacity(0); main.setFocusable(false); main.setSkipTaskbar(true); main.webContents.setBackgroundThrottling(false);
    main.webContents.on('console-message', details => { if (details.level === 'error') console.error('Renderer: ' + details.message); });
    main.webContents.once('did-finish-load', async () => {
      const run = async code => {
        let timer;
        try {
          return await Promise.race([main.webContents.executeJavaScript(code), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Renderer expression timed out')), 15000);
          })]);
        } catch (error) { throw new Error(error.message + '\nRenderer expression: ' + code.slice(0, 1600)); }
        finally { clearTimeout(timer); }
      };
      const write = async text => { for (const socket of peers) socket.write(text); await pause(40); };
      const nativeDrag = async (win, rect, modifiers = []) => {
        const start = { x: Math.round(rect.x), y: Math.round(rect.y) };
        const end = { x: Math.round(rect.x + 10 * rect.width), y: start.y };
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, modifiers, ...start });
        win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: [...modifiers, 'leftbuttondown'], ...end });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, modifiers, ...end });
        await pause(70);
      };
      const coordinates = () => run(`(()=>{const t=window.__term.term,r=t.element.querySelector('.xterm-screen').getBoundingClientRect(),row=Math.max(0,window.__targetLine-t.buffer.active.viewportY);return{x:r.x+2,y:r.y+(row+0.5)*r.height/t.rows,width:r.width/t.cols};})()`);
      const protocolDrag = async win => {
        const start = input.length;
        await nativeDrag(win, await coordinates());
        await until(() => input.slice(start).includes('m'), 'SGR mouse release');
        const reports = [...input.slice(start).matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)].map(m => ({ button: Number(m[1]), end: m[4] }));
        assert.deepEqual(reports, [{ button: 0, end: 'M' }, { button: 32, end: 'M' }, { button: 0, end: 'm' }], 'one down, drag and release, without duplicate host listeners');
      };
      try {
        await until(() => run('Boolean(window.__app?.workspaceLayout)'), 'app ready');
        console.log('WIDGET_HOST_STAGE app ready');
        main.webContents.on('did-create-window', child => {
          try {
            if (child.isDestroyed()) throw new Error('The permitted widget fixture popup was destroyed during creation');
            popup = child; child.setOpacity(0); child.setFocusable(false); child.setSkipTaskbar(true); child.showInactive(); child.webContents.setBackgroundThrottling(false);
          } catch (error) { fail(error); }
        });
        await run(`window.__term=window.__app.openTerminal({protocol:'raw',host:'127.0.0.1',port:${server.address().port}},{name:'Owned host fixture',protocol:'raw'});true;`);
        await until(() => run(`window.__term.state==='connected'`), 'raw connection');
        await until(() => run(String.raw`(()=>{const b=window.__term.term.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\n').includes('READY#');})()`), 'console banner');
        await pause(100);
        await run(`window.__term.term.scrollToTop();const b=window.__term.term.buffer.active;window.__targetLine=Array.from({length:b.length},(_,i)=>i).find(i=>b.getLine(i)?.translateToString(true).includes('POPUP_SELECTION_TARGET'));window.__term.term.select(0,window.__targetLine,22);window.__originalTerm=window.__term.term;window.__originalId=window.__term.id;window.__originalHighlighter=window.__term.ciscoHighlighter;window.__oldHost=window;window.__resize=[];window.__term.term.onResize(size=>window.__resize.push(size));window.__beforeGeometry={cols:window.__term.term.cols,rows:window.__term.term.rows,selection:window.__term.term.getSelection(),el:window.__term.el.getBoundingClientRect().toJSON(),wrap:window.__term.wrap.getBoundingClientRect().toJSON()};true;`);
        await run(`window.__move=async(tab,preserveSize=false)=>{
          const bounds=tab.el.getBoundingClientRect();
          const permit=await window.api.invoke('app:popoutPrepare');
          window.__moved=tab;const child=window.__child=window.open('about:blank',permit.frameName,'width=900,height=600');
          if(!child)throw Error('Popup denied');const doc=child.document;
          const base=doc.createElement('base');base.href=document.baseURI;doc.head.append(base);
          await Promise.all([...document.querySelectorAll('link[rel="stylesheet"],style')].map(el=>new Promise((resolve,reject)=>{const clone=el.cloneNode(true);if(clone.tagName==='LINK'){clone.onload=resolve;clone.onerror=()=>reject(Error('Fixture stylesheet failed'));}else resolve();doc.head.append(clone);})));
          for(const [name,value]of Object.entries(document.documentElement.dataset))doc.documentElement.dataset[name]=value;
          doc.documentElement.style.cssText=document.documentElement.style.cssText;doc.body.style.cssText='margin:0;height:100vh;overflow:hidden';
          tab.el.style.cssText='position:absolute;inset:0;display:flex;width:'+(preserveSize?bounds.width+'px':'100%')+';height:'+(preserveSize?bounds.height+'px':'100%');
          window.__app.workspaceLayout.attachExternal(tab,{body:doc.body,window:child});
          tab.onHostWindowChanged(child,window);
          child.addEventListener('resize',()=>tab.refit());
          const redock=()=>{if(tab.el.ownerDocument===document)return;tab.el.style.cssText='';window.__app.workspaceLayout.releaseExternal(tab);tab.onHostWindowChanged(window,child);};
          const unlisten=window.api.on('app:popoutDock',({id})=>{if(id!==permit.id)return;redock();window.api.invoke('app:popoutClose',id);});
          child.addEventListener('beforeunload',()=>{redock();unlisten();});
          return true;
        };window.__move(window.__term,true);`);
        await pause(120);
        assert.deepEqual(await run(`({same:window.__term.term===window.__originalTerm,id:window.__term.id===window.__originalId,selection:window.__term.term.getSelection(),oldDisposed:window.__originalHighlighter.disposed,host:window.__term.hostWindow===window.__child})`), { same: true, id: true, selection: 'POPUP_SELECTION_TARGET', oldDisposed: true, host: true });
        console.log('WIDGET_HOST_STAGE same-size move');
        // xterm intentionally clears selections when resizing rows. Verify host
        // migration separately, then let the real view fit its new window.
        await run(`window.__term.el.style.width='100%';window.__term.el.style.height='100%';window.__term.refit();window.__term.term.scrollToTop();window.__term.ciscoHighlighter.refresh();true;`);
        await until(() => run(`!!window.__term.wrap.querySelector('.konx-cisco-highlight')`), 'new host highlighter');
        await run('window.__term.term.focus();true;'); popup.webContents.sendInputEvent({ type: 'char', keyCode: 'Z' });
        await until(() => input.includes('Z'), 'native child input');
        await run('window.__term.term.scrollToTop();window.__term.term.clearSelection();window.__child.scrollTo(0,0);true;');
        await pause(60);
        await popup.webContents.executeJavaScript(`window.__mouse=[];for(const type of ['mousedown','mousemove','mouseup'])document.addEventListener(type,e=>window.__mouse.push({type,button:e.button,buttons:e.buttons,detail:e.detail,x:e.clientX,y:e.clientY,target:e.target.className}),true);true;`);
        const beforeSelection = input;
        await nativeDrag(popup, await coordinates());
        const selection = await run('window.__term.term.getSelection()'); assert.match(selection, /^POPUP/, JSON.stringify(await popup.webContents.executeJavaScript(`({events:window.__mouse,active:document.activeElement?.className,geometry:document.querySelector('.xterm-screen').getBoundingClientRect().toJSON(),rows:[...document.querySelectorAll('.xterm-rows>div')].slice(0,8).map(e=>e.textContent)})`)));
        assert.equal(input, beforeSelection, 'ordinary selection sends no mouse reports');
        await run('window.__term.copy();true;'); await until(() => copied === selection, 'copy selected text through IPC');
        await write('\x1b[?1002h\x1b[?1006h');
        await until(() => run(`window.__term.term.modes.mouseTrackingMode==='drag'`), 'remote mouse mode');
        await protocolDrag(popup);
        console.log('WIDGET_HOST_STAGE child native mouse report');
        const beforeForced = input;
        await nativeDrag(popup, await coordinates(), ['shift']);
        assert.equal(input, beforeForced, 'shift selection bypasses mouse report bridge');
        await run('window.__term.onHostWindowChanged(window.__child,window);true;');
        await protocolDrag(popup);
        const cancellationStart = input.length, point = await coordinates();
        const start = { x: Math.round(point.x), y: Math.round(point.y) };
        const end = { x: Math.round(point.x + 5 * point.width), y: start.y };
        popup.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...start });
        popup.webContents.sendInputEvent({ type: 'mouseMove', button: 'right', modifiers: ['rightbuttondown'], ...end });
        await until(() => input.slice(cancellationStart).includes('[<34;'), 'native right-button drag');
        await run(`window.__child.dispatchEvent(new window.__child.Event('blur'));true;`);
        await until(() => /\x1b\[<2;\d+;\d+m/.test(input.slice(cancellationStart)), 'blur releases held right button');
        assert.deepEqual([...input.slice(cancellationStart).matchAll(/\x1b\[<(\d+);\d+;\d+([Mm])/g)].map(m => [Number(m[1]), m[2]]), [[2, 'M'], [34, 'M'], [2, 'm']]);
        popup.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...end });
        await pause(30);
        popup.close(); await until(() => run('window.__term.el.ownerDocument===document&&window.__child.closed'), 'terminal dock');
        await protocolDrag(main);
        await run('window.__move(window.__term)'); await pause(100); await protocolDrag(popup);
        const oldCols = await run('window.__term.term.cols'); popup.setSize(650, 430);
        await until(async () => await run('window.__term.term.cols') < oldCols, 'refit in resized popup');
        await write('\x1b[?1002l\x1b[?1006l');
        popup.close(); await until(() => run('window.__term.el.ownerDocument===document&&window.__child.closed'), 'repeat terminal dock');
        assert.equal(connections, 1); assert.equal(closes, 0);
        console.log('WIDGET_HOST_STAGE repeated terminal dock');

        await run(String.raw`(async()=>{window.__np=await window.__app.openNotepad();window.__doc=window.__np.newDoc({title:'Owned popup draft.txt',text:'original alpha\nsecond beta\n',language:'plaintext'});window.__model=window.__doc.model;window.__editor=window.__np.editor;window.__np.editor.setSelection({startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:9});return true;})()`);
        await run('window.__move(window.__np)'); await pause(100);
        await run('window.__np.editor.focus();true;'); await popup.webContents.insertText('changed');
        await until(() => run(String.raw`window.__model.getValue()==='changed alpha\nsecond beta\n'`), 'native moved Monaco input');
        await run(`window.__np.editor.trigger('fixture','undo',null);true;`);
        await until(() => run(String.raw`window.__model.getValue()==='original alpha\nsecond beta\n'`), 'Monaco undo after move');
        console.log('WIDGET_HOST_STAGE Monaco native input and undo');
        await run(`window.__np.editor.getAction('actions.find').run();true;`);
        await until(() => popup.webContents.executeJavaScript(`Boolean(document.querySelector('.find-widget.visible textarea, .find-widget.visible input'))`), 'popup find widget');
        await popup.webContents.insertText('second');
        await until(() => popup.webContents.executeJavaScript(`document.activeElement?.value==='second'`), 'popup find input');
        assert.equal(await run(`window.__model.getValue()`), 'original alpha\nsecond beta\n');
        popup.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        popup.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await run(String.raw`window.__other=window.__np.createDoc({text:'different alpha\nsecond beta\n',title:'Other draft'});window.__np.compare(window.__other,window.__doc);true;`);
        await until(() => run('Boolean(window.__np.diffEditor?.getModel())'), 'diff editor created in child');
        console.log('WIDGET_HOST_STAGE diff created');
        const width = await run('window.__np.diffEditor.getModifiedEditor().getLayoutInfo().width'); popup.setSize(650, 430);
        await until(async () => await run('window.__np.diffEditor.getModifiedEditor().getLayoutInfo().width') < width, 'diff refit');
        popup.close(); await until(() => run('window.__np.el.ownerDocument===document&&window.__child.closed'), 'Notepad dock');
        assert.deepEqual(await run(`({editor:window.__np.editor===window.__editor,model:window.__np.current.model===window.__model,original:window.__np.diffEditor.getModel().modified===window.__model,text:window.__model.getValue()})`), { editor: true, model: true, original: true, text: 'original alpha\nsecond beta\n' });
        await run(`window.__np.closeCompare();window.__np.editor.trigger('fixture','redo',null);true;`);
        await until(() => run(String.raw`window.__model.getValue()==='changed alpha\nsecond beta\n'`), 'redo after dock retains undo stack');
        assert.equal(connections, 1); assert.equal(closes, 0);
        await run(`window.__app.closeTab(window.__term)`);
        await until(() => closes === 1, 'actual terminal close releases owned peer');
        console.log('WIDGET_HOST_PASS'); await finish(0);
      } catch (error) { await finish(1, error); }
    });
  });
  require('../src/main/main');
}

module.exports = { runWidgetHostUiTests };
if (process.argv.includes('--widget-host-fixture')) fixture().catch(error => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) {
  let failed = 0;
  runWidgetHostUiTests(async (name, fn) => { try { await fn(); console.log('PASS ' + name); } catch (error) { failed++; console.error(error.stack || error); } })
    .then(() => { process.exitCode = failed ? 1 : 0; }).catch(error => { console.error(error); process.exitCode = 1; });
}
