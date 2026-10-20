'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { finding, makeReport, checkCancelled, onCancel } = require('./common');

const MAX_OUTPUT = 1024 * 1024;
const TIMEOUT_MS = 45000;
const DOCS = {
  defender: 'https://learn.microsoft.com/en-us/powershell/module/defender/get-mpcomputerstatus',
  firewall: 'https://learn.microsoft.com/en-us/powershell/module/netsecurity/get-netfirewallprofile',
  smb: 'https://learn.microsoft.com/en-us/windows-server/storage/file-server/smb-signing',
  rdp: 'https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/remotepc/remote-desktop-allow-access',
  uac: 'https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/settings-and-configuration',
  boot: 'https://learn.microsoft.com/en-us/powershell/module/secureboot/confirm-securebootuefi',
  bitlocker: 'https://learn.microsoft.com/en-us/powershell/module/bitlocker/get-bitlockervolume',
  updates: 'https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/get-hotfix',
  accounts: 'https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.localaccounts/get-localuser',
};
const LIMITATIONS = [
  'Local read-only configuration assessment. No malware scan, exploitation, elevation, online update check, or settings changes are performed.',
  'Unavailable, unsupported, and access-denied queries remain unknown. A pass applies only to the stated check and is not proof that this PC is secure.',
  'Antivirus registration does not verify third-party antivirus health. Defender may be passive when another antivirus product is primary.',
  'Hotfix inventory is limited to 500 entries and excludes some update mechanisms; it cannot establish that Windows is fully patched or free of CVEs.',
  'Local account checks are aggregate policy observations, not password-strength tests. Domain policies and network reachability are not assessed.',
];
const count = (value, max = 100000) => Number.isInteger(value) && value >= 0 && value <= max ? value : null;
const isBool = (value) => typeof value === 'boolean';
const available = (value) => value && typeof value === 'object' && value.available === true;
const boolText = (value) => value === true ? 'on' : value === false ? 'off' : 'unknown';

