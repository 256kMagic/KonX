'use strict';
// Test-only local SSH peer. Never invokes an OS shell or captures live traffic.
const { Server } = require('ssh2');
const { sshHostKey } = require('./ssh-host-key.cjs');
function samplePcap() {
  const h = Buffer.alloc(24); h.writeUInt32LE(0xa1b2c3d4, 0); h.writeUInt16LE(2, 4); h.writeUInt16LE(4, 6); h.writeUInt32LE(65535, 16); h.writeUInt32LE(1, 20);
  const frame = Buffer.from('02000000000202000000000108004500002e123440004011a477c0000201c000020213c413c4001a00004b6f6e582073796e746865746963205353482074657374', 'hex');
  frame.writeUInt16BE(frame.length - 14, 16); frame.writeUInt16BE(0, 24);
  frame.writeUInt16BE(40000, 34); frame.writeUInt16BE(40001, 36); frame.writeUInt16BE(frame.length - 34, 38);
  let sum = 0; for (let i = 14; i < 34; i += 2) sum += frame.readUInt16BE(i);
  while (sum > 65535) sum = (sum & 65535) + (sum >>> 16); frame.writeUInt16BE((~sum) & 65535, 24);
  const r = Buffer.alloc(16); r.writeUInt32LE(1792530000, 0); r.writeUInt32LE(frame.length, 8); r.writeUInt32LE(frame.length, 12);
  return Buffer.concat([h, r, frame, r, frame]);
}
async function startRemoteSshFixture({ slow = false, bytes = samplePcap() } = {}) {
  const peers = new Set(), commands = [], signals = [], timers = new Set();
  const server = new Server({ hostKeys: [sshHostKey()] }, peer => {
    peers.add(peer); peer.on('close', () => peers.delete(peer)); peer.on('error', () => {});
    peer.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === 'fixture' ? ctx.accept() : ctx.reject());
    peer.on('ready', () => peer.on('session', accept => {
      const session = accept(); session.on('pty', acceptPty => acceptPty());
      session.on('shell', acceptShell => { const channel = acceptShell(); channel.on('error', () => {}); channel.write('KonX local SSH fixture\r\nfixture$ '); channel.on('data', chunk => channel.write(chunk)); });
      session.on('exec', (acceptExec, _reject, info) => {
        commands.push(info.command); const channel = acceptExec(); channel.on('error', () => {});
        if (!info.command.startsWith("exec 'timeout' '--signal=INT' '--kill-after=5s'")) { channel.stderr.write('Unsupported fixture command'); channel.exit(1); channel.end(); return; }
        channel.stderr.write('tcpdump fixture: synthetic local packets only\n');
        session.on('signal', (_accept, _rejectSignal, info) => { signals.push(info.name); channel.exit(130); channel.end(); });
        if (slow) {
          const firstLength = 24 + 16 + bytes.readUInt32LE(32);
          channel.write(bytes.subarray(0, Math.min(bytes.length, firstLength + 20)));
        } else {
          channel.write(bytes.subarray(0, 29));
          const timer = setTimeout(() => { timers.delete(timer); if (!channel.destroyed && channel.writable) { channel.write(bytes.subarray(29)); channel.exit(0); channel.end(); } }, 20); timers.add(timer);
        }
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { connection: { host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'fixture', name: 'KonX remote capture fixture' }, commands, signals,
    async close() { for (const timer of timers) clearTimeout(timer); timers.clear(); for (const peer of peers) peer.end(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { startRemoteSshFixture, samplePcap };
