import { frame, str } from './packets.mjs';
import { writePcapng } from '../../src/renderer/js/capture/pcapfile.mjs';

const client = '192.0.2.10', proxy = '192.0.2.20', phone = '192.0.2.30';
const macA = '02:00:00:00:00:10', macB = '02:00:00:00:00:20';
export function demoSdp(address, port = 4000) {
  return `v=0\r\no=konx 1 1 IN IP4 ${address}\r\ns=KonX sample call\r\nc=IN IP4 ${address}\r\nt=0 0\r\nm=audio ${port} RTP/AVP 0 8 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:101 telephone-event/8000\r\na=fmtp:101 0-16\r\na=sendrecv\r\n`;
}
export function sipMessage(startLine, { callId = 'demo-call@konx.test', cseq = 1, method = 'INVITE', branch = 'z9hG4bK-demo', toTag = '', from = '<sip:alice@konx.test>;tag=alice', to = '<sip:bob@konx.test>', body = '' } = {}) {
  return `${startLine}\r\nVia: SIP/2.0/UDP 192.0.2.10:5060;branch=${branch}\r\nFrom: ${from}\r\nTo: ${to}${toTag ? ';tag=' + toTag : ''}\r\nCall-ID: ${callId}\r\nCSeq: ${cseq} ${method}\r\nMax-Forwards: 70\r\n${body ? 'Content-Type: application/sdp\r\n' : ''}Content-Length: ${new TextEncoder().encode(body).length}\r\n\r\n${body}`;
}

/** Synthetic documentation-address traffic, with no calls or network I/O. */
export function sipDemoPackets() {
  const packets = [];
  const base = 1700000000;
  const add = (time, src, dst, text, tcp = null) => {
    const data = tcp ? frame.tcp(macA, macB, src, dst, tcp, typeof text === 'string' ? str(text) : text) : frame.udp(macA, macB, src, dst, { sport: 5060, dport: 5060 }, str(text));
    packets.push({ ts: base + time, len: data.length, caplen: data.length, linktype: 1, data });
  };
  const invite = sipMessage('INVITE sip:bob@konx.test SIP/2.0', { body: demoSdp(client) });
  add(0, client, proxy, invite);
  add(0.01, proxy, phone, sipMessage('INVITE sip:bob@konx.test SIP/2.0', { branch: 'z9hG4bK-proxy', body: demoSdp(client) }));
  add(0.02, proxy, client, sipMessage('SIP/2.0 100 Trying'));
  add(0.1, phone, proxy, sipMessage('SIP/2.0 180 Ringing', { branch: 'z9hG4bK-proxy', toTag: 'bob' }));
  add(0.11, proxy, client, sipMessage('SIP/2.0 180 Ringing', { toTag: 'bob' }));
  add(0.2, client, proxy, invite); // Observed UDP retransmission.
  add(0.4, phone, proxy, sipMessage('SIP/2.0 200 OK', { branch: 'z9hG4bK-proxy', toTag: 'bob', body: demoSdp(phone, 6000) }));
  add(0.41, proxy, client, sipMessage('SIP/2.0 200 OK', { toTag: 'bob', body: demoSdp(phone, 6000) }));
  add(0.42, client, proxy, sipMessage('ACK sip:bob@konx.test SIP/2.0', { method: 'ACK', branch: 'z9hG4bK-ack', toTag: 'bob' }));
  add(0.43, proxy, phone, sipMessage('ACK sip:bob@konx.test SIP/2.0', { method: 'ACK', branch: 'z9hG4bK-proxy-ack', toTag: 'bob' }));
  add(12, client, proxy, sipMessage('BYE sip:bob@konx.test SIP/2.0', { cseq: 2, method: 'BYE', branch: 'z9hG4bK-bye', toTag: 'bob' }));
  add(12.01, proxy, phone, sipMessage('BYE sip:bob@konx.test SIP/2.0', { cseq: 2, method: 'BYE', branch: 'z9hG4bK-proxy-bye', toTag: 'bob' }));
  add(12.02, phone, proxy, sipMessage('SIP/2.0 200 OK', { cseq: 2, method: 'BYE', branch: 'z9hG4bK-proxy-bye', toTag: 'bob' }));
  add(12.03, proxy, client, sipMessage('SIP/2.0 200 OK', { cseq: 2, method: 'BYE', branch: 'z9hG4bK-bye', toTag: 'bob' }));
  const busy = { callId: 'busy-call@konx.test', branch: 'z9hG4bK-busy' };
  add(13, client, proxy, sipMessage('INVITE sip:bob@konx.test SIP/2.0', busy));
  add(13.1, proxy, client, sipMessage('SIP/2.0 486 Busy Here', { ...busy, toTag: 'busy' }));
  add(13.11, client, proxy, sipMessage('ACK sip:bob@konx.test SIP/2.0', { ...busy, method: 'ACK', toTag: 'busy' }));

  const tcpOptions = { callId: 'tcp-call@konx.test', branch: 'z9hG4bK-tcp' };
  const tcpMessage = str(sipMessage('INVITE sip:bob@konx.test SIP/2.0', { ...tcpOptions, body: demoSdp(client, 8000) }).replace('SIP/2.0/UDP', 'SIP/2.0/TCP'));
  const split = 115;
  add(14, client, proxy, [], { sport: 5090, dport: 5070, seq: 100, flags: 'S' });
  add(14.01, proxy, client, [], { sport: 5070, dport: 5090, seq: 900, ack: 101, flags: 'SA' });
  add(14.02, client, proxy, [], { sport: 5090, dport: 5070, seq: 101, ack: 901, flags: 'A' });
  // The later TCP segment is captured first; reassembly must restore byte order.
  add(14.03, client, proxy, tcpMessage.slice(split), { sport: 5090, dport: 5070, seq: 101 + split, ack: 901, flags: 'PA' });
  add(14.04, client, proxy, tcpMessage.slice(0, split), { sport: 5090, dport: 5070, seq: 101, ack: 901, flags: 'PA' });
  const answer = sipMessage('SIP/2.0 200 OK', { ...tcpOptions, toTag: 'tcp-bob', body: demoSdp(proxy, 9000) }).replace('SIP/2.0/UDP', 'SIP/2.0/TCP');
  add(14.1, proxy, client, answer, { sport: 5070, dport: 5090, seq: 901, ack: 101 + tcpMessage.length, flags: 'PA' });
  return packets;
}

export const sipDemoCapture = () => writePcapng(sipDemoPackets(), { app: 'KonX synthetic SIP demonstration' });
