'use strict';

// An atomic rename may be temporarily denied by Windows sharing rules. The
// caller owns both the pending file and the exact target revision being replaced.
// Retry that replacement only; never reinterpret a new path occupant as ours.
const sameFile = (a, b) => !!a && !!b && a.ino !== 0n && b.ino !== 0n && a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const conflict = () => Object.assign(new Error('File changed during atomic replacement; reopen the saved record before retrying.'), { code: 'ATOMIC_CONFLICT' });

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
module.exports = { sameFile, sameVersion, replaceOwnedFile };
