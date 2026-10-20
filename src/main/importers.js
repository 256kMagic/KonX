'use strict';
// Import sessions from SecureCRT session folders and OpenSSH config files.
const fs = require('fs');
const path = require('path');
const os = require('os');

function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

function defaultSecureCrtDir() {
  const base = process.platform === 'win32' ? process.env.APPDATA || '' : path.join(os.homedir(), 'Library/Application Support');
  return path.join(base, 'VanDyke', 'Config', 'Sessions');
}

/** Parse one SecureCRT session .ini into a session object (or null if not a session). */
function parseSecureCrtIni(text) {
  const kv = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([SDB]):"([^"]+)"=(.*)$/);
    if (!m) continue;
    const [, kind, key, raw] = m;
    kv[key] = kind === 'D' ? parseInt(raw, 16) : raw;
  }
  const proto = String(kv['Protocol Name'] || '').toLowerCase();
  const s = { name: '', host: kv['Hostname'] || '', username: kv['Username'] || '' };
  if (proto.startsWith('ssh')) {
    s.protocol = 'ssh';
    s.port = kv['[SSH2] Port'] || kv['Port'] || 22;
  } else if (proto === 'telnet') {
    s.protocol = 'telnet';
    s.port = kv['Port'] || 23;
  } else if (proto === 'raw') {
    s.protocol = 'raw';
    s.port = kv['Port'] || 23;
  } else if (proto === 'serial') {
    s.protocol = 'serial';
    s.serialPort = kv['Com Port'] || 'COM1';
    s.baudRate = kv['Baud Rate'] || 9600;
    s.dataBits = kv['Data Bits'] || 8;
    s.parity = ['none', 'odd', 'even', 'mark', 'space'][kv['Parity'] || 0] || 'none';
    s.stopBits = kv['Stop Bits'] === 2 ? 2 : 1;
  } else {
    return null;
  }
  if (s.protocol !== 'serial' && !s.host) return null;
  const keyFile = kv['Identity Filename V2'] || kv['Identity Filename'];
  if (keyFile && s.protocol === 'ssh' && kv['Use Global Public Key'] === 0) {
    s.auth = 'key';
    s.keyPath = keyFile.replace(/::raw.*$/, '');
  } else {
    s.auth = 'password';
  }
  return s;
}

function importSecureCrt(root) {
  const out = [];
  const walk = (dir, folder) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, folder ? `${folder}/${e.name}` : e.name);
      } else if (/\.ini$/i.test(e.name) && !/^(__FolderData__|Default)\.ini$/i.test(e.name)) {
        try {
          const s = parseSecureCrtIni(readText(full));
          if (s) out.push({ ...s, name: e.name.replace(/\.ini$/i, ''), folder: folder ? `SecureCRT/${folder}` : 'SecureCRT' });
        } catch {}
      }
    }
  };
  walk(root, '');
  return out;
}

/** Parse ~/.ssh/config Host blocks (wildcard-only hosts are skipped). */
function importSshConfig(file) {
  const text = readText(file);
  const out = [];
  let cur = null;
  const jumpNames = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s*=?\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      cur = null;
      for (const alias of val.split(/\s+/)) {
        if (/[*?!]/.test(alias)) continue;
        cur = { name: alias, host: alias, protocol: 'ssh', port: 22, auth: 'password', folder: 'SSH config' };
        out.push(cur);
        break;
      }
    } else if (cur) {
      if (key === 'hostname') cur.host = val;
      else if (key === 'user') cur.username = val;
      else if (key === 'port') cur.port = Number(val) || 22;
      else if (key === 'identityfile') {
        cur.auth = 'key';
        cur.keyPath = val.replace(/^~/, os.homedir());
      } else if (key === 'proxyjump') jumpNames.push([cur, val.split(',')[0]]);
    }
  }
  for (const [s, j] of jumpNames) s.jumpName = j.replace(/^.*@/, '').replace(/:\d+$/, '');
  return out;
}

module.exports = { importSecureCrt, importSshConfig, defaultSecureCrtDir, parseSecureCrtIni };