/** Evaluate allow-listed aggregate facts. Never pass arbitrary raw inventory into reports. */
function evaluateWindowsFacts(facts = {}, now = Date.now()) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) facts = {};
  const checks = [];
  const add = (id, title, status, severity, evidence, remediation, reference, confidence = 'high') => checks.push(finding({ id, title, status, severity, evidence, remediation, reference, confidence }));
  const unknown = (id, title, fact, reference) => add(id, title, 'unknown', 'info', fact?.reason === 'access-denied' ? 'Windows denied this read-only query at the current permission level.' : 'This setting could not be read or the required Windows component is unavailable.', 'Review this setting in Windows Security or your managed endpoint console. KonX does not request elevation.', reference);

  const d = facts.defender;
  const av = facts.antivirus;
  const otherAv = available(av) ? count(av.otherRegisteredCount, 100) : null;
  if (available(d)) {
    const active = d.mode === 'active';
    const passive = d.mode === 'passive' || d.mode === 'edr-block';
    const evidence = `Defender mode: ${active ? 'active' : passive ? 'passive / EDR block' : 'unknown'}; antivirus: ${boolText(d.antivirusEnabled)}; real-time protection: ${boolText(d.realtimeEnabled)}.${otherAv !== null ? ` Other registered antivirus products: ${otherAv}.` : ''}`;
    if (active && d.antivirusEnabled === true && d.realtimeEnabled === true) add('windows-antivirus', 'Antivirus protection', 'pass', 'info', evidence, '', DOCS.defender);
    else if (active && (d.antivirusEnabled === false || d.realtimeEnabled === false)) add('windows-antivirus', 'Antivirus protection', 'fail', 'high', evidence, 'Review Microsoft Defender protection settings and managed policy. Enable active real-time protection or confirm an approved alternative is protecting this PC.', DOCS.defender);
    else if (passive || otherAv > 0) add('windows-antivirus', 'Antivirus protection', 'unknown', 'medium', `${evidence} Third-party protection health was not verified.`, 'Confirm the primary antivirus product is active and healthy in Windows Security or its management console.', DOCS.defender);
    else add('windows-antivirus', 'Antivirus protection', 'unknown', 'medium', evidence, 'Confirm the active antivirus provider and its protection state in Windows Security.', DOCS.defender);
    const age = typeof d.signatureAgeDays === 'number' && Number.isFinite(d.signatureAgeDays) && d.signatureAgeDays >= 0 && d.signatureAgeDays < 65535 ? d.signatureAgeDays : null;
    if (active && age !== null) add('windows-defender-signatures', 'Defender security intelligence age', age > 7 ? 'fail' : age > 2 ? 'warning' : 'pass', age > 7 ? 'high' : age > 2 ? 'medium' : 'info', `Defender reports security intelligence age: ${Math.floor(age)} day(s). KonX flags more than 2 days for review and more than 7 days as stale.`, age > 2 ? 'Review antivirus update connectivity and policy; update security intelligence through Windows Security or your management system.' : '', DOCS.defender);
    else add('windows-defender-signatures', 'Defender security intelligence age', 'unknown', 'info', passive ? 'Defender is not the primary antivirus; its signature age does not describe primary-provider health.' : 'A valid signature age for active Defender was not available.', 'Check signature currency for the primary antivirus provider.', DOCS.defender);
  } else {
    unknown('windows-antivirus', 'Antivirus protection', d, DOCS.defender);
    unknown('windows-defender-signatures', 'Defender security intelligence age', d, DOCS.defender);
  }

  const f = facts.firewall;
  const profiles = available(f) && Array.isArray(f.profiles) ? f.profiles : [];
  for (const name of ['Domain', 'Private', 'Public']) {
    const matches = profiles.filter((p) => p && p.name === name);
    const profile = matches.length === 1 ? matches[0] : null;
    if (!profile || !isBool(profile.enabled)) unknown(`windows-firewall-${name.toLowerCase()}`, `${name} firewall profile`, f, DOCS.firewall);
    else add(`windows-firewall-${name.toLowerCase()}`, `${name} firewall profile`, profile.enabled ? 'pass' : 'fail', profile.enabled ? 'info' : 'high', `${name} firewall profile is ${profile.enabled ? 'enabled' : 'disabled'} in the active policy store. Individual rules and third-party firewalls were not reviewed.`, profile.enabled ? '' : 'Review managed firewall policy and enable the Windows Firewall profile unless an approved alternative provides the required protection.', DOCS.firewall);
  }

  const s = facts.smbServer;
  if (available(s) && isBool(s.smb1Enabled)) add('windows-smb1', 'SMBv1 server protocol', s.smb1Enabled ? 'fail' : 'pass', s.smb1Enabled ? 'high' : 'info', `SMBv1 server protocol is ${s.smb1Enabled ? 'enabled' : 'disabled'}. The SMBv1 client feature was not checked.`, s.smb1Enabled ? 'Remove legacy SMBv1 dependencies and disable the SMBv1 server protocol through approved Windows configuration management.' : '', DOCS.smb);
  else unknown('windows-smb1', 'SMBv1 server protocol', s, DOCS.smb);
  for (const [key, label] of [['smbServer', 'server'], ['smbClient', 'client']]) {
    const item = facts[key];
    if (available(item) && isBool(item.signingRequired)) add(`windows-smb-signing-${label}`, `SMB ${label} signing requirement`, item.signingRequired ? 'pass' : 'warning', item.signingRequired ? 'info' : 'medium', `SMB ${label} signing is ${item.signingRequired ? 'required' : 'not required'}. This describes configuration, not a negotiated connection.`, item.signingRequired ? '' : 'Review compatibility and require SMB signing in managed policy to reduce tampering and relay exposure.', DOCS.smb);
    else unknown(`windows-smb-signing-${label}`, `SMB ${label} signing requirement`, item, DOCS.smb);
  }

  const r = facts.rdp;
  if (available(r) && [0, 1].includes(r.denyConnections)) {
    if (r.denyConnections === 1) add('windows-rdp', 'Remote Desktop and NLA', 'pass', 'info', 'Remote Desktop connections are disabled by the read configuration. No listening-port or firewall reachability test was performed.', '', DOCS.rdp);
    else if (r.nlaRequired === 1) add('windows-rdp', 'Remote Desktop and NLA', 'info', 'info', 'Remote Desktop is enabled and Network Level Authentication is required by the read configuration. Reachability was not tested.', 'Keep Remote Desktop limited to trusted access paths and approved users.', DOCS.rdp);
    else if (r.nlaRequired === 0) add('windows-rdp', 'Remote Desktop and NLA', 'fail', 'high', 'Remote Desktop is enabled without requiring Network Level Authentication.', 'Require Network Level Authentication and restrict Remote Desktop access to trusted networks or a managed gateway.', DOCS.rdp);
    else add('windows-rdp', 'Remote Desktop and NLA', 'unknown', 'medium', 'Remote Desktop is enabled; the NLA requirement could not be determined.', 'Review the Network Level Authentication requirement and Remote Desktop policy.', DOCS.rdp);
  } else unknown('windows-rdp', 'Remote Desktop and NLA', r, DOCS.rdp);

  const u = facts.uac;
  if (available(u) && [0, 1].includes(u.enabled)) {
    if (u.enabled === 0) add('windows-uac', 'User Account Control', 'fail', 'high', 'EnableLUA is disabled in the read configuration; pending restart state was not checked.', 'Review managed UAC policy and enable Admin Approval Mode.', DOCS.uac);
    else if (u.adminPrompt === 0) add('windows-uac', 'User Account Control', 'warning', 'medium', 'UAC is enabled but administrator elevation is configured without a consent prompt.', 'Use an administrator consent or credential prompt appropriate for your organization.', DOCS.uac);
    else if ([1, 2, 3, 4, 5].includes(u.adminPrompt) && u.secureDesktop === 1) add('windows-uac', 'User Account Control', 'pass', 'info', 'UAC is enabled, administrator prompts are configured, and the secure desktop is required. Pending restart state was not checked.', '', DOCS.uac);
    else if ([1, 2, 3, 4, 5].includes(u.adminPrompt) && u.secureDesktop === 0) add('windows-uac', 'User Account Control', 'warning', 'low', 'UAC is enabled with administrator prompts, but the secure desktop is disabled.', 'Review use of the secure desktop for elevation prompts against your managed UAC policy.', DOCS.uac);
    else unknown('windows-uac', 'User Account Control', u, DOCS.uac);
  } else unknown('windows-uac', 'User Account Control', u, DOCS.uac);

  const boot = facts.secureBoot;
  if (available(boot) && isBool(boot.enabled)) add('windows-secure-boot', 'Secure Boot', boot.enabled ? 'pass' : 'warning', boot.enabled ? 'info' : 'medium', `UEFI Secure Boot reports ${boot.enabled ? 'enabled' : 'disabled'}.`, boot.enabled ? '' : 'Review firmware compatibility and managed boot policy before enabling Secure Boot.', DOCS.boot);
  else unknown('windows-secure-boot', 'Secure Boot', boot, DOCS.boot);

  const b = facts.bitlocker;
  if (available(b) && ['on', 'off'].includes(b.protection) && ['encrypted', 'decrypted', 'encrypting', 'decrypting', 'paused'].includes(b.volumeStatus)) {
    const protectedVolume = b.protection === 'on' && b.volumeStatus === 'encrypted';
    add('windows-bitlocker', 'Operating-system drive BitLocker', protectedVolume ? 'pass' : 'warning', protectedVolume ? 'info' : 'medium', `OS drive protection: ${b.protection}; encryption state: ${b.volumeStatus}. No key protectors or recovery material were collected.`, protectedVolume ? '' : 'Review OS-drive encryption and protection status with your endpoint administrator. Preserve recovery access before making encryption changes.', DOCS.bitlocker);
  } else unknown('windows-bitlocker', 'Operating-system drive BitLocker', b, DOCS.bitlocker);

  const updates = facts.updates;
  const total = available(updates) ? count(updates.count, 500) : null;
  if (total !== null) {
    const date = typeof updates.latestInstalledAt === 'string' ? Date.parse(updates.latestInstalledAt) : NaN;
    const age = Number.isFinite(date) && date >= 0 && date <= now + 86400000 ? Math.max(0, Math.floor((now - date) / 86400000)) : null;
    add('windows-update-inventory', 'Installed hotfix inventory', age !== null && age > 60 ? 'warning' : 'info', age !== null && age > 60 ? 'low' : 'info', `${total}${updates.truncated === true ? '+' : ''} hotfix inventory entries.${age !== null ? ` Latest reported installation: ${new Date(date).toISOString().slice(0, 10)} (${age} day(s) ago).` : ' A valid installation date was not available.'} This does not establish patch completeness.`, 'Check Windows Update or your managed patch system for pending updates and OS support status.', DOCS.updates, 'medium');
  } else unknown('windows-update-inventory', 'Installed hotfix inventory', updates, DOCS.updates);

  const a = facts.accounts;
  if (available(a) && count(a.enabledCount, 1000) !== null && count(a.passwordNotRequiredCount, 1000) !== null && count(a.passwordRequirementUnknownCount, 1000) !== null && isBool(a.guestEnabled)) {
    const risky = a.passwordNotRequiredCount > 0 || a.guestEnabled;
    add('windows-local-accounts', 'Local account policy summary', risky ? 'warning' : 'info', risky ? 'medium' : 'info', `Enabled local accounts: ${a.enabledCount}; password-not-required flag: ${a.passwordNotRequiredCount}; unknown password requirement: ${a.passwordRequirementUnknownCount}; built-in Guest enabled: ${a.guestEnabled ? 'yes' : 'no'}.${a.truncated === true ? ' Inventory capped at 1000 accounts.' : ''} Password contents, strength, and domain accounts were not checked.`, risky ? 'Review enabled local accounts and Guest policy. A password-not-required flag does not prove that an account has a blank password.' : 'Review account necessity and password policy in your identity management tools.', DOCS.accounts, 'medium');
  } else unknown('windows-local-accounts', 'Local account policy summary', a, DOCS.accounts);

  return makeReport({ kind: 'windows', title: 'Windows Security Assessment', target: 'This PC', checks, limitations: LIMITATIONS });
}

