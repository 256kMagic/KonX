'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
async function runCopilotEditorActionTests(test) {
  await test('Real Electron Monaco reviewed edit validates live identity, permission and selection, retains EOL and undoes as one change without save/upload', async () => {
    const root = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(root, 'konx-reviewed-editor-')); let child, output = '';
    try {
      const env = { ...process.env, KONX_REVIEWED_EDITOR_ROOT: dir }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require(path.join(repo, 'node_modules/electron')), [__filename, '--editor-action-fixture'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = data => { output = (output + data).slice(-1024 * 1024); }; child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Editor fixture timed out\n' + output)); }, 50000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
      assert.equal(code, 0, output); assert.match(output, /REVIEWED_EDITOR_PASS/);
    } finally {
      if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
      assert.equal(path.dirname(path.resolve(dir)), root); assert.match(path.basename(dir), /^konx-reviewed-editor-/); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
async function fixture() {
  const { app, BrowserWindow } = require('electron'), dir = path.resolve(process.env.KONX_REVIEWED_EDITOR_ROOT || '');
  assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir())); assert.match(path.basename(dir), /^konx-reviewed-editor-/); app.setPath('userData', path.join(dir, 'profile'));
  let win; try {
    await app.whenReady(); fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><div id="editor" style="width:850px;height:560px"></div></body></html>');
    win = new BrowserWindow({ show: false, focusable: false, width: 900, height: 650, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    await win.loadFile(path.join(dir, 'index.html'));
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const {loadMonaco}=await import(${JSON.stringify(pathToFileURL(path.join(repo, 'src/renderer/js/notepad/monaco.js')).href)});
      const {captureEditorActionTarget:capture,applyReviewedEditorAction:apply}=await import(${JSON.stringify(pathToFileURL(path.join(__dirname, '../src/renderer/js/copilot-editor-actions.mjs')).href)});
      const monaco=await loadMonaco(), check=(value,message)=>{if(!value)throw new Error(message)}, rejected=async(request,owner,message)=>{check((await apply(owner,request)).status==='rejected',message)};
      const editor=monaco.editor.create(document.getElementById('editor'),{value:'',language:'plaintext',minimap:{enabled:false},automaticLayout:false});
      let saved=0,uploaded=0; const owner={id:'owned-notepad',docs:[],current:null,editor,monaco,save(){saved++},upload(){uploaded++}};
      const set=(content,id='owned-document')=>{const model=monaco.editor.createModel(content,'plaintext');const doc={id,model,readOnly:false,savePending:false};owner.docs.push(doc);owner.current=doc;editor.setModel(model);editor.setSelection(model.getFullModelRange());return doc};
      const request=async(replacement)=>({operationId:crypto.randomUUID(),nonce:crypto.randomUUID(),expiresAt:new Date(Date.now()+5000).toISOString(),target:await capture(owner),replacement});
      for(const eol of ['\\n','\\r\\n']){
        const doc=set('before'+eol+'second'+eol+'tail'); editor.setSelection({startLineNumber:1,startColumn:1,endLineNumber:2,endColumn:7});
        const before=doc.model.getValue(), req=await request('after\\nchanged'), ack=await apply(owner,req);
        check(ack.status==='applied'&&ack.afterVersion>req.target.versionId,'edit acknowledged'); check(doc.model.getValue()==='after'+eol+'changed'+eol+'tail','EOL retained');
        check(doc.model.getValueInRange({startLineNumber:1,startColumn:1,endLineNumber:2,endColumn:8},monaco.editor.EndOfLinePreference.LF)==='after\\nchanged','LF snapshot exact');
        await doc.model.undo(); check(doc.model.getValue()===before,'single undo restores all original text');
        await rejected(req,owner,'replay after undo must fail version identity');
      }
      let doc=set('first second');editor.setSelection({startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:6});let req=await request('replacement');
      editor.setSelection({startLineNumber:1,startColumn:7,endLineNumber:1,endColumn:13});await rejected(req,owner,'selection changed');
      editor.setSelection(req.target.selection);doc.readOnly=true;await rejected(req,owner,'doc read-only');doc.readOnly=false;doc.savePending=true;await rejected(req,owner,'save pending');doc.savePending=false;
      editor.updateOptions({readOnly:true});await rejected(req,owner,'editor permission');editor.updateOptions({readOnly:false});
      const raced=apply(owner,req);doc.readOnly=true;check((await raced).status==='rejected','permission change during hash');doc.readOnly=false;
      const captureRace=capture(owner);doc.model.setValue('changed during snapshot');let blocked=false;try{await captureRace}catch{blocked=true}check(blocked,'capture cannot publish stale version');
      doc=set('old');req=await request('new');const sameId=doc.id;doc.model.dispose();owner.docs=owner.docs.filter(item=>item!==doc);doc=set('old',sameId);await rejected(req,owner,'recreated document ID with new model');
      req=await request('');check((await apply(owner,req)).status==='applied','explicit deletion');check(doc.model.getValue()==='','deletion exact');await doc.model.undo();check(doc.model.getValue()==='old','deletion undo');
      editor.setSelection(doc.model.getFullModelRange());req=await request('new');req.expiresAt=new Date(0).toISOString();await rejected(req,owner,'expired target');
      req=await request('new');req.target.beforeDigest='a'.repeat(64);await rejected(req,owner,'tampered before digest');
      check(saved===0&&uploaded===0,'no file save or remote upload'); editor.dispose();for(const item of owner.docs)if(!item.model.isDisposed())item.model.dispose();return {saved,uploaded};
    })()`);
    assert.deepEqual(result, { saved: 0, uploaded: 0 }); console.log('REVIEWED_EDITOR_PASS'); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack || error); win?.destroy(); app.exit(1); }
}
module.exports = { runCopilotEditorActionTests };
if (process.argv.includes('--editor-action-fixture')) fixture();
else if (require.main === module) runCopilotEditorActionTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
