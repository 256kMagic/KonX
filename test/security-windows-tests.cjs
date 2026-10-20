'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { evaluateWindowsFacts, runWindowsInventory, scanWindows } = require('../src/main/security/windows');

const NOW = Date.parse('2026-10-20T12:00:00Z');
function healthyFacts() {
  return {
    schemaVersion: 1,
    defender: { available: true, mode: 'active', antivirusEnabled: true, realtimeEnabled: true, signatureAgeDays: 0 },
    antivirus: { available: true, registeredCount: 1, otherRegisteredCount: 0 },
    firewall: { available: true, profiles: ['Domain', 'Private', 'Public'].map((name) => ({ name, enabled: true })) },
    smbServer: { available: true, smb1Enabled: false, signingRequired: true },
    smbClient: { available: true, signingRequired: true },
    rdp: { available: true, denyConnections: 1, nlaRequired: 1 },
    uac: { available: true, enabled: 1, adminPrompt: 5, secureDesktop: 1 },
    secureBoot: { available: true, enabled: true },
    bitlocker: { available: true, protection: 'on', volumeStatus: 'encrypted' },
    updates: { available: true, count: 12, latestInstalledAt: '2026-10-19T00:00:00Z' },
    accounts: { available: true, enabledCount: 1, passwordNotRequiredCount: 0, passwordRequirementUnknownCount: 0, guestEnabled: false },
  };
}
const check = (report, id) => {
  const item = report.checks.find((candidate) => candidate.id === id);
  assert.ok(item, `missing ${id}`);
  return item;
};

