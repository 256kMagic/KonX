'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
let ROOT = __dirname;
while (!fs.existsSync(path.join(ROOT, 'package.json')) || !fs.existsSync(path.join(ROOT, 'src/main/ai.js'))) {
  if (path.dirname(ROOT) === ROOT) throw new Error('Cannot find KonX source'); ROOT = path.dirname(ROOT);
}
const SOURCE = path.resolve(__dirname, '../src/renderer/js');

async function runCopilotWorkspaceTests(test) {
  await test('workspace Copilot: real xterm, Monaco, SFTP and session menus attach only explicit bounded evidence without actions', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-copilot-workspace-'));
    let child, output = '';
    try {
      fs.cpSync(path.join(ROOT, 'src/renderer'), path.join(root, 'src/renderer'), { recursive: true });
      for (const name of ['copilot-context.mjs', 'copilot-workspace.mjs', 'terminal.js', 'sftp.js', 'sessions.js', 'notepad/notepad.js']) fs.copyFileSync(path.join(SOURCE, name), path.join(root, 'src/renderer/js', name));
      for (const pkg of ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search', '@xterm/addon-web-links']) {
        for (const dir of ['lib', ...(pkg === '@xterm/xterm' ? ['css'] : [])]) fs.cpSync(path.join(ROOT, 'node_modules', pkg, dir), path.join(root, 'node_modules', pkg, dir), { recursive: true });
      }
      fs.cpSync(path.join(ROOT, 'node_modules/monaco-editor/min/vs'), path.join(root, 'node_modules/monaco-editor/min/vs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src/renderer/fixture.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="../../node_modules/@xterm/xterm/css/xterm.css"><div id="toasts"></div><main id="fixture" style="width:900px;height:540px"></main>');
      const env = { ...process.env, KONX_WORKSPACE_CONTEXT_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--workspace-context-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = data => { output = (output + data).slice(-512 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Workspace context fixture timed out\n' + output)); }, 60000);
        child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0, output); assert.match(output, /COPILOT_WORKSPACE_PASS/);
      const snapshots = JSON.parse(fs.readFileSync(path.join(root, 'snapshots.json'), 'utf8'));
      const { redactText } = require(path.join(ROOT, 'src/main/ai-redaction.js'));
      for (const snapshot of snapshots) {
        const raw = JSON.stringify(snapshot);
        assert.ok(Buffer.byteLength(raw) <= 64 * 1024); assert.equal(raw.includes('NeverCollectSyntheticPassword'), false); assert.equal(raw.includes('NeverCollectSyntheticPrivateKey'), false);
        assert.equal(raw.includes('NeverCollectSyntheticLogonCommand'), false);
        const safe = redactText(raw, ['KnownSyntheticKeyAcrossSelection']); assert.equal(safe.includes('KnownSyntheticKeyAcrossSelection'), false);
      }
      const { normalizeSnapshot } = require(path.join(ROOT, 'src/main/copilot-store.js'));
      for (const snapshot of snapshots) normalizeSnapshot(snapshot);
    } finally {
      if (child && child.exitCode == null) { const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit; }
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-copilot-workspace-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow } = require('electron');
  const root = path.resolve(process.env.KONX_WORKSPACE_CONTEXT_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-copilot-workspace-'));
  app.setPath('userData', path.join(root, 'profile')); await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 920, height: 620, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const fail = error => { console.error(error.stack || error); for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.exit(1); };
  process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
  try {
    await win.loadFile(path.join(root, 'src/renderer/fixture.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const assert=(value,message)=>{if(!value)throw new Error(message)};
      const pending=[],calls=[],attachments=[],snapshots=[],revisions=[];
      const delay=()=>new Promise(resolve=>setTimeout(resolve,10));
      window.api={platform:'win32',on(){return()=>{}},send(channel,...args){calls.push({channel,args})},invoke(channel,...args){
        calls.push({channel,args});
        if(channel==='np:session:get')return Promise.resolve({docs:[]});
        if(['np:session:set','np:backup:write','np:backup:delete','np:watch','conn:close','sftp:close','serial:list'].includes(channel))return Promise.resolve(channel==='serial:list'?[]:undefined);
        return new Promise((resolve,reject)=>pending.push({channel,args,resolve,reject}));
      }};
      const [{TerminalTab},{SftpTab},{NotepadTab},{SessionTree},context]=await Promise.all([import('./js/terminal.js'),import('./js/sftp.js'),import('./js/notepad/notepad.js'),import('./js/sessions.js'),import('./js/copilot-workspace.mjs')]);
      const settings={fontFamily:'Consolas,monospace',fontSize:13,scrollback:1000,cursorStyle:'block',cursorBlink:false,colorScheme:'konx',uiTheme:'konx',terminalHighlighting:'off',copyOnSelect:false,rightClick:'menu',sftpShowHidden:false,sftpConflict:'ask',notepad:{}};
      const session={id:'synthetic-session',name:'Synthetic',protocol:'serial',serialPort:'COM_FAKE',baudRate:'auto',dataBits:8,parity:'none',stopBits:1,flowControl:'none',serialAutoBaudProbe:false,username:'operator',password:'NeverCollectSyntheticPassword',privateKey:'NeverCollectSyntheticPrivateKey',loginCommand:'NeverCollectSyntheticLogonCommand',logonActions:[{send:'NeverCollectSyntheticLogonCommand'}],forwards:[{type:'L',listenPort:2222,destHost:'192.0.2.1',destPort:22}]};
      const host={settings,sessions:{data:{sessions:[session]}},tabStateChanged(){},tabActivity(){},updateStatus(){},setTabTitle(tab,title){tab.title=title},saveSettings(){},copilot:{sourceChanged(tab){revisions.push(tab.copilot?.revision)}},openCopilot(source,options){attachments.push({sourceId:source?.id,snapshot:options.snapshot});return Promise.resolve()},active:null};
      const fixture=document.querySelector('#fixture');
      const take=channel=>{const index=pending.findIndex(item=>item.channel===channel);assert(index>=0,'Missing '+channel);return pending.splice(index,1)[0]};
      const capture=(tab,choice)=>{const before=calls.length;const snapshot=tab.captureCopilotContext({choice});assert(calls.length===before,'Capture invoked IPC '+choice);snapshots.push(snapshot);return snapshot};
      const forbiddenSnapshot=snapshot=>{const value=JSON.stringify(snapshot);assert(!value.includes('NeverCollectSynthetic'),'Sensitive session field retained');};
      const terminal=new TerminalTab(host,{sessionId:session.id},{name:'Synthetic console',protocol:'serial'});fixture.append(terminal.el);host.active=terminal;
      terminal.term.resize(20,6);const connecting=terminal.connect();take('conn:open').resolve({ok:true});await connecting;
      terminal.onStatus({state:'connecting',message:'Listening at 9600 baud',baudDetect:{phase:'sampling',baudRate:9600,index:1,total:11,message:'Listening'}});
      let diagnostic=capture(terminal,'connection');assert(diagnostic.kind==='connection'&&diagnostic.facts.rows[0].serialProgress.baudRate===9600,'Serial progress missing');forbiddenSnapshot(diagnostic);
      terminal.onStatus({state:'connected',info:{protocol:'serial',serialPort:'COM_FAKE',baudRate:115200,autoBaud:{method:'heuristic',confidence:'likely',baudRate:115200,confirmed:true,probe:false,candidatesTested:11,score:95},logging:'C:/Synthetic/console.txt'}});
      diagnostic=capture(terminal,'connection');assert(diagnostic.scope.inputs.requested.baudRate==='auto'&&diagnostic.facts.rows[0].serialDetection.baudRate===115200,'Configured vs detected serial rate');assert(diagnostic.facts.rows[0].forwardingRuntimeStatus===null&&diagnostic.facts.rows[0].logging.active===true,'Unknown forwarding and active logging');forbiddenSnapshot(diagnostic);
      await new Promise(resolve=>terminal.term.write('OFFSCREEN_ONLY\\r\\n'+Array.from({length:12},(_,i)=>'line '+i+'\\r\\n').join('')+'VISIBLE_END',resolve));
      terminal.term.scrollToBottom();let visible=capture(terminal,'visible');assert(!JSON.stringify(visible).includes('OFFSCREEN_ONLY')&&visible.facts.rows[0].text.includes('VISIBLE_END'),'Ambient scrollback collected');assert(!JSON.stringify(visible).includes('configuredForwards'),'Terminal text leaked connection settings');
      const buffer=terminal.term.buffer.active;terminal.term.select(0,buffer.length-1,7);const selected=capture(terminal,'selection');assert(selected.facts.rows[0].text==='VISIBLE','Selected xterm text differs');
      let requiresChoice=false;try{terminal.captureCopilotContext()}catch{requiresChoice=true}assert(requiresChoice,'Workspace capture silently chose ambient terminal context');
      terminal.copilotButton.click();let button=[...document.querySelectorAll('.ctx .item')].find(el=>el.textContent.includes('Explain selected terminal text'));
      if(!button)button=[...document.querySelectorAll('button')].find(el=>el.textContent.includes('Explain selected terminal text'));
      assert(button,'Terminal Copilot menu absent');const beforeMenu=calls.length;button.click();assert(attachments.length===1&&calls.length===beforeMenu,'Terminal menu performed extra actions');
      terminal.term.clearSelection();terminal.ro.disconnect();terminal.term.reset();terminal.term.resize(20,3);await new Promise(resolve=>terminal.term.write('A'.repeat(80)+'\\r\\nTAIL',resolve));terminal.term.scrollToLine(1);
      const clipped=capture(terminal,'visible');assert(!clipped.facts.rows[0].text.includes('AAAA')&&/clipped/.test(clipped.omissions.join(' ')),'Clipped wrapped secret prefix retained');
      terminal.term.reset();terminal.term.resize(80,6);await new Promise(resolve=>terminal.term.write(('Z'.repeat(80)+'\\r\\n').repeat(650),resolve));terminal.term.selectAll();
      const hugeTerminal=capture(terminal,'selection');assert(hugeTerminal.facts.rows[0].text===null&&!JSON.stringify(hugeTerminal).includes('ZZZZ'),'Oversized terminal selection prefix attached');
      const sftp=new SftpTab(host,{host:'192.0.2.10',password:'NeverCollectSyntheticPassword'},{name:'SFTP'});fixture.replaceChildren(sftp.el);sftp.state='connected';sftp.remote.ready=true;
      const nav1=sftp.remote.navigate('/old'),request1=take('sftp:list');const nav2=sftp.remote.navigate('/new'),request2=take('sftp:list');
      request2.resolve([{name:'chosen.txt',size:12,mtime:1,isDir:false,perms:'-rw-r--r--',owner:'operator'},{name:'other.txt',size:40,mtime:2,isDir:false},{name:'.hidden',size:99,hidden:true,isDir:false}]);await nav2;
      request1.resolve([{name:'stale.txt',size:1,isDir:false}]);await nav1;sftp.remote.table.selected=new Set(['chosen.txt']);
      const sf=capture(sftp,'remote-selection');assert(sf.facts.runSummary.observedPath==='/new'&&sf.facts.rows.length===1&&sf.facts.rows[0].name==='chosen.txt','SFTP stale navigation or selected metadata mismatch');assert(!JSON.stringify(sf).includes('other.txt')&&!JSON.stringify(sf).includes('.hidden'),'Unselected or hidden file metadata attached');
      const badNav=sftp.remote.navigate('/missing');take('sftp:list').reject(new Error('synthetic access denied'));await badNav;const failed=capture(sftp,'remote-listing');assert(failed.facts.runSummary.observedPath==='/new'&&failed.facts.runSummary.request.path==='/missing'&&failed.facts.runSummary.request.state==='error','Failed navigation relabelled retained listing');
      sftp.xfers.update({id:1,name:'failed.bin',direction:'down',src:'/remote/failed.bin',dst:'C:/Synthetic/failed.bin',size:9,done:2,status:'error',error:'Synthetic transfer failure',bytes:'NEVER_COLLECT_FILE_CONTENT'});
      const xf=capture(sftp,'transfers');assert(xf.facts.rows[0].error==='Synthetic transfer failure'&&!JSON.stringify(xf).includes('NEVER_COLLECT_FILE_CONTENT'),'Transfer error omitted or file data leaked');
      sftp.copilotButton.click();const transferMenu=[...document.querySelectorAll('.ctx .item')].find(el=>el.textContent.includes('Explain transfer status and errors'));assert(transferMenu,'SFTP Copilot menu missing');const beforeTransferMenu=calls.length;transferMenu.click();assert(calls.length===beforeTransferMenu&&attachments.length===2,'SFTP menu performed backend action');
      const late=sftp.remote.navigate('/late');const lateReq=take('sftp:list');sftp.onClosed('Synthetic disconnect');lateReq.resolve([{name:'late.bin',size:1}]);await late;assert(sftp.remote.cwd==='/new','Late disconnected listing accepted');assert(/not live/.test(capture(sftp,'remote-listing').omissions.join(' ')),'Retained listing freshness absent');
      const np=new NotepadTab(host);fixture.replaceChildren(np.el);host.active=np;await np.ready;
      const other=np.newDoc({text:'UNRELATED_DOCUMENT_SECRET',title:'Other'});const doc=np.newDoc({text:'Selected café 😀 KnownSyntheticKeyAcrossSelection\\nUnselected current text',title:'Current'});
      np.editor.setSelection(new np.monaco.Selection(1,1,1,doc.model.getLineMaxColumn(1)));
      const modelBefore=doc.model.getValue(),notepad=capture(np,'selection');assert(notepad.facts.rows[0].text===doc.model.getLineContent(1),'Monaco selected text changed');assert(!JSON.stringify(notepad).includes('UNRELATED_DOCUMENT_SECRET')&&!JSON.stringify(notepad).includes('Unselected current text'),'Other Notepad content attached');
      assert(doc.model.getValue()===modelBefore&&other.model.getValue()==='UNRELATED_DOCUMENT_SECRET','Capture modified editor model');
      const oldSnapshot=notepad;doc.model.setValue('Edited text');assert(oldSnapshot.facts.rows[0].text.includes('Selected café')&&capture(np,'document').facts.rows[0].text==='Edited text','Notepad snapshot mutated or revision wrong');
      doc.model.setValue('Z'.repeat(60000)+'OPAQUE_SUFFIX_NEVER_PREFIX');const big=capture(np,'document');assert(big.facts.rows[0].text===null&&!JSON.stringify(big).includes('ZZZZ')&&/complete chosen text/.test(big.omissions.join(' ')),'Oversized document raw prefix attached');
      doc.model.setValue('Small again');np.editor.setSelection(new np.monaco.Selection(1,1,1,1));let emptyRejected=false;try{capture(np,'selection')}catch{emptyRejected=true}assert(emptyRejected,'Empty selection fell back to whole document');
      [...np.menubar.querySelectorAll('button')].find(el=>el.textContent==='Ask Copilot').click();const docMenu=[...document.querySelectorAll('.ctx .item')].find(el=>el.textContent.includes('Explain current Notepad document'));assert(docMenu,'Notepad Copilot menu missing');const beforeDocMenu=calls.length;docMenu.click();assert(calls.length===beforeDocMenu&&attachments.length===3&&doc.model.getValue()==='Small again','Notepad menu performed backend action or edit');
      const tree=new SessionTree(host);tree.data={folders:[],sessions:[session]};tree.sessionMenu(5,5,session);let settingsButton=[...document.querySelectorAll('.ctx .item')].find(el=>el.textContent.includes('Ask Copilot about saved settings'));
      assert(settingsButton,'Saved-session Copilot menu missing');const beforeSession=calls.length;settingsButton.click();assert(calls.length===beforeSession&&attachments.length===4,'Session context connected or read extra data');
      const saved=attachments[3].snapshot;forbiddenSnapshot(saved);assert(saved.source.revision===null&&saved.source.runId===null&&saved.facts.rows[0].connectionState===null,'Saved session invented runtime or revision');snapshots.push(saved);
      assert(revisions.length>10,'Workspace producer revision updates missing');
      assert(!calls.some(call=>['conn:write','sftp:read','sftp:write','np:read','conn:startLog','xfer:start'].includes(call.channel)),'Context feature executed a mutation or content read');
      terminal.dispose();sftp.dispose();np.dispose();return snapshots;
    })()`);
    fs.writeFileSync(path.join(root, 'snapshots.json'), JSON.stringify(result)); console.log('COPILOT_WORKSPACE_PASS'); win.destroy(); app.exit(0);
  } catch (error) { fail(error); }
}

if (process.argv.includes('--workspace-context-fixture')) fixture().catch(error => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) runCopilotWorkspaceTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { runCopilotWorkspaceTests };
