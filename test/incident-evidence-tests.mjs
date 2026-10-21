import assert from 'node:assert/strict';
import { incidentEvidence } from '../src/renderer/js/incident-evidence.mjs';
import { readCapture } from '../src/renderer/js/capture/pcapfile.mjs';

export async function runIncidentEvidenceTests(test) {
  await test('incident capture evidence owns original bytes and preserves packet link types and timestamps',()=>{
    const data=new Uint8Array([0,1,2,3]), tab={kind:'capture',title:'Capture',fileName:'original.pcap',packets:[{no:9,ts:0,len:6,lt:101,data}]};
    const evidence=incidentEvidence(tab);data.fill(8);tab.packets=[];
    const imported=readCapture(evidence.bytes);assert.equal(imported.packets.length,1);assert.deepEqual([...imported.packets[0].data],[0,1,2,3]);
    assert.equal(imported.packets[0].linktype,101);assert.equal(imported.packets[0].ts,0);assert.equal(imported.packets[0].len,6);
  });
  await test('incident terminal evidence includes only explicit selection and leaves observation time unknown',()=>{
    const evidence=incidentEvidence({kind:'terminal',title:'Router',term:{getSelection:()=> 'selected line'}});
    assert.equal(evidence.text,'selected line');assert.equal(evidence.observedAt,null);
    assert.throws(()=>incidentEvidence({kind:'terminal',term:{getSelection:()=>''}}),/no selected evidence/);
  });
  await test('incident tool snapshot retains chosen report and does not collect other tabs or saved credentials',()=>{
    const report={collectedAt:'2026-10-21T10:00:00Z',value:'chosen'};
    const evidence=incidentEvidence({kind:'tool',toolKind:'device',title:'Devices',report});report.value='later';
    assert.equal(JSON.parse(evidence.text).value,'chosen');assert.equal(evidence.observedAt,'2026-10-21T10:00:00Z');
    assert.throws(()=>incidentEvidence({kind:'tool',toolKind:'ai',report}),/Choose/);
    assert.throws(()=>incidentEvidence({disposed:true}),/closed/);
  });
  await test('incident pending evidence rejects text and PCAPNG expansion beyond import bounds',()=>{
    assert.throws(()=>incidentEvidence({kind:'tool',toolKind:'dns',el:{innerText:'x'.repeat(256*1024+1)}}),/exceeds/);
    const packet={data:new Uint8Array(1024*1024),ts:1,lt:1};
    assert.throws(()=>incidentEvidence({kind:'capture',packets:new Array(128).fill(packet)}),/exceeds/);
  });
}
