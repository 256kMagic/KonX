'use strict';
// "Run as administrator" for the capture helper: ShellExecuteExW with the "runas" verb shows
// Windows' UAC prompt. Called asynchronously so the app keeps running while the prompt is up.
const SEE_MASK_NOASYNC = 0x00000100;
const SEE_MASK_FLAG_NO_UI = 0x00000400;
const SE_ERR_FNF = 2;
const SE_ERR_PNF = 3;
const SE_ERR_ACCESSDENIED = 5;

let api = null;

function load() {
  if (api) return api;
  const koffi = require('koffi');
  const shell32 = koffi.load('shell32.dll');
  const SHELLEXECUTEINFOW = koffi.struct('KONX_SHELLEXECUTEINFOW', {
    cbSize: 'uint32_t',
    fMask: 'uint32_t',
    hwnd: 'intptr_t',
    lpVerb: 'str16',
    lpFile: 'str16',
    lpParameters: 'str16',
    lpDirectory: 'str16',
    nShow: 'int32_t',
    hInstApp: 'intptr_t',
    lpIDList: 'void *',
    lpClass: 'str16',
    hkeyClass: 'intptr_t',
    dwHotKey: 'uint32_t',
    hIconOrMonitor: 'intptr_t',
    hProcess: 'intptr_t',
  });
  api = {
    koffi,
    SHELLEXECUTEINFOW,
    ShellExecuteExW: shell32.func('bool __stdcall ShellExecuteExW(_Inout_ KONX_SHELLEXECUTEINFOW *info)'),
    IsUserAnAdmin: shell32.func('bool __stdcall IsUserAnAdmin()'),
  };
  if (koffi.sizeof(SHELLEXECUTEINFOW) !== 112) throw new Error('SHELLEXECUTEINFOW layout mismatch');
  return api;
}

/** Quote one argument the way CommandLineToArgvW reads it back. */
function quoteArg(a) {
  a = String(a);
  if (a && !/[\s"]/.test(a)) return a;
  let out = '"';
  let slashes = 0;
  for (const ch of a) {
    if (ch === '\\') slashes++;
    else if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
    } else {
      out += '\\'.repeat(slashes) + ch;
      slashes = 0;
    }
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

/** True when this process already has administrator rights (no prompt needed). */
function isElevated() {
  try {
    return process.platform === 'win32' && load().IsUserAnAdmin();
  } catch {
    return false;
  }
}

/**
 * Start file with args. verb 'runas' asks Windows for administrator rights first.
 * Resolves once the process has started; rejects with code 'CANCELLED' if the prompt was declined.
 */
function shellExecute(file, args, { verb = 'runas', hwnd = 0 } = {}) {
  const a = load();
  const info = {
    cbSize: a.koffi.sizeof(a.SHELLEXECUTEINFOW),
    // No error dialogs for plain launches; "runas" keeps the default so the UAC prompt shows.
    fMask: SEE_MASK_NOASYNC | (verb === 'runas' ? 0 : SEE_MASK_FLAG_NO_UI),
    hwnd,
    lpVerb: verb,
    lpFile: file,
    lpParameters: args.map(quoteArg).join(' '),
    lpDirectory: null,
    nShow: 0, // SW_HIDE: the helper has no window
    hInstApp: 0,
    lpIDList: null,
    lpClass: null,
    hkeyClass: 0,
    dwHotKey: 0,
    hIconOrMonitor: 0,
    hProcess: 0,
  };
  return new Promise((resolve, reject) => {
    a.ShellExecuteExW.async(info, (err, ok) => {
      if (err) return reject(err);
      if (ok) return resolve();
      const code = Number(info.hInstApp);
      if (code === SE_ERR_FNF || code === SE_ERR_PNF) return reject(new Error(`Could not find ${file}`));
      if (verb === 'runas' && (code === SE_ERR_ACCESSDENIED || code === 0)) {
        return reject(Object.assign(new Error('Administrator permission was not granted, so the capture did not start.'), { code: 'CANCELLED' }));
      }
      reject(new Error(`Windows could not start the capture helper (error ${code})`));
    });
  });
}

module.exports = { shellExecute, isElevated, quoteArg };