async function runSecurityWindowsTests(test) {
  await test('Windows assessment identifies healthy settings without claiming complete security or patching', () => {
    const report = evaluateWindowsFacts(healthyFacts(), NOW);
    assert.strictEqual(report.kind, 'windows');
    assert.strictEqual(report.target, 'This PC');
    assert.strictEqual(report.checks.length, 14);
    assert.strictEqual(check(report, 'windows-antivirus').status, 'pass');
    assert.strictEqual(check(report, 'windows-bitlocker').status, 'pass');
    assert.strictEqual(check(report, 'windows-update-inventory').status, 'info');
    assert.match(check(report, 'windows-update-inventory').evidence, /does not establish patch completeness/);
    assert.ok(report.limitations.some((value) => /cannot establish.*fully patched/.test(value)));
  });

  await test('Windows missing and denied components produce unknown checks, never secure defaults', () => {
    const report = evaluateWindowsFacts({ secureBoot: { available: false, reason: 'access-denied' } }, NOW);
    assert.ok(report.checks.every((item) => item.status === 'unknown'));
    assert.match(check(report, 'windows-secure-boot').evidence, /denied/);
    assert.ok(evaluateWindowsFacts(null).checks.every((item) => item.status === 'unknown'));
  });

  await test('Windows Defender disabled flags and stale active signatures produce actionable findings', () => {
    const facts = healthyFacts();
    facts.defender.realtimeEnabled = false;
    facts.defender.signatureAgeDays = 8;
    const report = evaluateWindowsFacts(facts, NOW);
    assert.strictEqual(check(report, 'windows-antivirus').status, 'fail');
    assert.strictEqual(check(report, 'windows-antivirus').severity, 'high');
    assert.strictEqual(check(report, 'windows-defender-signatures').status, 'fail');
    facts.antivirus.otherRegisteredCount = 1;
    assert.strictEqual(check(evaluateWindowsFacts(facts, NOW), 'windows-antivirus').status, 'fail', 'registration alone cannot override explicitly disabled active Defender protection');
    facts.defender.signatureAgeDays = 3;
    assert.strictEqual(check(evaluateWindowsFacts(facts, NOW), 'windows-defender-signatures').status, 'warning');
  });

  await test('Windows passive Defender and third-party registration never prove absent antivirus', () => {
    for (const mode of ['passive', 'edr-block', 'unknown']) {
      const facts = healthyFacts();
      facts.defender = { available: true, mode, antivirusEnabled: false, realtimeEnabled: false, signatureAgeDays: 365 };
      facts.antivirus.otherRegisteredCount = 1;
      const report = evaluateWindowsFacts(facts, NOW);
      assert.strictEqual(check(report, 'windows-antivirus').status, 'unknown');
      assert.strictEqual(check(report, 'windows-defender-signatures').status, 'unknown');
      assert.match(check(report, 'windows-antivirus').evidence, /health was not verified/);
    }
  });

  await test('Windows unknown boolean and duplicate firewall data cannot yield a pass', () => {
    const facts = healthyFacts();
    facts.firewall.profiles = [{ name: 'Domain', enabled: 'True' }, { name: 'Public', enabled: true }, { name: 'Public', enabled: false }];
    facts.smbServer.smb1Enabled = 'False';
    facts.smbClient.signingRequired = null;
    facts.secureBoot.enabled = 1;
    const report = evaluateWindowsFacts(facts, NOW);
    for (const id of ['windows-firewall-domain', 'windows-firewall-private', 'windows-firewall-public', 'windows-smb1', 'windows-smb-signing-client', 'windows-secure-boot']) assert.strictEqual(check(report, id).status, 'unknown');
  });

  await test('Windows flags disabled firewall, SMBv1 and optional signing independently', () => {
    const facts = healthyFacts();
    facts.firewall.profiles[2].enabled = false;
    facts.smbServer.smb1Enabled = true;
    facts.smbServer.signingRequired = false;
    facts.smbClient.signingRequired = false;
    const report = evaluateWindowsFacts(facts, NOW);
    assert.strictEqual(check(report, 'windows-firewall-public').status, 'fail');
    assert.strictEqual(check(report, 'windows-smb1').status, 'fail');
    assert.strictEqual(check(report, 'windows-smb-signing-server').status, 'warning');
    assert.strictEqual(check(report, 'windows-smb-signing-client').status, 'warning');
    assert.match(check(report, 'windows-smb1').evidence, /client feature was not checked/);
  });

  await test('Windows Remote Desktop needs NLA only when enabled and does not imply reachability', () => {
    const facts = healthyFacts();
    facts.rdp = { available: true, denyConnections: 0, nlaRequired: 0 };
    assert.strictEqual(check(evaluateWindowsFacts(facts, NOW), 'windows-rdp').status, 'fail');
    facts.rdp.nlaRequired = 1;
    const enabled = check(evaluateWindowsFacts(facts, NOW), 'windows-rdp');
    assert.strictEqual(enabled.status, 'info');
    assert.match(enabled.evidence, /Reachability was not tested/);
    facts.rdp.nlaRequired = null;
    assert.strictEqual(check(evaluateWindowsFacts(facts, NOW), 'windows-rdp').status, 'unknown');
    facts.rdp.denyConnections = 1;
    assert.strictEqual(check(evaluateWindowsFacts(facts, NOW), 'windows-rdp').status, 'pass');
  });

  await test('Windows UAC distinguishes disabled, no prompt, nonsecure desktop and missing policy', () => {
    const facts = healthyFacts();
    facts.uac.enabled = 0;
    assert.strictEqual(check(evaluateWindowsFacts(facts, NOW), 'windows-uac').status, 'fail');
    facts.uac.enabled = 1;
    facts.uac.adminPrompt = 0;
    assert.strictEqual(check(evaluateWindowsFacts(facts, NOW), 'windows-uac').status, 'warning');
    facts.uac.adminPrompt = 5;
    facts.uac.secureDesktop = 0;
    assert.strictEqual(check(evaluateWindowsFacts(facts, NOW), 'windows-uac').severity, 'low');
    facts.uac.secureDesktop = null;
    assert.strictEqual(check(evaluateWindowsFacts(facts, NOW), 'windows-uac').status, 'unknown');
  });

  await test('Windows BitLocker requires both protection on and completed encryption', () => {
    const facts = healthyFacts();
    for (const [protection, volumeStatus] of [['off', 'encrypted'], ['on', 'encrypting'], ['off', 'decrypted']]) {
      facts.bitlocker = { available: true, protection, volumeStatus };
      assert.strictEqual(check(evaluateWindowsFacts(facts, NOW), 'windows-bitlocker').status, 'warning');
    }
    facts.bitlocker.protection = 'unknown';
    assert.strictEqual(check(evaluateWindowsFacts(facts, NOW), 'windows-bitlocker').status, 'unknown');
  });

  await test('Windows bounded hotfix inventory handles stale, missing, future and malformed dates', () => {
    const facts = healthyFacts();
    facts.updates = { available: true, count: 500, truncated: true, latestInstalledAt: '2026-01-01T00:00:00Z' };
    let report = evaluateWindowsFacts(facts, NOW);
    assert.strictEqual(check(report, 'windows-update-inventory').status, 'warning');
    assert.match(check(report, 'windows-update-inventory').evidence, /500\+/);
    for (const date of [null, '2027-01-01T00:00:00Z', '/Date(0)/', 'bad']) {
      facts.updates.latestInstalledAt = date;
      report = evaluateWindowsFacts(facts, NOW);
      assert.strictEqual(check(report, 'windows-update-inventory').status, 'info');
      assert.match(check(report, 'windows-update-inventory').evidence, /valid installation date was not available/);
    }
    facts.updates.count = 501;
    assert.strictEqual(check(evaluateWindowsFacts(facts, NOW), 'windows-update-inventory').status, 'unknown');
  });

  await test('Windows account summary flags policy without asserting blank passwords or exposing identities', () => {
    const facts = healthyFacts();
    facts.accounts.passwordNotRequiredCount = 1;
    facts.accounts.guestEnabled = true;
    facts.accounts.names = ['private@example.invalid'];
    facts.bitlocker.keyProtector = 'SECRET-RECOVERY-KEY';
    facts.defender.ComputerID = 'PRIVATE-HOST-ID';
    const report = evaluateWindowsFacts(facts, NOW);
    assert.strictEqual(check(report, 'windows-local-accounts').status, 'warning');
    assert.match(check(report, 'windows-local-accounts').remediation, /does not prove.*blank password/);
    assert.doesNotMatch(JSON.stringify(report), /private@example|SECRET-RECOVERY|PRIVATE-HOST-ID/);
  });

  await test('Windows inventory launches only the fixed hidden noninteractive PowerShell query with limits', async () => {
    let captured;
    const facts = healthyFacts();
    const returned = await runWindowsInventory({}, (command, args, options, callback) => {
      captured = { command, args, options };
      queueMicrotask(() => callback(null, '\uFEFF' + JSON.stringify(facts), ''));
      return { kill() { throw new Error('unexpected kill'); } };
    });
    assert.deepStrictEqual(returned, facts);
    assert.match(captured.command, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    assert.deepStrictEqual(captured.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(captured.args[4], 'base64').toString('utf16le');
    assert.strictEqual(script, fs.readFileSync(path.join(__dirname, '../src/main/security/windows-assessment.ps1'), 'utf8'));
    assert.match(script, /Get-NetFirewallProfile -PolicyStore ActiveStore/);
    assert.doesNotMatch(script, /Start-MpScan|Start-Process|Set-ItemProperty|Invoke-Expression|-Credential|KeyProtector\s*=/);
    assert.strictEqual(captured.options.windowsHide, true);
    assert.strictEqual(captured.options.timeout, 45000);
    assert.strictEqual(captured.options.maxBuffer, 1024 * 1024);
    assert.ok(!captured.options.shell);
  });

  await test('Windows inventory cancellation kills its child and restores the existing hook', async () => {
    let previousCalled = 0;
    let killed = 0;
    let completion;
    const previous = () => { previousCalled++; };
    const signal = { onStop: previous };
    const pending = runWindowsInventory(signal, (_command, _args, _options, callback) => {
      completion = callback;
      return { kill() { killed++; queueMicrotask(() => callback({ killed: true }, '', 'private stderr')); } };
    });
    signal.stopped = true;
    signal.onStop();
    await assert.rejects(pending, /^Error: Assessment cancelled$/);
    assert.strictEqual(killed, 1);
    assert.strictEqual(previousCalled, 1);
    assert.strictEqual(signal.onStop, previous);
    completion(null, JSON.stringify(healthyFacts()), '');
    assert.throws(() => runWindowsInventory({ stopped: true }), /cancelled/);
  });

  await test('Windows inventory timeout, output overflow and launch errors redact raw process details', async () => {
    for (const error of [{ killed: true }, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, { code: 'EACCES', message: 'C:\\Users\\Private\\secret' }]) {
      await assert.rejects(runWindowsInventory({}, (_command, _args, _options, callback) => {
        queueMicrotask(() => callback(error, 'private stdout', 'private stderr'));
        return { kill() {} };
      }), (e) => /Windows inventory/.test(e.message) && !/private|secret|Users/i.test(e.message));
    }
    await assert.rejects(runWindowsInventory({}, () => { throw new Error('Private path'); }), /could not complete/);
  });

  await test('Windows inventory rejects malformed JSON, wrong schema and nonobject responses', async () => {
    for (const stdout of ['bad JSON', 'null', '[]', '{}', '{"schemaVersion":2}']) {
      await assert.rejects(runWindowsInventory({}, (_command, _args, _options, callback) => {
        queueMicrotask(() => callback(null, stdout, ''));
        return { kill() {} };
      }), /invalid response/);
    }
  });

  await test('Windows posture assessment refuses remote hosts and cancels before process launch', async () => {
    await assert.rejects(scanWindows({}, { stopped: true }), /cancelled/);
    if (process.platform === 'win32') await assert.rejects(scanWindows({ target: 'remote.example.invalid; injected' }), /This PC only/);
    else await assert.rejects(scanWindows(), /only on Windows/);
  });
}

module.exports = { runSecurityWindowsTests };
if (require.main === module) {
  let failures = 0;
  runSecurityWindowsTests(async (name, fn) => {
    try { await fn(); console.log('  ok   ' + name); }
    catch (error) { failures++; console.error('  FAIL ' + name, error); }
  }).then(() => { process.exitCode = failures ? 1 : 0; });
}
