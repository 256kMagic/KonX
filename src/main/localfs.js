'use strict';
// Local file system pane for the SFTP browser.
const fs = require('fs');
const path = require('path');
const os = require('os');

/** "" lists the drives on Windows (the "This PC" view). */
async function list(dir) {
  if (process.platform === 'win32' && (!dir || dir === 'This PC')) {
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const root = String.fromCharCode(c) + ':\\';
      try {
        await fs.promises.access(root);
        drives.push({ name: root, type: 'd', isDir: true, size: 0, mtime: 0, perms: '', drive: true });
      } catch {}
    }
    return drives;
  }
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const out = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name);
      let st = null;
      try {
        st = await fs.promises.stat(full);
      } catch {}
      const isDir = st ? st.isDirectory() : e.isDirectory();
      return {
        name: e.name,
        type: e.isSymbolicLink() ? 'l' : isDir ? 'd' : 'f',
        isDir,
        size: st && !isDir ? st.size : 0,
        mtime: st ? st.mtimeMs : 0,
        hidden: e.name.startsWith('.') || (process.platform === 'win32' && /^(desktop\.ini|thumbs\.db|ntuser\.)/i.test(e.name)),
      };
    })
  );
  return out;
}

function parent(dir) {
  if (process.platform === 'win32' && /^[A-Za-z]:\\?$/.test(dir)) return 'This PC';
  const up = path.dirname(dir);
  return up === dir ? dir : up;
}

module.exports = {
  list,
  parent,
  join: (...a) => path.join(...a),
  home: () => os.homedir(),
  mkdir: (d) => fs.promises.mkdir(d, { recursive: false }),
  rename: (a, b) => fs.promises.rename(a, b),
  exists: async (p) => {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  },
};
