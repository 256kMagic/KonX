'use strict';
const path = require('node:path');

// An atomic rename may be temporarily denied by Windows sharing rules. The
// caller owns both the pending file and the exact target revision being replaced.
// Retry that replacement only; never reinterpret a new path occupant as ours.
const sameFile = (a, b) => !!a && !!b && a.ino !== 0n && b.ino !== 0n && a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const conflict = () => Object.assign(new Error('File changed during atomic replacement; reopen the saved record before retrying.'), { code: 'ATOMIC_CONFLICT' });

let windowsMove;
function moveNewWindowsFile(temporary, target) {
  if (!windowsMove) {
    const library = require('koffi').load('kernel32.dll');
    windowsMove = { library, move: library.func('int __stdcall MoveFileExW(str16 existing, str16 destination, uint32_t flags)'), error: library.func('uint32_t __stdcall GetLastError()') };
  }
  // Same-directory metadata move only: no replace, copy or reboot flags.
  // https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw
  // The already-flushed file is published intact; this is not a promise of
  // directory durability after power loss. Koffi preserves synchronous LastError.
  if (windowsMove.move(path.toNamespacedPath(temporary), path.toNamespacedPath(target), 0)) return;
  const win32Code = windowsMove.error();
  const code = ({ 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 17: 'EXDEV', 32: 'EBUSY', 33: 'EBUSY', 80: 'EEXIST', 183: 'EEXIST' })[win32Code] || 'EIO';
  throw Object.assign(new Error(`Exclusive file publication failed (Windows ${win32Code}).`), { code, win32Code, syscall: 'MoveFileExW' });
}

async function publishNewFile(io, temporary, target, sourceVersion, { platform = process.platform, moveNoReplace = moveNewWindowsFile } = {}) {
  if (typeof temporary !== 'string' || typeof target !== 'string' || !path.isAbsolute(temporary) || !path.isAbsolute(target)
      || temporary.includes('\0') || target.includes('\0') || path.dirname(temporary) !== path.dirname(target) || path.resolve(temporary) === path.resolve(target)) throw conflict();
  for (let attempt = 0; ; attempt++) {
    let source;
    try { source = await io.lstat(temporary, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') throw conflict(); throw error; }
    if (!sameVersion(sourceVersion, source)) throw conflict();
    try {
      if (platform === 'win32') { await moveNoReplace(temporary, target); return true; }
      await io.link(temporary, target); return false;
    } catch (error) {
      // Removing a new hardlink's temporary alias made the next Windows
      // replacement intermittently fail even with every owned handle closed.
      // No fallback may copy a partial record or overwrite an existing target.
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

async function replaceOwnedFile(io, temporary, target, sourceVersion, targetVersion) {
  for (let attempt = 0; ; attempt++) {
    let source, destination;
    try { source = await io.lstat(temporary, { bigint: true }); destination = await io.lstat(target, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') throw conflict(); throw error; }
    if (!sameVersion(sourceVersion, source) || !sameVersion(targetVersion, destination)) throw conflict();
    try { await io.rename(temporary, target); return; }
    catch (error) {
      // At most six attempts / 775 ms total backoff. ENOSPC, ENOENT and other
      // permanent failures remain immediate; a changed identity never retries.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}
module.exports = { sameFile, sameVersion, replaceOwnedFile, publishNewFile };
