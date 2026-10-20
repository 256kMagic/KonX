// Text utilities for the notepad: encodings, line endings, line operations, case,
// formatters, encoders, extraction and language detection. Pure functions (tested in Node).

// ---------------------------------------------------------------- encodings

export const ENCODINGS = [
  ['utf-8', 'UTF-8'],
  ['utf-8-bom', 'UTF-8 with BOM'],
  ['utf-16le', 'UTF-16 LE (BOM)'],
  ['utf-16be', 'UTF-16 BE (BOM)'],
  ['windows-1252', 'ANSI (Windows-1252)'],
];

// Windows-1252 bytes 0x80-0x9F that differ from Latin-1.
const CP1252 = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178 };
const CP1252_REV = new Map(Object.entries(CP1252).map(([b, u]) => [u, Number(b)]));

function decode1252(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += String.fromCharCode(b >= 0x80 && b <= 0x9f && CP1252[b] ? CP1252[b] : b);
  }
  return s;
}

/** Decode file bytes, detecting BOMs and falling back to ANSI when not valid UTF-8. */
export function decodeBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom', binary: false };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', binary: false };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', binary: false };
  const binary = bytes.subarray(0, 8000).includes(0);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', binary };
  } catch {
    return { text: decode1252(bytes), encoding: 'windows-1252', binary };
  }
}

/** Encode text for saving. Unmappable ANSI characters become "?" (reported in .lossy). */
export function encodeText(text, encoding) {
  switch (encoding) {
    case 'utf-8-bom': {
      const b = new TextEncoder().encode(text);
      const out = new Uint8Array(b.length + 3);
      out.set([0xef, 0xbb, 0xbf]);
      out.set(b, 3);
      return out;
    }
    case 'utf-16le':
    case 'utf-16be': {
      const le = encoding === 'utf-16le';
      const out = new Uint8Array(2 + text.length * 2);
      out.set(le ? [0xff, 0xfe] : [0xfe, 0xff]);
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        out[2 + i * 2] = le ? c & 255 : c >> 8;
        out[3 + i * 2] = le ? c >> 8 : c & 255;
      }
      return out;
    }
    case 'windows-1252': {
      const out = new Uint8Array(text.length);
      let lossy = 0;
      let n = 0;
      for (const ch of text) {
        const c = ch.codePointAt(0);
        if (c < 0x80 || (c >= 0xa0 && c <= 0xff) || (c >= 0x80 && c <= 0x9f && !CP1252[c])) out[n++] = c;
        else if (CP1252_REV.has(c)) out[n++] = CP1252_REV.get(c);
        else {
          out[n++] = 0x3f;
          lossy++;
        }
      }
      const r = out.subarray(0, n);
      r.lossy = lossy;
      return r;
    }
    default:
      return new TextEncoder().encode(text);
  }
}

// ---------------------------------------------------------------- line endings

export function detectEol(text, fallback = 'CRLF') {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length && crlf + lf + cr < 10000; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  if (!crlf && !lf && !cr) return fallback;
  if (crlf >= lf && crlf >= cr) return 'CRLF';
  return lf >= cr ? 'LF' : 'CR';
}

export const EOL_TEXT = { CRLF: '\r\n', LF: '\n', CR: '\r' };

export function convertEol(text, eol) {
  return text.replace(/\r\n|\r|\n/g, EOL_TEXT[eol] || '\n');
}

// ---------------------------------------------------------------- line operations

const splitLines = (t) => t.split(/\r\n|\r|\n/);

export function sortLines(text, { desc = false, ci = true, numeric = true } = {}) {
  const coll = new Intl.Collator(undefined, { numeric, sensitivity: ci ? 'base' : 'variant' });
  const lines = splitLines(text).sort(coll.compare);
  if (desc) lines.reverse();
  return lines.join('\n');
}

export function sortIpLines(text, { desc = false } = {}) {
  const key = (l) => {
    const m = l.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/);
    return m ? m.slice(1).reduce((a, x) => a * 256 + Number(x), 0) : Number.MAX_SAFE_INTEGER;
  };
  const lines = splitLines(text).sort((a, b) => key(a) - key(b) || a.localeCompare(b));
  if (desc) lines.reverse();
  return lines.join('\n');
}

