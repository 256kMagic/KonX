'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'src/renderer/js');
const KINDS = ['device', 'snapshots', 'topology', 'events', 'sites', 'incidents', 'runbook', 'change-validation'];
const FILES = ['copilot-investigations.mjs', 'device.js', 'snapshots.js', 'topology.js', 'events.js', 'site-workspaces.js', 'incidents.js', 'runbooks.js', 'change-validation.js'];

async function runCopilotInvestigationTests(test) {
  await test('investigation Copilot: actual eight renderer views attach selected canonical evidence without backend actions, clipping or unrelated data', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-copilot-investigation-'));
    let child, output = '';
    try {
      fs.cpSync(path.join(ROOT, 'src/renderer'), path.join(root, 'src/renderer'), { recursive: true });
      for (const name of FILES) fs.copyFileSync(path.join(SOURCE, name), path.join(root, 'src/renderer/js', name));
      fs.writeFileSync(path.join(root, 'src/renderer/fixture.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="toasts"></div><main id="fixture" style="width:900px;height:540px;overflow:auto"></main>');
      const env = { ...process.env, KONX_INVESTIGATION_CONTEXT_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--investigation-context-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = data => { output = (output + data).slice(-512 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(Error('Investigation fixture timed out\n' + output)); }, 60000);
        child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0, output); assert.match(output, /COPILOT_INVESTIGATION_PASS/);
      const snapshots = JSON.parse(fs.readFileSync(path.join(root, 'snapshots.json'), 'utf8'));
      const store = require(path.join(ROOT, 'src/main/copilot-store.js'));
      // This assertion is unconditional: no published test can silently skip a
      // missing main kind registration or an incompatible snapshot contract.
      for (const kind of KINDS) assert.ok(store.KINDS.includes(kind), 'Main kind registration missing: ' + kind);
      const { redactText } = require(path.join(ROOT, 'src/main/ai-redaction.js'));
      for (const snapshot of snapshots) {
        assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 64 * 1024);
        const safe = store.normalizeSnapshot(snapshot, value => typeof value === 'string' ? redactText(value, ['SyntheticOpaqueContextSecret']) : value);
        assert.equal(JSON.stringify(safe).includes('SyntheticOpaqueContextSecret'), false);
        assert.equal(JSON.stringify(snapshot).includes('NEVER_ATTACH_'), false);
      }
      assert.deepEqual([...new Set(snapshots.map(snapshot => snapshot.kind))].sort(), [...KINDS].sort());
    } finally {
      if (child && child.exitCode == null) { const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit; }
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-copilot-investigation-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow } = require('electron'), root = path.resolve(process.env.KONX_INVESTIGATION_CONTEXT_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-copilot-investigation-'));
  app.setPath('userData', path.join(root, 'profile')); await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 920, height: 620, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const fail = error => { console.error(error.stack || error); for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.exit(1); };
  process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
  try {
    await win.loadFile(path.join(root, 'src/renderer/fixture.html'));
    const { analyzeDevice } = require('../src/main/device-analysis');
    const commandCases = [
      ['ok', 'GigabitEthernet0/1 is up, line protocol is up\n  Description: Complete canonical source'],
      ['truncated', 'GigabitEthernet0/1 is up, line protocol is up\n  Description: NEVER_ATTACH_TRUNCATED_COMMAND_PREFIX'],
      ['timeout', 'GigabitEthernet0/1 is up, line protocol is up\n  Description: NEVER_ATTACH_TIMEOUT_COMMAND_PREFIX'],
      ['cancelled', 'GigabitEthernet0/1 is up, line protocol is up\n  Description: NEVER_ATTACH_CANCELLED_COMMAND_PREFIX'],
      ['ok', 'GigabitEthernet0/1 is up, line protocol is up\n  Description: NEVER_ATTACH_PAGINATED_COMMAND_PREFIX\n--More--'],
    ].map(([status, output]) => analyzeDevice([{ id: 'interfaces', status, output }], { id: 'canonical-device', host: '192.0.2.20', collectedAt: '2026-10-23T12:00:00.000Z' }));
    assert.equal(commandCases[0].coverage.find(item => item.commandId === 'interfaces').complete, true);
    assert.ok(commandCases.slice(1).every(device => device.coverage.find(item => item.commandId === 'interfaces').complete === false));
    assert.ok(commandCases.every(device => !Object.hasOwn(device.commands[0], 'truncated')));
    const snapshots = await win.webContents.executeJavaScript(`(async () => {
      const assert=(condition,message)=>{if(!condition)throw Error(message)},snapshots=[],calls=[],attachments=[],revisions=[],pending=[];
      const time='2026-10-23T12:00:00.000Z',later='2026-10-23T12:01:00.000Z';
      window.api={on(){return()=>{}},send(channel,...args){calls.push({channel,args});throw Error('Unexpected send '+channel)},invoke(channel,...args){
        calls.push({channel,args});
        if(channel==='tools:deviceConnections')return Promise.resolve([]);
        if(channel==='tools:snapshotList')return Promise.resolve({snapshots:[],issues:[]});
        if(channel==='tools:siteList')return Promise.resolve({workspaces:[],issues:[],capabilities:{toolKinds:[]}});
        if(channel==='tools:incidentList')return Promise.resolve({incidents:[],issues:[]});
        if(channel==='tools:runbookTemplates')return Promise.resolve([]);
        if(channel==='tools:runbookList')return Promise.resolve({runbooks:[],issues:[]});
        if(channel==='tools:changeList')return Promise.resolve({records:[],issues:[]});
        if(channel==='tools:eventsList')return Promise.resolve({listeners:[]});
        if(channel==='sessions:list')return Promise.resolve({sessions:[]});
        if(channel==='tools:deviceTrace'||channel==='tools:snapshotCompare'||channel==='tools:topologyBuild')return new Promise(resolve=>pending.push({channel,resolve}));
        throw Error('Unexpected IPC '+channel);
      }};
      const [{DeviceTab},{SnapshotTab},{TopologyTab},{EventsTab},{SiteWorkspacesTab},{IncidentTab},{RunbookTab},{ChangeValidationTab},context]=await Promise.all([
        import('./js/device.js'),import('./js/snapshots.js'),import('./js/topology.js'),import('./js/events.js'),import('./js/site-workspaces.js'),import('./js/incidents.js'),import('./js/runbooks.js'),import('./js/change-validation.js'),import('./js/copilot-investigations.mjs')]);
      const {CopilotController}=await import('./js/copilot.js');
      const host={tabs:[],byId:new Map(),settings:{},sessions:{data:{sessions:[]},async load(){}},copilot:{sourceChanged(tab){revisions.push({id:tab.id,revision:tab.copilot?.revision})}},
        updateStatus(){},tabStateChanged(){},registerJob(){},unregisterJob(){},openCopilot(tab,options){attachments.push({id:tab.id,...options});return Promise.resolve()},openTool(){throw Error('Capture opened a tool')},activate(){throw Error('Capture navigated a tab')},connectSession(){throw Error('Capture connected')}};
      const fixture=document.querySelector('#fixture');
      const capture=(tab,choice)=>{const before=calls.length,revision=tab.copilot.revision;const result=tab.captureCopilotContext({choice});assert(calls.length===before,'Capture invoked IPC '+choice);assert(tab.copilot.revision===revision,'Capture mutated source revision');assert(Object.isFrozen(result)&&Object.isFrozen(result.facts),'Snapshot is mutable');snapshots.push(result);return result};
      const menu=(tab,label)=>{fixture.replaceChildren(tab.el);tab.el.classList.add('active');const before=calls.length;tab.copilotButton.click();const item=[...document.querySelectorAll('.ctx .item')].find(item=>item.textContent.includes(label));assert(item,'Missing local choice '+label);item.click();assert(attachments.length&&calls.length===before,'Menu had backend side effect '+label)};
      const expectThrow=fn=>{let threw=false;try{fn()}catch{threw=true}assert(threw,'Expected explicit unavailable-choice error')};
      const device=new DeviceTab(host);host.tabs.push(device);fixture.append(device.el);await device.ready;
      const facts={interfaces:[{name:'Gi0/1',status:'up',description:'SyntheticOpaqueContextSecret',source:{commandId:'interfaces',line:2}},{name:'NEVER_ATTACH_UNSELECTED_INTERFACE',status:'down',source:{commandId:'interfaces',line:3}}],vlans:[],mac:[],arp:[],neighbors:[],poe:[],routes:[]};
      const dev={id:'dev-a',label:'Switch A',host:'192.0.2.10',collectedAt:time,facts,coverage:[{commandId:'interfaces',complete:true,status:'ok',recognizedRows:2}],warnings:[],commands:[{id:'interfaces',command:'show interfaces',status:'ok',output:'Gi0/1 is up\\nSyntheticOpaqueContextSecret'},{id:'other',command:'show version',status:'ok',output:'NEVER_ATTACH_UNSELECTED_COMMAND'}]};
      device.acceptReport({kind:'device',schemaVersion:1,collectedAt:time,devices:[dev],limitations:['Recorded observations only']});device.table.selected.add(0);
      let s=capture(device,'facts');assert(s.facts.rows[0].observation.name==='Gi0/1'&&s.facts.rows[0].observation.source.line===2,'Selected device facts/source lost');assert(s.facts.runSummary.device.collectedAt===time,'Device source time lost');
      expectThrow(()=>device.captureCopilotContext());menu(device,'selected device facts');
      device.commandSelect.value='interfaces';s=capture(device,'command');assert(s.facts.rows[0].output.includes('SyntheticOpaqueContextSecret'),'Whole command not retained');
      for (const [index, canonical] of ${JSON.stringify(commandCases)}.entries()) {
        device.acceptReport({kind:'device',schemaVersion:1,collectedAt:time,devices:[canonical],limitations:[]});
        s=capture(device,'command');
        if(index===0)assert(s.facts.rows[0].output===canonical.commands[0].output,'Complete canonical command was lost');
        else assert(s.facts.rows[0].output===null&&/omitted whole/.test(s.omissions.join(' ')),'Incomplete canonical command prefix retained: '+canonical.commands[0].status);
      }
      device.acceptReport({kind:'device',schemaVersion:1,collectedAt:time,devices:[dev],limitations:[]});
      dev.commands[0].output='Z'.repeat(60000)+'NEVER_ATTACH_OVERSIZED_COMMAND';s=capture(device,'command');assert(s.facts.rows[0].output===undefined&&/whole-field/.test(s.omissions.join(' ')),'Oversized command partly attached');dev.commands[0].output='complete';
      device.query.value='192.0.2.90';const tracePromise=device.find();pending.shift().resolve({query:'192.0.2.90',warnings:['Candidate only'],matches:[{deviceId:'dev-a',interface:'Gi0/1',source:{commandId:'mac',line:4}}],paths:[{mac:'0011.2233.4455',status:'candidate',reason:'Neighbor evidence',steps:[{deviceId:'dev-a',interface:'Gi0/1'}]}]});await tracePromise;device.query.value='NEVER_ATTACH_LIVE_TRACE_INPUT';s=capture(device,'trace');assert(s.facts.rows[0].query==='192.0.2.90'&&s.facts.rows[0].paths[0].status==='candidate','Trace used live query or lost candidate uncertainty');
      const snapshot=new SnapshotTab(host);host.tabs.push(snapshot);await snapshot.ready;
      const diff={before:{id:'before',label:'Before',savedAt:time},after:{id:'after',label:'After',savedAt:later},summary:{changed:1,unknown:0,comparedDevices:1},warnings:[],devices:[],unmatched:[],changes:[{deviceId:'dev-a',deviceLabel:'Switch A',category:'interfaces',identity:'Gi0/1',status:'changed',before:{name:'Gi0/1',status:'down'},after:{name:'Gi0/1',status:'up'},beforeSource:{deviceId:'dev-a',commandId:'interfaces',line:2},afterSource:{deviceId:'dev-a',commandId:'interfaces',line:3}},{deviceId:'dev-a',deviceLabel:'Switch A',category:'interfaces',identity:'NEVER_ATTACH_OTHER_CHANGE',status:'changed'}]};
      snapshot.before.append(new Option('Before','before'));snapshot.after.append(new Option('After','after'));snapshot.before.value='before';snapshot.after.value='after';snapshot.records={before:{report:{devices:[dev]}},after:{report:{devices:[dev]}}};const cmp=snapshot.compare();pending.shift().resolve(diff);await cmp;snapshot.table.selected.add(0);snapshot.before.value='';s=capture(snapshot,'changes');assert(s.facts.rows[0].before.status==='down'&&s.facts.rows[0].after.status==='up'&&s.facts.runSummary.before.id==='before','Comparison used live selectors or lost before/after');menu(snapshot,'before/after changes');
      const topology=new TopologyTab(host);host.tabs.push(topology);await topology.ready;
      const graph={kind:'topology',schemaVersion:1,generatedAt:later,staleHours:24,limitations:['Directional advertisements are observations'],coverage:{completeGraph:true,observationsComplete:true,clippedFields:0},nodes:[{id:'a',kind:'device',label:'Switch A',host:'192.0.2.10',age:'within-threshold',collectedAt:time,deviceId:'dev-a',coverage:[]},{id:'b',kind:'neighbor',label:'Switch B',age:'unknown',resolution:'unresolved',candidateDeviceIds:[]}],links:[{id:'link-a',from:'a',to:'b',protocols:['CDP'],kind:'neighbor',age:'unknown',resolution:'unresolved',localInterface:'Gi0/1',remoteInterface:'Gi0/2',localState:'up',meaning:'Advertisement, not verified forwarding',evidence:[{deviceId:'dev-a',commandId:'cdp',line:7,complete:true}]}],endpoint:{query:'192.0.2.90',matches:[],arpEvidence:[{deviceId:'dev-a',commandId:'arp',line:4,ip:'192.0.2.90',mac:'0011.2233.4455'}],warnings:[],paths:[{mac:'0011.2233.4455',status:'candidate',reason:'Not direct attachment proof',steps:[{deviceLabel:'Switch A',interface:'Gi0/1'}]}]}};
      const loading=topology.load(()=>device.report,'Loaded');await Promise.resolve();pending.shift().resolve(graph);await loading;topology.select('link','link-a');topology.query.value='NEVER_ATTACH_LIVE_TOPOLOGY_QUERY';s=capture(topology,'selection');assert(s.facts.rows[0].evidence[0].line===7&&s.facts.rows[0].resolution==='unresolved','Selected link provenance missing');menu(topology,'selected topology');s=capture(topology,'paths');assert(s.facts.rows[0].paths[0].status==='candidate'&&s.facts.rows[0].query==='192.0.2.90','Candidate trace wrong');graph.coverage.clippedFields=1;graph.links[0].meaning='NEVER_ATTACH_CLIPPED_GRAPH_PREFIX';s=capture(topology,'selection');assert(s.facts.rows[0].graphEvidence===null,'Clipped graph prefix retained');graph.coverage.clippedFields=0;graph.links[0].meaning='Advertisement';
      const events=new EventsTab(host);host.tabs.push(events);await events.ready;
      events.adoptSummary({listenerId:events.listenerId,state:'stopped',settings:{protocol:'snmp',bindAddress:'127.0.0.1',port:5162},startedAt:time,stoppedAt:later,hasOwnership:false,retainedRecords:3,lastSequence:3,counters:{received:3,accepted:3,historyEvicted:2}});
      events.replaceRecords([{listenerId:events.listenerId,sequence:1,receivedAt:later,source:{address:'192.0.2.11',port:99},protocol:'syslog',format:'rfc3164',parseStatus:'parsed',timestamp:null,timestampText:'Oct 23 08:00:00',timestampUncertainty:'Year and timezone absent',message:'Selected switch event'},{listenerId:events.listenerId,sequence:2,receivedAt:later,source:{address:'192.0.2.12',port:99},protocol:'snmp',format:'snmp2c',parseStatus:'parsed',timestamp:null,message:'SNMP trap 1.2.3',community:'NEVER_ATTACH_COMMUNITY',snmp:{version:'2c',trapOid:'1.2.3',community:'NEVER_ATTACH_COMMUNITY_NESTED',variables:[{oid:'1.2.4',type:'OctetString',value:'NEVER_ATTACH_TRUNCATED_VAR_PREFIX',truncated:true,byteLength:3000},{oid:'1.2.5',type:'Integer32',value:7}]}},{listenerId:events.listenerId,sequence:3,receivedAt:later,source:{address:'192.0.2.13',port:99},protocol:'syslog',message:'NEVER_ATTACH_UNSELECTED_EVENT'}]);events.selected=new Set([1,2]);s=capture(events,'selected-events');assert(s.facts.rows.length===2&&s.facts.rows[0].timestamp===null&&s.facts.rows[1].snmp.variables[0].value===null&&s.facts.rows[1].snmp.variables[1].value===7,'Event parsed facts/uncertainty lost');menu(events,'explicitly selected events');assert(events.navigateCopilotSource(s.facts.rows[0].locator),'Retained event locator failed');events.replaceRecords([]);assert(!events.navigateCopilotSource(s.facts.rows[0].locator),'Stale event locator falsely resolved');
      const sites=new SiteWorkspacesTab(host);host.tabs.push(sites);await sites.ready;sites.draft={name:'Site A draft',description:'Investigate voice reachability',notes:'SyntheticOpaqueContextSecret',sessions:[{id:'session-a',name:'Switch A',group:'Access',password:'NEVER_ATTACH_SESSION_PASSWORD',privateKey:'NEVER_ATTACH_SESSION_KEY'}],captures:[{id:'capture-a',name:'Voice trace',path:'C:/Synthetic/voice.pcap',contents:'NEVER_ATTACH_CAPTURE_CONTENTS'}],incidentIds:['incident-a'],layout:{preset:'workbench',panels:[{key:'panel-a',kind:'session',referenceId:'session-a',sessionMode:'sftp',placement:'docked',slot:0}]}};sites.changed();s=capture(sites,'draft');assert(s.state==='unknown'&&s.facts.runSummary.draft&&s.facts.rows[0].sessions[0].group==='Access'&&s.facts.rows[0].notes==='SyntheticOpaqueContextSecret'&&s.facts.rows[0].layout.panels[0].referenceId==='session-a'&&s.facts.rows[0].layout.panels[0].sessionMode==='sftp','Workspace draft semantics wrong');menu(sites,'current workspace draft');sites.draft.notes='X'.repeat(60000)+'NEVER_ATTACH_OVERSIZED_NOTE';s=capture(sites,'draft');assert(s.facts.rows[0].notes===undefined&&/whole-field/.test(s.omissions.join(' ')),'Oversized site note partly attached');
      const incidents=new IncidentTab(host);host.tabs.push(incidents);await incidents.ready;
      const evidence={id:'ev-a',label:'Selected note',kind:'note',observedAt:time,addedAt:later,bytes:50,sha256:'a'.repeat(64),integrity:'verified',textPreview:'Complete retained note SyntheticOpaqueContextSecret',textPreviewTruncated:false};
      const report={id:'incident-a',title:'Voice incident',description:'Selected retained evidence',updatedAt:later,evidence:[evidence,{id:'other-evidence',label:'Other',kind:'note',textPreview:'NEVER_ATTACH_OTHER_INCIDENT_EVIDENCE',bytes:1}],timeline:[{id:'ev-a:1',evidenceId:'ev-a',observedAt:null,timeText:'08:00:00',timestampStatus:'unknown',message:'NEVER_ATTACH_TRUNCATED_TIMELINE_PREFIX',messageTruncated:true,line:1}],timelineLimited:false,totalBytes:51};
      incidents.acceptIncident(report);incidents.showEvidence('ev-a');s=capture(incidents,'evidence');assert(s.facts.rows[0].textPreview===evidence.textPreview&&s.facts.rows[0].integrity==='verified','Incident complete text/integrity missing');menu(incidents,'selected incident evidence');evidence.textPreviewTruncated=true;evidence.textPreview='NEVER_ATTACH_TRUNCATED_INCIDENT_PREFIX';s=capture(incidents,'evidence');assert(s.facts.rows[0].textPreview===null,'Incident prefix retained');incidents.table.selected.add('ev-a:1');s=capture(incidents,'timeline');assert(s.facts.rows[0].event.message===null&&s.facts.rows[0].event.timestampStatus==='unknown'&&s.facts.rows[0].event.line===1,'Timeline clipped prefix or timestamp invented');
      const runbook=new RunbookTab(host);host.tabs.push(runbook);await runbook.ready;runbook.jobId='synthetic-run';const runReport={schemaVersion:1,kind:'runbook',name:'Retained diagnostic procedure',startedAt:time,finishedAt:later,complete:true,stopped:false,warnings:['Observations do not diagnose root cause'],steps:[{id:'dns',title:'Retained DNS lookup',kind:'dns',status:'pass',summary:'Address observed',startedAt:time,finishedAt:later,durationMs:4,evidence:{target:'example.test',recordType:'A',records:[{type:'A',name:'example.test',value:'192.0.2.10'}]}},{id:'manual',title:'Manual review',kind:'checklist',status:'unknown',summary:'NEVER_ATTACH_UNSELECTED_STEP',evidence:{instructions:'NEVER_ATTACH_OTHER_STEP_CONTENT'}}]};runbook.onJobEvent('report',runReport);runbook.onJobEvent('done');runbook.table.selected.add('dns');runbook.editor.value='NEVER_ATTACH_EDITABLE_RUNBOOK';runbook.definition={name:'NEVER_ATTACH_EDITABLE_DEFINITION'};s=capture(runbook,'steps');assert(s.facts.rows[0].evidence.records[0].value==='192.0.2.10'&&s.scope.startedAt===time,'Retained runbook facts or source time lost');menu(runbook,'retained runbook steps');
      const change=new ChangeValidationTab(host);host.tabs.push(change);await change.ready;const record={id:'validation-a',revision:2,phase:'review',planVersion:1,createdAt:time,updatedAt:later,plan:{name:'Voice upgrade',scope:'Voice VLAN',expectedOutcome:'No new RTP gaps',rollbackPlan:'Manual restore',checks:[{id:'voice',label:'Review voice evidence'}]},sources:{beforeId:'before',afterId:'after',devicePairs:[]},decisions:[{checkId:'voice',status:'unknown',rationale:'Awaiting client evidence',sourceRefs:['copy-a'],reviewedAt:later}],evidence:[{id:'copy-a',label:'Reviewed runbook copy',phase:'after',planVersion:1,provenance:'User-reviewed copy',report:{kind:'runbook',steps:[{id:'dns',status:'pass',evidence:{target:'example.test'}}]}}],comparison:{id:'comparison-a',status:'complete',report:{...diff,changes:[diff.changes[0]]}},timeline:[]};change.accept(record);change.plan.scope='NEVER_ATTACH_UNSAVED_PLAN_IN_SAVED';change.changed();s=capture(change,'saved-plan');assert(s.facts.rows[0].plan.scope==='Voice VLAN'&&s.facts.rows[0].decisions[0].status==='unknown'&&s.facts.runSummary.manualAssessment,'Saved/manual assessment semantics wrong');menu(change,'saved plan and manual decisions');s=capture(change,'evidence:0');assert(s.facts.rows[0].originVerified===false&&s.facts.rows[0].reviewedCopy.steps[0].evidence.target==='example.test','Reviewed copy misattributed');s=capture(change,'comparison');assert(s.facts.rows[0].before.status==='down'&&s.facts.rows[0].after.status==='up','Change comparison facts lost');change.plan.scope='Draft voice scope';s=capture(change,'draft-plan');assert(s.state==='unknown'&&s.facts.runSummary.draft&&s.facts.rows[0].plan.scope==='Draft voice scope','Draft plan mislabeled');
      const old=snapshots[0];facts.interfaces[0].name='Changed later';assert(old.facts.rows[0].observation.name==='Gi0/1','Historical frozen attachment changed');
      // Invoke the real controller entry point against a real view navigator:
      // only a current singleton attachment can restore its exact selection.
      const sourceCalls=calls.length,activated=[];
      const controller={app:{byId:new Map([[topology.id,topology]]),activate(tab){activated.push(tab)}},changedSources:new Set(),message:'',changes:0,changed(){this.changes++}};
      const focus=attachment=>CopilotController.prototype.focusSource.call(controller,attachment);
      topology.select('link','link-a');const sourceSnapshot=capture(topology,'selection'),attachment={id:'source-link',snapshot:sourceSnapshot};
      topology.select('node','a');focus(attachment);
      assert(activated.at(-1)===topology&&topology.selection.type==='link'&&topology.selection.id==='link-a','Current singleton source did not restore the exact real view selection');
      assert(/selected evidence/.test(controller.message),'Resolved source did not report exact navigation');
      topology.select('node','a');focus({id:'multiple-sources',snapshot:{...sourceSnapshot,facts:{...sourceSnapshot.facts,rows:[...sourceSnapshot.facts.rows,...sourceSnapshot.facts.rows]}}});
      assert(topology.selection.type==='node'&&topology.selection.id==='a','Multiple rows implicitly changed selection');
      topology.copilot.touch();focus(attachment);
      assert(topology.selection.type==='node'&&topology.selection.id==='a'&&controller.changedSources.has(attachment.id)&&/observations have changed/.test(controller.message),'Stale attachment changed source selection or failed to report staleness');
      const activations=activated.length;focus({id:'closed-source',snapshot:{...sourceSnapshot,source:{...sourceSnapshot.source,tabId:'missing-source'}}});
      assert(activated.length===activations&&/no longer open/.test(controller.message),'Missing source caused navigation or lost retained evidence notice');
      assert(calls.length===sourceCalls&&controller.changes===4,'Source navigation performed a backend action or failed to update the panel');
      const before=calls.length;for(const tab of host.tabs){expectThrow(()=>tab.captureCopilotContext());assert(tab.copilotContextChoices().length>0,'Missing choice registry '+tab.toolKind)}assert(calls.length===before,'Choice inspection caused IPC');
      assert(attachments.length===8,'Not all eight actual local menus attached evidence');assert(revisions.length>host.tabs.length,'Producer changes did not mark source revision');
      return snapshots;
    })()`);
    fs.writeFileSync(path.join(root, 'snapshots.json'), JSON.stringify(snapshots)); console.log('COPILOT_INVESTIGATION_PASS'); win.destroy(); app.exit(0);
  } catch (error) { fail(error); }
}
if (process.argv.includes('--investigation-context-fixture')) fixture();
else if (require.main === module) runCopilotInvestigationTests(async (name, fn) => { await fn(); console.log('PASS', name); }).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { runCopilotInvestigationTests };
