'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { MAX_BYTES } = require('./remote-capture');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RESULTS = 128;
const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino && a.ino !== 0n; }
function snapshotSame(a, b) { return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
class RemoteCaptureResults {
  constructor(profileDir, options = {}) {
    if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)) throw Error('Remote results require an absolute profile directory');
    this.directory = path.resolve(profileDir, 'remote-captures'); this.io = options.fs || fs;
    this.entries = new Map(); this.paths = new Map(); this.pendingClose = new Set(); this.queue = Promise.resolve();
  }
  get hasOpenHandles() { return this.entries.size > 0 || this.pendingClose.size > 0; }
  get hasPendingCleanup() { return this.pendingClose.size > 0; }
  assertCapacity(pending = 0) {
    if (!Number.isInteger(pending) || pending < 0 || pending > MAX_RESULTS) throw Error('Invalid pending capture count');
    const owned = new Set([...this.entries.values()].map(entry => entry.handle));
    for (const handle of this.pendingClose) owned.add(handle);
    if (owned.size + pending >= MAX_RESULTS) throw Error('Remote capture session has reached its 128-result limit. Remove a saved result before capturing again.');
  }
  serialize(operation) { const pending = this.queue.then(operation); this.queue = pending.catch(() => {}); return pending; }
  registered(id) { if (typeof id !== 'string' || !UUID.test(id) || !this.entries.has(id)) throw Error('Unknown remote capture result'); return this.entries.get(id); }
  async directoryStat() {
    const stat = await this.io.lstat(this.directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) throw Error('Remote capture directory must have a verifiable local directory identity');
    return stat;
  }
  async pathStat(entry) {
    const dir = await this.directoryStat();
    if (!sameIdentity(dir, entry.directory)) throw Error('Remote capture directory changed since registration');
    const stat = await this.io.lstat(entry.file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, entry.identity)) throw Error('Remote capture file changed identity since registration');
    return stat;
  }
  async snapshot(handle) {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.ino === 0n || before.size < 24n || before.size > BigInt(MAX_BYTES)) throw Error('Remote capture must be a regular PCAP file of 24 bytes to 64 MiB');
    const size = Number(before.size), bytes = Buffer.alloc(size + 1); let offset = 0;
    while (offset < bytes.length) { const part = await handle.read(bytes, offset, bytes.length - offset, offset); if (!part.bytesRead) break; offset += part.bytesRead; }
    const after = await handle.stat({ bigint: true });
    if (offset !== size || !snapshotSame(before, after)) throw Error('Remote capture changed while reading');
    const content = bytes.subarray(0, size), hash = crypto.createHash('sha256').update(content).digest('hex');
    return { bytes: content, identity: after, hash };
  }
  async closeHandle(handle) {
    try { await handle.close(); this.pendingClose.delete(handle); }
    catch (error) { this.pendingClose.add(handle); throw error; }
  }
  remember(report) {
    return this.serialize(async () => {
      this.assertCapacity();
      if (!report || report.schemaVersion !== 1 || report.kind !== 'remote-capture' || typeof report.file !== 'string' || !path.isAbsolute(report.file)) throw Error('Invalid remote capture report');
      const basename = path.basename(report.file), file = path.resolve(report.file);
      if (!basename.endsWith('.pcap') || !UUID.test(basename.slice(0, -5)) || normalize(path.dirname(file)) !== normalize(this.directory)) throw Error('Remote capture result is outside its owned directory');
      if (!Number.isInteger(report.bytes) || report.bytes < 24 || report.bytes > MAX_BYTES || !Number.isInteger(report.packets) || report.packets < 0 || report.packets > 100000) throw Error('Invalid remote capture counts');
      const pathKey = normalize(file); if (this.paths.has(pathKey)) throw Error('Remote capture is already registered');
      const directory = await this.directoryStat(), identity = await this.io.lstat(file, { bigint: true });
      if (!identity.isFile() || identity.isSymbolicLink() || identity.ino === 0n) throw Error('Remote capture must be a verifiable regular file, not a symbolic link');
      const handle = await this.io.open(file, 'r');
      try {
        const observed = await this.snapshot(handle);
        if (!sameIdentity(identity, observed.identity) || observed.bytes.length !== report.bytes || !sameIdentity(directory, await this.directoryStat())) throw Error('Remote capture changed before registration');
        const captureId = crypto.randomUUID();
        const allowed = ['schemaVersion', 'kind', 'startedAt', 'finishedAt', 'connectionId', 'host', 'interface', 'filter', 'bytes', 'packets', 'stopped', 'complete', 'exitCode', 'exitSignal', 'remoteExitConfirmed', 'stderr', 'warnings'];
        const publicReport = { captureId, fileName: basename };
        for (const field of allowed) if (Object.hasOwn(report, field)) publicReport[field] = structuredClone(report[field]);
        const entry = { captureId, file, handle, directory, identity: observed.identity, hash: observed.hash, bytes: observed.bytes.length, publicReport, removed: false };
        this.entries.set(captureId, entry); this.paths.set(pathKey, captureId); return structuredClone(publicReport);
      } catch (error) { try { await this.closeHandle(handle); } catch (cleanup) { throw Error(`${error.message}; capture handle cleanup failed: ${cleanup.message}`); } throw error; }
    });
  }
  read(id) {
    return this.serialize(async () => {
      const entry = this.registered(id); if (entry.removed) throw Error('Remote capture was removed and is waiting for handle cleanup');
      await this.pathStat(entry);
      const snapshot = await this.snapshot(entry.handle);
      if (!sameIdentity(snapshot.identity, entry.identity) || snapshot.bytes.length !== entry.bytes || snapshot.hash !== entry.hash) throw Error('Remote capture bytes changed since registration; the original result cannot be opened');
      await this.pathStat(entry);
      return { name: entry.publicReport.fileName, bytes: snapshot.bytes };
    });
  }
  remove(id) {
    return this.serialize(async () => {
      const entry = this.registered(id);
      if (!entry.removed) { await this.pathStat(entry); await this.io.unlink(entry.file); entry.removed = true; }
      await this.closeHandle(entry.handle);
      this.entries.delete(id); this.paths.delete(normalize(entry.file)); return { removed: true, captureId: id };
    });
  }
  // Session shutdown releases handles only. Captures remain on disk unless the
  // user explicitly removes a result. Failed cleanup remains owned for retry.
  close() {
    return this.serialize(async () => {
      const errors = [];
      for (const [id, entry] of this.entries) {
        try { await this.closeHandle(entry.handle); this.entries.delete(id); this.paths.delete(normalize(entry.file)); }
        catch (error) { errors.push(error.message); }
      }
      const stillRegistered = new Set([...this.entries.values()].map(entry => entry.handle));
      for (const handle of [...this.pendingClose]) { if (stillRegistered.has(handle)) continue; try { await this.closeHandle(handle); } catch (error) { errors.push(error.message); } }
      if (errors.length) throw Error('Remote capture handle cleanup is incomplete: ' + errors.join('; '));
    });
  }
}
module.exports = { RemoteCaptureResults, MAX_RESULTS };
