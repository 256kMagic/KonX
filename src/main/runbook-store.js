'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateDefinition, LIMITS } = require('./runbooks');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_FILES = 200, MAX_FILE_BYTES = LIMITS.bytes + 1024;
const validId = id => typeof id === 'string' && UUID.test(id) || (() => { throw Error('Invalid runbook identifier'); })();
const date = value => typeof value === 'string' && value.length < 64 && Number.isFinite(Date.parse(value));
function boundedJson(value, limit) {
  const pretty = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(pretty) <= limit) return pretty;
  const compact = JSON.stringify(value), size = Buffer.byteLength(compact);
  if (size > limit) throw Error('Serialized runbook exceeds its file limit');
  return size < limit ? compact + '\n' : compact;
}
class RunbookStore {
  constructor(profileDir, options = {}) {
    if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)) throw Error('Runbook storage requires an absolute profile directory');
    this.directory = path.join(profileDir, 'runbooks'); this.io = options.fs || fs; this.queue = Promise.resolve();
    this.pendingCleanup = new Set(); this.operations = 0; this.closing = false;
  }
  get hasOwnership() { return this.operations > 0 || this.pendingCleanup.size > 0; }
  get hasPendingCleanup() { return this.pendingCleanup.size > 0; }
  async closeHandle(owner) {
    if (owner.remove && !owner.identity) {
      const stat = await owner.handle.stat({ bigint: true });
      if (!stat.isFile() || stat.ino === 0n) throw Error('Could not establish temporary runbook file identity');
      owner.identity = { dev: stat.dev, ino: stat.ino };
    }
    if (!owner.closed) { await owner.handle.close(); owner.closed = true; }
  }
  async finishCleanup(owner) {
    await this.closeHandle(owner);
    if (owner.remove) {
      let stat;
      try { stat = await this.io.lstat(owner.file, { bigint: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== owner.identity.dev || stat.ino !== owner.identity.ino) throw Error('Temporary runbook path no longer identifies the owned file');
        await this.io.unlink(owner.file);
      }
    }
    this.pendingCleanup.delete(owner);
  }
  async close() {
    if (this.closing) return this.closeTask;
    this.closing = true;
    this.closeTask = (async () => {
      await this.queue;
      const errors = [];
      for (const owner of [...this.pendingCleanup]) {
        try { await this.finishCleanup(owner); } catch (error) { errors.push(error.message); }
      }
      if (errors.length) throw Error('Runbook file cleanup is incomplete: ' + errors.join('; '));
    })().finally(() => { this.closing = false; });
    return this.closeTask;
  }
  file(id) { validId(id); return path.join(this.directory, id + '.json'); }
  async ready() {
    await this.io.mkdir(this.directory, { recursive: true }); const stat = await this.io.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Runbook directory must be a real local directory');
  }
  async readBytes(file, limit) {
    const stat = await this.io.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(limit)) throw Error('Runbook must be a bounded regular JSON file');
    const handle = await this.io.open(file, 'r'), owner = { handle, file, remove: false, closed: false }; let bytes;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.size !== stat.size || opened.dev !== stat.dev || opened.ino !== stat.ino) throw Error('Runbook changed while opening');
      const buffer = Buffer.alloc(Number(stat.size) + 1); let offset = 0;
      while (offset < buffer.length) { const result = await handle.read(buffer, offset, buffer.length - offset, null); if (!result.bytesRead) break; offset += result.bytesRead; }
      if (BigInt(offset) !== stat.size) throw Error('Runbook changed while reading'); bytes = buffer.subarray(0, offset);
    } finally {
      try { await this.finishCleanup(owner); }
      catch (error) { this.pendingCleanup.add(owner); throw Error('Runbook file cleanup did not finish: ' + error.message); }
    }
    return bytes;
  }
  async read(id) {
    const bytes = await this.readBytes(this.file(id), MAX_FILE_BYTES);
    let record;
    try { record = JSON.parse(bytes.toString('utf8')); } catch { throw Error('Runbook JSON is malformed'); }
    if (record?.schemaVersion !== 1 || record.id !== id || !date(record.createdAt) || !date(record.updatedAt)) throw Error('Runbook identity or schema is invalid');
    if (Object.keys(record).some(key => !['schemaVersion', 'id', 'createdAt', 'updatedAt', 'definition'].includes(key))) throw Error('Runbook contains unknown record fields');
    return { schemaVersion: 1, id, createdAt: record.createdAt, updatedAt: record.updatedAt, definition: validateDefinition(record.definition) };
  }
  list() { return this.serialize(async () => {
    await this.ready(); const runbooks = [], issues = []; let examined = 0, entries = 0;
    const directory = await this.io.opendir(this.directory);
    for await (const entry of directory) {
      if (++entries > 1000) { issues.push({ message: 'Directory entry limit reached; additional files were not examined.' }); break; }
      if (!entry.name.endsWith('.json') || !UUID.test(entry.name.slice(0, -5))) { if (issues.length < 64) issues.push({ file: entry.name.slice(0, 256), message: 'Unrecognized file was not loaded.' }); continue; }
      if (++examined > MAX_FILES) { issues.push({ message: 'Runbook listing reached its 200-file limit.' }); break; }
      const id = entry.name.slice(0, -5);
      try { const record = await this.read(id); runbooks.push({ id, name: record.definition.name, description: record.definition.description, stepCount: record.definition.steps.length, createdAt: record.createdAt, updatedAt: record.updatedAt }); }
      catch (error) { if (this.pendingCleanup.size) throw error; if (issues.length < 64) issues.push({ id, message: error.message }); }
    }
    runbooks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)); return { runbooks, issues };
  }); }
  get(id) { return this.serialize(async () => { await this.ready(); return this.read(id); }); }
  importFile(file) { return this.serialize(async () => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('Select a local runbook JSON file');
    const bytes = await this.readBytes(file, LIMITS.bytes);
    let definition;
    try { definition = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw Error('Runbook JSON is malformed'); }
    return validateDefinition(definition);
  }); }
  serialize(operation) {
    if (this.closing) return Promise.reject(Error('Runbook storage is closing'));
    if (this.pendingCleanup.size) return Promise.reject(Error('Runbook file cleanup is pending. Quit KonX to retry cleanup before using saved procedures.'));
    this.operations++;
    const pending = this.queue.then(() => {
      if (this.pendingCleanup.size) throw Error('Runbook file cleanup is pending. Quit KonX to retry cleanup before using saved procedures.');
      return operation();
    }).finally(() => { this.operations--; });
    this.queue = pending.catch(() => {}); return pending;
  }
  save(input) {
    return this.serialize(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id', 'definition'].includes(key))) throw Error('Invalid runbook save request');
      const definition = validateDefinition(input.definition); await this.ready();
      let existing;
      if (input.id !== undefined) existing = await this.read(input.id);
      else {
        let count = 0, entries = 0; const directory = await this.io.opendir(this.directory);
        for await (const entry of directory) { if (++entries > 1000) throw Error('Runbook directory has too many entries'); if (entry.name.endsWith('.json') && UUID.test(entry.name.slice(0, -5)) && ++count >= MAX_FILES) throw Error('Runbook store reached its 200-file limit'); }
      }
      const id = existing?.id || crypto.randomUUID(), timestamp = new Date().toISOString();
      const record = { schemaVersion: 1, id, createdAt: existing?.createdAt || timestamp, updatedAt: timestamp, definition };
      const data = boundedJson(record, MAX_FILE_BYTES);
      const target = this.file(id), temporary = path.join(this.directory, '.' + crypto.randomUUID() + '.tmp');
      let owner;
      try {
        const handle = await this.io.open(temporary, 'wx'); owner = { handle, file: temporary, remove: true, closed: false, identity: null };
        await handle.writeFile(data, 'utf8'); await handle.sync(); await this.closeHandle(owner);
        await this.io.rename(temporary, target); return record;
      } catch (error) {
        if (owner) {
          try { await this.finishCleanup(owner); }
          catch (cleanup) { this.pendingCleanup.add(owner); throw Error(`${error.message}; temporary runbook cleanup failed: ${cleanup.message}`); }
        }
        throw error;
      }
    });
  }
  remove(id) { return this.serialize(async () => { await this.ready(); const file = this.file(id), stat = await this.io.lstat(file); if (!stat.isFile() && !stat.isSymbolicLink()) throw Error('Runbook path is not a removable file'); await this.io.unlink(file); return { removed: true, id }; }); }
  async export(id) { const record = await this.get(id); return boundedJson(record.definition, LIMITS.bytes); }
  exportFile(id, file) { return this.serialize(async () => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('Choose a local export filename');
    await this.ready(); const record = await this.read(id), content = boundedJson(record.definition, LIMITS.bytes);
    const handle = await this.io.open(file, 'w'), owner = { handle, file, remove: false, closed: false };
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
    finally {
      try { await this.finishCleanup(owner); }
      catch (error) { this.pendingCleanup.add(owner); throw Error('Runbook export cleanup did not finish: ' + error.message); }
    }
    return file;
  }); }
}
module.exports = { RunbookStore, MAX_FILES, MAX_FILE_BYTES };
