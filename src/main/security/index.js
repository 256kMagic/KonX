'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { makeReport, checkCancelled } = require('./common');
const { scanWindows } = require('./windows');
const { scanTls, scanSsh, scanWeb, scanExposure } = require('./network');
const { scanConfig, scanCapture } = require('./offline');

const AUDITS = Object.freeze({
  windows: scanWindows,
  'windows-remote': (params, signal) => scanExposure({ ...params, profile: 'windows' }, signal),
  tls: scanTls, ssh: scanSsh, web: scanWeb, exposure: scanExposure,
  config: scanConfig, capture: scanCapture,
});

async function run(params, emit, signal) {
  if (!params || !Object.hasOwn(AUDITS, params.audit)) throw new Error('Unknown security assessment');
  checkCancelled(signal);
  emit('progress', { phase: 'Collecting read-only assessment evidence…' });
  const result = await AUDITS[params.audit](params, signal);
  checkCancelled(signal);
  // Keep report shape and size consistent even when a provider is unavailable.
  const report = makeReport({ ...result, kind: params.audit });
  if (params.audit === 'config' && typeof params.label === 'string' && params.label.trim()) report.target = params.label.trim().slice(0, 200);
  let endpoint = params.filePath ? path.resolve(params.filePath) : report.target;
  if (params.audit === 'web') {
    const url = new URL(params.url);
    url.search = ''; url.hash = '';
    endpoint = url.href;
  }
  report.scopeId = crypto.createHash('sha256').update(JSON.stringify([report.kind, endpoint, params.port || '', params.profile || '', params.ports || []])).digest('hex');
  // Pasted snippets need an explicit identity to compare across runs/devices.
  if (params.audit === 'config' && !params.filePath && !(typeof params.label === 'string' && params.label.trim())) report.scopeId = '';
  emit('report', report);
}

module.exports = { run, AUDITS };
