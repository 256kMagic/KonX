'use strict';

const assert = require('node:assert/strict');
const { createPrivateKey, sign } = require('node:crypto');
const { utils } = require('ssh2');
const { sshHostKey } = require('./lib/ssh-host-key.cjs');

async function runSshHostKeyTests(test) {
  await test('local SSH fixture host key preserves its native key identity through ssh2 parsing', async () => {
    const key = sshHostKey();
    assert.match(key, /^-----BEGIN RSA PRIVATE KEY-----/);
    assert.equal(sshHostKey(), key, 'reuse only the process-local test identity');
    const native = createPrivateKey(key);
    assert.equal(native.asymmetricKeyDetails.modulusLength, 2048);
    const parsed = utils.parseKey(key);
    assert.ok(!(parsed instanceof Error), parsed instanceof Error ? parsed.message : 'parsed');
    assert.equal(parsed.type, 'ssh-rsa');
    const challenge = Buffer.from('KonX local SSH fixture key boundary');
    assert.equal(parsed.verify(challenge, sign('sha256', challenge, native), 'sha256'), true);
  });
}

module.exports = { runSshHostKeyTests };

if (require.main === module) {
  let failed = 0;
  runSshHostKeyTests(async (name, fn) => {
    try { await fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  }).then(() => { process.exitCode = failed ? 1 : 0; })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
