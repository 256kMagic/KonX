import { writePcapng } from './pcapfile.mjs';

export const MAX_SIP_EXPORT_BYTES = 64 * 1024 * 1024;

/** Export original signaling frames, including retransmissions and shared TCP frames. */
export function buildSipCallCapture(packets, call) {
  const wanted = new Set(call.frames);
  const selected = [];
  let size = 1024;
  for (const packet of packets) {
    if (!wanted.has(packet.no)) continue;
    size += 32 + Math.ceil(packet.data.byteLength / 4) * 4;
    if (size > MAX_SIP_EXPORT_BYTES) throw new RangeError('Call capture exceeds the 64 MiB export limit.');
    selected.push({ ts: packet.ts, len: packet.len, linktype: packet.lt ?? packet.linktype ?? 1, data: packet.data });
    wanted.delete(packet.no);
  }
  if (wanted.size) throw new Error('Some call packets are no longer available in this capture snapshot.');
  if (!selected.length) throw new Error('This call has no captured signaling packets to export.');
  return writePcapng(selected, { app: 'KonX SIP signaling export' });
}

// Bound JSON expansion before serialization. A UTF-16 code unit requires at most
// six bytes when JSON-escaped; compact structural punctuation is included.
function jsonBudget(value, remaining) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') remaining -= 6 * item.length + 4;
    else if (item == null || typeof item !== 'object') remaining -= 32;
    else if (Array.isArray(item)) {
      remaining -= 4 + 4 * item.length;
      for (const child of item) pending.push(child);
    } else {
      const entries = Object.entries(item);
      remaining -= 4 + 8 * entries.length;
      for (const [key, child] of entries) { remaining -= 6 * key.length; pending.push(child); }
    }
    if (remaining < 0) throw new RangeError('Call report exceeds the 64 MiB export budget. Export its signaling packets instead.');
  }
}

export function buildSipCallReport(call, { sourceName = '', warnings = [], limited = false, scannedPackets = null } = {}) {
  const report = {
    format: 'konx-sip-call', version: 1, sourceName,
    coverage: { scannedPackets, limited, warnings,
      scope: 'Observed SIP signaling only. Capture gaps and omitted messages remain unknown. RTP media is not included.',
      packetExport: 'Original frames may contain other messages when TCP carries several SIP messages in one packet.' },
    call,
  };
  jsonBudget(report, MAX_SIP_EXPORT_BYTES);
  const bytes = new TextEncoder().encode(JSON.stringify(report));
  if (bytes.byteLength > MAX_SIP_EXPORT_BYTES) throw new RangeError('Call report exceeds the 64 MiB export limit.');
  return bytes;
}