function runWindowsInventory(signal, execFile = childProcess.execFile) {
  checkCancelled(signal);
  // Reading through Node also works when this file is packaged inside app.asar.
  const encoded = fs.readFileSync(path.join(__dirname, 'windows-assessment.ps1'), 'utf8');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(encoded, 'utf16le').toString('base64')];
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    let child;
    let stopped = false;
    let settled = false;
    let unsubscribe = () => {};
    const done = (error, stdout) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (stopped || signal?.stopped) return reject(new Error('Assessment cancelled'));
      // Never forward raw PowerShell errors: they may contain local paths or identities.
      if (error) return reject(new Error(error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Windows inventory exceeded its time or output limit' : 'Windows inventory could not complete'));
      try {
        const parsed = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== 1) throw new Error('schema');
        resolve(parsed);
      } catch { reject(new Error('Windows inventory returned an invalid response')); }
    };
    try {
      child = execFile(executable, args, { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: 'utf8' }, done);
      if (!settled) unsubscribe = onCancel(signal, () => { stopped = true; child?.kill(); });
    } catch { done(new Error('spawn failed')); }
  });
}

async function scanWindows(params = {}, signal = {}) {
  checkCancelled(signal);
  if (process.platform !== 'win32') throw new Error('Windows assessment is available only on Windows');
  // No target, command, executable, or query supplied by the renderer is accepted.
  if (params && typeof params === 'object' && params.target && !['local', 'localhost', 'This PC'].includes(params.target)) throw new Error('Windows posture assessment supports This PC only');
  const facts = await runWindowsInventory(signal);
  checkCancelled(signal);
  return evaluateWindowsFacts(facts);
}

module.exports = { scanWindows, evaluateWindowsFacts, runWindowsInventory };
