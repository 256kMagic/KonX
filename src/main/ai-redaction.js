'use strict';

// Shared whole-text redaction. Call before selecting excerpts or applying limits.
function redactText(value, secrets = []) {
  let out = typeof value === 'string' ? value : '';
  for (const secret of (Array.isArray(secrets) ? secrets : [secrets])) {
    if (typeof secret === 'string' && secret) out = out.split(secret).join('[Redacted]');
  }
  return out
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?(?:-----END (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|$)/g, '[Private key redacted]')
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|nq-v1-[A-Za-z0-9_-]{15,}|AIza[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9]{15,}|AKIA[A-Z0-9]{16})\b/g, '[Redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[Redacted]')
    .replace(/(\b(?:Authorization|Proxy-Authorization)\s*[=:]\s*)(?:["']?)(?:Bearer|Basic|Token)\s+[^\s"',;}]+/gi, '$1[Redacted]')
    .replace(/((?:["']?)(?:authorization|proxy-authorization|api[_-]?key|x-api-key|x-goog-api-key|access[_-]?token|refresh[_-]?token|token|password|passwd|passphrase|secret|client[_-]?secret|psk|community|cookie|set-cookie)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1[Redacted]')
    .replace(/(^|\n)(\s*(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, '$1$2[Redacted]')
    .replace(/(^|\n)(\s*(?:enable (?:secret|password)|username\s+\S+\s+(?:secret|password)|snmp-server community|(?:wpa-)?psk(?:-ascii)?|password|passphrase)\s+)[^\r\n]+/gi, '$1$2[Redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[Redacted]@');
}

module.exports = { redactText };
