const STATUS = new Set(['pass', 'warning', 'fail', 'unknown', 'info']);
const SEVERITY = new Set(['high', 'medium', 'low', 'info']);
const text = (value, limit) => {
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid assessment report text');
  return value;
};

export function validateReport(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.checks) || value.checks.length > 500 || !Array.isArray(value.limitations) || value.limitations.length > 30) throw new Error('Invalid assessment report');
  const ids = new Set();
  const checks = value.checks.map((check) => {
    if (!check || !STATUS.has(check.status) || !SEVERITY.has(check.severity) || !['high', 'medium', 'low'].includes(check.confidence)) throw new Error('Invalid assessment finding');
    const id = text(check.id, 120);
    if (!id || ids.has(id)) throw new Error('Duplicate or missing assessment finding ID');
    ids.add(id);
    return { id, title: text(check.title, 200), status: check.status, severity: check.severity,
      evidence: text(check.evidence, 4000), remediation: text(check.remediation, 4000), confidence: check.confidence,
      reference: text(check.reference || '', 1000) };
  });
  return {
    schemaVersion: 1, kind: text(value.kind, 50), title: text(value.title, 200), target: text(value.target, 500),
    scannedAt: text(value.scannedAt, 100), scopeId: /^[0-9a-f]{64}$/.test(value.scopeId) ? value.scopeId : '',
    checks, limitations: value.limitations.map((item) => text(item, 2000)),
  };
}

export function summary(report) {
  const counts = { pass: 0, warning: 0, fail: 0, unknown: 0, info: 0 };
  for (const check of report.checks) counts[check.status]++;
  return counts;
}

export function compareReports(current, baseline) {
  current = validateReport(current); baseline = validateReport(baseline);
  if (!current.scopeId || current.kind !== baseline.kind || current.target !== baseline.target || current.scopeId !== baseline.scopeId) throw new Error('Baseline belongs to a different assessment target');
  const previous = new Map(baseline.checks.map((check) => [check.id, check]));
  const changes = current.checks.map((check) => {
    const old = previous.get(check.id);
    previous.delete(check.id);
    return { id: check.id, change: !old ? 'new' : ['status', 'severity', 'evidence'].some((key) => old[key] !== check[key]) ? 'changed' : 'unchanged', previous: old?.status || '' };
  });
  return { changes, removed: [...previous.values()], scannedAt: baseline.scannedAt };
}

const esc = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export function exportReport(value, format) {
  const report = validateReport(value);
  if (format === 'json') return JSON.stringify(report, null, 2);
  if (format !== 'html') throw new Error('Unsupported report format');
  const counts = summary(report);
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    `<title>${esc(report.title)} — KonX</title><style>body{font:15px/1.5 system-ui;margin:2em;color:#182332}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd4df;padding:.6em;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#eef2f7}li{margin:.5em 0}small{color:#41536a}h2{margin-top:2em}</style>` +
    `<h1>${esc(report.title)}</h1><p><b>Target:</b> ${esc(report.target)}<br><b>Collected:</b> ${esc(report.scannedAt)}</p>` +
    `<p>${Object.entries(counts).map(([key, count]) => `${count} ${key}`).join(' · ')}</p><p>These are scoped observations. Unknown and inaccessible checks are not passing results.</p>` +
    '<table><thead><tr><th>Check</th><th>Result</th><th>Evidence</th><th>Recommendation</th></tr></thead><tbody>' +
    report.checks.map((check) => `<tr><td>${esc(check.title)}<br><small>${esc(check.id)}</small></td><td>${esc(check.status)}<br>${esc(check.severity)} severity<br>${esc(check.confidence)} confidence</td><td>${esc(check.evidence)}</td><td>${esc(check.remediation)}</td></tr>`).join('') +
    `</tbody></table><h2>Scope and limitations</h2><ul>${report.limitations.map((item) => `<li>${esc(item)}</li>`).join('')}</ul><p><small>Generated locally by KonX Security.</small></p></html>`;
}
