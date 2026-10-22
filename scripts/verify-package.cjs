'use strict';
// Check the built application against this checkout before publishing a release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const { verifySsh2Patch } = require('./patch-ssh2.cjs');
const root = path.resolve(__dirname, '..');
const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
const pkg = require('../package.json');
const extract = name => asar.extractFile(archive, path.normalize(name));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function files(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const name = directory + '/' + entry.name;
    return entry.isDirectory() ? files(name) : [name];
  });
}
assert.equal(JSON.parse(extract('package.json')).version, pkg.version, 'Packaged version mismatch');
const sources = files('src').map(name => {
  const source = fs.readFileSync(path.join(root, name));
  assert(source.equals(extract(name)), 'Packaged source mismatch: ' + name);
  return { name, sha256: hash(source) };
});
const dependencies = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).map(name => {
  const dependency = JSON.parse(extract('node_modules/' + name + '/package.json'));
  const entry = name === '@noble/hashes' ? 'argon2.js' : (dependency.main || 'index.js');
  assert(extract('node_modules/' + name + '/' + entry).length, 'Missing dependency entry: ' + name);
  return { name, version: dependency.version };
});
const ssh2Patch = verifySsh2Patch(extract('node_modules/ssh2/lib/protocol/kex.js'), dependencies.find(item => item.name === 'ssh2').version);
for (const name of files('assets').filter(name => name.endsWith('.json'))) assert(fs.readFileSync(path.join(root, name)).equals(extract(name)), 'Packaged demo differs: ' + name);
for (const name of [`KonX-Setup-${pkg.version}.exe`, `KonX-${pkg.version}-portable.exe`]) assert(fs.statSync(path.join(root, 'dist', name)).size > 1024 * 1024, 'Missing release executable: ' + name);
const output = path.join(root, 'review', 'release-' + pkg.version);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'package-verification.json'), JSON.stringify({ checkedAt: new Date().toISOString(), version: pkg.version, passed: true, sourceCount: sources.length, sources, dependencies, ssh2Patch }, null, 2));
console.log(`Package ${pkg.version}: ${sources.length} source files and ${dependencies.length} runtime dependencies verified.`);
