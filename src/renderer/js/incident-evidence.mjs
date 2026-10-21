import { writePcapng } from './capture/pcapfile.mjs';

const TEXT_BYTES = 256 * 1024, CAPTURE_BYTES = 128 * 1024 * 1024;
const encoded = new TextEncoder();
function textEvidence(kind, text, label, observedAt = null) {
  if (!text?.trim()) throw new Error('There is no selected evidence to add.');
  if (encoded.encode(text).length > TEXT_BYTES) throw new Error('This result exceeds 256 KiB. Export it and import the file into the incident.');
  return { kind, text, label: String(label).slice(0, 256), observedAt };
}
/** Snapshot only the explicitly selected tab. Nothing is saved until the user
 * chooses an incident and presses Add pending evidence. */
export function incidentEvidence(tab) {
  if (!tab || tab.disposed) throw new Error('The source tab is closed.');
  if (tab.kind === 'terminal') return textEvidence('terminal', tab.term?.getSelection(), 'Selected terminal output: ' + tab.title);
  if (tab.kind === 'capture') {
    if (!tab.packets?.length) throw new Error('No captured packets are available.');
    const packets = tab.packets.map(packet => ({ ts: packet.ts, timestampKnown: packet.timestampKnown, len: packet.len, data: packet.data, linktype: packet.lt ?? packet.linktype ?? 1 }));
    // The format owner validates exact section/interface/padding expansion
    // before allocation, including timestamp-free simple packet sections.
    const bytes = writePcapng(packets, { maxBytes: CAPTURE_BYTES });
    return { kind: 'capture', bytes, sourceName: tab.fileName || 'capture-snapshot.pcapng',
      label: ('Capture snapshot: ' + (tab.fileName || tab.title)).slice(0, 256), observedAt: null };
  }
  if (tab.kind !== 'tool' || ['ai', 'incidents'].includes(tab.toolKind)) throw new Error('Choose a capture, terminal selection, or diagnostic tool result.');
  const report = tab.report;
  const text = report ? JSON.stringify(report, null, 2) : tab.el?.innerText;
  const time = report?.collectedAt || report?.finishedAt;
  const observedAt = typeof time === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(time) && Number.isFinite(Date.parse(time)) ? time : null;
  return textEvidence('tool', text, 'Tool result: ' + tab.title, observedAt);
}
