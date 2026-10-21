'use strict';

// Mist credentials and authenticated transport stay in the main process.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { checkCancelled, onCancel } = require('./security/common');

const REGIONS = Object.freeze([
  { id: 'global01', label: 'Global 01', origin: 'https://api.mist.com' },
  { id: 'global02', label: 'Global 02', origin: 'https://api.gc1.mist.com' },
  { id: 'global03', label: 'Global 03', origin: 'https://api.ac2.mist.com' },
  { id: 'global04', label: 'Global 04', origin: 'https://api.gc2.mist.com' },
  { id: 'global05', label: 'Global 05', origin: 'https://api.gc4.mist.com' },
  { id: 'emea01', label: 'EMEA 01', origin: 'https://api.eu.mist.com' },
  { id: 'emea02', label: 'EMEA 02', origin: 'https://api.gc3.mist.com' },
  { id: 'emea03', label: 'EMEA 03', origin: 'https://api.ac6.mist.com' },
  { id: 'emea04', label: 'EMEA 04', origin: 'https://api.gc6.mist.com' },
  { id: 'apac01', label: 'APAC 01', origin: 'https://api.ac5.mist.com' },
  { id: 'apac02', label: 'APAC 02', origin: 'https://api.gc5.mist.com' },
  { id: 'apac03', label: 'APAC 03', origin: 'https://api.gc7.mist.com' },
].map(Object.freeze));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 2 * 1024 * 1024;
const PAGE_LIMIT = 200;
const TIMEOUT_MS = 20000;
const text = (value, max = 256) => typeof value === 'string' ? value.slice(0, max) : '';
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label} must be a valid UUID`);
  return value.toLowerCase();
}

function mac(value) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}:){5}[0-9a-f]{2}|(?:[0-9a-f]{2}-){5}[0-9a-f]{2})$/i.test(value)) {
    throw new Error('Device MAC must contain 12 hexadecimal digits');
  }
  return value.replace(/[:-]/g, '').toLowerCase();
}

function requestPath(action, params) {
  if (!record(params)) throw new Error('Invalid Mist request parameters');
  switch (action) {
    case 'self': return '/api/v1/self';
    case 'sites': return `/api/v1/orgs/${uuid(params.orgId, 'Organization ID')}/sites?limit=${PAGE_LIMIT}&page=1`;
    case 'aps': return `/api/v1/sites/${uuid(params.siteId, 'Site ID')}/stats/devices?type=ap&limit=${PAGE_LIMIT}&page=1`;
    case 'clients': return `/api/v1/sites/${uuid(params.siteId, 'Site ID')}/stats/clients?limit=${PAGE_LIMIT}&wired=false`;
    case 'marvis': {
      const orgId = uuid(params.orgId, 'Organization ID');
      const query = new URLSearchParams();
      if (params.siteId) query.set('site_id', uuid(params.siteId, 'Site ID'));
      if (params.mac) query.set('mac', mac(params.mac));
      if (!query.size) throw new Error('Choose a site or enter a device MAC for Marvis');
      const type = params.type || 'wireless';
      if (!['wireless', 'wired', 'wan'].includes(type)) throw new Error('Choose wireless, wired, or WAN troubleshooting');
      query.set('type', type);
      const duration = params.duration || '1d';
      const ranges = { '1h': 3600, '1d': 86400, '7d': 604800 };
      if (typeof duration !== 'string' || !Object.hasOwn(ranges, duration)) throw new Error('Choose a Marvis time range of 1 hour, 1 day, or 7 days');
      const seconds = ranges[duration];
      const end = Math.floor(Date.now() / 1000);
      query.set('start', String(end - seconds));
      query.set('end', String(end));
      return `/api/v1/orgs/${orgId}/troubleshoot?${query}`;
    }
    default: throw new Error('Unsupported Mist action');
  }
}

function safeClone(value, token, state = { nodes: 0 }, depth = 0) {
  if (++state.nodes > 10000 || depth > 10) { state.truncated = true; return '[Truncated]'; }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const redacted = token ? value.split(token).join('[Redacted]') : value;
    if (redacted.length > 10000) state.truncated = true;
    return redacted.slice(0, 10000);
  }
  if (Array.isArray(value)) {
    if (value.length > 500) state.truncated = true;
    return value.slice(0, 500).map((item) => safeClone(item, token, state, depth + 1));
  }
  if (record(value)) {
    const out = Object.create(null);
    const keys = Object.keys(value);
    if (keys.length > 300) state.truncated = true;
    for (const key of keys.slice(0, 300)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || /token|password|passphrase|secret|authorization|api[_-]?key|cookie|psk|community|(?:private|shared|auth)[_-]?key/i.test(key) || (token && key.includes(token))) continue;
      out[text(key, 128)] = safeClone(value[key], token, state, depth + 1);
    }
    return out;
  }
  return null;
}

function selfSummary(value) {
  if (!record(value) || !Array.isArray(value.privileges)) throw new Error('Mist returned an unexpected account response');
  const orgs = new Map(), sites = new Map();
  for (const entry of value.privileges.slice(0, 1000)) {
    if (!record(entry)) continue;
    const orgId = UUID.test(entry.org_id || '') ? entry.org_id.toLowerCase() : entry.scope === 'org' && UUID.test(entry.scope_id || '') ? entry.scope_id.toLowerCase() : '';
    if (orgId) orgs.set(orgId, { id: orgId, name: text(entry.org_name || (entry.scope === 'org' ? entry.name : '') || orgs.get(orgId)?.name || orgId), role: text(entry.scope === 'org' ? entry.role : orgs.get(orgId)?.role || entry.role, 80) });
    const siteId = UUID.test(entry.site_id || '') ? entry.site_id.toLowerCase() : entry.scope === 'site' && UUID.test(entry.scope_id || '') ? entry.scope_id.toLowerCase() : '';
    if (siteId) sites.set(siteId, { id: siteId, orgId, name: text(entry.site_name || entry.name || siteId), role: text(entry.role, 80) });
  }
  return { name: text([text(value.first_name, 80), text(value.last_name, 80)].filter(Boolean).join(' ') || value.name || 'Mist account'), orgs: [...orgs.values()].slice(0, PAGE_LIMIT), sites: [...sites.values()].slice(0, PAGE_LIMIT) };
}

function reportScope(action, endpoint, params) {
  const url = new URL(endpoint, 'https://api.mist.com');
  if (action === 'self') return {};
  if (action === 'sites') return { orgId: url.pathname.split('/')[4] };
  if (action === 'aps' || action === 'clients') return { siteId: url.pathname.split('/')[4] };
  const query = url.searchParams;
  return {
    orgId: url.pathname.split('/')[4],
    ...(query.has('site_id') ? { siteId: query.get('site_id') } : {}),
    ...(query.has('mac') ? { mac: query.get('mac') } : {}),
    type: query.get('type'), duration: params.duration || '1d',
    start: Number(query.get('start')), end: Number(query.get('end')),
  };
}

function rows(value) {
  if (Array.isArray(value)) return value;
  if (record(value) && Array.isArray(value.results)) return value.results;
  throw new Error('Mist returned an unexpected list response');
}

function summary(action, value) {
  if (action === 'self') return selfSummary(value);
  if (action === 'marvis') {
    if (typeof value !== 'string' && !record(value) && !Array.isArray(value)) throw new Error('Mist returned an unexpected Marvis response');
    return value;
  }
  return rows(value).slice(0, PAGE_LIMIT).filter(record).map((item) => {
    if (action === 'sites') return { id: text(item.id, 36), name: text(item.name), timezone: text(item.timezone, 100), orgId: text(item.org_id, 36) };
    if (action === 'aps') return {
      id: text(item.id, 36), mac: text(item.mac, 32), name: text(item.name), model: text(item.model, 100),
      status: text(item.status, 40), ip: text(item.ip, 100), numClients: number(item.num_clients), uptime: number(item.uptime), version: text(item.version, 100),
      radios: record(item.radio_stat) ? Object.entries(item.radio_stat).slice(0, 8).map(([band, radio]) => ({
        band: text(band.replace(/^band_/, ''), 20), channel: number(radio?.channel), power: number(radio?.power), utilization: number(radio?.util_all),
      })) : [],
    };
    return { mac: text(item.mac, 32), hostname: text(item.hostname), ip: text(item.ip, 100), ssid: text(item.ssid), apMac: text(item.ap_mac, 32), band: text(item.band, 20), channel: number(item.channel), rssi: number(item.rssi), snr: number(item.snr), lastSeen: number(item.last_seen) };
  });
}

class MistClient {
  constructor({ dir, crypt, request = https.request }) {
    if (!dir || !crypt || typeof request !== 'function') throw new TypeError('Mist storage, encryption, and request transport are required');
    this.file = path.join(dir, 'mist.json');
    this.crypt = crypt;
    this.transport = request;
    this.config = { version: 1, region: 'global01' };
    // An opaque connection generation lets another tab detect changed settings
    // without exposing a token fingerprint or the encrypted credential.
    this.revision = crypto.randomUUID();
    this.storageError = '';
    this.cooldown = new Map();
    try {
      const stat = fs.statSync(this.file);
      if (!stat.isFile() || stat.size > 32768) throw new Error('Invalid storage');
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!record(data) || data.version !== 1 || !REGIONS.some((entry) => entry.id === data.region) || (data.tokenEnc !== undefined && (typeof data.tokenEnc !== 'string' || data.tokenEnc.length > 16384))) throw new Error('Invalid storage');
      this.config = { version: 1, region: data.region, ...(data.tokenEnc ? { tokenEnc: data.tokenEnc } : {}) };
    } catch (error) {
      if (error.code !== 'ENOENT') this.storageError = 'Saved Mist credentials could not be read. Save a new key or forget the saved key to repair them.';
    }
  }

  getConfig() {
    return { region: this.config.region, revision: this.revision, hasToken: !!this.config.tokenEnc, regions: REGIONS.map((entry) => ({ ...entry })), ...(this.storageError ? { warning: this.storageError } : {}) };
  }

  configure(input = {}) {
    if (!record(input)) throw new Error('Invalid Mist configuration');
    const region = input.region === undefined ? this.config.region : input.region;
    if (!REGIONS.some((entry) => entry.id === region)) throw new Error('Choose a supported Mist cloud region');
    const supplied = input.forget === true ? null : input.token;
    if (supplied !== undefined && supplied !== null && typeof supplied !== 'string') throw new Error('Mist API key must be text');
    const token = typeof supplied === 'string' ? supplied.trim() : supplied;
    if (region !== this.config.region && this.config.tokenEnc && !token && token !== null) throw new Error('Re-enter the API key when changing Mist cloud region, or forget the saved key first');
    if (this.storageError && !token && token !== null) throw new Error(this.storageError);
    const next = { ...this.config, region };
    if (token === null) delete next.tokenEnc;
    else if (token) {
      if (!/^[A-Za-z0-9_-]{16,512}$/.test(token)) throw new Error('Enter the Mist API key only, without spaces or an Authorization prefix');
      if (!this.crypt.available()) throw new Error('Secure Windows credential encryption is unavailable; the Mist API key was not saved');
      try {
        const encrypted = this.crypt.encrypt(token);
        if (typeof encrypted !== 'string' || !encrypted || encrypted === token || encrypted.length > 16384) throw new Error('Invalid encrypted credential');
        next.tokenEnc = encrypted;
      } catch { throw new Error('The Mist API key could not be encrypted; the saved configuration is unchanged'); }
    }
    const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, this.file);
    } catch {
      try { fs.unlinkSync(temp); } catch { /* Preserve previous config on a failed atomic save. */ }
      throw new Error('Mist credentials could not be saved; the previous configuration is unchanged');
    }
    this.config = next;
    this.revision = crypto.randomUUID();
    this.storageError = '';
    return this.getConfig();
  }

  _token() {
    if (this.storageError) throw new Error(this.storageError);
    if (!this.config.tokenEnc) throw new Error('Save a Mist API key first');
    if (!this.crypt.available()) throw new Error('Secure Windows credential encryption is unavailable');
    let token;
    try { token = this.crypt.decrypt(this.config.tokenEnc); } catch { throw new Error('The saved Mist API key could not be decrypted; save the key again'); }
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(token)) throw new Error('The saved Mist API key is invalid; save the key again');
    return token;
  }

  async request(action, params = {}, signal = {}) {
    checkCancelled(signal);
    const endpoint = requestPath(action, params);
    if (Object.hasOwn(params, 'configRevision') && params.configRevision !== this.revision) throw new Error('Mist connection settings changed; refresh connection settings and retry');
    const scope = reportScope(action, endpoint, params);
    const region = this.config.region;
    const origin = REGIONS.find((entry) => entry.id === region).origin;
    const token = this._token();
    const remaining = (this.cooldown.get(region) || 0) - Date.now();
    if (remaining > 0) throw new Error(`Mist rate limit reached. Try again in ${Math.ceil(remaining / 1000)} seconds`);
    const value = await this._get(new URL(endpoint, origin), token, signal, region);
    checkCancelled(signal);
    const cloneState = { nodes: 0, truncated: false };
    const data = safeClone(summary(action, value), token, cloneState);
    const list = action !== 'self' && action !== 'marvis';
    const discoveryLimited = action === 'self' && value.privileges.length > PAGE_LIMIT;
    const limited = cloneState.truncated || discoveryLimited || (list && (rows(value).length >= PAGE_LIMIT || !!value?.next || Number(value?.total) > PAGE_LIMIT));
    return {
      action, region, fetchedAt: new Date().toISOString(), scope, data, limited,
      limitations: [
        ...(list ? [`One snapshot of up to ${PAGE_LIMIT} records; refresh explicitly. Larger sites may require the Mist portal for the full inventory.`] : []),
        ...(action === 'self' ? ['Organizations and sites reflect the API key privileges returned by Mist. A restricted key may require entering an organization or site ID manually.'] : []),
        ...(discoveryLimited ? ['Account discovery was limited to the first 1,000 privileges and up to 200 organizations and sites. Enter an authorized ID manually if needed.'] : []),
        ...(cloneState.truncated ? ['Cloud response truncated at the local text, record, or nesting limit. Use the Mist portal to inspect the full response.'] : []),
        ...(action === 'marvis' ? ['Direct Marvis troubleshooting requires an observer API token and an organization Marvis subscription. This is the documented site/device troubleshooting API; natural-language portal chat is not exposed here.'] : []),
      ],
    };
  }

  _get(url, token, signal, region) {
    return new Promise((resolve, reject) => {
      let req, response, timer, settled = false;
      let detach = () => {};
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detach();
        if (error) { response?.destroy?.(); req?.destroy?.(); reject(error); }
        else resolve(value);
      };
      const failure = (message) => finish(new Error(message));
      try {
        req = this.transport({
          protocol: 'https:', hostname: url.hostname, port: 443, path: url.pathname + url.search,
          method: 'GET', headers: { Authorization: `Token ${token}`, Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'KonX-Mist' },
          rejectUnauthorized: true, minVersion: 'TLSv1.2', agent: false,
        }, (res) => {
          response = res;
          if (settled) { res.destroy?.(); return; }
          const status = Number(res.statusCode);
          if (status !== 200) {
            if (status === 429) {
              const raw = res.headers?.['retry-after'];
              const retryMs = /^\d+$/.test(String(raw || '')) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
              const waitMs = Math.min(3600000, Math.max(1000, Number.isFinite(retryMs) ? retryMs : 60000));
              this.cooldown.set(region, Date.now() + waitMs);
              return failure(`Mist rate limit reached. Try again in ${Math.ceil(waitMs / 1000)} seconds`);
            }
            if (status >= 300 && status < 400) return failure('Mist redirected the request. Verify the cloud region; credentials were not forwarded');
            if (status === 401) return failure('Mist rejected the API key. Check the key and cloud region');
            if (status === 403) return failure('Mist denied access. Check API key permissions and the organization Marvis subscription when troubleshooting');
            if (status === 404) return failure('Mist could not find this resource. Check the organization or site ID and cloud region');
            return failure(`Mist request failed (HTTP ${Number.isInteger(status) ? status : 'unknown'})`);
          }
          const encoding = text(res.headers?.['content-encoding'], 40).toLowerCase();
          if (encoding && encoding !== 'identity') return failure('Mist returned an unsupported response encoding');
          if (Number(res.headers?.['content-length']) > MAX_BODY) return failure('Mist response exceeded the 2 MiB limit; use a smaller site or the Mist portal');
          let bytes = 0;
          const chunks = [];
          res.on('error', () => failure('Mist response was interrupted'));
          res.on('aborted', () => failure('Mist response was interrupted'));
          res.on('data', (chunk) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > MAX_BODY) return failure('Mist response exceeded the 2 MiB limit; use a smaller site or the Mist portal');
            chunks.push(buffer);
          });
          res.on('end', () => {
            if (settled) return;
            try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { failure('Mist returned an invalid JSON response'); }
          });
        });
        req.on('error', () => failure('Unable to connect securely to Mist. Check network access and the selected cloud region'));
        detach = onCancel(signal, () => failure('Assessment cancelled'));
        if (settled) { detach(); return; }
        timer = setTimeout(() => failure('Mist request timed out after 20 seconds'), TIMEOUT_MS);
        if (!settled) req.end();
      } catch { failure('Unable to connect securely to Mist. Check network access and the selected cloud region'); }
    });
  }

  async run(params = {}, emit, signal = {}) {
    checkCancelled(signal);
    emit('progress', { phase: 'Reading Mist cloud data…' });
    const report = await this.request(params.action, params, signal);
    checkCancelled(signal);
    emit('report', report);
  }
}

module.exports = { MistClient, REGIONS, requestPath, safeClone };
