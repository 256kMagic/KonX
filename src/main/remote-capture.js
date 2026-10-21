'use strict';
// One bounded exec channel on an existing SSH client. The local file owner
// commits/counts whole PCAP records; transport cancellation never destroys it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_RECORD = 1024 * 1024;
const STDERR_BYTES = 8192;
const pendingCleanup = new Set();
async function finishFileCleanup(owned) {
  // Capture identity while the owned handle is still open. A later retry must
  // never delete a new file that happens to occupy the original pathname.
  if (!owned.identity) {
    const stat = await owned.handle.stat({ bigint: true });
    if (!stat.isFile() || stat.ino === 0n) throw Error('Could not establish remote capture file identity.');
    owned.identity = { dev: stat.dev, ino: stat.ino };
  }
  if (!owned.closed) { await owned.handle.close(); owned.closed = true; }
  if (!owned.remove) return;
  let current;
  try { current = await fs.promises.lstat(owned.file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.identity.dev || current.ino !== owned.identity.ino) {
    throw Error('Remote capture cleanup path no longer identifies the owned file.');
  }
  await owned.unlink(owned.file);
}
async function closePending() {
  const errors = [];
  for (const owned of [...pendingCleanup]) {
    try {
      await finishFileCleanup(owned);
      pendingCleanup.delete(owned);
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw Error('Remote capture writable-file cleanup is incomplete: ' + errors.join('; '));
}
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function validate(params) {
  if (!params || typeof params.connectionId !== 'string' || !params.connectionId || params.connectionId.length > 128) throw Error('Choose a connected Linux SSH terminal.');
  const iface = params.interface ?? 'any';
  if (typeof iface !== 'string' || !/^[A-Za-z0-9_.:@-]{1,64}$/.test(iface)) throw Error('Invalid capture interface.');
  const duration = params.duration ?? 30, packets = params.packetLimit ?? 1000;
  if (!Number.isInteger(duration) || duration < 1 || duration > 300) throw Error('Capture duration must be 1–300 seconds.');
  if (!Number.isInteger(packets) || packets < 1 || packets > 100000) throw Error('Packet limit must be 1–100000.');
  const filter = params.filter ?? '';
  if (typeof filter !== 'string' || Buffer.byteLength(filter) > 2048 || /[\x00-\x1f\x7f]/.test(filter)) throw Error('Invalid capture filter.');
  return { connectionId: params.connectionId, interface: iface, duration, packetLimit: packets, filter };
}
function commandFor(params) {
  const p = validate(params);
  const args = ['timeout', '--signal=INT', '--kill-after=5s', p.duration + 's', 'tcpdump', '-U', '-n', '-s', '0', '-i', p.interface, '-c', String(p.packetLimit), '-w', '-', '--'];
  if (p.filter) args.push(p.filter);
  return 'exec ' + args.map(quote).join(' ');
}

// The parser retains at most one bounded record, even for arbitrarily chunked
// input. commit() must finish before its bytes/count become observed facts.
class CompletePcap {
  constructor(maxBytes = MAX_BYTES, maxPackets = 100000) {
    if (!Number.isInteger(maxBytes) || maxBytes < 24 || maxBytes > MAX_BYTES || !Number.isInteger(maxPackets) || maxPackets < 1 || maxPackets > 100000) throw Error('Invalid remote capture limits.');
    this.maxBytes = maxBytes; this.maxPackets = maxPackets;
    this.buffer = Buffer.alloc(24); this.offset = 0; this.stage = 'header';
    this.bytes = 0; this.packets = 0; this.header = false; this.truncated = false; this.limited = false;
  }
  u32(offset) { return this.le ? this.buffer.readUInt32LE(offset) : this.buffer.readUInt32BE(offset); }
  async feed(chunk, commit, shouldStop = () => false) {
    let cursor = 0;
    while (cursor < chunk.length && !shouldStop()) {
      const count = Math.min(chunk.length - cursor, this.buffer.length - this.offset);
      chunk.copy(this.buffer, this.offset, cursor, cursor + count); cursor += count; this.offset += count;
      if (this.offset < this.buffer.length) continue;
      if (this.stage === 'header') {
        const magic = this.buffer.subarray(0, 4).toString('hex');
        if (!['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(magic)) throw Error('Remote output is not classic PCAP. Check tcpdump and permissions.');
        this.le = magic === 'd4c3b2a1' || magic === '4d3cb2a1'; this.nano = magic === '4d3cb2a1' || magic === 'a1b23c4d';
        const u16 = offset => this.le ? this.buffer.readUInt16LE(offset) : this.buffer.readUInt16BE(offset);
        if (u16(4) !== 2 || u16(6) !== 4) throw Error('Unsupported remote PCAP version.');
        this.snaplen = this.u32(16);
        if (!this.snaplen || this.snaplen > MAX_RECORD) throw Error('Unsupported remote PCAP snapshot length.');
        await commit(this.buffer, false); this.bytes = 24; this.header = true;
        this.buffer = Buffer.alloc(16); this.offset = 0; this.stage = 'record-header';
        continue;
      }
      if (this.stage === 'record-header') {
        const captured = this.u32(8), original = this.u32(12);
        if (captured > this.snaplen || captured > original) throw Error('Invalid remote PCAP record lengths.');
        if (this.u32(4) >= (this.nano ? 1000000000 : 1000000)) throw Error('Invalid remote PCAP timestamp fraction.');
        const length = 16 + captured;
        if (this.bytes + length > this.maxBytes || this.packets >= this.maxPackets) {
          this.limited = true; throw Error(this.packets >= this.maxPackets ? 'Remote capture reached its packet limit.' : 'Remote capture reached its file size limit.');
        }
        const record = Buffer.alloc(length); this.buffer.copy(record); this.buffer = record; this.stage = 'record-data';
        if (captured) continue;
      }
      await commit(this.buffer, true); this.bytes += this.buffer.length; this.packets++;
      this.buffer = Buffer.alloc(16); this.offset = 0; this.stage = 'record-header';
    }
  }
  finish() { this.truncated ||= this.offset > 0 && !this.limited; this.buffer = Buffer.alloc(0); this.offset = 0; }
}

class PcapFile {
  constructor(handle) { this.handle = handle; this.bytes = 0; this.packets = 0; this.header = false; this.safe = true; }
  async commit(bytes, packet) {
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const result = await this.handle.write(bytes, offset, bytes.length - offset, this.bytes + offset);
        if (!Number.isInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > bytes.length - offset) throw Error('Remote capture file write made no valid progress.');
        offset += result.bytesWritten;
      }
    } catch (error) {
      // Roll back the current record only after the outstanding write settles.
      // If rollback fails, the file must never be offered as a readable capture.
      try { await this.handle.truncate(this.bytes); } catch (repair) { this.safe = false; throw Error(`${error.message}; could not remove the incomplete file record: ${repair.message}`); }
      throw error;
    }
    this.bytes += bytes.length; if (packet) this.packets++; else this.header = true;
  }
  async verify() {
    try {
      const stat = await this.handle.stat();
      if (stat.size !== this.bytes) throw Error('Remote capture file size does not match committed records.');
    } catch (error) { this.safe = false; throw error; }
  }
}
const ignoreError = () => {};
function closeChannel(channel, interrupt = false) {
  if (!channel) return;
  // SSH2 can emit a late error after a close request. Only this channel is ours.
  channel.on('error', ignoreError);
  if (interrupt) { try { channel.signal('INT'); } catch {} }
  try { channel.destroy(); } catch {}
}

async function run(params, emit, signal, connections, profileDir) {
  if (pendingCleanup.size) throw Error('Remote capture cleanup is pending. Quit KonX to retry cleanup before starting another capture.');
  const selected = validate(params), borrowed = connections.sshClient(selected.connectionId);
  if (!borrowed) throw Error('The selected SSH terminal is no longer connected.');
  return captureOnClient(selected, emit, signal, borrowed, profileDir);
}

// Internal production boundary, also used by local SSH2 lifecycle fixtures.
// Production run() supplies no overrides; shorter deadlines/lower byte caps are
// useful for deterministic tests without changing the public IPC contract.
async function captureOnClient(params, emit, signal, borrowed, profileDir, options = {}) {
  const selected = validate(params);
  if (signal.stopped) return;
  const openMs = options.openTimeoutMs ?? 15000, stopMs = options.stopGraceMs ?? 1000;
  const deadlineMs = options.deadlineMs ?? (selected.duration + 10) * 1000;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const parser = new CompletePcap(maxBytes, selected.packetLimit);
  let channel, file, owner, rejectOpen, openTimer, deadline, closeTimer, exitTimer;
  let ended = false, closed = false, aborted = false, problem = null, exitCode = null, exitSignal = null;
  let stopRequested = false, waiter, pendingWake = false, stderrSize = 0, stderrTruncated = false, cleanupError = null;
  const stderrChunks = [];
  const wake = () => { if (waiter) { const resolve = waiter; waiter = null; resolve(); } else pendingWake = true; };
  const wait = () => pendingWake ? (pendingWake = false, Promise.resolve()) : new Promise(resolve => { waiter = resolve; });
  const abort = error => { problem ||= error; aborted = true; rejectOpen?.(error); wake(); };
  const stop = () => {
    if (!channel) { abort(Error('Remote capture cancelled.')); return; }
    if (stopRequested) return;
    stopRequested = true;
    try { channel.signal('INT'); } catch {}
    closeTimer = setTimeout(() => { abort(Error('Remote capture channel did not finish after stop.')); closeChannel(channel); }, stopMs);
  };
  const onClientClose = () => abort(Error('SSH connection closed during capture.'));
  const onClientError = error => abort(Error(`SSH connection failed during capture: ${error.message}`));
  const onChannelError = error => abort(Error(`Remote capture channel failed: ${error.message}`));
  const onEnd = () => {
    ended = true; wake();
    if (exitCode === null && exitSignal === null && !closed && !exitTimer) exitTimer = setTimeout(() => abort(Error('Remote capture ended without a command exit status.')), options.exitTimeoutMs ?? 2000);
  };
  const onClose = () => { closed = true; if (!ended && !channel?.readableEnded) problem ||= Error('Remote capture channel closed before EOF.'); wake(); };
  const onExit = (code, signalName) => { exitCode = Number.isInteger(code) ? code : null; exitSignal = typeof signalName === 'string' ? signalName : null; clearTimeout(exitTimer); wake(); };
  const onStderr = chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const keep = Math.min(STDERR_BYTES - stderrSize, bytes.length);
    if (keep) { stderrChunks.push(Buffer.from(bytes.subarray(0, keep))); stderrSize += keep; }
    if (keep < bytes.length) stderrTruncated = true;
  };
  borrowed.client.on('close', onClientClose); borrowed.client.on('error', onClientError);
  signal.onStop = stop;
  const startedAt = new Date().toISOString();
  let lastProgress = 0;
  try {
    const directory = path.join(profileDir, 'remote-captures');
    await fs.promises.mkdir(directory, { recursive: true });
    if (signal.stopped) return;
    if (aborted) throw problem;
    file = path.join(directory, crypto.randomUUID() + '.pcap');
    owner = new PcapFile(await (options.openFile ? options.openFile(file) : fs.promises.open(file, 'wx')));
    if (signal.stopped) return;
    if (aborted) throw problem;
    emit('progress', { phase: 'Starting tcpdump on the selected SSH connection…', bytes: 0, packets: 0 });
    if (signal.stopped) return;
    if (aborted) throw problem;
    channel = await new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error, stream) => {
        if (finished) return; finished = true; clearTimeout(openTimer); rejectOpen = null;
        error ? reject(error) : resolve(stream);
      };
      rejectOpen = error => finish(error);
      openTimer = setTimeout(() => finish(Error('Timed out opening the remote capture channel.')), openMs);
      try {
        borrowed.client.exec(commandFor(selected), (error, stream) => {
          if (finished || signal.stopped || aborted) { closeChannel(stream, true); if (!finished) finish(Error('Remote capture cancelled.')); return; }
          if (error) { closeChannel(stream, true); finish(error); return; }
          if (!stream || typeof stream.read !== 'function') { closeChannel(stream, true); finish(Error('SSH did not provide a readable capture channel.')); return; }
          // Attach status handlers inside the callback, before a server can send
          // EOF/exit in the same turn. Reading remains paused until the file is ready.
          channel = stream;
          channel.on('error', onChannelError); channel.on('readable', wake); channel.on('end', onEnd); channel.on('close', onClose); channel.on('exit', onExit);
          channel.stderr?.on('data', onStderr);
          finish(null, stream);
        });
      } catch (error) { finish(error); }
    });
    deadline = setTimeout(() => { problem ||= Error('Remote capture exceeded its deadline.'); stop(); }, deadlineMs);
    if (signal.stopped) stop();
    for (;;) {
      if (aborted) break;
      const available = channel.readableLength;
      const chunk = channel.read(available ? Math.min(65536, available) : undefined);
      if (chunk) {
        await parser.feed(chunk, (bytes, packet) => owner.commit(bytes, packet), () => aborted);
        if (Date.now() - lastProgress > 250) {
          lastProgress = Date.now(); emit('progress', { phase: 'Capturing remote packets…', bytes: owner.bytes, packets: owner.packets });
        }
        continue;
      }
      ended ||= !!channel.readableEnded;
      if (closed || (ended && (exitCode !== null || exitSignal !== null))) break;
      await wait();
    }
  } catch (error) { problem ||= error; }
  finally {
    clearTimeout(openTimer); clearTimeout(deadline); clearTimeout(closeTimer); clearTimeout(exitTimer);
    if (signal.onStop === stop) signal.onStop = null;
    borrowed.client.removeListener('close', onClientClose); borrowed.client.removeListener('error', onClientError);
    if (channel) {
      channel.removeListener('readable', wake); channel.removeListener('end', onEnd); channel.removeListener('close', onClose); channel.removeListener('exit', onExit);
      channel.stderr?.removeListener('data', onStderr); channel.removeListener('error', onChannelError);
      closeChannel(channel, !ended || !!problem || !!signal.stopped);
    }
    parser.finish();
    if (owner) {
      try { await owner.verify(); await owner.handle.sync(); } catch (error) { problem ||= error; }
      const cleanup = { handle: owner.handle, file, remove: !owner.header || !owner.safe, closed: false, identity: null,
        unlink: options.unlinkFile || (name => fs.promises.unlink(name)) };
      try { await finishFileCleanup(cleanup); }
      catch (error) {
        cleanupError = Error('Remote capture file cleanup did not finish: ' + error.message);
        pendingCleanup.add(cleanup);
      }
    }
    // A failed close must not advertise a cleaned-up capture or discard the
    // writable handle. Main shutdown retries through the same retained owner.
    if (cleanupError) throw cleanupError;
  }
  const stderr = Buffer.concat(stderrChunks, stderrSize).toString('utf8');
  if (!owner?.header || !owner.safe) throw Error(stderr.trim() || problem?.message || 'No PCAP header received. tcpdump and GNU timeout must be installed and permitted for this account.');
  const remoteExitConfirmed = exitCode !== null || exitSignal !== null;
  const complete = !signal.stopped && !problem && !parser.truncated && !parser.limited && ended && [0, 124].includes(exitCode);
  const warnings = [
    ...(problem ? [problem.message] : []),
    ...(signal.stopped ? ['Capture was stopped by the user; saved packets are a partial observation.'] : []),
    ...(parser.truncated ? ['An incomplete final PCAP record was omitted.'] : []),
    ...(exitCode !== null && ![0, 124].includes(exitCode) ? [`Remote command exited with status ${exitCode}.`] : []),
    ...(exitSignal ? [`Remote command ended by signal ${exitSignal}.`] : []),
    ...(!remoteExitConfirmed ? [`Remote command exit was not confirmed. Its GNU timeout is limited to ${selected.duration} seconds plus a 5 second kill grace.`] : []),
    ...(stderrTruncated ? ['Remote diagnostic output exceeded 8192 bytes and was truncated.'] : []),
    'This capture observes the selected remote interface only. Filters, permissions and packet drops affect coverage.'
  ];
  const report = { schemaVersion: 1, kind: 'remote-capture', file, startedAt, finishedAt: new Date().toISOString(), connectionId: selected.connectionId,
    host: typeof borrowed.session?.host === 'string' ? borrowed.session.host : null, interface: selected.interface, filter: selected.filter,
    bytes: owner.bytes, packets: owner.packets, stopped: !!signal.stopped, complete, exitCode, exitSignal, remoteExitConfirmed, stderr, warnings };
  emit('report', report); return report;
}
module.exports = { validate, commandFor, CompletePcap, PcapFile, run, captureOnClient, MAX_BYTES, closePending,
  get hasPendingCleanup() { return pendingCleanup.size > 0; } };
