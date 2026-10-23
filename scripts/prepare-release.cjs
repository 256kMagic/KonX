'use strict';
// Produce the complete release bundle before publishing it as GitHub's latest.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function main() {
  const root = path.resolve(__dirname, '..');
  const { version } = require('../package.json');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('A stable release version is required');
  const binaries = [`KonX-Setup-${version}.exe`, `KonX-${version}-portable.exe`];
  const documents = [
    ['docs/USER_GUIDE.md', 'USER_GUIDE.md'], ['docs/UPDATING.md', 'UPDATING.md'],
    ['docs/SECURITY_SUITE.md', 'SECURITY_SUITE.md'], ['docs/WIRELESS_MIST_GUIDE.md', 'WIRELESS_MIST_GUIDE.md'],
    ['docs/AI_KNOWLEDGE_GUIDE.md', 'AI_KNOWLEDGE_GUIDE.md'],
    ['docs/COPILOT.md', 'COPILOT.md'],
    ['docs/DEVICE_INSPECTOR.md', 'DEVICE_INSPECTOR.md'],
    ['docs/DEVICE_SNAPSHOTS.md', 'DEVICE_SNAPSHOTS.md'],
    ['docs/RTP_MEDIA.md', 'RTP_MEDIA.md'],
    ['docs/INCIDENT_WORKSPACES.md', 'INCIDENT_WORKSPACES.md'],
    ['docs/REMOTE_CAPTURE.md', 'REMOTE_CAPTURE.md'],
    ['docs/RUNBOOKS.md', 'RUNBOOKS.md'],
    ['docs/CAPTURE_COMPARISON.md', 'CAPTURE_COMPARISON.md'],
    ['docs/WORKSPACE_LAYOUTS.md', 'WORKSPACE_LAYOUTS.md'],
    ['docs/SESSION_MANAGEMENT.md', 'SESSION_MANAGEMENT.md'],
    ['docs/SSH_COMPATIBILITY.md', 'SSH_COMPATIBILITY.md'],
    ['docs/CISCO_HIGHLIGHTING.md', 'CISCO_HIGHLIGHTING.md'],
    ['docs/SERIAL_AUTO_BAUD.md', 'SERIAL_AUTO_BAUD.md'],
    ['docs/TESTER_SUPPORT.md', 'TESTER_SUPPORT.md'],
    ['docs/SITE_WORKSPACES.md', 'SITE_WORKSPACES.md'],
    ['docs/TOPOLOGY.md', 'TOPOLOGY.md'],
    ['docs/EVENTS.md', 'EVENTS.md'],
    ['docs/CHANGE_VALIDATION.md', 'CHANGE_VALIDATION.md'],
    ['CHANGELOG.md', 'CHANGELOG.md'], [`docs/releases/${version}.md`, 'RELEASE_NOTES.md'],
  ];
  for (const file of [...binaries.map((name) => `dist/${name}`), ...documents.map(([source]) => source)]) {
    if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Required release file missing: ${file}`);
  }
  const output = path.join(root, 'publication', `v${version}`);
  fs.mkdirSync(output, { recursive: true });
  // A failed preparation must not leave an older manifest advertising new files.
  const manifest = path.join(output, 'SHA256SUMS.txt');
  try { fs.unlinkSync(manifest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of binaries) fs.copyFileSync(path.join(root, 'dist', name), path.join(output, name));
  for (const [source, name] of documents) {
    const text = fs.readFileSync(path.join(root, source), 'utf8');
    const downloadable = text.replace(/(!?\[[^\]\r\n]*\])\(([^)\r\n]+)\)/g, (match, label, target) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return match;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), target));
      if (resolved.startsWith('../') || !fs.existsSync(path.join(root, resolved.split('#')[0]))) throw new Error(`Broken documentation link: ${source} -> ${target}`);
      const prefix = label.startsWith('!') || /\.(pcapng|png|jpg|svg)$/.test(resolved)
        ? `https://raw.githubusercontent.com/256kMagic/KonX/v${version}/`
        : `https://github.com/256kMagic/KonX/blob/v${version}/`;
      return `${label}(${prefix}${resolved})`;
    });
    fs.writeFileSync(path.join(output, name), downloadable);
  }
  const names = [...binaries, ...documents.map(([, name]) => name)];
  const lines = [];
  for (const name of names) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(output, name))) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${name}`);
  }
  fs.writeFileSync(manifest, lines.join('\n') + '\n');
  console.log(`Prepared ${names.length + 1} release files in ${output}`);
  console.log('Upload the complete bundle to a draft release before marking it latest.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
