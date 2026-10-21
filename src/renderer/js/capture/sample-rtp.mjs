// Synthetic, local-only sample: two G.711 tones with an intentional capture gap,
// late packet, duplicate and RTCP receiver report. No speech or captured users.
// Intended production location: src/renderer/js/capture/sample-rtp.mjs. Change pcapfile import to ./pcapfile.mjs on integration.


import { writePcapng } from './pcapfile.mjs';
import { decodeG711 } from './rtp.mjs';
const u16 = v => [(v >>> 8) & 255, v & 255];
const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
function udpFrame(m1, m2, src, dst, {sport, dport}, payload) {
  const ip = s => s.split('.').map(Number), mac = s => s.split(':').map(v => parseInt(v, 16));
  const udp = concat(u16(sport), u16(dport), u16(payload.length + 8), [0, 0], payload);
  const header = concat([0x45, 0], u16(20 + udp.length), [0x12, 0x34, 0x40, 0, 64, 17, 0, 0], ip(src), ip(dst));
  let sum = 0; for (let i = 0; i < header.length; i += 2) sum += (header[i] << 8) | header[i + 1];
  while (sum > 65535) sum = (sum & 65535) + (sum >>> 16);
  const checksum = (~sum) & 65535; header[10] = checksum >>> 8; header[11] = checksum & 255;
  return concat(mac(m2), mac(m1), [8, 0], header, udp);
}
const P = {u16,u32,concat,frame:{udp:udpFrame}};

const A = '192.0.2.10', B = '192.0.2.20', MA = '02:00:00:00:00:10', MB = '02:00:00:00:00:20';
const enc = new TextEncoder();
const base = 1792530000;
const payloadTables = [decodeG711(Uint8Array.from({ length: 256 }, (_, i) => i), 'PCMU'), decodeG711(Uint8Array.from({ length: 256 }, (_, i) => i), 'PCMA')];
function tone(frame, direction) {
  const table = payloadTables[direction];
  return Uint8Array.from({ length: 160 }, (_, n) => {
    const sample = Math.round(Math.sin((frame * 160 + n) * 2 * Math.PI * (direction ? 660 : 440) / 8000) * 6000);
    let best = 0, delta = Infinity;
    for (let i = 0; i < 256; i++) { const d = Math.abs(table[i] - sample); if (d < delta) { best = i; delta = d; } }
    return best;
  });
}
function udp(payload, offset, reverse = false, sport = 4000, dport = 5000) {
  const data = P.frame.udp(reverse ? MB : MA, reverse ? MA : MB, reverse ? B : A, reverse ? A : B, { sport, dport }, payload);
  return { ts: base + offset, data, len: data.length, caplen: data.length, linktype: 1, lt: 1 };
}
function sip(response = false) {
  const ip = response ? B : A, port = response ? 5000 : 4000;
  const body = `v=0\r\no=konx-demo 1 1 IN IP4 ${ip}\r\ns=KonX synthetic G.711 tones\r\nc=IN IP4 ${ip}\r\nt=0 0\r\nm=audio ${port} RTP/AVP 0 8\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\n`;
  return enc.encode(`${response ? 'SIP/2.0 200 OK' : 'INVITE sip:bob@example.test SIP/2.0'}\r\nVia: SIP/2.0/UDP ${A}:5060;branch=z9hG4bK-konx-demo\r\nFrom: <sip:alice@example.test>;tag=alice\r\nTo: <sip:bob@example.test>${response ? ';tag=bob' : ''}\r\nCall-ID: konx-rtp-demo@example.test\r\nCSeq: 1 INVITE\r\nContent-Type: application/sdp\r\nContent-Length: ${enc.encode(body).length}\r\n\r\n${body}`);
}
export function rtpDemoPackets() {
  const packets = [udp(sip(), 0, false, 5060, 5060), udp(sip(true), 0.1, true, 5060, 5060)];
  for (let i = 0; i < 200; i++) for (let direction = 0; direction < 2; direction++) {
    if (!direction && i >= 80 && i <= 82) continue;
    const seq = (65500 + i) & 0xffff, timestamp = 1000 + i * 160, ssrc = direction ? 0x20202020 : 0x10101010;
    const payload = P.concat([0x80, (direction ? 8 : 0) | (i === 0 ? 128 : 0)], P.u16(seq), P.u32(timestamp), P.u32(ssrc), tone(i, direction));
    const arrival = 1 + i * 0.02 + direction * 0.008 + ((!direction && i === 40) ? 0.035 : 0) + Math.sin(i) * 0.001;
    packets.push(udp(payload, arrival, !!direction, direction ? 5000 : 4000, direction ? 4000 : 5000));
    if (!direction && i === 120) packets.push(udp(payload, arrival + 0.002));
  }
  // Synthetic RR: fraction 3/256, cumulative loss 3, jitter 16 RTP clock ticks.
  const block = P.concat(P.u32(0x10101010), [3, 0, 0, 3], P.u32(65699), P.u32(16), P.u32(0), P.u32(0));
  const rr = P.concat([0x81, 201], P.u16(7), P.u32(0x20202020), block);
  packets.push(udp(rr, 5.1, true, 5001, 4001));
  return packets.sort((a, b) => a.ts - b.ts).map((p, i) => ({ ...p, no: i + 1 }));
}
export function rtpDemoCapture() { return writePcapng(rtpDemoPackets()); }
export function makeRtpDemo() { return {name:'konx-rtp-demo.pcapng', bytes:rtpDemoCapture()}; }

