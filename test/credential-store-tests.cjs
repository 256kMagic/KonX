'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/main/store');

// A reversible fixture adapter exercises the Store boundary, not Windows DPAPI.
const fixtureCrypt = () => ({
  available: () => true,
  encrypt: value => 'fixture:' + Buffer.from(value, 'utf8').toString('base64'),
  decrypt: value => {
    assert.ok(value.startsWith('fixture:'));
    return Buffer.from(value.slice(8), 'base64').toString('utf8');
  },
});

function withStore(run) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'konx-credential-store-'));
  const crypt = fixtureCrypt(), store = new Store(directory, crypt);
  try { return run({ store, crypt, directory, reload: () => new Store(directory, crypt) }); }
  finally {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('konx-credential-store-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function publicOnly(session) {
  for (const field of ['password', 'passphrase', 'passwordEnc', 'passphraseEnc']) assert.equal(Object.hasOwn(session, field), false, field + ' escaped the Store boundary');
  assert.equal(typeof session.hasPassword, 'boolean');
  assert.equal(typeof session.hasPassphrase, 'boolean');
}

function checkpoint(store) {
  const data = store.sessions.data;
  const value = structuredClone(data);
  const bytes = fs.existsSync(store.sessions.file) ? fs.readFileSync(store.sessions.file) : null;
  return () => {
    assert.equal(store.sessions.data, data, 'failed save published a different in-memory document');
    assert.deepEqual(store.sessions.data, value, 'failed save changed the in-memory session or folders');
    if (bytes) assert.deepEqual(fs.readFileSync(store.sessions.file), bytes, 'failed save changed persisted sessions');
    else assert.equal(fs.existsSync(store.sessions.file), false, 'failed creation wrote a sessions document');
  };
}

async function runCredentialStoreTests(test) {
  await test('credentials: new session persists username and both encrypted secrets across reload without public disclosure', () => withStore(({ store, reload }) => {
    const password = 'new-password-\u03bb-credential', passphrase = 'new-key-passphrase-credential';
    const input = { name: 'Saved router', host: '192.0.2.10', username: 'operator', protocol: 'ssh', folder: 'Lab/Core', password, passphrase };
    const saved = store.saveSession(input);
    publicOnly(saved); assert.equal(saved.username, 'operator'); assert.equal(saved.hasPassword, true); assert.equal(saved.hasPassphrase, true);
    assert.equal(input.password, password); assert.equal(input.passphrase, passphrase);
    const raw = fs.readFileSync(store.sessions.file, 'utf8');
    assert.equal(raw.includes(password), false); assert.equal(raw.includes(passphrase), false);
    const loaded = reload(); const secret = loaded.getSessionSecret(saved.id);
    assert.equal(secret.username, 'operator'); assert.equal(secret.password, password); assert.equal(secret.passphrase, passphrase);
    const listed = loaded.listSessions(); assert.deepEqual(listed.folders, ['Lab', 'Lab/Core']); publicOnly(listed.sessions[0]);
    assert.deepEqual(listed.sessions[0], saved);
  }));

  await test('credentials: blank and omitted fields retain existing secrets without requiring encryption availability', () => withStore(({ store, crypt, reload }) => {
    const saved = store.saveSession({ name: 'Retained', username: 'old-user', password: 'retained-password', passphrase: 'retained-passphrase' });
    const before = structuredClone(store.sessions.data.sessions[0]);
    crypt.available = () => { throw new Error('Retention must not query encryption'); };
    crypt.encrypt = () => { throw new Error('Retention must not re-encrypt'); };
    store.saveSession({ id: saved.id, username: 'new-user', password: '', passphrase: undefined });
    store.saveSession({ id: saved.id, name: 'Renamed', password: undefined, passphrase: '' });
    const stored = store.sessions.data.sessions[0];
    assert.equal(stored.passwordEnc, before.passwordEnc); assert.equal(stored.passphraseEnc, before.passphraseEnc);
    const secret = reload().getSessionSecret(saved.id);
    assert.equal(secret.username, 'new-user'); assert.equal(secret.name, 'Renamed');
    assert.equal(secret.password, 'retained-password'); assert.equal(secret.passphrase, 'retained-passphrase');
  }));

  await test('credentials: replacement and explicit null removal affect only the selected secret', () => withStore(({ store, crypt, reload }) => {
    const saved = store.saveSession({ name: 'Replace', password: 'original-password', passphrase: 'original-passphrase' });
    store.saveSession({ id: saved.id, password: 'replacement-password' });
    let secret = reload().getSessionSecret(saved.id);
    assert.equal(secret.password, 'replacement-password'); assert.equal(secret.passphrase, 'original-passphrase');
    store.saveSession({ id: saved.id, passphrase: 'replacement-passphrase' });
    crypt.available = () => false;
    const withoutPassword = store.saveSession({ id: saved.id, password: null });
    publicOnly(withoutPassword); assert.equal(withoutPassword.hasPassword, false); assert.equal(withoutPassword.hasPassphrase, true);
    secret = reload().getSessionSecret(saved.id); assert.equal(secret.password, undefined); assert.equal(secret.passphrase, 'replacement-passphrase');
    const withoutEither = store.saveSession({ id: saved.id, passphrase: null });
    assert.equal(withoutEither.hasPassphrase, false);
    const persisted = JSON.parse(fs.readFileSync(store.sessions.file, 'utf8')).sessions[0];
    assert.equal(Object.hasOwn(persisted, 'passwordEnc'), false); assert.equal(Object.hasOwn(persisted, 'passphraseEnc'), false);
  }));

  await test('credentials: unavailable encryption rejects creation and replacement without partial session or folder changes', () => withStore(({ store, crypt }) => {
    crypt.available = () => false;
    const unchangedNew = checkpoint(store);
    assert.throws(() => store.saveSession({ id: 'new', username: 'operator', folder: 'Uncommitted/New', password: 'unsaved-secret' }), /encryption is unavailable.*not saved/);
    unchangedNew();
    crypt.available = () => true;
    const saved = store.saveSession({ name: 'Original', username: 'original-user', password: 'original-secret', folder: 'Saved' });
    crypt.available = () => false;
    const unchangedEdit = checkpoint(store);
    assert.throws(() => store.saveSession({ id: saved.id, name: 'Changed', username: 'changed-user', folder: 'Uncommitted/Edit', password: 'replacement-secret' }), /encryption is unavailable/);
    unchangedEdit(); assert.equal(store.getSessionSecret(saved.id).password, 'original-secret');
    // A session without a requested secret can still be saved in this environment.
    const plain = store.saveSession({ name: 'No saved credential', username: 'operator', password: '' });
    publicOnly(plain); assert.equal(plain.hasPassword, false);
  }));

  await test('credentials: encryption failure after the first secret leaves both original secrets and metadata intact', () => withStore(({ store, crypt }) => {
    const saved = store.saveSession({ name: 'Original', password: 'old-password', passphrase: 'old-passphrase' });
    const unchanged = checkpoint(store), encrypt = crypt.encrypt;
    let calls = 0;
    crypt.encrypt = value => { calls++; if (calls === 2) throw new Error('provider leaked ' + value); return encrypt(value); };
    assert.throws(() => store.saveSession({ id: saved.id, name: 'Uncommitted', folder: 'Uncommitted/Child', password: 'new-password', passphrase: 'private-passphrase' }), error => {
      assert.equal(error.message, 'Could not encrypt the session passphrase. The session was not saved.');
      assert.equal(error.message.includes('private-passphrase'), false); return true;
    });
    assert.equal(calls, 2); unchanged();
  }));

  await test('credentials: failed availability checks and invalid encryption results reject without publishing a secretless session', () => withStore(({ store, crypt }) => {
    const unchanged = checkpoint(store);
    crypt.available = () => { throw new Error('provider-private-detail'); };
    assert.throws(() => store.saveSession({ name: 'Unavailable', password: 'private-password' }), error => {
      assert.match(error.message, /encryption is unavailable/); assert.equal(error.message.includes('provider-private-detail'), false); return true;
    });
    unchanged(); crypt.available = () => true;
    for (const result of ['', undefined, Buffer.from('invalid-adapter-result')]) {
      crypt.encrypt = () => result;
      assert.throws(() => store.saveSession({ name: 'Invalid result', password: 'private-password' }), /Could not encrypt the session password/);
      unchanged();
    }
  }));

  await test('credentials: caller ciphertext and presence flags cannot replace or forge stored secrets', () => withStore(({ store }) => {
    const forged = { passwordEnc: 'caller-password', passphraseEnc: 'caller-passphrase', hasPassword: true, hasPassphrase: true };
    const created = store.saveSession({ name: 'No credentials', ...forged });
    publicOnly(created); assert.equal(created.hasPassword, false); assert.equal(created.hasPassphrase, false);
    const saved = store.saveSession({ name: 'Owned credentials', password: 'owned-password', passphrase: 'owned-passphrase' });
    const updated = store.saveSession({ id: saved.id, ...forged, password: '', passphrase: undefined, hasPassword: false });
    publicOnly(updated); assert.equal(updated.hasPassword, true); assert.equal(updated.hasPassphrase, true);
    assert.equal(store.getSessionSecret(saved.id).password, 'owned-password'); assert.equal(store.getSessionSecret(saved.id).passphrase, 'owned-passphrase');
    const removed = store.saveSession({ id: saved.id, ...forged, password: null, passphrase: null });
    publicOnly(removed); assert.equal(removed.hasPassword, false); assert.equal(removed.hasPassphrase, false);
    assert.equal(fs.readFileSync(store.sessions.file, 'utf8').includes('caller-'), false);
  }));

  await test('credentials: public listing strips plaintext fields from pre-existing malformed records', () => withStore(({ store, reload }) => {
    fs.writeFileSync(store.sessions.file, JSON.stringify({ version: 1, folders: [], sessions: [{ id: 'legacy', name: 'Legacy', password: 'plaintext-password', passphrase: 'plaintext-passphrase', hasPassword: 'forged', hasPassphrase: 'forged', passwordEnc: 'owned-ciphertext' }] }));
    const loaded = reload(), listed = loaded.listSessions().sessions[0];
    publicOnly(listed); assert.equal(listed.hasPassword, true); assert.equal(listed.hasPassphrase, false);
    assert.equal(JSON.stringify(listed).includes('plaintext-'), false); assert.equal(JSON.stringify(listed).includes('owned-ciphertext'), false);
    publicOnly(loaded.saveSession({ id: 'legacy', name: 'Edited' }));
    assert.equal(fs.readFileSync(store.sessions.file, 'utf8').includes('plaintext-'), false);
  }));

  await test('credentials: failed file replacement preserves the previous document, credentials and folders and permits retry', () => withStore(({ store, reload }) => {
    const saved = store.saveSession({ name: 'Original', username: 'original-user', folder: 'Original', password: 'original-password' });
    const unchanged = checkpoint(store), rename = fs.renameSync;
    const patch = { id: saved.id, name: 'Replacement', username: 'replacement-user', folder: 'Replacement/Child', password: 'replacement-password' };
    try {
      fs.renameSync = (source, destination) => { if (destination === store.sessions.file) throw Object.assign(new Error('Synthetic sessions file lock'), { code: 'EACCES' }); return rename(source, destination); };
      assert.throws(() => store.saveSession(patch), { code: 'EACCES' }); unchanged();
      assert.equal(reload().getSessionSecret(saved.id).password, 'original-password');
    } finally { fs.renameSync = rename; }
    const updated = store.saveSession(patch); publicOnly(updated);
    assert.equal(reload().getSessionSecret(saved.id).password, 'replacement-password');
    assert.deepEqual(store.listSessions().folders, ['Original', 'Replacement', 'Replacement/Child']);
  }));

  await test('credentials: a failed initial write publishes neither the new session nor its folders', () => withStore(({ store }) => {
    const unchanged = checkpoint(store), write = fs.writeFileSync;
    try {
      fs.writeFileSync = (file, ...args) => { if (file === store.sessions.file + '.tmp') throw Object.assign(new Error('Synthetic full disk'), { code: 'ENOSPC' }); return write(file, ...args); };
      assert.throws(() => store.saveSession({ id: 'uncommitted', name: 'Uncommitted', folder: 'New/Child', password: 'new-password' }), { code: 'ENOSPC' });
      unchanged(); assert.equal(store.getSessionSecret('uncommitted'), null);
    } finally { fs.writeFileSync = write; }
  }));
}

module.exports = { runCredentialStoreTests };
if (require.main === module) (async () => {
  let passed = 0, failed = 0;
  await runCredentialStoreTests(async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name, error); } });
  console.log(`${passed}/${passed + failed} credential Store tests passed`); process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
