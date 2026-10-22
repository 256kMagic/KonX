'use strict';

// Run the serial transport regressions against the shipped ASAR/runtime using
// synthetic bindings. This never enumerates or opens a physical serial port.
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
const result = cp.spawnSync(executable, [path.join(root, 'test/serial-autobaud-tests.cjs')], {
  cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KONX_TEST_ASAR: archive },
  encoding: 'utf8', windowsHide: true, timeout: 120000,
});
const log = (result.stdout || '') + (result.stderr || '');
fs.writeFileSync(path.join(output, 'serial-packaged.log'), log);
assert.equal(result.status, 0, 'Packaged serial tests failed: ' + (result.error?.message || log.slice(-4000)));
const tests = (log.match(/^PASS /gm) || []).length;
assert(tests > 0, 'Packaged serial tests did not report any passing checks.');
fs.writeFileSync(path.join(output, 'serial-package-verification.json'), JSON.stringify({
  checkedAt: new Date().toISOString(), version, passed: true, tests, archive, executable,
  physicalHardwareTested: false, log: 'serial-packaged.log',
}, null, 2));
console.log(`Packaged serial: ${tests} checks passed with synthetic bindings.`);
