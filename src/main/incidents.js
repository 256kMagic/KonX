'use strict';
const { sameFile, sameVersion, replaceOwnedFile, publishNewFile } = require('./atomic-replacement');

// Local, explicitly imported incident evidence. Assets are immutable copies;
// the manifest is an atomic append-only index. No sockets or cloud clients.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const LIMITS = Object.freeze({ incidents: 200, evidence: 128, fileBytes: 128 * 1024 * 1024, textBytes: 8 * 1024 * 1024,
  noteBytes: 256 * 1024, incidentBytes: 512 * 1024 * 1024, manifestBytes: 1024 * 1024,
  responseBytes: 2 * 1024 * 1024, previewBytes: 64 * 1024, exportTextBytes: 4 * 1024 * 1024,
  exportBytes: 32 * 1024 * 1024, timeline: 1500, eventMessageChars: 512 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEXT_KINDS = new Set(['note', 'terminal', 'tool', 'syslog']);
const FILE_KINDS = new Set(['capture', 'terminal', 'tool', 'syslog', 'other']);
const idOf = value => { if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid incident or evidence identifier'); return value; };
const string = (value, name, max, fallback = '') => { if (value == null) value = fallback; if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${name}`); return value; };
const nullableString = (value, name, max) => value == null ? null : string(value, name, max);
const titleOf = value => { const out = string(value, 'title', 256).trim(); if (!out) throw new Error('Enter an incident title'); return out; };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const utf8Prefix = (text, bytes) => { const raw = Buffer.from(text); if (raw.length <= bytes) return text; let end = Math.max(0, bytes); while (end && (raw[end] & 0xc0) === 0x80) end--; return raw.subarray(0, end).toString('utf8'); };
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

function parseTimestamp(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  if (+month < 1 || +month > 12 || +day < 1 || +hour > 23 || +minute > 59 || +second > 59) return null;
  const base = new Date(0); base.setUTCFullYear(+year, +month - 1, +day); base.setUTCHours(+hour, +minute, +second, Number((fraction || '.0').slice(1).padEnd(3, '0').slice(0, 3)));
  if (base.getUTCMonth() !== +month - 1 || base.getUTCDate() !== +day) return null;
  let shift = 0;
  if (offset !== 'Z') { const hours = +offset.slice(1, 3), minutes = +offset.slice(4, 6); if (hours > 23 || minutes > 59) return null; shift = (offset[0] === '+' ? 1 : -1) * (hours * 60 + minutes) * 60000; }
  const result = new Date(base.getTime() - shift);
  return result.getUTCFullYear() < 0 || result.getUTCFullYear() > 9999 ? null : result.toISOString();
}
function observedTime(value) {
  if (value == null || value === '') return null;
  const parsed = parseTimestamp(value);
  if (!parsed) throw new Error('Observation time must include a valid date, time, and UTC offset');
  return parsed;
}
function parseSyslog(text, options = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.textBytes) throw new Error('Syslog text exceeds the 8 MiB limit');
  const limit = options.limit ?? LIMITS.timeline;
  if (!Number.isInteger(limit) || limit < 0 || limit > LIMITS.timeline) throw new Error('Invalid timeline limit');
  const events = []; let nonempty = 0, explicit = 0, unknown = 0, line = 0, start = 0;
  // Scan one source line at a time rather than allocating an unbounded array
  // of empty lines from a small file containing millions of newline bytes.
  const separator = /\r\n|\n|\r/g;
  const inspect = original => {
    line++; if (!original.trim()) return; nonempty++;
    const raw = original.replace(/^<\d{1,3}>(?:\d{1,3}\s+)?\s*/, '');
    const iso = raw.match(/^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\]?(?:\s|$)/);
    const traditional = raw.match(/^[*.]?(?:[A-Za-z]{3})\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?/);
    const timeText = (iso?.[1] || traditional?.[0] || (raw.startsWith('- ') ? '-' : null));
    const observedAt = iso ? parseTimestamp(iso[1]) : null;
    if (observedAt) explicit++; else unknown++;
    if (events.length < limit) events.push({ line, observedAt, timeText: timeText?.slice(0, 128) || null, timestampStatus: observedAt ? 'explicit' : 'unknown',
      message: original.slice(0, LIMITS.eventMessageChars), messageTruncated: original.length > LIMITS.eventMessageChars });
  };
  let match;
  while ((match = separator.exec(text))) { inspect(text.slice(start, match.index)); start = separator.lastIndex; }
  inspect(text.slice(start));
  return { events, totalLines: line, nonemptyLines: nonempty, examinedLines: line, explicitTimestamps: explicit, unknownTimestamps: unknown, retainedEvents: events.length, limited: events.length < nonempty };
}

class IncidentStore {
  constructor(userDataDir, options = {}) {
    if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir)) throw new Error('Incident storage requires an absolute profile directory');
    this.directory = path.join(userDataDir, 'incidents'); this.io = options.fs || fs; this.publishNew = options.publishNew || publishNewFile; this.queue = Promise.resolve();
    this.operations = 0; this.owners = new Set(); this.readVersions = new WeakMap(); this.closing = null;
  }
  get hasOwnership() { return this.operations > 0 || this.owners.size > 0; }
  serialize(fn) {
    if (this.closing) return Promise.reject(new Error('Incident storage is closing.'));
    this.operations++; const work = this.queue.then(fn).finally(() => { this.operations--; }); this.queue = work.catch(() => {}); return work;
  }
  async cleanup(owner) {
    if (owner.remove && !owner.identity && owner.handle) owner.identity = await owner.handle.stat({ bigint: true });
    if (owner.handle) { await owner.handle.close(); owner.handle = null; }
    if (owner.remove) {
      let current; try { current = await this.io.lstat(owner.file, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current) { if (!sameFile(owner.identity, current)) throw new Error('Owned incident temporary path changed; cleanup remains pending.'); await this.io.unlink(owner.file); }
    }
    this.owners.delete(owner);
  }
  async retryCleanup() {
    const errors = []; for (const owner of [...this.owners]) try { await this.cleanup(owner); } catch (error) { errors.push(error); }
    if (errors.length) throw Object.assign(new Error('Incident cleanup remains pending. Retry closing when storage is available.'), { code: 'INCIDENT_CLEANUP' });
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = this.queue.then(() => this.retryCleanup()).finally(() => { this.closing = null; }); return this.closing;
  }
  async regular(file, max) {
    const stat = await this.io.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Evidence must be a regular file, not a symbolic link');
    if (stat.size > max) throw new Error('File exceeds its allowed byte limit');
    return stat;
  }
  async realDirectory(directory, create = false) {
    if (create) await this.io.mkdir(directory, { recursive: true });
    const stat = await this.io.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Incident paths must be real directories, not symbolic links');
  }
  async ready() { await this.retryCleanup(); await this.realDirectory(this.directory, true); }
  dir(id) { return path.join(this.directory, idOf(id)); }
  async readBytes(file, max, observed) {
    const stat = await this.io.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(max) || stat.ino === 0n) throw new Error('Evidence must be a bounded regular file with known identity');
    const owner = { file, handle: await this.io.open(file, 'r'), remove: false }; this.owners.add(owner);
    try {
      const opened = await owner.handle.stat({ bigint: true }); if (!sameVersion(stat, opened)) throw new Error('Evidence changed while opening');
      const buffer = Buffer.alloc(Number(stat.size) + 1); let offset = 0;
      while (offset < buffer.length) { const part = await owner.handle.read(buffer, offset, buffer.length - offset, null); if (!part.bytesRead) break; offset += part.bytesRead; }
      const after = await owner.handle.stat({ bigint: true });
      if (BigInt(offset) !== stat.size || !sameVersion(opened, after)) throw new Error('Evidence changed while reading');
      observed?.(after); return buffer.subarray(0, offset);
    } finally { await this.cleanup(owner); }
  }
  async readJson(file, max, observed) { const bytes = await this.readBytes(file, max, observed); try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Incident JSON is malformed'); } }
  async owned(id, requireEvidence = true) {
    await this.ready(); const directory = this.dir(id); await this.realDirectory(directory);
    const owner = await this.readJson(path.join(directory, 'owner.json'), 4096);
    if (owner?.schemaVersion !== 1 || owner.product !== 'KonX' || owner.kind !== 'incident' || owner.id !== id) throw new Error('Incident ownership record does not match');
    if (requireEvidence) await this.realDirectory(path.join(directory, 'evidence'));
    return directory;
  }
  async atomicJson(directory, name, value, initial = false, expectedVersion) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    if (bytes.length > LIMITS.manifestBytes) throw new Error('Incident manifest exceeds its byte limit');
    const temp = path.join(directory, '.manifest-' + crypto.randomUUID() + '.tmp'), destination = path.join(directory, name);
    const targetVersion = initial ? null : expectedVersion || await this.io.lstat(destination, { bigint: true });
    const owner = { file: temp, handle: await this.io.open(temp, 'wx', 0o600), remove: true, identity: null }; this.owners.add(owner);
    let published = false;
    try {
      owner.identity = await owner.handle.stat({ bigint: true }); await owner.handle.writeFile(bytes); await owner.handle.sync();
      const sourceVersion = await owner.handle.stat({ bigint: true }); if (!sameFile(owner.identity, sourceVersion)) throw new Error('Owned incident replacement identity is unavailable');
      await owner.handle.close(); owner.handle = null;
      if (initial) owner.remove = !await this.publishNew(this.io, temp, destination, sourceVersion);
      else { try { await replaceOwnedFile(this.io, temp, destination, sourceVersion, targetVersion); } catch (error) { if (error.code === 'ATOMIC_CONFLICT') error.code = 'INCIDENT_CONFLICT'; throw error; } owner.remove = false; }
      published = true;
    } finally { try { await this.cleanup(owner); } catch (error) { if (!published) throw error; } }
  }
  validate(value, id) {
    if (value?.schemaVersion !== 1 || value.id !== id || !parseTimestamp(value.createdAt) || !parseTimestamp(value.updatedAt) || !Array.isArray(value.evidence) || !Array.isArray(value.timeline) || value.evidence.length > LIMITS.evidence || value.timeline.length > LIMITS.timeline) throw new Error('Incident manifest schema or identity is invalid');
    const title = titleOf(value.title), description = string(value.description, 'description', 4096);
    const ids = new Set(), evidence = []; let bytes = 0;
    for (const item of value.evidence) {
      idOf(item?.id); if (ids.has(item.id)) throw new Error('Duplicate evidence identifier'); ids.add(item.id);
      const maxBytes = item.kind === 'note' ? LIMITS.noteBytes : TEXT_KINDS.has(item.kind) ? LIMITS.textBytes : LIMITS.fileBytes;
      if (![...FILE_KINDS, 'note'].includes(item.kind) || item.relativePath !== 'evidence/' + item.id + '.bin' || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isInteger(item.bytes) || item.bytes < 0 || item.bytes > maxBytes || !parseTimestamp(item.addedAt)) throw new Error('Invalid evidence record');
      if (item.observedAt != null && !parseTimestamp(item.observedAt)) throw new Error('Invalid evidence observation time');
      if (item.sourceModifiedAt != null && !parseTimestamp(item.sourceModifiedAt)) throw new Error('Invalid evidence source modification time');
      const record = { id: item.id, kind: item.kind, label: string(item.label, 'evidence label', 256), addedAt: parseTimestamp(item.addedAt),
        observedAt: item.observedAt == null ? null : parseTimestamp(item.observedAt), timeText: nullableString(item.timeText, 'source timestamp', 128),
        sourceName: string(item.sourceName, 'source name', 1024), originalPath: nullableString(item.originalPath, 'original path', 4096),
        sourceModifiedAt: item.sourceModifiedAt == null ? null : parseTimestamp(item.sourceModifiedAt), relativePath: item.relativePath, bytes: item.bytes, sha256: item.sha256 };
      if (item.analysisError != null) record.analysisError = string(item.analysisError, 'evidence analysis error', 1024);
      if (item.timelineCoverage != null) {
        const coverage = item.timelineCoverage, clean = {};
        for (const key of ['totalLines', 'nonemptyLines', 'examinedLines', 'explicitTimestamps', 'unknownTimestamps', 'retainedEvents']) {
          if (!Number.isInteger(coverage[key]) || coverage[key] < 0 || coverage[key] > LIMITS.textBytes + 1) throw new Error('Invalid timeline coverage');
          clean[key] = coverage[key];
        }
        if (item.kind !== 'syslog' || typeof coverage.limited !== 'boolean' || coverage.nonemptyLines > coverage.totalLines || coverage.examinedLines !== coverage.totalLines || coverage.explicitTimestamps + coverage.unknownTimestamps !== coverage.nonemptyLines || coverage.retainedEvents > Math.min(coverage.nonemptyLines, LIMITS.timeline)) throw new Error('Inconsistent timeline coverage');
        clean.limited = coverage.limited; record.timelineCoverage = clean;
      }
      evidence.push(record);
      bytes += item.bytes;
    }
    if (bytes > LIMITS.incidentBytes || value.totalBytes !== bytes) throw new Error('Incident evidence size is inconsistent');
    const timeline = [], eventIds = new Set(), retainedCounts = new Map();
    for (const event of value.timeline) {
      if (!event || !ids.has(event.evidenceId) || typeof event.id !== 'string' || event.id.length > 128 || eventIds.has(event.id) || !['explicit', 'unknown'].includes(event.timestampStatus) || event.observedAt != null && !parseTimestamp(event.observedAt)) throw new Error('Invalid incident timeline record');
      if (event.line != null && (!Number.isInteger(event.line) || event.line < 1 || event.line > LIMITS.textBytes + 1)) throw new Error('Invalid evidence source line');
      if (event.id !== event.evidenceId + ':' + (event.line ?? 'item') || (event.timestampStatus === 'explicit') !== (event.observedAt != null)) throw new Error('Inconsistent timeline identity or time');
      eventIds.add(event.id); retainedCounts.set(event.evidenceId, (retainedCounts.get(event.evidenceId) || 0) + 1);
      timeline.push({ id: event.id, evidenceId: event.evidenceId, observedAt: event.observedAt == null ? null : parseTimestamp(event.observedAt),
        timeText: nullableString(event.timeText, 'source timestamp', 128), timestampStatus: event.timestampStatus,
        message: string(event.message, 'timeline message', LIMITS.eventMessageChars), line: event.line ?? null, messageTruncated: event.messageTruncated === true });
    }
    for (const item of evidence) if (item.timelineCoverage && item.timelineCoverage.retainedEvents !== (retainedCounts.get(item.id) || 0)) throw new Error('Timeline coverage differs from retained events');
    return { schemaVersion: 1, id, title, description, createdAt: parseTimestamp(value.createdAt), updatedAt: parseTimestamp(value.updatedAt),
      totalBytes: bytes, evidence, timeline, timelineLimited: value.timelineLimited === true };
  }
  async manifest(id) { const directory = await this.owned(id); let version; const record = this.validate(await this.readJson(path.join(directory, 'manifest.json'), LIMITS.manifestBytes, stat => { version = stat; }), id); this.readVersions.set(record, version); return record; }
  summary(value) { return { id: value.id, title: value.title, description: value.description, createdAt: value.createdAt, updatedAt: value.updatedAt, evidenceCount: value.evidence.length, totalBytes: value.totalBytes, timelineEvents: value.timeline.length, timelineLimited: !!value.timelineLimited }; }
  create(input) { return this.serialize(async () => {
    await this.ready(); const title = titleOf(input?.title), description = string(input?.description, 'description', 4096);
    const entries = await this.io.readdir(this.directory); if (entries.filter(name => UUID.test(name)).length >= LIMITS.incidents) throw new Error('Incident store has reached its 200-workspace limit');
    const id = crypto.randomUUID(), directory = this.dir(id), now = new Date().toISOString();
    const manifest = { schemaVersion: 1, id, title, description, createdAt: now, updatedAt: now, totalBytes: 0, evidence: [], timeline: [], timelineLimited: false };
    await this.io.mkdir(directory);
    try {
      await this.atomicJson(directory, 'owner.json', { schemaVersion: 1, product: 'KonX', kind: 'incident', id }, true);
      await this.io.mkdir(path.join(directory, 'evidence'));
      await this.atomicJson(directory, 'manifest.json', manifest, true);
    } catch (error) {
      // Ownership survives a failed cleanup, so an incomplete incident can be
      // listed as an issue and explicitly removed later.
      try {
        let markerExists = true;
        try { await this.io.lstat(path.join(directory, 'owner.json')); }
        catch (missing) { if (missing.code !== 'ENOENT') throw missing; markerExists = false; }
        if (markerExists) await this.removeOwnedDirectory(id); else await this.io.rmdir(directory);
      } catch (cleanup) { error.message += '; incomplete incident retained: ' + id + ' (' + cleanup.message + ')'; }
      throw error;
    }
    return this.summary(manifest);
  }); }
  list() { return this.serialize(async () => {
    await this.ready(); const incidents = [], issues = [];
    const entries = await this.io.readdir(this.directory);
    for (const name of entries.slice(0, LIMITS.incidents * 2)) {
      if (!UUID.test(name)) { issues.push({ file: name, message: 'Unrecognized entry was not loaded.' }); continue; }
      try { incidents.push(this.summary(await this.manifest(name))); } catch (error) { issues.push({ id: name, message: error.message }); }
    }
    if (entries.length > LIMITS.incidents * 2) issues.push({ message: 'Directory listing limit reached; some entries were not examined.' });
    incidents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); return { incidents, issues };
  }); }
  assetPath(id, item) { return path.join(this.dir(id), 'evidence', idOf(item.id) + '.bin'); }
  async verifiedText(id, item) {
    const bytes = await this.readBytes(this.assetPath(id, item), LIMITS.textBytes);
    if (bytes.length !== item.bytes || hash(bytes) !== item.sha256) throw new Error('Evidence checksum differs from its imported bytes');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { const error = new Error('Text evidence is not valid UTF-8; the original bytes remain available'); error.code = 'INCIDENT_TEXT_ENCODING'; throw error; }
  }
  get(id) { return this.serialize(async () => this.withPreviews(await this.manifest(id))); }
  async withPreviews(manifest) {
    const id = manifest.id, result = structuredClone(manifest);
    let budget = Math.max(0, LIMITS.responseBytes - jsonBytes(result) - 16384);
    for (const item of result.evidence) {
      item.integrity = 'not-checked';
      if (!TEXT_KINDS.has(item.kind)) continue;
      if (budget <= 64) { item.previewOmitted = 'Display text budget reached'; continue; }
      try {
        const text = await this.verifiedText(id, item), size = Math.min(LIMITS.previewBytes, Math.floor(budget / 6));
        item.textPreview = utf8Prefix(text, size); item.textPreviewTruncated = Buffer.byteLength(text) > Buffer.byteLength(item.textPreview); item.integrity = 'verified';
        budget -= jsonBytes({ textPreview: item.textPreview, textPreviewTruncated: item.textPreviewTruncated }) + 64;
      } catch (error) { item.integrity = error.code === 'INCIDENT_TEXT_ENCODING' ? 'verified' : 'error'; item.previewError = error.message; }
    }
    result.timeline.sort((a, b) => a.observedAt && b.observedAt ? a.observedAt.localeCompare(b.observedAt) : a.observedAt ? -1 : b.observedAt ? 1 : 0);
    if (jsonBytes(result) > LIMITS.responseBytes) throw new Error('Incident response exceeds its display limit');
    return result;
  }
  addFile(id, input) { return this.serialize(async () => {
    if (!FILE_KINDS.has(input?.kind)) throw new Error('Choose a supported evidence file type');
    if (typeof input.sourcePath !== 'string' || !path.isAbsolute(input.sourcePath) || input.sourcePath.length > 4096) throw new Error('Choose an absolute source-file path');
    return this.append(id, input, { sourcePath: input.sourcePath });
  }); }
  addText(id, input) { return this.serialize(async () => {
    if (!TEXT_KINDS.has(input?.kind) || typeof input.text !== 'string') throw new Error('Choose a supported text evidence type');
    const bytes = Buffer.from(input.text); if (bytes.length > LIMITS.noteBytes) throw new Error('Entered text exceeds the 256 KiB limit; import a UTF-8 text file for larger evidence');
    return this.append(id, input, { bytes });
  }); }
  addBytes(id, input) {
    if (input?.kind !== 'capture' || !(input.bytes instanceof Uint8Array)) throw new Error('Capture evidence requires a byte array');
    if (input.bytes.byteLength > LIMITS.fileBytes) throw new Error('Capture exceeds the 128 MiB evidence limit');
    const request = { kind: 'capture', label: input.label, observedAt: input.observedAt };
    const sourceName = string(input.sourceName, 'source name', 1024, 'capture.pcap');
    // The capture can keep changing in the application. Own the supplied byte
    // range now, before queueing or awaiting any filesystem work.
    const bytes = Buffer.from(input.bytes);
    return this.serialize(() => this.append(id, request, { bytes, sourceName }));
  }
  async append(id, input, content) {
    const manifest = await this.manifest(id); if (manifest.evidence.length >= LIMITS.evidence) throw new Error('Incident has reached its 128-evidence-item limit');
    const observedAt = observedTime(input.observedAt), evidenceId = crypto.randomUUID();
    const sourceName = string(content.sourcePath ? path.basename(content.sourcePath) : content.sourceName || input.kind + '.txt', 'source name', 1024);
    const label = string(input.label, 'evidence label', 256, sourceName).trim() || sourceName;
    const max = TEXT_KINDS.has(input.kind) ? LIMITS.textBytes : LIMITS.fileBytes;
    const sourceStat = content.sourcePath ? await this.regular(content.sourcePath, max) : null;
    const size = sourceStat ? sourceStat.size : content.bytes.length;
    if (manifest.totalBytes + size > LIMITS.incidentBytes) throw new Error('Incident exceeds its 512 MiB evidence limit');
    const item = { id: evidenceId, kind: input.kind, label, addedAt: new Date().toISOString(), observedAt, timeText: input.observedAt || null,
      sourceName, originalPath: content.sourcePath || null, sourceModifiedAt: sourceStat ? new Date(sourceStat.mtimeMs).toISOString() : null,
      relativePath: 'evidence/' + evidenceId + '.bin', bytes: size, sha256: null };
    const target = this.assetPath(id, item);
    let destination, source, destinationOwner, sourceOwner, savedManifest;
    try {
      destination = await this.io.open(target, 'wx', 0o600); destinationOwner = { file: target, handle: destination, remove: true, identity: null }; this.owners.add(destinationOwner); destinationOwner.identity = await destination.stat({ bigint: true });
      const digest = crypto.createHash('sha256');
      if (content.bytes) { await destination.writeFile(content.bytes); digest.update(content.bytes); }
      else {
        source = await this.io.open(content.sourcePath, 'r'); sourceOwner = { file: content.sourcePath, handle: source, remove: false }; this.owners.add(sourceOwner); const opened = await source.stat();
        if (!opened.isFile() || opened.size !== sourceStat.size || opened.dev !== sourceStat.dev || (opened.ino && sourceStat.ino && opened.ino !== sourceStat.ino)) throw new Error('Source file changed while opening');
        const buffer = Buffer.alloc(65536); let copied = 0;
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
          if (copied + bytesRead > size || copied + bytesRead > max) throw new Error('Source file grew beyond its declared size');
          const part = buffer.subarray(0, bytesRead); await destination.writeFile(part); digest.update(part); copied += bytesRead;
        }
        const after = await source.stat();
        if (copied !== size || after.size !== size || after.mtimeMs !== sourceStat.mtimeMs) throw new Error('Source file changed during import');
      }
      item.sha256 = digest.digest('hex'); await destination.sync(); await destination.close(); destination = null; destinationOwner.handle = null;
      if (sourceOwner) { await this.cleanup(sourceOwner); source = null; }
      let events;
      if (input.kind === 'syslog') {
        try {
          const parsed = parseSyslog(await this.verifiedText(id, item), { limit: Math.max(0, LIMITS.timeline - manifest.timeline.length) });
          item.timelineCoverage = { ...parsed }; delete item.timelineCoverage.events;
          events = parsed.events.map(event => ({ id: evidenceId + ':' + event.line, evidenceId, ...event }));
        } catch (error) { item.analysisError = error.message; events = []; }
      } else events = [{ id: evidenceId + ':item', evidenceId, observedAt, timeText: input.observedAt || null, timestampStatus: observedAt ? 'explicit' : 'unknown', message: label.slice(0, LIMITS.eventMessageChars), line: null, messageTruncated: false }];
      const remaining = Math.max(0, LIMITS.timeline - manifest.timeline.length), retained = events.slice(0, remaining);
      manifest.evidence.push(item); manifest.totalBytes += size; manifest.updatedAt = item.addedAt;
      manifest.timeline.push(...retained);
      manifest.timelineLimited ||= retained.length < events.length || !!item.timelineCoverage?.limited;
      // Account for JSON whitespace/escaping expansion. Find a bounded prefix
      // with logarithmic serialization passes rather than deleting one event
      // and repeatedly serializing a large manifest for every removed row.
      if (Buffer.byteLength(JSON.stringify(manifest, null, 2)) + 1 > LIMITS.manifestBytes && retained.length) {
        manifest.timelineLimited = true;
        const previous = manifest.timeline.slice(0, manifest.timeline.length - retained.length);
        let low = 0, high = retained.length;
        while (low < high) {
          const count = Math.ceil((low + high) / 2); manifest.timeline = previous.concat(retained.slice(0, count));
          if (item.timelineCoverage) { item.timelineCoverage.retainedEvents = count; item.timelineCoverage.limited = true; }
          if (Buffer.byteLength(JSON.stringify(manifest, null, 2)) + 1 <= LIMITS.manifestBytes) low = count; else high = count - 1;
        }
        retained.length = low; manifest.timeline = previous.concat(retained);
      }
      if (item.timelineCoverage) { item.timelineCoverage.retainedEvents = retained.length; item.timelineCoverage.limited ||= retained.length < events.length; }
      savedManifest = this.validate(manifest, id);
      await this.atomicJson(this.dir(id), 'manifest.json', savedManifest, false, this.readVersions.get(manifest)); destinationOwner.remove = false; await this.cleanup(destinationOwner);
    } catch (error) {
      // Close owned handles before removing only the unpublished asset whose
      // inode we created. Failed cleanup remains owned for close()/retry.
      for (const owner of [sourceOwner, destinationOwner]) if (owner && this.owners.has(owner)) {
        try { await this.cleanup(owner); } catch (cleanup) { error.message += '; incident cleanup pending (' + cleanup.message + ')'; }
      }
      throw error;
    }
    // The append is committed. Reopening its manifest could fail independently
    // and incorrectly invite a retry that saves the same note twice. Build the
    // response from the committed record; preview failures remain item details.
    return this.withPreviews(savedManifest);
  }
  evidencePath(id, evidenceId) { return this.serialize(async () => {
    const manifest = await this.manifest(id), item = manifest.evidence.find(e => e.id === idOf(evidenceId));
    if (!item) throw new Error('Evidence was not found in this incident');
    const file = this.assetPath(id, item), stat = await this.regular(file, LIMITS.fileBytes);
    if (stat.size !== item.bytes) throw new Error('Evidence size changed after import');
    const handle = await this.io.open(file, 'r'), owner = { file, handle, remove: false }, digest = crypto.createHash('sha256'); this.owners.add(owner); let total = 0;
    try {
      const opened = await handle.stat(); if (!opened.isFile() || opened.size !== stat.size || opened.dev !== stat.dev || (opened.ino && stat.ino && opened.ino !== stat.ino)) throw new Error('Evidence changed while opening');
      const buffer = Buffer.alloc(65536);
      for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; total += bytesRead; if (total > item.bytes) throw new Error('Evidence grew during verification'); digest.update(buffer.subarray(0, bytesRead)); }
    } finally { await this.cleanup(owner); }
    if (total !== item.bytes || digest.digest('hex') !== item.sha256) throw new Error('Evidence checksum differs from its imported bytes');
    return file;
  }); }
  readCapture(id, evidenceId) { return this.serialize(async () => {
    const manifest = await this.manifest(id), item = manifest.evidence.find(e => e.id === idOf(evidenceId));
    if (!item || item.kind !== 'capture') throw new Error('Choose capture evidence from this incident');
    const bytes = await this.readBytes(this.assetPath(id, item), LIMITS.fileBytes);
    if (bytes.length !== item.bytes || hash(bytes) !== item.sha256) throw new Error('Evidence checksum differs from its imported bytes');
    return { name: item.sourceName, bytes };
  }); }
  exportRecord(id) { return this.serialize(async () => {
    const incident = await this.manifest(id), result = { schemaVersion: 1, kind: 'konx-incident-report', exportedAt: new Date().toISOString(), incident: structuredClone(incident), limitations: [
      'Captured files and other binary evidence are not embedded. SHA-256 values describe the original imported bytes.',
      'Text is embedded up to the report budget; truncation and integrity failures are explicit. Source assets remain in the local incident workspace.',
      'Missing source dates or time zones remain unknown. Import times and file modification times are not substituted for observation times.',
    ] };
    let remaining = LIMITS.exportTextBytes;
    for (const item of result.incident.evidence) {
      item.integrity = 'not-checked';
      if (!TEXT_KINDS.has(item.kind)) continue;
      if (!remaining) { item.textOmitted = 'Report text budget reached'; continue; }
      try {
        const text = await this.verifiedText(id, item); item.text = utf8Prefix(text, remaining); item.textTruncated = Buffer.byteLength(item.text) < Buffer.byteLength(text); item.embeddedTextBytes = Buffer.byteLength(item.text); item.integrity = 'verified'; remaining -= item.embeddedTextBytes;
      } catch (error) { item.integrity = error.code === 'INCIDENT_TEXT_ENCODING' ? 'verified' : 'error'; item.textOmitted = error.message; }
    }
    return result;
  }); }
  async exportJson(id) { const text = JSON.stringify(await this.exportRecord(id), null, 2) + '\n'; if (Buffer.byteLength(text) > LIMITS.exportBytes) throw new Error('Incident export exceeds its byte limit'); return text; }
  writeExport(destination, content) { return this.serialize(async () => {
    if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.length > 4096 || destination.includes('\0')) throw new Error('Choose an absolute incident export path');
    if (typeof content !== 'string' || Buffer.byteLength(content) > LIMITS.exportBytes) throw new Error('Incident export exceeds its byte limit');
    await this.ready();
    const parent = await this.io.realpath(path.dirname(destination)), library = await this.io.realpath(this.directory);
    const relative = path.relative(library, parent);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Choose an export location outside the managed incident library');
    const target = path.join(parent, path.basename(destination));
    let targetVersion = null;
    try { targetVersion = await this.io.lstat(target, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (targetVersion && (!targetVersion.isFile() || targetVersion.isSymbolicLink())) throw new Error('Incident export destination must be a regular file');
    const temp = path.join(parent, '.konx-incident-export-' + crypto.randomUUID() + '.tmp');
    const owner = { file: temp, handle: await this.io.open(temp, 'wx', 0o600), remove: true, identity: null }; this.owners.add(owner);
    let published = false;
    try {
      owner.identity = await owner.handle.stat({ bigint: true }); await owner.handle.writeFile(content, 'utf8'); await owner.handle.sync();
      const sourceVersion = await owner.handle.stat({ bigint: true }); await owner.handle.close(); owner.handle = null;
      if (targetVersion) { await replaceOwnedFile(this.io, temp, target, sourceVersion, targetVersion); owner.remove = false; }
      else owner.remove = !await this.publishNew(this.io, temp, target, sourceVersion);
      published = true; return destination;
    } finally { try { await this.cleanup(owner); } catch (error) { if (!published) throw error; } }
  }); }
  async exportHtml(id) {
    const report = await this.exportRecord(id), incident = report.incident;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const timeline = [...incident.timeline].sort((a, b) => a.observedAt && b.observedAt ? a.observedAt.localeCompare(b.observedAt) : a.observedAt ? -1 : b.observedAt ? 1 : 0);
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(incident.title)} — KonX incident</title><style>body{font:15px system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;color:#17202a}h1,h2{color:#174c83}table{border-collapse:collapse;width:100%;margin:18px 0}td,th{border:1px solid #ccd5de;padding:9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}pre{background:#f0f3f6;padding:15px;white-space:pre-wrap;overflow-wrap:anywhere}.hint{color:#536471}details{border:1px solid #ccd5de;padding:12px;margin:12px 0}code{overflow-wrap:anywhere}</style></head><body><h1>${escape(incident.title)}</h1><p>${escape(incident.description)}</p><p class="hint">Incident ${escape(incident.id)} · Exported ${escape(report.exportedAt)}</p><h2>Timeline</h2><p>${incident.timelineLimited ? 'Timeline is limited. Original evidence assets retain the complete imported content.' : 'Events with unknown source times appear after explicitly timestamped events.'}</p><table><thead><tr><th>Observed time</th><th>Evidence</th><th>Event</th></tr></thead><tbody>${timeline.map(e => `<tr><td>${escape(e.observedAt || 'Unknown')}${e.timeText ? '<br><small>Source: ' + escape(e.timeText) + '</small>' : ''}</td><td>${escape(e.evidenceId)}${e.line ? ' · line ' + e.line : ''}</td><td>${escape(e.message)}${e.messageTruncated ? ' [preview truncated]' : ''}</td></tr>`).join('')}</tbody></table><h2>Evidence and notes</h2>${incident.evidence.map(e => `<details open><summary><strong>${escape(e.label)}</strong> · ${escape(e.kind)} · ${e.bytes} bytes</summary><p>Source: ${escape(e.sourceName)}<br>Observation time: ${escape(e.observedAt || 'Unknown')}<br>Imported: ${escape(e.addedAt)}<br>SHA-256: <code>${escape(e.sha256)}</code><br>Integrity checked for this report: ${escape(e.integrity)}</p>${e.text !== undefined ? '<pre>' + escape(e.text) + '</pre>' + (e.textTruncated ? '<p>Embedded text truncated by report budget; the original asset is complete.</p>' : '') : '<p>' + escape(e.textOmitted || 'Binary asset is not embedded in this report.') + '</p>'}</details>`).join('')}<h2>Scope</h2><ul>${report.limitations.map(line => '<li>' + escape(line) + '</li>').join('')}</ul></body></html>`;
    if (Buffer.byteLength(body) > LIMITS.exportBytes) throw new Error('Incident HTML export exceeds its byte limit'); return body;
  }
  async removeOwnedDirectory(id) {
    const directory = await this.owned(id, false), evidenceDir = path.join(directory, 'evidence');
    const names = await this.io.readdir(directory); let assets = [];
    if (names.includes('evidence')) { await this.realDirectory(evidenceDir); assets = await this.io.readdir(evidenceDir); }
    if (names.some(name => !['owner.json', 'manifest.json', 'evidence'].includes(name) && !(name.startsWith('.manifest-') && name.endsWith('.tmp') && UUID.test(name.slice(10, -4))))) throw new Error('Incident contains unrecognized files; deletion stopped');
    if (assets.length > LIMITS.evidence * 2 || assets.some(name => !name.endsWith('.bin') || !UUID.test(name.slice(0, -4)))) throw new Error('Incident contains unrecognized evidence files; deletion stopped');
    const files = [...assets.map(name => path.join(evidenceDir, name)), ...names.filter(name => name !== 'evidence' && name !== 'owner.json').map(name => path.join(directory, name))];
    for (const file of files) await this.regular(file, LIMITS.fileBytes);
    for (const file of files) await this.io.unlink(file);
    if (names.includes('evidence')) await this.io.rmdir(evidenceDir);
    await this.io.unlink(path.join(directory, 'owner.json'));
    try { await this.io.rmdir(directory); }
    catch (error) {
      // A final directory-removal failure must not erase the ownership needed
      // for a retry. Restore only our exact, absent owner marker.
      try { await this.atomicJson(directory, 'owner.json', { schemaVersion: 1, product: 'KonX', kind: 'incident', id }, true); }
      catch (restore) { error.message += '; owner marker could not be restored: ' + restore.message; }
      throw error;
    }
    return { removed: id };
  }
  remove(id) { return this.serialize(() => this.removeOwnedDirectory(id)); }
}

module.exports = { IncidentStore, LIMITS, parseTimestamp, parseSyslog };
