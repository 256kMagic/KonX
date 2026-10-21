'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function harness(show) {
  const filename = path.join(__dirname, '../src/renderer/js/capture.js');
  const source = fs.readFileSync(filename, 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class CaptureTab', 'class CaptureTab');
  const module = { exports: {} }, events = [], pending = [], snapshots = [], exports = [];
  let options, dialogs = 0;
  vm.runInNewContext(source + '\nmodule.exports=CaptureTab;', {
    module, AbortController, setTimeout: fn => pending.push(fn),
    analyzeSipCalls: packets => { snapshots.push(packets); return { calls: [{id:'call-1'}] }; },
    showRtpMedia: (packets, opts) => { options = opts; dialogs++; return show(packets, opts); },
    toast: (...args) => events.push(['toast', ...args]), errMsg: e => e.message,
    api: { invoke: async (...args) => { exports.push(args); return 'media.wav'; } },
  }, { filename });
  const tab = Object.create(module.exports.prototype);
  const packets = [{no:11},{no:33}];
  Object.assign(tab, { packets, view:[0], rtpButton:{disabled:false},
    setAutoScroll: v => events.push(['scroll',v]), setFilter: v => {events.push(['filter',v]);tab.view=[0,1];},
    select: v => events.push(['select',v]), list:{ensureVisible:v=>events.push(['visible',v])},
    openSipCalls: async key => events.push(['sip',key]),
  });
  return {tab,packets,events,snapshots,exports,get options(){return options;},get dialogs(){return dialogs;},async paint(){assert(pending.length);pending.shift()();await Promise.resolve();}};
}
async function runRtpNavigationTests(test) {
  await test('RTP navigation selects original source frames and clears only an excluding filter', async()=>{
    const h=harness(()=>({action:'packet',frame:33})), p=h.tab.openRtpMedia();await h.paint();await p;
    assert.deepEqual(h.events,[['scroll',false],['filter',''],['select',1],['visible',1]]);
    assert.equal(h.tab.rtpOpen,false);assert.equal(h.tab.rtpButton.disabled,false);assert(h.options.signal.aborted);
  });
  await test('RTP media shares one frozen opening packet list and one dialog while live packets arrive',async()=>{
    let finish;const h=harness(()=>new Promise(r=>finish=r)),p=h.tab.openRtpMedia();await h.paint();
    h.packets.push({no:99});await h.tab.openRtpMedia();assert.equal(h.dialogs,1);assert.equal(h.snapshots[0].length,2);
    finish(null);await p;
  });
  await test('RTP replacement before analysis cancels work and late navigation cannot select new packets',async()=>{
    const h=harness(()=>({action:'packet',frame:33})),p=h.tab.openRtpMedia();h.tab.packets=[];await h.paint();await p;assert.equal(h.dialogs,0);
    let finish;const late=harness(()=>new Promise(r=>finish=r)),q=late.tab.openRtpMedia();await late.paint();late.tab.packets=[];finish({action:'packet',frame:33});await q;assert.deepEqual(late.events,[]);
  });
  await test('RTP export rejects stale captures and passes exact WAV bytes only on explicit action',async()=>{
    let finish;const h=harness(()=>new Promise(r=>finish=r)),p=h.tab.openRtpMedia();await h.paint();
    const bytes=new Uint8Array([82,73,70,70]);await h.options.onExportWav('test.wav',bytes);
    assert.equal(h.exports[0][0],'cap:saveBody');assert.equal(h.exports[0][2],bytes);
    h.tab.packets=[];assert.throws(()=>h.options.onExportWav('test.wav',bytes),/replaced/);finish(null);await p;
  });
  await test('RTP return to the SIP call occurs after audio and dialog ownership are released',async()=>{
    const h=harness(()=>({action:'call',callKey:'call-1'})),p=h.tab.openRtpMedia();await h.paint();await p;
    assert.deepEqual(h.events,[['sip','call-1']]);assert.equal(h.tab.rtpOpen,false);assert(h.options.signal.aborted);
  });
  await test('RTP failure and disposal release controls and prevent navigation',async()=>{
    const h=harness(()=>{throw new Error('bad media');}),p=h.tab.openRtpMedia();await h.paint();await p;
    assert.equal(h.events[0][1],'bad media');assert.equal(h.tab.rtpOpen,false);assert.equal(h.tab.rtpButton.disabled,false);
    const closed=harness(()=>({action:'packet',frame:33})),q=closed.tab.openRtpMedia();closed.tab.disposed=true;await closed.paint();await q;assert.equal(closed.dialogs,0);
  });
}
module.exports={runRtpNavigationTests};
