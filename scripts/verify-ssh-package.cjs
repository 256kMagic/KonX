'use strict';
// Exercise the shipped runtime and ASAR, including the private-key worker and
// its ESM Argon2 dependency. All peers and keys are isolated synthetic fixtures.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { version } = require('../package.json');
const executable = path.join(root, 'dist/win-unpacked/KonX.exe');
const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
const output = path.join(root, 'review', 'release-' + version);
assert(fs.statSync(executable).isFile() && fs.statSync(archive).isFile(), 'Build the package first.');
fs.mkdirSync(output, { recursive: true });
function run(command, file, name, electron) {
  const env = { ...process.env, KONX_TEST_ASAR: archive, KONX_TEST_EXECUTABLE: executable };
  if (electron) env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(command, [path.join(root, file)], {
    cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 240000,
  });
  const log = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(output, name + '.log'), log);
  assert.equal(result.status, 0, name + ' failed: ' + (result.error?.message || log.slice(-4000)));
  const match = log.match(/(\d+)\/(\d+) SSH (?:compatibility|key) tests passed/);
  assert(match && match[1] === match[2], name + ' did not report a passing suite');
  console.log(name + ': ' + match[1] + '/' + match[2] + ' passed');
  return { passed: true, tests: Number(match[1]), log: name + '.log' };
}
const negotiation = run(executable, 'test/ssh-compatibility-tests.cjs', 'ssh-packaged-negotiation', true);
// The host Node process generates encrypted fixtures using OpenSSL, then the
// suite launches KonX.exe to load and authenticate them using packaged code.
const keys = run(process.execPath, 'test/ssh-key-tests.cjs', 'ssh-packaged-keys', false);
fs.writeFileSync(path.join(output, 'ssh-package-verification.json'), JSON.stringify({
  checkedAt: new Date().toISOString(), version, passed: true, archive, executable, negotiation, keys,
}, null, 2));
