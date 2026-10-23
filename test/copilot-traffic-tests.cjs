'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
let ROOT = __dirname;
while (!fs.existsSync(path.join(ROOT, 'src/main/ai.js'))) { if (path.dirname(ROOT) === ROOT) throw new Error('Cannot locate KonX'); ROOT = path.dirname(ROOT); }
const SOURCE = path.resolve(__dirname, '../src/renderer/js');
const KINDS = ['capture-packet', 'capture-stream', 'sip-call', 'rtp-stream', 'capture-compare', 'remote-capture', 'security', 'wifi', 'mist'];

async function runCopilotTrafficTests(test) {
  await test('traffic KonX-AI: actual offline capture and assessment views attach explicit bounded parsed facts without collection', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-copilot-traffic-'));
    let child, output = '';
    try {
      fs.cpSync(path.join(ROOT, 'src/renderer'), path.join(root, 'renderer'), { recursive: true });
      for (const name of ['copilot-traffic.mjs', 'copilot-traffic-ui.js', 'capture.js', 'security.js', 'wifi.js', 'mist.js', 'remote-capture.js', 'capture-compare.js', 'capture/traffic-view.js', 'capture/sip-view.js', 'capture/rtp-view.js']) fs.copyFileSync(path.join(SOURCE, name), path.join(root, 'renderer/js', name));
      fs.writeFileSync(path.join(root, 'renderer/fixture.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="toasts"></div><main id="fixture" style="height:540px;width:900px"></main>');
      const env = { ...process.env, KONX_TRAFFIC_CONTEXT_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--traffic-context-fixture'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = data => { output = (output + data).slice(-256 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Traffic context fixture timeout\n' + output)); }, 60000);
        child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
      assert.equal(code, 0, output); assert.match(output, /COPILOT_TRAFFIC_UI_PASS/);
      const snapshots = JSON.parse(fs.readFileSync(path.join(root, 'snapshots.json'), 'utf8'));
      assert.deepEqual([...new Set(snapshots.map(item => item.kind))].sort(), [...KINDS].sort());
      const schema = require(path.join(ROOT, 'src/main/copilot-store.js'));
      for (const snapshot of snapshots) schema.normalizeSnapshot(snapshot);
      const { redactText } = require(path.join(ROOT, 'src/main/ai-redaction.js'));
      const boundary = snapshots.find(item => item.facts.rows.some(row => row.text?.includes('SyntheticCompleteKey')));
      assert.ok(boundary, 'Complete source text reached the redaction boundary');
      assert.equal(redactText(JSON.stringify(boundary), ['SyntheticCompleteKey']).includes('SyntheticCompleteKey'), false);
    } finally {
      if (child && child.exitCode == null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-copilot-traffic-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow } = require('electron');
  const root = path.resolve(process.env.KONX_TRAFFIC_CONTEXT_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-copilot-traffic-'));
  let win, finishing = false;
  const fail = error => { if (finishing) return; finishing = true; console.error(error.stack || error); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); };
  process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
  app.setPath('userData', path.join(root, 'profile')); await app.whenReady();
  win = new BrowserWindow({ show: false, width: 900, height: 560, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(root, 'renderer/fixture.html'));
    const snapshots = await win.webContents.executeJavaScript(`(async () => {
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      const wait = async fn => { const until=Date.now()+6000; while(!fn()) { if(Date.now()>until)throw new Error('Fixture condition timed out'); await new Promise(r=>setTimeout(r,10)); } };
      const calls=[], attached=[], changes=[], tabs=[], snapshots=[];
      window.api={invoke:async(channel,...args)=>{calls.push({channel,args}); if(channel==='cap:status')return {available:false,error:'Offline fixture'};
        if(channel==='cap:stop')return; if(channel==='tools:deviceConnections')return [];
        if(channel==='tools:mistConfig')return {hasToken:false,region:'global',regions:[{id:'global',label:'Global'}]};
        throw new Error('Unexpected IPC: '+channel); }};
      const host={byId:new Map(),registerJob(){},unregisterJob(){},tabStateChanged(){},updateStatus(){},setTabTitle(tab,title){tab.title=title},copilot:{sourceChanged(tab){changes.push(tab.copilot.revision)}},openCopilot(tab,options){attached.push(options.snapshot);snapshots.push(options.snapshot)}};
      const make=tab=>{tabs.push(tab);document.querySelector('#fixture').replaceChildren(tab.el);return tab};
      const snap=(tab,choice)=>{const before=calls.length;const result=tab.captureCopilotContext({choice});check(calls.length===before,'Attachment invoked IPC');snapshots.push(result);return result};
      const click=label=>{const button=[...document.querySelectorAll('button,.ctx .item')].find(b=>b.textContent.trim()===label);check(button&&!button.disabled&&!button.classList.contains('disabled'),'Missing enabled button: '+label);button.click();};
      const {CaptureTab}=await import('./js/capture.js');
      const {createComparisonDemo}=await import('./js/capture/sample-compare.mjs');
      const {rtpDemoCapture}=await import('./js/capture/sample-rtp.mjs');
      const {streamContext,rtpContext}=await import('./js/copilot-traffic.mjs');
      const {parseHttpStream}=await import('./js/capture/http.mjs');
      const cap=make(new CaptureTab(host));await new Promise(r=>setTimeout(r,0));
      check(cap.copilotContextChoices()[0].disabled,'Empty packet source must disable attachment');
      let rejected=false;try{cap.captureCopilotContext()}catch{rejected=true}check(rejected,'Implicit capture was permitted');
      const demo=createComparisonDemo();await cap.loadBytes(demo.before.bytes,demo.before.name);cap.select(5);
      const ps=snap(cap,'selected-packet');check(ps.facts.rows[0].no===6&&ps.facts.rows[0].fields['tcp.srcport'],'Packet identity or decoded fields missing');
      check(!JSON.stringify(ps).includes('data\\":')&&!JSON.stringify(ps).includes('payload'),'Raw packet bytes included');
      const conv=cap.analyzer.streams.find(c=>c.proto==='TCP');const old=cap.copilot.retain(),oldRevision=old.revision;cap.copilot.touch();
      const pending=cap.follow(conv.id);await wait(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Ask KonX-AI about this stream'&&!b.disabled));
      const before=calls.length;click('Ask KonX-AI about this stream');await pending;check(calls.length===before,'Stream attachment performed IO');
      const readable=attached.at(-1);check(readable.kind==='capture-stream'&&readable.facts.rows.some(row=>row.text==='ok'),'Real HTTP reassembly text missing');
      const stream=cap.analyzer.followStream(cap.packets,conv.id,'TCP'),parsed=await parseHttpStream(stream);
      const artificial={...parsed,messages:[{...parsed.messages[0],text:'A'.repeat(30000)+'SyntheticCompleteKey',previewTruncated:false,headers:[{name:'Authorization',value:'HiddenHeader'},{name:'Content-Type',value:'text/plain'}]}]};
      const complete=streamContext(old,stream,artificial);snapshots.push(complete);check(complete.source.revision===oldRevision,'Historical modal revision changed');
      check(complete.facts.rows[0].text.endsWith('SyntheticCompleteKey')&&!JSON.stringify(complete).includes('HiddenHeader'),'Body sliced before redaction or auth header attached');
      artificial.messages[0].previewTruncated=true;const truncated=streamContext(old,stream,artificial);check(truncated.facts.rows[0].text===undefined&&/truncated text preview/.test(truncated.omissions.join(' ')),'Partial raw message text disclosed');
      artificial.messages[0].previewTruncated=false;artificial.messages[0].text='OpaqueBoundarySecret'.repeat(10000);const bounded=streamContext(old,stream,artificial);check(!JSON.stringify(bounded).includes('OpaqueBoundarySecret')&&/whole-field/.test(bounded.omissions.join(' ')),'Oversize field split');
      const ppcap=cap.captureCopilotContext({choice:'selected-packet'});cap.clear(false);check(cap.copilotContextChoices()[0].disabled&&ppcap.facts.rows[0].no===6,'Clear mutated historical attachment');
      await cap.loadBytes(rtpDemoCapture(),'synthetic-media.pcapng');const sipPending=cap.openSipCalls();await wait(()=>document.querySelector('.sip-workspace'));click('Ask KonX-AI about this call');await sipPending;
      const sip=attached.at(-1);check(sip.kind==='sip-call'&&sip.facts.rows.some(row=>row.sdp?.media.length),'Real SIP/SDP evidence missing');check(!JSON.stringify(sip).includes('rawText'),'Raw SIP attached');
      const mediaPending=cap.openRtpMedia();await wait(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Ask KonX-AI about stream quality'&&!b.disabled));click('Ask KonX-AI about stream quality');await mediaPending;
      const rtp=attached.at(-1);check(rtp.kind==='rtp-stream'&&rtp.facts.runSummary.stream.sequenceGaps===3&&rtp.facts.rows[0].frame,'Real RTP gap/frame facts missing');
      check(!JSON.stringify(rtp).includes('payload\\":')&&!JSON.stringify(rtp).includes('audioData'),'Media payload included');
      const massive={...rtp.facts.runSummary.stream,packets:Array.from({length:10000},(_,i)=>({frame:i+1,flags:[]})),packetCount:10000};
      const boundedRtp=rtpContext(cap.copilot,massive,{});check(boundedRtp.facts.rows.length===200&&/200 rows/.test(boundedRtp.omissions.join(' ')),'RTP bounds not enforced');
      const {CaptureComparisonTab}=await import('./js/capture-compare.js');const compare=make(new CaptureComparisonTab(host));await compare.loadDemo();check(compare.report,'Offline comparison not produced');
      compare.showChange(compare.report.changes.find(row=>row.status==='changed')||compare.report.changes[0]);const cs=snap(compare,'selected-change');check(cs.facts.rows.length===1&&cs.facts.rows[0].sourceId&&cs.facts.runSummary.before.label,'Comparison source references missing');
      const {SecurityTab}=await import('./js/security.js');const sec=make(new SecurityTab(host));sec.report={schemaVersion:1,kind:'ssh',title:'Fixture assessment',target:'old.example',scopeId:'a'.repeat(64),scannedAt:'2026-10-23T12:00:00Z',checks:[{id:'weak',title:'Weak algorithm',status:'warning',severity:'medium',confidence:'high',evidence:'Observed group1',remediation:'Upgrade device',reference:''},{id:'unknown',title:'Unavailable',status:'unknown',severity:'info',confidence:'low',evidence:'Handshake incomplete',remediation:'',reference:''}],limitations:['Only observed handshake']};sec.renderReport();sec.table.selected=new Set(['unknown']);sec.host.value='unsent.example';sec.config.value='NeverAttachConfiguration';
      const ss=snap(sec,'selected-check');check(ss.facts.rows[0].status==='unknown'&&ss.scope.inputs.target==='old.example'&&!JSON.stringify(ss).includes('NeverAttach'),'Security unknown or frozen scope lost');
      sec.el.querySelector('[aria-label="Ask KonX-AI about this evidence"]').click();click('Selected security check');check(attached.at(-1).kind==='security','Local evidence menu failed');
      const {WifiTab}=await import('./js/wifi.js');const wifi=make(new WifiTab(host));wifi.report={schemaVersion:1,kind:'wifi',collectedAt:'2026-10-23T12:00:00Z',adapters:[{id:'wlan',name:'Fixture Wi-Fi',state:'connected',connection:{ssid:'Lab',rxMbps:72}}],networks:[{adapterId:'wlan',bssid:'00:11:22:33:44:55',ssid:'Lab',band:'2.4 GHz',channel:6,authentication:'WPA2',encryption:'CCMP',groupEncryption:'TKIP',rssiDbm:null}],channels:[],findings:[],limitations:['Cached only']};wifi.renderReport();wifi.networks.selected=new Set([wifi.networks.rowKey(wifi.report.networks[0])]);const ws=snap(wifi,'selected-network');check(ws.facts.rows[0].groupEncryption==='TKIP'&&ws.facts.rows[0].rssiDbm===null,'Wi-Fi group cipher or unknown RSSI lost');snap(wifi,'survey');
      const {MistTab}=await import('./js/mist.js');const mist=make(new MistTab(host));await mist.ready;mist.report={action:'aps',region:'global',fetchedAt:'2026-10-23T12:00:00Z',scope:{siteId:'fixture-site'},data:[{id:'ap-1',name:'Fixture AP',model:'AP43',status:'connected',token:'NeverAttachToken',arbitrary:'NeverAttachArbitrary'}],limited:false,limitations:[]};mist.renderReport();mist.table.selected=new Set([':ap-1']);mist.token.value='NeverAttachInput';const ms=snap(mist,'selected-entity');check(ms.facts.rows[0].name==='Fixture AP'&&!JSON.stringify(ms).includes('NeverAttach'),'Mist credential or arbitrary value disclosed');
      mist.report={...mist.report,limited:true,limitations:['Cloud response truncated at the local text, record, or nesting limit. Use the Mist portal to inspect the full response.']};mist.renderReport();mist.table.selected=new Set([':ap-1']);check(!snap(mist,'selected-entity').facts.rows.length,'Possibly pretruncated cloud field disclosed');
      const {RemoteCaptureTab}=await import('./js/remote-capture.js');const remote=make(new RemoteCaptureTab(host));await remote.ready;remote.report={schemaVersion:1,kind:'remote-capture',host:'capture.example',interface:'any',filter:'udp port 5060',startedAt:'2026-10-23T12:00:00Z',finishedAt:'2026-10-23T12:00:01Z',packets:2,bytes:500,fileName:'fixture.pcap',captureId:'fixture-cap',remoteExitConfirmed:false,complete:false,warnings:['Remote termination unconfirmed'],stderr:'NeverAttachStderr'};remote.renderReport();const rs=snap(remote,'collection-report');check(rs.facts.rows[0].remoteExitConfirmed===false&&!JSON.stringify(rs).includes('NeverAttachStderr'),'Remote uncertainty or stderr exclusion');const rv=remote.copilot.revision;remote.report.captureUnavailable=true;remote.renderReport();check(remote.copilot.revision>rv&&snap(remote,'collection-report').facts.rows[0].captureUnavailable,'Remote deletion did not update source revision');
      check(changes.length>10,'Producer revisions missing');check(calls.every(call=>['cap:status','cap:stop','tools:mistConfig','tools:deviceConnections'].includes(call.channel)),'Context caused collection or file/network access');
      for(const snapshot of snapshots){check(new TextEncoder().encode(JSON.stringify(snapshot)).length<=65536,'Snapshot byte bound');check(snapshot.coverage.complete===false,'Selective context claims complete source coverage');}
      for(const tab of tabs)tab.dispose();return snapshots;
    })()`);
    fs.writeFileSync(path.join(root, 'snapshots.json'), JSON.stringify(snapshots));
    console.log('COPILOT_TRAFFIC_UI_PASS'); finishing = true; win.destroy(); app.exit(0);
  } catch (error) { fail(error); }
}
if (process.argv.includes('--traffic-context-fixture')) fixture().catch(error => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) runCopilotTrafficTests(async(name,fn)=>{await fn();console.log('PASS '+name)}).catch(error=>{console.error(error);process.exitCode=1});
module.exports = { runCopilotTrafficTests };
