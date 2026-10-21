'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 128 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024;

function utf8Prefix(text, limit) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) return bytes;
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

function describe(error) {
  try {
    if (typeof error?.stack === 'string') return error.stack.slice(0, MAX_ENTRY_BYTES);
    if (typeof error === 'string') return error.slice(0, MAX_ENTRY_BYTES);
    if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, MAX_ENTRY_BYTES);
    if (typeof error?.message === 'string') return `Non-Error thrown: ${error.message}`.slice(0, MAX_ENTRY_BYTES);
    if (error === null || ['number', 'boolean', 'undefined', 'bigint', 'symbol'].includes(typeof error)) return `Non-Error thrown: ${String(error)}`;
    return `Non-Error thrown (${error === null ? 'null' : typeof error})`;
  } catch { return 'Thrown value could not be formatted'; }
}

/** Observe fatal JavaScript errors without replacing Electron's error handling. */
function installDiagnostics({ process: target = process, logDir, writeStderr = (text) => fs.writeSync(2, text), now = () => new Date(), version = require('../../package.json').version } = {}) {
  const filePath = path.join(logDir, 'javascript-errors.log');
  const previousPath = path.join(logDir, 'javascript-errors.previous.log');
  const seen = new WeakSet();
  let recording = false;
  const record = (error, origin = 'uncaughtException') => {
    if (recording) return;
    if (error && typeof error === 'object' && seen.has(error)) return;
    recording = true;
    try {
      const runtime = String(target.versions?.electron || 'unavailable').slice(0, 100);
      const heading = `[${now().toISOString()}] KonX ${String(version).slice(0, 100)} | Electron ${runtime} | ${String(origin).slice(0, 100)}\n`;
      const text = heading + describe(error) + '\n\n';
      const full = Buffer.from(text, 'utf8');
      const marker = Buffer.from('\n[Entry truncated]\n\n');
      const entry = full.length <= MAX_ENTRY_BYTES ? full : Buffer.concat([utf8Prefix(text, MAX_ENTRY_BYTES - marker.length), marker]);
      fs.mkdirSync(logDir, { recursive: true });
      let size = 0;
      try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid diagnostics log');
        size = stat.size;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size + entry.length > MAX_LOG_BYTES) {
        try { fs.unlinkSync(previousPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        fs.renameSync(filePath, previousPath);
      }
      fs.appendFileSync(filePath, entry, { mode: 0o600 });
      if (error && typeof error === 'object') seen.add(error);
    } catch {
      // Avoid async stderr stream errors while already reporting a fatal error.
      try { writeStderr('KonX could not save its JavaScript error log.\n'); } catch { /* Preserve the original error. */ }
    } finally { recording = false; }
  };
  const onWarning = (warning) => {
    // Electron can report unhandled rejections as warnings instead of fatal
    // exceptions. Observe that existing path without changing rejection policy.
    if (warning?.name === 'UnhandledPromiseRejectionWarning') record(warning, 'unhandledRejectionWarning');
  };
  target.on('uncaughtExceptionMonitor', record);
  target.on('warning', onWarning);
  return { filePath, record, dispose: () => {
    target.removeListener('uncaughtExceptionMonitor', record);
    target.removeListener('warning', onWarning);
  } };
}

module.exports = { installDiagnostics, MAX_LOG_BYTES, MAX_ENTRY_BYTES };
