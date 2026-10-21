'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getInstallTarget, launchUpdate } = require('../src/main/update-install');
const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function eventually(read, predicate, timeout = 15000) {
  const until = Date.now() + timeout;
  let value;
  while (Date.now() < until) {
    try { value = await read(); if (predicate(value)) return value; } catch (error) { if (!['ENOENT', 'EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    await sleep(50);
  }
  throw new Error('Timed out waiting for helper: ' + JSON.stringify(value));
}
const readStatus = (file) => fs.readFile(file, 'utf8').then(JSON.parse);
const terminal = (file) => eventually(() => readStatus(file), (s) => ['complete', 'failed', 'cancelled'].includes(s.phase));

async function compileFixture(directory, name) {
  const source = path.join(directory, name + '.cs');
  const executable = path.join(directory, name + '.exe');
  await fs.writeFile(source, `using System; using System.IO; using System.Text; using System.Reflection;
public class Fixture {
  public static int Main(string[] args) {
    if (args.Length == 3 && args[0] == "lock-status") {
      using (FileStream heldStatus = new FileStream(args[1], FileMode.Open, FileAccess.Read, FileShare.Read)) {
        File.WriteAllText(args[2], "locked"); Console.ReadLine();
      }
      return 0;
    }
    string location = Assembly.GetExecutingAssembly().Location;
    string[] values = new string[] { "${name}", location, Environment.CommandLine,
      Environment.GetEnvironmentVariable("PORTABLE_EXECUTABLE_FILE") ?? "",
      Environment.GetEnvironmentVariable("PORTABLE_EXECUTABLE_DIR") ?? "",
      Environment.GetEnvironmentVariable("KONX_CAPTURE") ?? "",
      Environment.GetEnvironmentVariable("KONX_DEMO") ?? "",
      Environment.GetEnvironmentVariable("KONX_USERDATA") ?? "" };
    for (int i = 0; i < values.Length; i++) values[i] = Convert.ToBase64String(Encoding.UTF8.GetBytes(values[i]));
    FileStream held = args.Length > 0 && args[0] == "hold" ? new FileStream(location, FileMode.Open, FileAccess.Read, FileShare.Read) : null;
    File.WriteAllLines(location + ".invocation", values);
    if (held != null) { Console.ReadLine(); held.Dispose(); }
    return 0;
  }
}`);
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await execute(compiler, ['/nologo', '/target:exe', '/out:' + executable, source], { windowsHide: true, timeout: 30000 });
  return executable;
}

async function runUpdateInstallTests(test) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'konx-update-install-test-'));
  const children = new Set();
  const registryKeys = new Set();
  const parent = (executable = process.execPath, args = ['-e', 'process.stdin.resume()']) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    children.add(child);
    child.once('exit', () => children.delete(child));
    return child;
  };
  const end = async (child) => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    await exited;
  };
  const registrations = async (directory, action, key) => {
    const name = key || 'KonXUpdateFixture-' + crypto.randomBytes(8).toString('hex');
    const registryPath = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + name;
    if (action === 'remove') {
      await execute('reg.exe', ['delete', registryPath, '/f'], { windowsHide: true });
      registryKeys.delete(registryPath);
    } else {
      registryKeys.add(registryPath);
      for (const [value, data] of [['DisplayName', 'KonX'], ['InstallLocation', directory]]) {
        await execute('reg.exe', ['add', registryPath, '/v', value, '/t', 'REG_SZ', '/d', data, '/f'], { windowsHide: true });
      }
    }
    return name;
  };
  try {
    await test('updater installation refuses development, unsupported and unpacked targets', async () => {
      assert.equal(getInstallTarget({ isPackaged: false }).mode, 'unsupported');
      assert.equal(getInstallTarget({ isPackaged: true, platform: 'linux' }).mode, 'unsupported');
      assert.equal(getInstallTarget({ isPackaged: true, platform: 'win32', arch: 'arm64' }).mode, 'unsupported');
      const executable = path.join(root, 'KonX.exe');
      await fs.writeFile(executable, 'fixture');
      const args = { isPackaged: true, platform: 'win32', arch: 'x64', execPath: executable, portablePath: '' };
      assert.equal(getInstallTarget(args).mode, 'unsupported');
      await fs.mkdir(path.join(root, 'resources'));
      await fs.writeFile(path.join(root, 'resources', 'app.asar'), 'fixture');
      await fs.writeFile(path.join(root, 'Uninstall KonX.exe'), 'fixture');
      assert.equal(getInstallTarget(args).mode, 'installed');
      assert.equal(getInstallTarget({ ...args, portablePath: executable }).mode, 'portable');
      assert.equal(getInstallTarget({ ...args, portablePath: 'relative.exe' }).mode, 'unsupported');
    });
    if (process.platform !== 'win32') return;
    const oldExe = await compileFixture(root, 'original');
    const newExe = await compileFixture(root, 'replacement');
    const originalBytes = await fs.readFile(oldExe);
    const replacementBytes = await fs.readFile(newExe);
    let number = 0;
    const fixture = async (mode = 'portable', data = replacementBytes) => {
      // Spaces, &, apostrophes and backticks remain filesystem data, not commands.
      const directory = path.join(root, `case ${++number} & O'Brien ` + '`fixture');
      await fs.mkdir(directory);
      const targetPath = path.join(directory, mode === 'installed' ? 'KonX.exe' : 'My renamed KonX.exe');
      const file = path.join(directory, 'download.exe');
      await fs.writeFile(targetPath, originalBytes);
      await fs.writeFile(file, data);
      if (mode === 'installed') {
        await fs.mkdir(path.join(directory, 'resources'));
        await fs.writeFile(path.join(directory, 'resources', 'app.asar'), 'fixture');
        await fs.writeFile(path.join(directory, 'Uninstall KonX.exe'), 'fixture');
      }
      return { directory, target: { mode, targetPath }, update: { mode, file, size: data.length, sha256: digest(data), version: '9.9.9' }, cacheDir: path.join(directory, 'cache'), showFailure: false };
    };
    await test('updater real helper verifies readiness and cancellation without replacing or quitting', async () => {
      const options = await fixture();
      const p = parent();
      const helper = await launchUpdate({ ...options, parentPid: p.pid });
      assert.equal((await readStatus(helper.statusPath)).phase, 'ready');
      const ready = await readStatus(path.join(path.dirname(helper.statusPath), 'ready.json'));
      assert.match(ready.parentStartTicks, /^\d+$/);
      assert.equal(ready.parentPid, p.pid);
      await helper.cancel();
      assert.equal((await terminal(helper.statusPath)).phase, 'cancelled');
      await assert.rejects(fs.stat(path.join(path.dirname(helper.statusPath), 'payload.exe')), { code: 'ENOENT' });
      assert.equal((await fs.readdir(options.directory)).some((file) => file.endsWith('.new.exe')), false);
      assert.equal(p.exitCode, null);
      assert.deepEqual(await fs.readFile(options.target.targetPath), originalBytes);
      await end(p);
    });
    await test('updater real helper rejects corrupted payload before the application quits', async () => {
      const options = await fixture();
      options.update.sha256 = '0'.repeat(64);
      const p = parent();
      let failure;
      await assert.rejects(launchUpdate({ ...options, parentPid: p.pid }), (error) => { failure = error; return /SHA-256/.test(error.message); });
      assert.equal((await readStatus(failure.statusPath)).phase, 'failed');
      await assert.rejects(fs.stat(path.join(path.dirname(failure.statusPath), 'payload.exe')), { code: 'ENOENT' });
      assert.equal(p.exitCode, null);
      assert.deepEqual(await fs.readFile(options.target.targetPath), originalBytes);
      await end(p);
    });
    await test('updater cancellation remains retryable when its signal cannot be written', async () => {
      const options = await fixture();
      const p = parent();
      const helper = await launchUpdate({ ...options, parentPid: p.pid });
      const rename = fs.rename;
      try {
        fs.rename = async (source, target) => {
          if (target === path.join(path.dirname(helper.statusPath), 'cancel.json')) throw Object.assign(new Error('Synthetic signal write denial'), { code: 'EACCES' });
          return rename(source, target);
        };
        await assert.rejects(helper.cancel(), /Synthetic signal/);
      } finally { fs.rename = rename; }
      await helper.cancel();
      assert.equal((await terminal(helper.statusPath)).phase, 'cancelled');
      assert.deepEqual(await fs.readFile(options.target.targetPath), originalBytes);
      await end(p);
    });
    await test('updater polling retries transient Windows status read locks within its handoff deadline', async () => {
      const options = await fixture();
      const p = parent();
      const helper = await launchUpdate({ ...options, parentPid: p.pid });
      const readFile = fs.readFile;
      const errors = ['EBUSY', 'EACCES', 'EPERM'];
      let failures = 0;
      try {
        fs.readFile = async (file, ...args) => {
          if (file === helper.statusPath && failures < errors.length) throw Object.assign(new Error('Synthetic Windows status lock'), { code: errors[failures++] });
          return readFile(file, ...args);
        };
        await helper.commit();
      } finally { fs.readFile = readFile; }
      assert.equal(failures, 3);
      await helper.cancel();
      assert.equal((await terminal(helper.statusPath)).phase, 'cancelled');
      await end(p);
    });
    await test('updater real helper preserves the last status while a Windows reader temporarily blocks replacement', async () => {
      const options = await fixture();
      const p = parent();
      const helper = await launchUpdate({ ...options, parentPid: p.pid });
      const marker = path.join(options.directory, 'status-locked');
      const reader = parent(oldExe, ['lock-status', helper.statusPath, marker]);
      await eventually(() => fs.stat(marker), () => true);
      const pending = helper.commit();
      await sleep(250);
      assert.equal((await readStatus(helper.statusPath)).phase, 'ready', 'the previous complete status remains readable while replacement retries');
      await end(reader);
      await pending;
      await helper.cancel();
      assert.equal((await terminal(helper.statusPath)).phase, 'cancelled');
      await end(p);
    });
    await test('updater real portable helper replaces atomically and restarts the same filename with clean bootstrap environment', async () => {
      const options = await fixture();
      const p = parent();
      const originalEnv = Object.fromEntries(['PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR', 'KONX_CAPTURE', 'KONX_DEMO', 'KONX_USERDATA'].map((key) => [key, process.env[key]]));
      let helper;
      try {
        Object.assign(process.env, { PORTABLE_EXECUTABLE_FILE: 'stale.exe', PORTABLE_EXECUTABLE_DIR: 'stale-dir', KONX_CAPTURE: '1', KONX_DEMO: '1', KONX_USERDATA: path.join(options.directory, 'chosen profile') });
        helper = await launchUpdate({ ...options, parentPid: p.pid });
      } finally { for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
      await helper.commit();
      assert.deepEqual(await fs.readFile(options.target.targetPath), originalBytes, 'commit alone must not replace an active app');
      await end(p);
      const status = await terminal(helper.statusPath);
      assert.equal(status.phase, 'complete', status.message);
      assert.deepEqual(await fs.readFile(options.target.targetPath), replacementBytes);
      assert.deepEqual(await fs.readFile(status.backupPath), originalBytes);
      const values = (await fs.readFile(options.target.targetPath + '.invocation', 'utf8')).trim().split(/\r?\n/).map((s) => Buffer.from(s, 'base64').toString());
      assert.equal(values[0], 'replacement');
      assert.equal(values[1], options.target.targetPath);
      assert.deepEqual(values.slice(3, 7), ['', '', '', '']);
      assert.equal(values[7], path.join(options.directory, 'chosen profile'));
    });
    await test('updater real helper times out without installing when the committed parent stays alive', async () => {
      const options = await fixture();
      const p = parent();
      const helper = await launchUpdate({ ...options, parentPid: p.pid, exitTimeoutMs: 500 });
      await helper.commit();
      const status = await terminal(helper.statusPath);
      assert.equal(status.phase, 'failed');
      assert.match(status.message, /did not exit/);
      assert.equal(p.exitCode, null);
      assert.deepEqual(await fs.readFile(options.target.targetPath), originalBytes);
      await end(p);
    });
    await test('updater real helper survives the spawning Node process exiting after commit', async () => {
      const options = await fixture();
      const script = path.join(options.directory, 'launch-parent.cjs');
      const input = path.join(options.directory, 'launch-options.json');
      await fs.writeFile(script, `const fs = require('fs');
const { launchUpdate } = require(${JSON.stringify(require.resolve('../src/main/update-install'))});
(async () => {
  const handoff = await launchUpdate(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
  await handoff.commit();
  process.stdout.write(handoff.statusPath, () => process.exit(0));
})().catch(error => { console.error(error); process.exit(1); });`);
      await fs.writeFile(input, JSON.stringify(options));
      const { stdout } = await execute(process.execPath, [script, input], { windowsHide: true, timeout: 15000 });
      const status = await terminal(stdout.trim());
      assert.equal(status.phase, 'complete', status.message);
      assert.deepEqual(await fs.readFile(options.target.targetPath), replacementBytes);
      await assert.rejects(fs.stat(path.join(path.dirname(stdout.trim()), 'payload.exe')), { code: 'ENOENT' });
    });
    await test('updater real helper cancels a committed handoff before parent exit', async () => {
      const options = await fixture();
      const p = parent();
      const helper = await launchUpdate({ ...options, parentPid: p.pid });
      await helper.commit();
      await helper.cancel();
      assert.equal((await terminal(helper.statusPath)).phase, 'cancelled');
      await end(p);
      assert.deepEqual(await fs.readFile(options.target.targetPath), originalBytes);
    });
    await test('updater real portable helper waits for a separate launcher lock without killing it', async () => {
      const options = await fixture();
      const launcher = parent(options.target.targetPath, ['hold']);
      await eventually(() => fs.stat(options.target.targetPath + '.invocation'), () => true);
      const p = parent();
      const helper = await launchUpdate({ ...options, parentPid: p.pid });
      await helper.commit();
      await end(p);
      await eventually(() => readStatus(helper.statusPath), (s) => s.phase === 'replacing');
      await sleep(250);
      assert.equal(launcher.exitCode, null);
      assert.deepEqual(await fs.readFile(options.target.targetPath), originalBytes);
      await end(launcher);
      const status = await terminal(helper.statusPath);
      assert.equal(status.phase, 'complete', status.message);
      assert.deepEqual(await fs.readFile(options.target.targetPath), replacementBytes);
    });
    await test('updater real portable helper retains an independent target change', async () => {
      const options = await fixture();
      const p = parent();
      const helper = await launchUpdate({ ...options, parentPid: p.pid });
      await fs.writeFile(options.target.targetPath, replacementBytes);
      await helper.commit();
      await end(p);
      const status = await terminal(helper.statusPath);
      assert.equal(status.phase, 'failed');
      assert.match(status.message, /changed after/);
      assert.deepEqual(await fs.readFile(options.target.targetPath), replacementBytes);
    });
    await test('updater real portable helper restores and restarts the original if replacement cannot launch', async () => {
      const badPayload = Buffer.from('This is deliberately not a Windows executable.');
      const options = await fixture('portable', badPayload);
      const p = parent();
      const helper = await launchUpdate({ ...options, parentPid: p.pid });
      await helper.commit();
      await end(p);
      const status = await terminal(helper.statusPath);
      assert.equal(status.phase, 'failed');
      assert.match(status.message, /previous portable executable was restored/);
      assert.deepEqual(await fs.readFile(options.target.targetPath), originalBytes);
      assert.deepEqual(await fs.readFile(status.failedPath), badPayload);
      const first = (await fs.readFile(options.target.targetPath + '.invocation', 'utf8')).split(/\r?\n/)[0];
      assert.equal(Buffer.from(first, 'base64').toString(), 'original');
    });
    await test('updater real installed helper rejects missing registration before quit', async () => {
      const options = await fixture('installed');
      const p = parent();
      await assert.rejects(launchUpdate({ ...options, parentPid: p.pid }), /installation mode/);
      assert.equal(p.exitCode, null);
      await end(p);
    });
    await test('updater real installed helper preserves explicit mode and final unquoted NSIS directory with spaces', async () => {
      const options = await fixture('installed');
      const key = await registrations(options.directory, 'add');
      const p = parent();
      try {
        const helper = await launchUpdate({ ...options, parentPid: p.pid });
        await helper.commit();
        await end(p);
        const status = await terminal(helper.statusPath);
        assert.equal(status.phase, 'complete', status.message);
        const record = await fs.readFile(path.join(path.dirname(helper.statusPath), 'payload.exe.invocation'), 'utf8');
        const command = Buffer.from(record.split(/\r?\n/)[2], 'base64').toString();
        assert.ok(command.endsWith('--updated /S --force-run /currentuser /D=' + options.directory), command);
        assert.deepEqual(await fs.readFile(options.target.targetPath), originalBytes, 'the fake installer never modifies an application');
      } finally { await registrations(options.directory, 'remove', key); await end(p); }
    });
  } finally {
    for (const child of children) await end(child);
    for (const key of registryKeys) await execute('reg.exe', ['delete', key, '/f'], { windowsHide: true });
    // This exact, exclusively created temporary directory contains only fixtures.
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('konx-update-install-test-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

module.exports = { runUpdateInstallTests };
if (require.main === module) {
  let failures = 0;
  runUpdateInstallTests(async (name, fn) => {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); }
  }).then(() => { process.exitCode = failures ? 1 : 0; }).catch((error) => { console.error(error); process.exitCode = 1; });
}
