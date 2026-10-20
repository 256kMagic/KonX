'use strict';

const path = require('node:path');
const { isUint8Array } = require('node:util').types;

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const truncateName = (name, length) => name.slice(0, length).replace(/[\ud800-\udbff]$/, '');

/** Captured filenames are suggestions only; the native dialog owns the destination. */
function bodyFilename(value) {
  if (typeof value !== 'string') return 'recovered-body.bin';
  let name = path.win32.basename(value).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[ .]+$/, '');
  if (!name || name === '.' || name === '..') return 'recovered-body.bin';
  // Win32 treats these names as devices even when an extension is present.
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(name)) name = '_' + name;
  if (name.length > 180) {
    const sourceExtension = path.win32.extname(name);
    const ext = truncateName(sourceExtension, 20);
    name = truncateName(name.slice(0, name.length - sourceExtension.length), 160) + ext;
  }
  return name.replace(/[ .]+$/, '') || 'recovered-body.bin';
}

async function saveCaptureBody(defaultName, bytes, { chooseFile, writeFile }) {
  if (!isUint8Array(bytes)) throw new TypeError('Recovered body must be a Uint8Array.');
  if (bytes.byteLength > MAX_BODY_BYTES) throw new RangeError('Recovered body exceeds the 16 MiB export limit.');
  // The save dialog is asynchronous. Keep the exact bytes selected for export,
  // even if the caller replaces or changes its preview while the dialog is open.
  const snapshot = Buffer.from(bytes);
  const result = await chooseFile({
    title: 'Save recovered HTTP body',
    defaultPath: bodyFilename(defaultName),
    filters: [{ name: 'All files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return null;
  await writeFile(result.filePath, snapshot);
  return result.filePath;
}

const MAX_SIP_EXPORT_BYTES = 64 * 1024 * 1024;

async function saveSipExport(format, bytes, { chooseFile, writeFile }) {
  if (!['pcapng', 'json'].includes(format)) throw new TypeError('Unsupported SIP export format.');
  if (!isUint8Array(bytes)) throw new TypeError('SIP export must be a Uint8Array.');
  if (!bytes.byteLength || bytes.byteLength > MAX_SIP_EXPORT_BYTES) throw new RangeError('SIP export must contain between 1 byte and 64 MiB.');
  const snapshot = Buffer.from(bytes);
  const result = await chooseFile({
    title: format === 'pcapng' ? 'Export SIP signaling packets' : 'Export SIP call report',
    defaultPath: `sip-call.${format}`,
    filters: [{ name: format === 'pcapng' ? 'PCAPNG capture' : 'JSON report', extensions: [format] }],
  });
  if (result.canceled || !result.filePath) return null;
  await writeFile(result.filePath, snapshot);
  return result.filePath;
}

module.exports = { MAX_BODY_BYTES, bodyFilename, saveCaptureBody, MAX_SIP_EXPORT_BYTES, saveSipExport };
