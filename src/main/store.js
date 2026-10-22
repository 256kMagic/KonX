'use strict';
// Persistent JSON stores: settings, sessions (with encrypted secrets) and known host keys.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class JsonFile {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return { ...structuredClone(this.defaults), ...JSON.parse(raw) };
    } catch {
      return structuredClone(this.defaults);
    }
  }

  save(data = this.data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
    this.data = data;
  }
}

const DEFAULT_SETTINGS = {
  uiTheme: 'dark',
  uiLayout: 'classic',
  themeAnimations: true,
  fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
  fontSize: 14,
  colorScheme: 'app',
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: true,
  rightClick: 'menu', // 'menu' | 'paste'
  confirmMultilinePaste: true,
  logDir: '',
  sftpShowHidden: false,
  sftpConflict: 'ask', // 'ask' | 'overwrite' | 'skip' | 'newer'
  sftpConcurrency: 2,
  sidebarWidth: 260,
  buttons: [
    { label: 'term len 0', send: 'terminal length 0\\r' },
    { label: 'show run', send: 'show running-config\\r' },
    { label: 'show ip int brief', send: 'show ip interface brief\\r' },
    { label: 'uptime', send: 'uptime\\r' },
  ],
  recentTools: [],
};

const DEFAULT_SESSIONS = { version: 1, folders: [], sessions: [] };

// Fields that never leave the main process in plaintext.
const SECRET_FIELDS = ['password', 'passphrase'];

class Store {
  /**
   * @param {string} dir  directory for the JSON files
   * @param {{encrypt:(s:string)=>string, decrypt:(s:string)=>string, available:()=>boolean}} crypt
   */
  constructor(dir, crypt) {
    this.dir = dir;
    this.crypt = crypt;
    this.settings = new JsonFile(path.join(dir, 'settings.json'), DEFAULT_SETTINGS);
    this.sessions = new JsonFile(path.join(dir, 'sessions.json'), DEFAULT_SESSIONS);
    this.hosts = new JsonFile(path.join(dir, 'known_hosts.json'), {});
  }

  // ---- settings ----
  getSettings() {
    return this.settings.data;
  }

  setSettings(patch) {
    Object.assign(this.settings.data, patch);
    this.settings.save();
    return this.settings.data;
  }

  // ---- sessions ----
  /** Sessions as the renderer sees them: secrets replaced by has* flags. */
  listSessions() {
    const { folders, sessions } = this.sessions.data;
    return {
      folders: [...folders],
      sessions: sessions.map((s) => this._public(s)),
    };
  }

  _public(s) {
    const out = { ...s };
    for (const f of SECRET_FIELDS) {
      out['has' + f[0].toUpperCase() + f.slice(1)] = !!s[f + 'Enc'];
      delete out[f];
      delete out[f + 'Enc'];
    }
    return out;
  }

  /** Full session including decrypted secrets, for use in the main process only. */
  getSessionSecret(id) {
    const s = this.sessions.data.sessions.find((x) => x.id === id);
    if (!s) return null;
    const out = { ...s };
    for (const f of SECRET_FIELDS) {
      if (s[f + 'Enc']) {
        try {
          out[f] = this.crypt.decrypt(s[f + 'Enc']);
        } catch {
          out[f] = '';
        }
      }
      delete out[f + 'Enc'];
    }
    return out;
  }

  /**
   * Insert or update a session. A nonempty secret string replaces its encrypted value;
   * null clears it, while undefined or an empty string keeps whatever was stored.
   * Publish the new session and folders only after encryption and persistence succeed.
   */
  saveSession(input) {
    const list = this.sessions.data.sessions;
    const id = input.id || crypto.randomUUID();
    const prev = list.find((x) => x.id === id) || {};
    const next = { ...prev, ...input, id };
    for (const f of SECRET_FIELDS) {
      if (input[f] != null && typeof input[f] !== 'string') throw new Error(`The session ${f} must be text, blank to keep, or null to remove.`);
    }
    if (SECRET_FIELDS.some((f) => typeof input[f] === 'string' && input[f] !== '')) {
      let available = false;
      try { available = this.crypt.available(); } catch { /* Report a credential-safe error below. */ }
      if (!available) throw new Error('Secure credential encryption is unavailable. The session was not saved.');
    }
    for (const f of SECRET_FIELDS) {
      delete next['has' + f[0].toUpperCase() + f.slice(1)];
      // Ciphertext and presence flags belong to this store, never to caller input.
      delete next[f + 'Enc'];
      if (Object.hasOwn(prev, f + 'Enc')) next[f + 'Enc'] = prev[f + 'Enc'];
      if (typeof input[f] === 'string' && input[f] !== '') {
        try {
          const encrypted = this.crypt.encrypt(input[f]);
          if (typeof encrypted !== 'string' || encrypted === '') throw new Error('Invalid encrypted credential.');
          next[f + 'Enc'] = encrypted;
        } catch {
          throw new Error(`Could not encrypt the session ${f}. The session was not saved.`);
        }
      } else if (input[f] === null) {
        delete next[f + 'Enc'];
      }
      delete next[f];
    }
    const data = { ...this.sessions.data, folders: [...this.sessions.data.folders], sessions: [...list] };
    if (next.folder) this._ensureFolder(next.folder, data);
    const idx = list.findIndex((x) => x.id === id);
    if (idx >= 0) data.sessions[idx] = next;
    else data.sessions.push(next);
    this.sessions.save(data);
    return this._public(next);
  }

  deleteSession(id) {
    const d = this.sessions.data;
    d.sessions = d.sessions.filter((s) => s.id !== id);
    this.sessions.save();
  }

  _ensureFolder(folder, data = this.sessions.data) {
    const parts = folder.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      if (!data.folders.includes(p)) data.folders.push(p);
    }
  }

  addFolder(folder) {
    this._ensureFolder(folder);
    this.sessions.save();
  }

  /** Rename a folder (and everything below it). */
  renameFolder(from, to) {
    const d = this.sessions.data;
    const remap = (p) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
    d.folders = [...new Set(d.folders.map(remap))];
    for (const s of d.sessions) if (s.folder) s.folder = remap(s.folder);
    this._ensureFolder(to);
    this.sessions.save();
  }

  /** Delete a folder; its sessions move to the parent folder. */
  deleteFolder(folder) {
    const d = this.sessions.data;
    const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
    const inside = (p) => p === folder || p.startsWith(folder + '/');
    d.folders = d.folders.filter((p) => !inside(p));
    for (const s of d.sessions) if (s.folder && inside(s.folder)) s.folder = parent;
    this.sessions.save();
  }

  importSessions(items) {
    let n = 0;
    for (const it of items) {
      this.saveSession({ ...it, id: undefined });
      n++;
    }
    return n;
  }

  // ---- known hosts ----
  hostKeyFor(host, port) {
    return this.hosts.data[`[${host}]:${port}`] || null;
  }

  saveHostKey(host, port, rec) {
    this.hosts.data[`[${host}]:${port}`] = { ...rec, added: new Date().toISOString() };
    this.hosts.save();
  }

  listHostKeys() {
    return Object.entries(this.hosts.data).map(([k, v]) => ({ host: k, ...v }));
  }

  deleteHostKey(key) {
    delete this.hosts.data[key];
    this.hosts.save();
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
