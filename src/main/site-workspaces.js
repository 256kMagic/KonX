'use strict';

// Reference-only workspace persistence. This module never resolves credentials,
// opens referenced captures, creates terminal connections, or starts tool jobs.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const LIMITS = Object.freeze({ workspaces: 100, fileBytes: 1024 * 1024, listBytes: 16 * 1024 * 1024,
  sessions: 128, captures: 64, incidents: 64, panels: 32, notesBytes: 128 * 1024 });
const LAYOUTS = Object.freeze(['classic', 'workbench', 'incident-desk', 'operations-wall', 'focus']);
const PASSIVE_TOOLS = Object.freeze(['capture', 'capture-compare', 'runbook', 'remote-capture', 'incidents', 'snapshots', 'device', 'topology', 'events',
  'security', 'ai', 'ping', 'sweep', 'portscan', 'traceroute', 'dns', 'whois', 'subnet', 'wol']);
const SPLITS = ['workbench', 'incident-desk', 'operations-wall'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KIND = 'konx-site-workspace';
const DATA_FIELDS = ['name', 'description', 'notes', 'sessions', 'captures', 'incidentIds', 'layout'];
const RECORD_FIELDS = ['schemaVersion', 'kind', 'id', 'revision', 'createdAt', 'updatedAt', ...DATA_FIELDS];
function fail(message, code = 'SITE_WORKSPACE_INVALID') { throw Object.assign(new Error(message), { code }); }
function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} contains unsupported field “${key}”; credentials, commands and inline connection settings cannot be stored`);
  return value;
}
function string(value, label, max, fallback = '') {
  if (value === undefined) value = fallback;
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(`${label} must be text of at most ${max} characters without NUL bytes`);
  return value;
}
function name(value) { const out = string(value, 'Workspace name', 256).trim(); if (!out) fail('Enter a workspace name'); return out; }
function reference(value, label = 'Reference') {
  const out = string(value, label, 128);
  if (!out || /[\x00-\x1f\x7f]/.test(out)) fail(`${label} must be a nonempty identifier`);
  return out;
}
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('Invalid workspace or incident identifier'); return value; }
function number(value, fallback, low, high, label, integer = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high || integer && !Number.isInteger(value)) fail(`Invalid ${label}`);
  return value;
}
function list(value, max, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail(`${label} supports at most ${max} entries`, 'SITE_WORKSPACE_LIMIT');
  return value;
}
function unique(items, key, label) {
  const ids = new Set();
  for (const item of items) { const id = key(item); if (ids.has(id)) fail(`Duplicate ${label} identifier`); ids.add(id); }
  return ids;
}
function rectangle(value, fallback = { x: 0.08, y: 0.08, width: 0.72, height: 0.78 }, minimum = 0) {
  if (value === undefined) return { ...fallback };
  object(value, ['x', 'y', 'width', 'height'], 'Floating bounds');
  const width = number(value.width, fallback.width, minimum, 1, 'floating width'), height = number(value.height, fallback.height, minimum, 1, 'floating height');
  if (!width || !height) fail('Floating bounds must have a positive size');
  const x = number(value.x, 0, 0, 1, 'floating x'), y = number(value.y, 0, 0, 1, 'floating y');
  if (x + width > 1 + 1e-9 || y + height > 1 + 1e-9) fail('Floating bounds must fit within the workspace');
  return { x, y, width, height };
}
function geometry(value) {
  if (value === undefined) value = {};
  object(value, ['version', 'ratios', 'lastFloatRect'], 'Workspace geometry');
  if (value.version !== undefined && value.version !== 1) fail('Unsupported workspace geometry version');
  const input = value.ratios === undefined ? {} : object(value.ratios, SPLITS, 'Split ratios');
  const ratios = Object.fromEntries(SPLITS.map(key => {
    const ratio = input[key] === undefined ? {} : object(input[key], ['columns', 'rows'], 'Split ratio');
    return [key, { columns: number(ratio.columns, 0.5, 0.2, 0.8, 'column ratio'), rows: number(ratio.rows, 0.5, 0.2, 0.8, 'row ratio') }];
  }));
  return { version: 1, ratios, lastFloatRect: rectangle(value.lastFloatRect, undefined, 0.2) };
}
function normalizeData(input) {
  const sessions = list(input.sessions, LIMITS.sessions, 'Saved session references').map(item => {
    object(item, ['id', 'name', 'group'], 'Session reference');
    return { id: reference(item.id, 'Session'), name: string(item.name, 'Session display name', 256), group: string(item.group, 'Session group', 512) };
  });
  const sessionIds = unique(sessions, item => item.id, 'session');
  const captures = list(input.captures, LIMITS.captures, 'Capture references').map(item => {
    object(item, ['id', 'name', 'path'], 'Capture reference');
    const file = string(item.path, 'Capture path', 4096);
    // Preserve the selected path exactly. It is only a reference, not an import
    // instruction or authorization to read the file.
    if (!path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) fail('Capture references require an absolute file path');
    return { id: reference(item.id, 'Capture'), name: string(item.name, 'Capture display name', 256), path: file };
  });
  const captureIds = unique(captures, item => item.id, 'capture');
  const incidentIds = list(input.incidentIds, LIMITS.incidents, 'Incident references').map(uuid);
  const incidentSet = unique(incidentIds, id => id, 'incident');
  const notes = string(input.notes, 'Workspace notes', LIMITS.notesBytes);
  if (Buffer.byteLength(notes) > LIMITS.notesBytes) fail('Workspace notes exceed the 128 KiB UTF-8 limit', 'SITE_WORKSPACE_LIMIT');
  const source = input.layout === undefined ? {} : object(input.layout, ['preset', 'geometry', 'wallCount', 'panels', 'activePanelKey'], 'Layout');
  const preset = source.preset === undefined ? 'classic' : source.preset;
  if (!LAYOUTS.includes(preset)) fail('Choose a supported workspace layout');
  const wallCount = number(source.wallCount, 4, 1, 4, 'wall pane count', true), geo = geometry(source.geometry);
  const slots = preset === 'operations-wall' ? Array.from({ length: wallCount }, (_, index) => `wall-${index}`) :
    preset === 'workbench' ? ['primary', 'companion'] : preset === 'incident-desk' ? ['primary', 'dossier'] : ['primary'];
  const occupied = new Set();
  const panels = list(source.panels, LIMITS.panels, 'Layout panels').map(item => {
    object(item, ['key', 'kind', 'referenceId', 'toolKind', 'sessionMode', 'placement', 'slot', 'bounds'], 'Panel');
    const key = reference(item.key, 'Panel'), kind = item.kind;
    if (!['session', 'capture', 'incident', 'tool', 'notes'].includes(kind)) fail('Unsupported workspace panel kind');
    let referenceId = item.referenceId ?? null, toolKind = item.toolKind ?? null;
    if (['session', 'capture', 'incident'].includes(kind)) {
      referenceId = reference(referenceId, 'Panel reference');
      if (!(kind === 'session' ? sessionIds : kind === 'capture' ? captureIds : incidentSet).has(referenceId)) fail('Panel references an entry missing from this workspace');
    } else if (referenceId !== null) fail('This panel kind cannot contain a reference identifier');
    if (kind === 'tool') { if (!PASSIVE_TOOLS.includes(toolKind)) fail('This tool cannot be restored as a passive workspace panel'); }
    else if (toolKind !== null) fail('Only tool panels may specify a tool kind');
    const sessionMode = kind === 'session' && item.sessionMode === undefined ? 'terminal' : item.sessionMode ?? null;
    if (kind === 'session' ? !['terminal', 'sftp'].includes(sessionMode) : sessionMode !== null) fail('Invalid panel session mode');
    let placement = item.placement === undefined ? 'docked' : item.placement;
    if (!['docked', 'floating', 'external'].includes(placement)) fail('Invalid panel placement');
    // A restored native window becomes a main-window floating panel. Restoring
    // a workspace never creates native popups or reuses stale monitor positions.
    if (placement === 'external') placement = 'floating';
    const slot = item.slot ?? null;
    if (slot !== null && (placement !== 'docked' || !slots.includes(slot))) fail('Panel slot is unavailable in this layout');
    if (slot === 'dossier' && kind !== 'incident' && !(kind === 'tool' && toolKind === 'incidents')) fail('The dossier slot requires an incident panel');
    if (slot !== null) { if (occupied.has(slot)) fail('Multiple panels cannot occupy the same dock slot'); occupied.add(slot); }
    if (placement === 'docked' && item.bounds != null) fail('Docked panels cannot contain floating bounds');
    return { key, kind, referenceId, toolKind, sessionMode, placement, slot, bounds: placement === 'floating' ? rectangle(item.bounds ?? undefined, geo.lastFloatRect) : null };
  });
  const panelKeys = unique(panels, item => item.key, 'panel'), activePanelKey = source.activePanelKey ?? null;
  if (activePanelKey !== null && !panelKeys.has(activePanelKey)) fail('Active panel does not exist in this workspace');
  return { name: name(input.name), description: string(input.description, 'Workspace description', 4096), notes, sessions, captures, incidentIds,
    layout: { preset, geometry: geo, wallCount, panels, activePanelKey } };
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('Invalid workspace timestamp');
  return value;
}
function record(value, id) {
  object(value, RECORD_FIELDS, 'Workspace record');
  if (value.schemaVersion !== 1 || value.kind !== KIND || value.id !== uuid(id)) fail('Workspace schema or identity is invalid', 'SITE_WORKSPACE_FORMAT');
  const revision = number(value.revision, undefined, 1, Number.MAX_SAFE_INTEGER, 'workspace revision', true);
  if (revision === undefined) fail('Workspace revision is missing');
  return { schemaVersion: 1, kind: KIND, id, revision, createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt), ...normalizeData(value) };
}
function json(value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(text) > LIMITS.fileBytes) fail('Serialized workspace exceeds its 1 MiB limit', 'SITE_WORKSPACE_LIMIT');
  return text;
}
function parse(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.fileBytes) fail('Workspace import exceeds its 1 MiB text limit', 'SITE_WORKSPACE_LIMIT');
  try { return JSON.parse(text); } catch { fail('Workspace JSON is malformed', 'SITE_WORKSPACE_FORMAT'); }
}
function importData(text) {
  const input = object(parse(text), ['schemaVersion', 'kind', 'exportedAt', 'workspace'], 'Workspace import');
  if (input.schemaVersion !== 1 || input.kind !== KIND + '-export') fail('Unsupported workspace import schema', 'SITE_WORKSPACE_FORMAT');
  timestamp(input.exportedAt); object(input.workspace, DATA_FIELDS, 'Imported workspace');
  return normalizeData(input.workspace);
}

class SiteWorkspaceStore {
  constructor(userDataDir, options = {}) {
    if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir)) fail('Workspace storage requires an absolute profile directory');
    this.directory = path.join(userDataDir, 'site-workspaces'); this.io = options.fs || fs; this.queue = Promise.resolve();
    this.cleanup = new Map(); this.pendingHandles = new Set(); this.pendingOperations = 0; this.closing = null;
  }
  get hasOwnership() { return this.pendingOperations > 0 || this.cleanup.size > 0 || this.pendingHandles.size > 0; }
  serialize(fn) {
    if (this.closing) fail('Workspace storage is closing; retry after shutdown is cancelled', 'SITE_WORKSPACE_CLOSING');
    this.pendingOperations++;
    const result = this.queue.then(fn).finally(() => { this.pendingOperations--; }); this.queue = result.catch(() => {}); return result;
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = this.queue.then(async () => {
      await this.retryCleanup();
      if (this.hasOwnership) fail('Workspace file cleanup remains pending; retry closing when the filesystem is available', 'SITE_WORKSPACE_CLEANUP');
    }).finally(() => { this.closing = null; });
    return this.closing;
  }
  file(id) { return path.join(this.directory, uuid(id) + '.json'); }
  async ready() {
    await this.io.mkdir(this.directory, { recursive: true });
    const stat = await this.io.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Workspace storage must be a real directory');
    await this.retryCleanup();
  }
  async retryCleanup() {
    for (const handle of this.pendingHandles) { try { await handle.close(); this.pendingHandles.delete(handle); } catch {} }
    for (const [file, owned] of this.cleanup) {
      try {
        if (owned.handle) { owned.stat ||= await owned.handle.stat(); await owned.handle.close(); owned.handle = null; }
        const current = await this.io.lstat(file);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.stat.dev || !current.ino || current.ino !== owned.stat.ino) continue;
        await this.io.unlink(file); this.cleanup.delete(file);
      } catch (error) { if (error.code === 'ENOENT') this.cleanup.delete(file); }
    }
  }
  capacity() { if (this.cleanup.size + this.pendingHandles.size >= LIMITS.workspaces) fail('Workspace cleanup is still pending; retry after the filesystem is available', 'SITE_WORKSPACE_LIMIT'); }
  async closeHandle(handle) { await handle.close(); this.pendingHandles.delete(handle); }
  async entries() {
    this.capacity(); const handle = await this.io.opendir(this.directory, { bufferSize: 32 }); this.pendingHandles.add(handle);
    const names = [];
    try {
      for (;;) { const entry = await handle.read(); if (!entry) break; names.push(entry.name); if (names.length > LIMITS.workspaces * 2) break; }
    } finally { await this.closeHandle(handle); }
    return { names: names.slice(0, LIMITS.workspaces * 2).sort(), limited: names.length > LIMITS.workspaces * 2 };
  }
  async regular(file) {
    const stat = await this.io.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('Workspace must be a regular file');
    if (stat.size > LIMITS.fileBytes) fail('Workspace file exceeds its 1 MiB limit', 'SITE_WORKSPACE_LIMIT');
    return stat;
  }
  async readText(file) {
    const stat = await this.regular(file);
    this.capacity(); const handle = await this.io.open(file, 'r'); this.pendingHandles.add(handle);
    let bytes;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== stat.size || opened.dev !== stat.dev || opened.ino !== stat.ino) fail('Workspace changed while opening', 'SITE_WORKSPACE_CONFLICT');
      const buffer = Buffer.alloc(stat.size + 1); let used = 0;
      while (used < buffer.length) { const part = await handle.read(buffer, used, buffer.length - used, null); if (!part.bytesRead) break; used += part.bytesRead; }
      const after = await handle.stat();
      if (used !== stat.size || after.size !== stat.size || after.mtimeMs !== opened.mtimeMs) fail('Workspace changed while reading', 'SITE_WORKSPACE_CONFLICT');
      bytes = buffer.subarray(0, used);
    } finally { await this.closeHandle(handle); }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('Workspace JSON is not valid UTF-8', 'SITE_WORKSPACE_FORMAT'); }
    return { text, bytes: stat.size };
  }
  async read(id) {
    let result;
    try { result = await this.readText(this.file(id)); }
    catch (error) { if (error.code === 'ENOENT') fail('Saved workspace was not found', 'SITE_WORKSPACE_NOT_FOUND'); throw error; }
    return { value: record(parse(result.text), id), bytes: result.bytes };
  }
  summary(value) { return { id: value.id, revision: value.revision, name: value.name, description: value.description, createdAt: value.createdAt,
    updatedAt: value.updatedAt, sessionCount: value.sessions.length, captureCount: value.captures.length, incidentCount: value.incidentIds.length, panelCount: value.layout.panels.length, preset: value.layout.preset }; }
  list() { return this.serialize(async () => {
    await this.ready(); const workspaces = [], issues = []; let bytes = 0, examined = 0;
    const entries = await this.entries();
    for (const file of entries.names) {
      if (!file.endsWith('.json') || !UUID.test(file.slice(0, -5))) { issues.push({ file, message: 'Unrecognized workspace entry was not loaded.' }); continue; }
      const id = file.slice(0, -5);
      if (++examined > LIMITS.workspaces) { issues.push({ id, message: 'Workspace count limit reached; this entry was not examined.' }); continue; }
      try {
        const stat = await this.regular(this.file(id));
        if (bytes + stat.size > LIMITS.listBytes) { issues.push({ id, message: 'Workspace listing byte limit reached; open this entry individually.' }); continue; }
        bytes += stat.size; workspaces.push(this.summary((await this.read(id)).value));
      } catch (error) { issues.push({ id, message: error.message }); }
    }
    if (entries.limited) issues.push({ message: 'Directory entry limit reached; remaining entries were not examined.' });
    workspaces.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    for (const [file] of this.cleanup) if (path.dirname(file) !== this.directory) issues.push({ file: path.basename(file), message: 'An owned export temporary file could not be removed; cleanup will be retried.' });
    if (this.pendingHandles.size) issues.push({ message: 'A workspace file handle could not be closed; cleanup will be retried.' });
    return { workspaces, issues, capabilities: { toolKinds: [...PASSIVE_TOOLS], layouts: [...LAYOUTS], limits: { ...LIMITS } } };
  }); }
  get(id) { uuid(id); return this.serialize(async () => { await this.ready(); return (await this.read(id)).value; }); }
  async writeAtomic(destination, data, initial) {
    this.capacity();
    const temp = path.join(path.dirname(destination), '.workspace-' + crypto.randomUUID() + '.tmp');
    const owned = { handle: null, stat: null }; let created = false, published = false;
    try {
      owned.handle = await this.io.open(temp, 'wx', 0o600); created = true; this.cleanup.set(temp, owned); owned.stat = await owned.handle.stat();
      await owned.handle.writeFile(data, 'utf8'); await owned.handle.sync(); await owned.handle.close(); owned.handle = null;
      if (initial) await this.io.link(temp, destination); else { await this.regular(destination); await this.io.rename(temp, destination); created = false; this.cleanup.delete(temp); }
      published = true;
    } finally {
      if (owned.handle) { try { owned.stat ||= await owned.handle.stat(); await owned.handle.close(); owned.handle = null; } catch {} }
      if (created && !owned.handle) { try { await this.io.unlink(temp); this.cleanup.delete(temp); } catch {} }
    }
    // Temporary-link cleanup is retried by ready() and listed if it remains.
    // It must not turn an already committed save into a duplicate-save retry.
    return published;
  }
  async publish(value, initial) {
    await this.writeAtomic(this.file(value.id), json(value), initial);
    return structuredClone(value);
  }
  save(input) {
    object(input, RECORD_FIELDS, 'Workspace');
    const data = normalizeData(input), id = input.id === undefined ? null : uuid(input.id), revision = input.revision;
    if (input.schemaVersion !== undefined && input.schemaVersion !== 1 || input.kind !== undefined && input.kind !== KIND) fail('Unsupported workspace schema', 'SITE_WORKSPACE_FORMAT');
    if (id && (!Number.isSafeInteger(revision) || revision < 1)) fail('Reopen the workspace before saving; its revision is required', 'SITE_WORKSPACE_CONFLICT');
    if (!id && revision !== undefined) fail('A new workspace cannot supply an existing revision');
    return this.serialize(() => this.saveOnce(data, id, revision));
  }
  async saveOnce(data, id = null, revision) {
    await this.ready(); let previous = null;
    if (id) {
      previous = (await this.read(id)).value;
      if (previous.revision !== revision) fail('Workspace changed since it was opened. Reopen it before saving.', 'SITE_WORKSPACE_CONFLICT');
      if (revision === Number.MAX_SAFE_INTEGER) fail('Workspace revision limit reached; duplicate this workspace to continue', 'SITE_WORKSPACE_LIMIT');
    }
    else {
      const entries = await this.entries();
      if (entries.limited) fail('Workspace directory has too many entries to validate; resolve its listing issues before saving', 'SITE_WORKSPACE_LIMIT');
      if (entries.names.filter(file => file.endsWith('.json') && UUID.test(file.slice(0, -5))).length >= LIMITS.workspaces) fail('Workspace library has reached its 100-workspace limit', 'SITE_WORKSPACE_LIMIT');
      id = crypto.randomUUID();
    }
    const now = new Date().toISOString(), value = { schemaVersion: 1, kind: KIND, id, revision: (previous?.revision || 0) + 1,
      createdAt: previous?.createdAt || now, updatedAt: now, ...data };
    return this.publish(value, !previous);
  }
  duplicate(id, options = {}) {
    uuid(id); object(options, ['name'], 'Duplicate options');
    const chosenName = options.name === undefined ? null : name(options.name);
    return this.serialize(async () => { await this.ready(); const value = (await this.read(id)).value;
      const data = normalizeData(value); data.name = chosenName || (data.name.slice(0, 249) + ' (copy)'); return this.saveOnce(data); });
  }
  remove(id) { uuid(id); return this.serialize(async () => {
    await this.ready(); await this.read(id); await this.io.unlink(this.file(id)); return { removed: id };
  }); }
  exportJson(id) { uuid(id); return this.serialize(async () => {
    await this.ready(); const value = (await this.read(id)).value;
    return json({ schemaVersion: 1, kind: KIND + '-export', exportedAt: new Date().toISOString(), workspace: normalizeData(value) });
  }); }
  importJson(text) {
    const data = importData(text); return this.serialize(() => this.saveOnce(data));
  }
  importFile(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) fail('Choose an absolute workspace import path');
    return this.serialize(async () => {
      const { text } = await this.readText(file); return this.saveOnce(importData(text));
    });
  }
  exportFile(id, file) {
    uuid(id);
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) fail('Choose an absolute workspace export path');
    const resolved = path.resolve(file), managed = path.resolve(this.directory), fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (fold(resolved) === fold(managed) || fold(resolved).startsWith(fold(managed) + path.sep)) fail('Export outside the managed workspace library');
    return this.serialize(async () => {
      await this.ready(); const value = (await this.read(id)).value, directory = await this.io.lstat(path.dirname(resolved));
      if (!directory.isDirectory() || directory.isSymbolicLink()) fail('Export folder must be a real directory');
      // A regular parent can still be reached through an ancestor junction.
      // Compare resolved directories and keep writing through that checked path.
      const parent = await this.io.realpath(path.dirname(resolved)), library = await this.io.realpath(this.directory);
      const destination = path.join(parent, path.basename(resolved));
      if (fold(destination) === fold(library) || fold(destination).startsWith(fold(library) + path.sep)) fail('Export outside the managed workspace library');
      let initial = false;
      try { await this.regular(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; initial = true; }
      await this.writeAtomic(destination, json({ schemaVersion: 1, kind: KIND + '-export', exportedAt: new Date().toISOString(), workspace: normalizeData(value) }), initial);
      return { path: resolved };
    });
  }
}

module.exports = { SiteWorkspaceStore, LIMITS, MAX_WORKSPACE_BYTES: LIMITS.fileBytes, LAYOUTS, PASSIVE_TOOLS };
