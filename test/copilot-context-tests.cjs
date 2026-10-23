'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const SOURCE = path.resolve(__dirname, '../src/renderer/js');
let ROOT = __dirname;
while (!fs.existsSync(path.join(ROOT, 'package.json')) || !fs.existsSync(path.join(ROOT, 'src/main/ai.js'))) {
  if (path.dirname(ROOT) === ROOT) throw new Error('Cannot locate KonX source root');
  ROOT = path.dirname(ROOT);
}
const fakeRows = count => Array.from({ length: count }, (_, i) => ({ fact: { id: `row:${i + 1}`, value: i }, selected: i === 2 }));

async function runCopilotContextTests(test) {
  const { BasicToolContext, captureCopilotContext, copilotContextSupport, COPILOT_SNAPSHOT_BYTES } = await import(pathToFileURL(path.join(SOURCE, 'copilot-context.mjs')));
  await test('typed context: immutable run inputs, timestamps, stale token rejection and historical snapshots', () => {
    let changes = 0;
    const ctx = new BasicToolContext('dns', 'tab-dns', 'DNS Lookup', { onChange: () => changes++ });
    const input = { name: 'first.example', type: 'A' }, token = ctx.begin(input); input.name = 'edited.example';
    const first = ctx.capture({ rows: fakeRows(2), observed: 2, total: 2 });
    assert.equal(first.scope.inputs.name, 'first.example'); assert.equal(first.state, 'running'); assert.ok(first.scope.startedAt); assert.equal(first.coverage.complete, false);
    assert.ok(Object.isFrozen(first.facts.rows[0])); assert.throws(() => { first.facts.rows[0].value = 9; }, TypeError);
    ctx.begin({ name: 'second.example' }); assert.equal(ctx.finish('error', 'obsolete', token), false);
    ctx.finish(); const latest = ctx.capture({ rows: fakeRows(1), observed: 1, total: 1, complete: true });
    assert.equal(latest.state, 'complete'); assert.equal(latest.coverage.complete, true); assert.ok(latest.scope.completedAt);
    assert.equal(first.scope.inputs.name, 'first.example'); assert.notEqual(first.source.runId, latest.source.runId); assert.ok(changes >= 3);
  });
  await test('typed context: selected rows, unavailable selections, idle and unsupported views are explicit', () => {
    const ctx = new BasicToolContext('sweep', 'tab-sweep', 'Sweep');
    const idle = ctx.capture({ rows: fakeRows(3), observed: 3, total: 3, complete: true });
    assert.deepEqual(idle.facts.rows, []); assert.equal(idle.coverage.observed, null); assert.match(idle.omissions.join(' '), /No run/);
    ctx.begin({ targets: '192.0.2.0/24' }); ctx.finish();
    const selected = ctx.capture({ rows: fakeRows(4), hasSelection: true });
    assert.deepEqual(selected.selection.ids, ['row:3']); assert.deepEqual(selected.facts.rows.map(r => r.value), [2]);
    const absent = ctx.capture({ rows: fakeRows(2) }, { selectedRowIds: ['row:9'] });
    assert.deepEqual(absent.facts.rows, []); assert.match(absent.omissions.join(' '), /unavailable/);
    assert.throws(() => ctx.capture({}, { selectedRowIds: Array(201).fill('row:1') }), /at most 200/);
    assert.equal(copilotContextSupport({ kind: 'terminal' }).supported, false);
    assert.throws(() => captureCopilotContext({ toolKind: 'capture', el: { textContent: 'must never scrape' } }), /not available/);
  });
  await test('typed context: whole-field and output bounds retain no secret prefix and disclose row/node omissions', () => {
    const ctx = new BasicToolContext('whois', 'tab-whois', 'Whois');
    ctx.begin({ query: 'a'.repeat(9000) }); ctx.finish();
    const opaque = 'SyntheticOpaqueCredential'.repeat(2500);
    const snapshot = ctx.capture({ rows: [{ fact: { id: 'row:1', response: opaque }, selected: false }], summary: { safe: 'complete synthetic fact' } });
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= COPILOT_SNAPSHOT_BYTES);
    assert.equal(JSON.stringify(snapshot).includes(opaque.slice(0, 80)), false);
    assert.equal(snapshot.scope.inputs.query, undefined); assert.equal(snapshot.facts.rows[0].response, undefined);
    assert.match(snapshot.omissions.join(' '), /whole-field|byte limit/); assert.equal(snapshot.coverage.complete, false);
    const capped = ctx.capture({ rows: fakeRows(250), observed: 250, total: 250, complete: true });
    assert.equal(capped.facts.rows.length, 200); assert.match(capped.omissions.join(' '), /200 rows/);
    const dense = ctx.capture({ rows: [{ fact: { id: 'row:1', data: Array.from({ length: 200 }, () => Array(200).fill(0)) } }] });
    assert.match(dense.omissions.join(' '), /node limit/); assert.ok(Buffer.byteLength(JSON.stringify(dense)) <= COPILOT_SNAPSHOT_BYTES);
  });
  await test('typed context: complete escaped credentials cross to the real main redaction boundary', () => {
    const { redactText } = require(path.join(ROOT, 'src/main/ai-redaction.js'));
    const ctx = new BasicToolContext('dns', 'tab-dns', 'DNS');
    const key = 'SyntheticOpaque"Credential\\WithEscape';
    ctx.begin({ name: 'safe.example' }); ctx.finish();
    const snap = ctx.capture({ rows: [{ fact: { id: 'row:1', value: 'a'.repeat(3900) + key + ' terminal' } }], observed: 1, total: 1, complete: true });
    const serialized = JSON.stringify(snap); assert.ok(serialized.includes(JSON.stringify(key).slice(1, -1)));
    const safe = redactText(serialized, [key]); assert.equal(safe.includes('SyntheticOpaque'), false); assert.match(safe, /Redacted/);
    assert.equal(JSON.parse(safe).facts.rows[0].value.endsWith(' terminal'), true);
  });
  await test('typed context: real Electron basic-tool producers freeze requests, select facts and reject stale completions', async () => {
    const base = fs.realpathSync(os.tmpdir()), fixtureRoot = fs.mkdtempSync(path.join(base, 'konx-copilot-context-'));
    let child, output = '';
    try {
      fs.cpSync(path.join(ROOT, 'src/renderer/js'), path.join(fixtureRoot, 'js'), { recursive: true });
      for (const name of ['tools.js', 'copilot-context.mjs']) fs.copyFileSync(path.join(SOURCE, name), path.join(fixtureRoot, 'js', name));
      fs.writeFileSync(path.join(fixtureRoot, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="toasts"></div>');
      const env = { ...process.env, KONX_CONTEXT_FIXTURE: fixtureRoot }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), [__filename, '--context-fixture'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = data => { output = (output + data).slice(-256 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Context fixture timed out\n' + output)); }, 45000);
        child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0, output); assert.match(output, /COPILOT_CONTEXT_UI_PASS/);
      const { normalizeSnapshot } = require(path.join(ROOT, 'src/main/copilot-store.js'));
      for (const snapshot of JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'snapshots.json'), 'utf8'))) normalizeSnapshot(snapshot);
    } finally {
      if (child && child.exitCode == null) { const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit; }
      assert.equal(path.dirname(fixtureRoot), base); assert.ok(path.basename(fixtureRoot).startsWith('konx-copilot-context-'));
      fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow } = require('electron');
  const root = path.resolve(process.env.KONX_CONTEXT_FIXTURE || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-copilot-context-'));
  app.setPath('userData', path.join(root, 'profile'));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 900, height: 560, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(root, 'index.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const pending = [], calls = [], changes = [], snapshots = [];
      window.api = { invoke(channel, ...args) {
        calls.push({channel,args});
        if (channel === 'tools:start' || channel === 'tools:stop') return Promise.resolve();
        return new Promise((resolve,reject) => pending.push({channel,args,resolve,reject}));
      } };
      const { createTool } = await import('./js/tools.js');
      const { captureCopilotContext, copilotContextSupport } = await import('./js/copilot-context.mjs');
      const jobs = new Map(), tabs = [];
      const host = { info:{defaultSweep:'192.0.2.0/30'}, presetPorts:()=> '22,443', registerJob:(id,tab)=>jobs.set(id,tab), unregisterJob:id=>jobs.delete(id),
        tabStateChanged(){}, setTabTitle(tab,title){tab.title=title}, copilot:{sourceChanged(tab){changes.push({id:tab.id,revision:tab.copilot.revision})}} };
      const make = kind => { const tab=createTool(host,kind,{});tabs.push(tab);document.body.append(tab.el);return tab; };
      const capture = (tab,opts) => { const before=calls.length; const value=captureCopilotContext(tab,opts);assert(calls.length===before,'Capture must not invoke any backend');snapshots.push(value);return value; };
      const take = channel => { const i=pending.findIndex(x=>x.channel===channel);assert(i>=0,'Missing pending '+channel);return pending.splice(i,1)[0]; };
      const ping=make('ping'); assert(capture(ping).state==='idle','Ping must start idle');
      ping.hosts.value='first.example, second.example';ping.count.value='2';ping.start();
      ping.hosts.value='edited.example';ping.count.value='99';
      ping.onJobEvent('resolved',{host:'first.example',ip:'192.0.2.1'});
      ping.onJobEvent('reply',{host:'first.example',ip:'192.0.2.1',seq:1,ok:true,ms:1.25});
      ping.onJobEvent('reply',{host:'second.example',seq:0,ok:false,error:'DNS: ENOTFOUND'});
      ping.render();ping.table.selected=new Set(['second.example']);
      const ps=capture(ping);assert(ps.scope.inputs.hosts==='first.example, second.example' && ps.scope.inputs.count===2,'Ping input changed after start');
      assert(ps.selection.mode==='selected' && ps.facts.rows.length===1 && ps.facts.rows[0].sent===0 && ps.facts.rows[0].lastError==='DNS: ENOTFOUND','Selected DNS-failed ping evidence');
      assert(!JSON.stringify(ps).includes('192.0.2.1'),'Unselected ping row disclosed');
      ping.onJobEvent('done',{stopped:true});assert(capture(ping).state==='stopped','Stopped ping state');
      const rev=ping.copilot.revision;ping.onJobEvent('reply',{host:'second.example',seq:1,ok:true,ms:9});assert(ping.copilot.revision===rev,'Late job event accepted');
      const sweep=make('sweep');await sweep.start();sweep.onJobEvent('result',{ip:'192.0.2.1',alive:true,ms:2,ttl:64,method:'icmp',name:'router'});
      sweep.onJobEvent('progress',{done:4,total:4,alive:1});sweep.onJobEvent('done',{stopped:false});
      const ss=capture(sweep);assert(ss.coverage.observed===4 && ss.facts.rows.length===1 && !ss.coverage.complete && /Only discovered/.test(ss.omissions.join(' ')),'Sweep omitted negatives disclosed');
      const scan=make('portscan');scan.targets.value='192.0.2.2';await scan.start();scan.showAll.checked=true;
      scan.onJobEvent('result',{host:'192.0.2.2',ip:'192.0.2.2',port:22,state:'open',service:'ssh',banner:'SSH-2.0-synthetic',ms:1});
      scan.onJobEvent('progress',{done:2,total:2,open:1,closed:1,filtered:0});scan.onJobEvent('done',{stopped:false});
      const pcs=capture(scan);assert(pcs.scope.inputs.showAll===false && /Closed and filtered/.test(pcs.omissions.join(' ')),'Port scan changed display options must not relabel old coverage');
      const trace=make('traceroute');trace.host.value='route.example';await trace.start();
      trace.onJobEvent('line','raw source deliberately excluded');trace.onJobEvent('hop',{hop:1,rtts:[null,2,null],ip:'192.0.2.1',host:'router'});trace.onJobEvent('done',{stopped:false});
      const ts=capture(trace);assert(ts.facts.rows[0].rtts[0]===null && ts.facts.runSummary.destinationReached===null && !JSON.stringify(ts).includes('raw source deliberately'),'Trace unknowns and raw exclusion');
      const dns=make('dns');dns.name.value='old.example';const d1=dns.start();const old=take('tools:dns');
      dns.name.value='new.example';dns.type.value='AAAA';const d2=dns.start();const newer=take('tools:dns');dns.name.value='unsent.example';
      const waiting=capture(dns);assert(waiting.state==='running' && !waiting.facts.rows.length && waiting.scope.inputs.name==='new.example','Pending lookup data attribution');
      newer.resolve({records:[{type:'AAAA',name:'new.example',value:'2001:db8::1',ttl:60}],server:'192.0.2.53',ms:3,errors:[]});await d2;
      old.resolve({records:[{type:'A',name:'old.example',value:'192.0.2.99'}],server:'192.0.2.54',ms:50});await d1;
      const ds=capture(dns);assert(ds.scope.inputs.name==='new.example' && ds.facts.rows[0].value==='2001:db8::1' && dns.table.rows[0].value==='2001:db8::1','Obsolete DNS result replaced new run');
      dns.name.value='partial.example';const d3=dns.start();take('tools:dns').resolve({records:[],server:'192.0.2.53',ms:9,errors:['AAAA: ETIMEOUT']});await d3;
      assert(!capture(dns).coverage.complete,'DNS failure must be partial');
      const whois=make('whois');whois.query.value='old.example';const w1=whois.start(),wr1=take('tools:whois');whois.query.value='new.example';const w2=whois.start(),wr2=take('tools:whois');
      wr2.resolve('new registry response');await w2;wr1.reject(new Error('old request failure'));await w1;
      assert(capture(whois).facts.rows[0].response==='new registry response','Stale whois error replaced current response');
      const subnet=make('subnet');subnet.input.value='192.0.2.1/24';subnet.calc();subnet.split.value='26';subnet.calc();subnet.subnets.selected=new Set([3]);
      const sub=capture(subnet);assert(sub.facts.rows.length===1 && sub.facts.rows[0].net==='192.0.2.128/26','Selected subnet rows');
      subnet.input.value='2001:db8::1/64';subnet.calc();const v6=capture(subnet);assert(v6.facts.runSummary.addressFamily==='IPv6' && !v6.facts.rows.length,'Old IPv4 split leaked into IPv6');
      subnet.input.value='invalid';subnet.calc();const invalid=capture(subnet);assert(invalid.state==='error' && !invalid.facts.rows.length && !invalid.facts.runSummary.properties.length,'Invalid calculator reused old facts');
      const wol=make('wol');wol.read=()=>({mac:'00:11:22:33:44:55',broadcast:'192.0.2.255',port:9});const wolRun=wol.send();take('tools:wol').resolve({bytes:102});await wolRun;
      const ws=capture(wol);assert(ws.facts.rows[0].bytes===102 && ws.facts.runSummary.deviceAwake===null,'WoL send must not claim awake');
      const wol1=wol.send(),wolr1=take('tools:wol');wol.read=()=>({mac:'00:11:22:33:44:66',broadcast:'192.0.2.255',port:9});const wol2=wol.send(),wolr2=take('tools:wol');
      wolr2.resolve({bytes:102});await wol2;wolr1.reject(new Error('old send error'));await wol1;
      const ws2=capture(wol);assert(ws2.state==='complete' && ws2.scope.inputs.mac==='00:11:22:33:44:66' && ws2.facts.error===null,'Old WoL failure overwrote latest send');
      const info=make('netinfo');const ifr=take('tools:interfaces'),arpr=take('tools:arp');
      ifr.resolve([{name:'Ethernet',family:'IPv4',address:'192.0.2.8',netmask:'255.255.255.0',network:'192.0.2.0/24',cidr:'192.0.2.8/24',mac:'00:11:22:33:44:55',internal:false},{name:'Loopback',family:'IPv6',address:'::1',internal:true}]);arpr.reject(new Error('synthetic ARP unavailable'));
      await new Promise(r=>setTimeout(r,10));const ni=capture(info);assert(ni.facts.rows.length===1 && ni.facts.runSummary.arp===null && !ni.coverage.complete,'Partial local source failure');assert(!JSON.stringify(ni).includes('::1'),'Hidden interface attached');
      const i2=info.load(),ifr2=take('tools:interfaces'),arp2=take('tools:arp');const i3=info.load(),ifr3=take('tools:interfaces'),arp3=take('tools:arp');
      ifr3.resolve([]);arp3.resolve([{ip:'192.0.2.10',mac:'00:11:22:33:44:66'}]);await i3;ifr2.resolve([{name:'old',family:'IPv4',address:'192.0.2.200'}]);arp2.resolve([]);await i2;
      assert(capture(info).facts.rows[0].ip==='192.0.2.10','Old local refresh overwrote latest');
      dns.name.value='disposed.example';const gone=dns.start(),pendingGone=take('tools:dns');dns.dispose();pendingGone.resolve({records:[{type:'A',value:'192.0.2.77'}],server:'192.0.2.53',ms:1});await gone;
      assert(dns.contextResult===null,'Disposed lookup accepted late data');
      assert(changes.length>20 && new Set(snapshots.map(s=>s.kind)).size===9,'Producer coverage or revision notifications missing');
      assert(!copilotContextSupport({kind:'terminal'}).supported,'Unsupported terminal must not attach');
      assert(calls.every(c=>!c.channel.includes('ai') && !c.channel.includes('copilot')),'Context captured or transmitted without explicit handoff');
      for(const tab of tabs)tab.dispose();assert(jobs.size===0,'Job subscription leaked');
      return snapshots;
    })()`);
    fs.writeFileSync(path.join(root, 'snapshots.json'), JSON.stringify(result));
    console.log('COPILOT_CONTEXT_UI_PASS'); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack || error); win.destroy(); app.exit(1); }
}

if (process.argv.includes('--context-fixture')) fixture().catch(error => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) runCopilotContextTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { runCopilotContextTests };