export function uniqueLines(text, { ci = false } = {}) {
  const seen = new Set();
  return splitLines(text)
    .filter((l) => {
      const k = ci ? l.toLowerCase() : l;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join('\n');
}

export const removeEmptyLines = (text, { blankToo = true } = {}) => splitLines(text).filter((l) => (blankToo ? l.trim() : l) !== '').join('\n');
export const trimTrailing = (text) => splitLines(text).map((l) => l.replace(/[ \t]+$/, '')).join('\n');
export const trimLeading = (text) => splitLines(text).map((l) => l.replace(/^[ \t]+/, '')).join('\n');
export const trimBoth = (text) => splitLines(text).map((l) => l.trim()).join('\n');
export const joinLines = (text) => splitLines(text).map((l) => l.trim()).filter(Boolean).join(' ');
export const reverseLines = (text) => splitLines(text).reverse().join('\n');
export const tabsToSpaces = (text, n = 4) => splitLines(text).map((l) => expandTabs(l, n)).join('\n');
export const spacesToTabs = (text, n = 4) => splitLines(text).map((l) => l.replace(/^ +/, (s) => '\t'.repeat(Math.floor(s.length / n)) + ' '.repeat(s.length % n))).join('\n');

function expandTabs(line, n) {
  let out = '';
  for (const ch of line) {
    if (ch === '\t') out += ' '.repeat(n - (out.length % n));
    else out += ch;
  }
  return out;
}

// ---------------------------------------------------------------- case

export const toUpper = (t) => t.toUpperCase();
export const toLower = (t) => t.toLowerCase();
export const toTitle = (t) => t.toLowerCase().replace(/(^|[\s\-_/([{"'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
export const toSentence = (t) => t.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
export const invertCase = (t) => Array.from(t, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');

// ---------------------------------------------------------------- formatters / encoders

export function jsonFormat(text, indent = 2) {
  return JSON.stringify(JSON.parse(text), null, indent);
}

export function jsonMinify(text) {
  return JSON.stringify(JSON.parse(text));
}

/** Pretty-print XML/HTML-like markup without changing text content. */
export function xmlFormat(text, indent = '  ') {
  const VOID = /^<(br|hr|img|input|meta|link|area|base|col|embed|source|wbr)\b/i;
  const tokens = text.replace(/>\s+</g, '><').trim().match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || [];
  const out = [];
  let depth = 0;
  const isOpen = (t) => /^<[^!?/][^>]*>$/.test(t) && !t.endsWith('/>') && !VOID.test(t);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const pad = indent.repeat(depth);
    if (isOpen(t)) {
      const next = tokens[i + 1];
      const after = tokens[i + 2];
      if (next && next.startsWith('</')) {
        out.push(pad + t + next); // <a></a>
        i += 1;
      } else if (next && !next.startsWith('<') && after && after.startsWith('</')) {
        out.push(pad + t + next.trim() + after); // <a>text</a>
        i += 2;
      } else {
        out.push(pad + t);
        depth++;
      }
    } else if (t.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      out.push(indent.repeat(depth) + t);
    } else out.push(pad + t.trim());
  }
  return out.join('\n');
}
export function base64Encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64Decode(text) {
  const clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('Not valid Base64');
  const bin = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export const urlEncode = (t) => encodeURIComponent(t);
export function urlDecode(t) {
  try {
    return decodeURIComponent(t.replace(/\+/g, ' '));
  } catch {
    throw new Error('Not valid URL encoding');
  }
}
export const hexEncode = (t) => Array.from(new TextEncoder().encode(t), (b) => b.toString(16).padStart(2, '0')).join(' ');
export function hexDecode(t) {
  const clean = t.replace(/0x/gi, '').replace(/[\s:,-]/g, '');
  if (!/^([0-9a-f]{2})*$/i.test(clean)) throw new Error('Not valid hex');
  return new TextDecoder().decode(Uint8Array.from(clean.match(/../g) || [], (h) => parseInt(h, 16)));
}

// ---------------------------------------------------------------- extraction / network helpers

const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const MAC_RE = /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b|\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b/gi;

export function extractIPv4(text, { unique = true, sort = true } = {}) {
  let ips = text.match(IPV4_RE) || [];
  if (unique) ips = [...new Set(ips)];
  if (sort) ips.sort((a, b) => a.split('.').reduce((x, o) => x * 256 + +o, 0) - b.split('.').reduce((x, o) => x * 256 + +o, 0));
  return ips;
}

export function extractMacs(text) {
  return [...new Set((text.match(MAC_RE) || []).map((m) => m.toLowerCase()))];
}

/** Remove passwords, secrets, keys and SNMP communities from a network device config. */
export function sanitizeConfig(text) {
  let count = 0;
  const rules = [
    // enable secret 9 $9$..., username x privilege 15 secret 0 pass, password 7 0822...
    /^(\s*(?:enable\s+(?:secret|password)|username\s+\S+(?:\s+privilege\s+\d+)?\s+(?:secret|password)|password|secret)(?:\s+\d{1,2})?\s+)(\S+)/gim,
    /^(\s*snmp-server\s+community\s+)(\S+)/gim,
    /^(\s*(?:tacacs-server|radius-server)\s+(?:host\s+\S+\s+)?key(?:\s+\d{1,2})?\s+)(\S+)/gim,
    /^(\s*key(?:-string)?(?:\s+\d{1,2})?\s+)(\S+)/gim,
    /^(\s*(?:pre-shared-key|crypto isakmp key)(?:\s+\d{1,2})?\s+)(\S+)/gim,
    /^(\s*(?:wpa-psk|psk|authentication-key|message-digest-key\s+\d+\s+md5)(?:\s+ascii)?(?:\s+\d{1,2})?\s+)(\S+)/gim,
    /^(\s*set\s+system\s+root-authentication\s+encrypted-password\s+)(\S+)/gim,
    /^(\s*(?:encrypted-password|secret|pre-shared-key\s+ascii-text)\s+)("?[^";\s]+"?)/gim,
  ];
  for (const re of rules) {
    text = text.replace(re, (_, keep) => {
      count++;
      return keep + '<removed>';
    });
  }
  return { text, count };
}

export function stats(text) {
  const lines = text ? splitLines(text).length : 0;
  const words = (text.match(/\S+/g) || []).length;
  return { lines, words, chars: text.length, charsNoSpaces: text.replace(/\s/g, '').length, bytes: new TextEncoder().encode(text).length };
}

// ---------------------------------------------------------------- language detection

const EXT_LANG = {
  json: 'json', jsonc: 'json', xml: 'xml', xsd: 'xml', svg: 'xml', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', py: 'python', ps1: 'powershell', psm1: 'powershell',
  sh: 'shell', bash: 'shell', zsh: 'shell', bat: 'bat', cmd: 'bat', ini: 'ini', cfg: 'ios', conf: 'ini', yml: 'yaml', yaml: 'yaml',
  md: 'markdown', sql: 'sql', cs: 'csharp', c: 'cpp', h: 'cpp', cpp: 'cpp', java: 'java', go: 'go', rs: 'rust', php: 'php', rb: 'ruby',
  pl: 'perl', lua: 'lua', tf: 'hcl', hcl: 'hcl', dockerfile: 'dockerfile', log: 'log', ios: 'ios', toml: 'ini', properties: 'ini',
  csv: 'plaintext', txt: 'plaintext', j2: 'plaintext', jinja: 'plaintext', vbs: 'vb', r: 'r', swift: 'swift', kt: 'kotlin',
};

/** Looks like a Cisco IOS / IOS-XE / NX-OS / ASA style configuration. */
export function looksLikeIos(text) {
  const head = text.slice(0, 20000);
  let score = 0;
  if (/^(Building configuration|Current configuration|!Command:|: Saved)/m.test(head)) score += 3;
  if (/^hostname \S+/m.test(head)) score += 2;
  if (/^interface (Gigabit|TenGig|FastEth|Ethernet|Vlan|Loopback|Port-channel|mgmt|Tunnel|Serial|Gi|Te|Eth)/im.test(head)) score += 3;
  score += Math.min(3, (head.match(/^!\s*$/gm) || []).length / 3);
  if (/^\s+(switchport|ip address|no shutdown|shutdown|description)\b/m.test(head)) score += 2;
  return score >= 4;
}

export function looksLikeLog(text) {
  const lines = text.slice(0, 20000).split(/\r?\n/).slice(0, 50).filter(Boolean);
  if (lines.length < 3) return false;
  const ts = /^(\d{4}-\d\d-\d\d[ T]\d\d:\d\d|\w{3}\s+\d{1,2} \d\d:\d\d:\d\d|\*?\w{3}\s+\d{1,2} \d{4} \d\d:\d\d|<\d+>|\[\d{4}-\d\d-\d\d|\d\d:\d\d:\d\d[.,]\d+)/;
  return lines.filter((l) => ts.test(l) || /%[A-Z0-9_]+-\d-[A-Z0-9_]+:/.test(l)).length / lines.length > 0.5;
}

export function detectLanguage(name, text) {
  const base = String(name || '').toLowerCase().split(/[\\/]/).pop();
  if (base === 'dockerfile') return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  const byExt = EXT_LANG[ext];
  if (byExt && byExt !== 'plaintext' && byExt !== 'ini' && byExt !== 'ios') return byExt;
  const sample = String(text || '');
  if (looksLikeIos(sample)) return 'ios';
  if (byExt === 'ios') return 'ios';
  if (looksLikeLog(sample)) return 'log';
  if (byExt && byExt !== 'plaintext') return byExt;
  const t = sample.trimStart();
  if (/^[{[]/.test(t)) {
    try {
      JSON.parse(sample);
      return 'json';
    } catch {}
  }
  if (/^<!doctype html|^<html[\s>]/i.test(t)) return 'html';
  if (/^<\?xml|^<[a-zA-Z][\w:-]*[\s>]/.test(t)) return 'xml';
  if (/^#!.*\b(bash|sh|zsh)\b/.test(t)) return 'shell';
  if (/^#!.*\bpython/.test(t)) return 'python';
  return byExt || 'plaintext';
}
