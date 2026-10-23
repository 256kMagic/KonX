'use strict';

// Exercise the shipped application without using a user's profile, credentials,
// network targets or native dialogs. The two launches also verify encrypted
// credential persistence and removal across a restart.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const TOKEN = 'KonX_Synthetic_Mist_Token_For_Package_Smoke_Only';
const assert = (value, message) => { if (!value) throw new Error(message); };

async function loggingPeer(run) {
  const sockets = new Set();
  const nonce = crypto.randomBytes(12).toString('hex');
  const logDirectory = path.join(run, 'logs');
  fs.mkdirSync(logDirectory);
  const options = { host: '127.0.0.1', port: null, logPath: path.join(logDirectory, 'synthetic-console.txt'),
    onMarker: 'KONX_LOG_ON_' + nonce, offMarker: 'KONX_LOG_OFF_' + nonce };
  options.ciscoMarker = 'KONX_CISCO_DONE_' + nonce;
  options.ciscoSample = 'Gi0/1 192.0.2.16 YES manual up up\r\nGi0/2 unassigned YES unset administratively down down\r\n% Invalid input detected at marker.\r\n' + options.ciscoMarker + '\r\n';
  const observed = { connections: 0, received: '' };
  const server = net.createServer(socket => {
    sockets.add(socket); observed.connections++;
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', bytes => {
      observed.received += bytes.toString('utf8');
      if (observed.received.length > 8192) return socket.destroy();
      socket.write(bytes);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, options.host, resolve);
  });
  options.port = server.address().port;
  return { options, observed, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

async function quickLoginPeer() {
  const { Server, utils } = require('ssh2');
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const nonce = crypto.randomBytes(12).toString('hex');
  const options = { host: '127.0.0.1', port: null, username: 'konx-fixture-' + nonce.slice(0, 8),
    password: 'Synthetic-password-' + nonce, fingerprint, marker: 'KONX_SAVED_LOGIN_' + nonce };
  const clients = new Set(), observed = { successfulAuthentications: 0, shells: 0 };
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === options.username && context.password === options.password) {
        observed.successfulAuthentications++; context.accept();
      } else context.reject(['password']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', acceptPty => acceptPty?.());
      session.on('window-change', acceptChange => acceptChange?.());
      session.on('shell', acceptShell => {
        observed.shells++;
        const stream = acceptShell(); stream.on('error', () => {});
        stream.write(options.marker + '\r\n');
      });
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, options.host, resolve);
  });
  options.port = server.address().port;
  return { options, observed, close: async () => {
    for (const client of clients) client.end();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

async function eventPeer() {
  const reservation = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.bind(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const socket = dgram.createSocket('udp4'), marker = 'KONX_SYNTHETIC_EVENT_' + crypto.randomBytes(12).toString('hex');
  const message = Buffer.from('<134>1 2026-10-23T12:00:00Z fixture konx 1 TEST - ' + marker);
  socket.on('error', () => {});
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const timer = setInterval(() => socket.send(message, port, '127.0.0.1', () => {}), 100);
  return { options: { port, marker }, close: async () => { clearInterval(timer); await new Promise(resolve => socket.close(resolve)); } };
}

async function nativeLoader(executable) {
  const archive = path.join(path.dirname(executable), 'resources', 'app.asar');
  if (process.platform !== 'win32' || !fs.existsSync(archive)) return { skipped: true, reason: 'No directly accessible Windows app archive beside this executable' };
  const code = `const path=require('node:path'); const k=require(${JSON.stringify(path.join(archive, 'node_modules', 'koffi'))}); const lib=k.load(path.join(process.env.SystemRoot||'C:\\\\Windows','System32','wlanapi.dll')); const open=lib.func('uint32_t __stdcall WlanOpenHandle(uint32_t version, void *reserved, _Out_ uint32_t *negotiated, _Out_ void **handle)'); if(typeof open!=='function')throw new Error('Missing WLAN binding'); console.log('KONX_NATIVE_LOADER_PASS '+JSON.stringify({koffi:true,wlanapi:true,functionBound:true,nativeCalls:0}));`;
  const output = await new Promise((resolve, reject) => execFile(executable, ['-e', code], {
    windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024, encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KONX_CAPTURE: '', KONX_DEMO: '' },
  }, (error, stdout, stderr) => error ? reject(new Error('Packaged native loader failed: ' + (stderr || error.message))) : resolve(stdout)));
  const marker = output.match(/KONX_NATIVE_LOADER_PASS (\{[^\r\n]+\})/);
  assert(marker, 'Packaged native loader produced no result');
  return JSON.parse(marker[1]);
}

async function launch(executable, root, run, profile, version, phase, logging = null, quickLogin = null, workspaceGeometry = null, events = null) {
  const demoPath = path.join(run, phase + '-demo.js');
  const screenshot = path.join(run, phase + '.png');
  const resultPath = path.join(run, phase + '-checks.json');
  // The second launch receives no password; its real SSH authentication must
  // use the credential the first launch saved through the Home checkbox.
  const loginOptions = quickLogin && (phase === 'save' ? quickLogin : { ...quickLogin, password: undefined });
  fs.writeFileSync(demoPath, 'window.__KONX_TOOLS_SMOKE = ' + JSON.stringify({ version, phase, token: TOKEN, resultPath, logging, quickLogin: loginOptions, workspaceGeometry, events }) + ';\n' +
    fs.readFileSync(path.join(__dirname, 'smoke-tools-demo.js'), 'utf8'));
  const env = {
    ...process.env, KONX_USERDATA: profile, KONX_CAPTURE: screenshot,
    KONX_DEMO: demoPath, KONX_CAPTURE_DELAY: '250', KONX_CAPTURE_NO_ELEVATE: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [], { cwd: root, env, windowsHide: true });
  let output = '', timedOut = false, spawnError = null;
  child.stdout.on('data', (data) => { output += data; process.stdout.write(data); });
  child.stderr.on('data', (data) => { output += data; process.stderr.write(data); });
  const timer = setTimeout(() => {
    timedOut = true;
    console.error('Package smoke timed out; closing only its own test process tree.');
    if (process.platform === 'win32' && Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null) {
      // The portable NSIS launcher starts KonX as a child. Stop that owned tree,
      // never every process with the application name.
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024,
      }, (error) => {
        if (error && child.exitCode === null && child.signalCode === null) {
          console.error('Process-tree cleanup failed; falling back to the owned launcher.');
          child.kill();
        }
      });
    } else child.kill();
  }, 45000);
  const exitCode = await new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error.message; resolve(null); });
    child.once('close', resolve);
  });
  clearTimeout(timer);
  const marker = output.match(/KONX_TOOLS_PACKAGE_SMOKE_PASS (\{[^\r\n]+\})/);
  const checks = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : marker ? JSON.parse(marker[1]) : null;
  const passed = !timedOut && !spawnError && exitCode === 0 && checks?.version === version && checks?.phase === phase &&
    checks.noAutomaticJobs === true && !output.includes('capture failed') && fs.existsSync(screenshot) && fs.statSync(screenshot).size > 0;
  const error = checks?.passed === false ? checks.error || 'Renderer smoke checks failed' : null;
  const result = { passed, phase, exitCode, timedOut, spawnError, error, checks, screenshot, output };
  fs.writeFileSync(path.join(run, phase + '-result.json'), JSON.stringify(result, null, 2));
  assert(passed, 'Packaged ' + phase + ' smoke failed' + (error ? ': ' + error : '') + '; inspect ' + path.join(run, phase + '-result.json'));
  return result;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const requested = process.argv[2] || process.env.KONX_TEST_EXE;
  const version = process.argv[3] || require('../package.json').version;
  assert(requested && path.isAbsolute(requested) && fs.statSync(requested).isFile(), 'Supply an absolute packaged KonX executable path as argv[2] or KONX_TEST_EXE');
  assert(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version), 'Expected version must be a semantic version');
  const executable = path.resolve(requested);
  const runs = path.join(root, 'review', 'tools-package-smoke');
  fs.mkdirSync(runs, { recursive: true });
  const run = fs.mkdtempSync(path.join(runs, 'run-'));
  const profile = path.join(run, 'profile');
  fs.mkdirSync(profile);
  console.log('Isolated package smoke artifacts: ' + run);
  const result = { passed: false, executable, expectedVersion: version, run, phases: [] };
  const [major, minor, patch] = version.match(/^(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
  const supportsLoggingSwitch = major > 0 || minor > 15 || (minor === 15 && patch >= 1);
  const supportsQuickLogin = major > 0 || minor > 15 || (minor === 15 && patch >= 2);
  const supportsCiscoHighlighting = major > 0 || minor >= 16;
  const supportsSerialAutoBaud = major > 0 || minor >= 17;
  const supportsWorkspaceWindows = major > 0 || minor >= 18;
  let logging, quickLogin, events;
  try {
    result.nativeLoader = await nativeLoader(executable);
    if (supportsLoggingSwitch) logging = await loggingPeer(run);
    if (supportsQuickLogin) quickLogin = await quickLoginPeer();
    if (major > 0 || minor >= 21) events = await eventPeer();
    result.phases.push(await launch(executable, root, run, profile, version, 'save', logging?.options, quickLogin?.options, null, events?.options));
    if (events) { await events.close(); events = null; }
    if (supportsWorkspaceWindows) {
      const checks = result.phases[0].checks.workspaceWindows;
      assert(checks?.floated && checks?.nativePopout && checks?.docked && checks?.nativeCloseAcknowledged &&
        checks?.originalTabAndNodeRetained && checks?.reportAndInputRetained && checks?.noAutomaticJobs && checks?.geometrySaved,
        'Packaged floating/native workspace did not retain and redock its report');
      const settings = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
      assert(checks.geometry?.version === 1 && JSON.stringify(settings.workspaceGeometry) === JSON.stringify(checks.geometry),
        'Packaged workspace geometry did not persist to disk');
      result.workspaceWindows = checks;
    }
    if (supportsSerialAutoBaud) {
      const checks = result.phases[0].checks.serialAutoBaud;
      assert(checks?.nativeSerialAvailable && checks?.manualDefault && checks?.autoAndProbeSaved && checks?.framingRetained && checks?.reopened && checks?.noPortOpened,
        'Packaged automatic serial settings did not pass editor checks');
      const saved = JSON.parse(fs.readFileSync(path.join(profile, 'sessions.json'), 'utf8')).sessions.find(session => session.id === checks.savedId);
      assert(saved?.baudRate === 'auto' && saved.serialAutoBaudProbe === true && Number(saved.dataBits) === 7 && saved.parity === 'even' &&
        Number(saved.stopBits) === 2 && saved.flowControl === 'xonxoff', 'Serial editor did not persist the selected detection and framing settings');
      result.serialAutoBaud = checks;
    }
    if (quickLogin) {
      const checks = result.phases[0].checks.quickLogin;
      assert(checks?.optInInitiallyOff && checks?.connected && checks?.passwordCleared && checks?.publicMetadataPrivate,
        'Home Quick Connect did not pass its saved-login UI checks');
      const sessionsText = fs.readFileSync(path.join(profile, 'sessions.json'), 'utf8');
      const session = JSON.parse(sessionsText).sessions.find(item => item.id === checks.savedId);
      assert(session?.host === quickLogin.options.host && Number(session.port) === quickLogin.options.port &&
        session.username === quickLogin.options.username && typeof session.passwordEnc === 'string' && session.passwordEnc.length > 32,
        'Home Quick Connect did not persist its encrypted username/password session');
      assert(!Object.hasOwn(session, 'password') && !sessionsText.includes(quickLogin.options.password) &&
        !sessionsText.includes(Buffer.from(quickLogin.options.password).toString('base64')), 'Home Quick Connect password was stored without encryption');
      assert(quickLogin.observed.successfulAuthentications === 1 && quickLogin.observed.shells === 1, 'Home Quick Connect did not authenticate exactly once with the synthetic credential');
      result.quickLogin = { savedId: checks.savedId, checkboxFlow: true, ciphertextStored: true, initialAuthentication: true };
    }
    if (logging) {
      const checks = result.phases[0].checks.logging;
      assert(checks?.switchedOn && checks?.switchedOff && checks?.litStateMatchesStatus && checks?.bothMarkersDisplayed,
        'Packaged console logging switch did not pass its UI/status checks');
      assert(checks.path === logging.options.logPath, 'Logging escaped its parent-selected synthetic file');
      assert(logging.observed.connections === 1 && [logging.options.onMarker, logging.options.offMarker].every(marker => logging.observed.received.includes(marker)),
        'The local fixture did not receive both console markers');
      const logged = fs.readFileSync(logging.options.logPath, 'utf8');
      assert(logged.includes(logging.options.onMarker), 'Enabled console logging omitted the echoed marker');
      assert(!logged.includes(logging.options.offMarker), 'Console logging continued after the switch was turned off');
      if (supportsCiscoHighlighting) {
        const cisco = result.phases[0].checks.ciscoHighlighting;
        assert(cisco?.rendered && cisco?.paintedGlyphs && cisco?.toggled && cisco?.bufferUnchanged && cisco?.copiedTextUnchanged,
          'Packaged Cisco highlighting did not pass its actual terminal rendering checks');
        assert(logged.includes(logging.options.ciscoSample.replace(/\r\n/g, '\n')) && !logged.includes('\x1b'),
          'Cisco highlighting changed the plain-text log transcript');
        result.ciscoHighlighting = { ...cisco, logUnchanged: true, loopbackOnly: true };
      }
      result.logging = { ...checks, onMarkerStored: true, offMarkerExcluded: true, loopbackOnly: true };
      await logging.close(); logging = null;
    }
    const savedText = fs.readFileSync(path.join(profile, 'mist.json'), 'utf8');
    const saved = JSON.parse(savedText);
    assert(saved.version === 1 && typeof saved.tokenEnc === 'string' && saved.tokenEnc.length > 32, 'Expected an encrypted Mist credential on disk');
    assert(!savedText.includes(TOKEN) && !savedText.includes(Buffer.from(TOKEN).toString('base64')), 'Synthetic Mist credential was written without encryption');
    const aiText = fs.readFileSync(path.join(profile, 'ai.json'), 'utf8');
    const aiSaved = JSON.parse(aiText);
    assert(typeof aiSaved.providers?.nyquest?.keyEnc === 'string' && aiSaved.providers.nyquest.keyEnc.length > 32, 'Expected encrypted AI key on disk');
    assert(!aiText.includes(TOKEN) && !aiText.includes(Buffer.from(TOKEN).toString('base64')), 'Synthetic AI credential was written without encryption');
    result.ciphertextStored = true;
    result.aiCiphertextStored = true;
    if (Number(version.split('.')[0]) > 0 || Number(version.split('.')[1]) >= 15) {
      const sessionsText = fs.readFileSync(path.join(profile, 'sessions.json'), 'utf8');
      const session = JSON.parse(sessionsText).sessions.find(item => item.name === 'Package smoke synthetic saved session');
      assert(session?.username === 'fixture-user' && typeof session.passwordEnc === 'string' && session.passwordEnc.length > 32, 'Expected an encrypted session password on disk');
      assert(!Object.hasOwn(session, 'password') && !sessionsText.includes(TOKEN + '-session') && !sessionsText.includes(Buffer.from(TOKEN + '-session').toString('base64')), 'Synthetic session password was written without encryption');
      result.sessionCiphertextStored = true;
    }
    result.phases.push(await launch(executable, root, run, profile, version, 'forget', null, quickLogin?.options, result.workspaceWindows?.geometry));
    if (supportsWorkspaceWindows) {
      const checks = result.phases[1].checks.workspaceWindows;
      assert(checks?.persistedAcrossRestart && checks?.geometryApplied && checks?.docked && checks?.originalNodeRetained &&
        checks?.noLiveViewsRestored && checks?.noAutomaticJobs && JSON.stringify(checks.geometry) === JSON.stringify(result.workspaceWindows.geometry),
        'Packaged workspace geometry did not restore and apply after restart');
      Object.assign(result.workspaceWindows, { persistedAcrossRestart: true, geometryApplied: true, noLiveViewsRestored: true });
    }
    if (supportsSerialAutoBaud) {
      const checks = result.phases[1].checks.serialAutoBaud;
      assert(checks?.savedId === result.serialAutoBaud.savedId && checks?.persistedAcrossRestart && checks?.reopened && checks?.removed && checks?.noPortOpened,
        'Packaged automatic serial settings did not reopen after restart');
      assert(!JSON.parse(fs.readFileSync(path.join(profile, 'sessions.json'), 'utf8')).sessions.some(session => session.id === checks.savedId),
        'Synthetic serial session remained on disk');
      Object.assign(result.serialAutoBaud, { persistedAcrossRestart: true, removed: true });
    }
    if (supportsCiscoHighlighting) {
      assert(result.phases[1].checks.ciscoHighlighting?.persistedAcrossRestart, 'Cisco setting did not survive the packaged restart');
      result.ciscoHighlighting.persistedAcrossRestart = true;
    }
    if (quickLogin) {
      const checks = result.phases[1].checks.quickLogin;
      assert(checks?.savedId === result.quickLogin.savedId && checks?.reconnectedWithoutPrompt && checks?.removed,
        'Saved Home login did not reconnect and remove cleanly after restart');
      assert(quickLogin.observed.successfulAuthentications === 2 && quickLogin.observed.shells === 2, 'Restart did not authenticate using the encrypted saved login');
      assert(!JSON.parse(fs.readFileSync(path.join(profile, 'sessions.json'), 'utf8')).sessions.some(item => item.id === result.quickLogin.savedId),
        'Synthetic Quick Connect session remained on disk after removal');
      Object.assign(result.quickLogin, { persistedAcrossRestart: true, authenticatedFromSavedCredential: true, removed: true, loopbackOnly: true });
      await quickLogin.close(); quickLogin = null;
    }
    const forgotten = JSON.parse(fs.readFileSync(path.join(profile, 'mist.json'), 'utf8'));
    assert(forgotten.version === 1 && !Object.hasOwn(forgotten, 'tokenEnc'), 'Encrypted token remained on disk after Forget token');
    assert(!Object.hasOwn(JSON.parse(fs.readFileSync(path.join(profile, 'ai.json'), 'utf8')).providers.nyquest, 'keyEnc'), 'AI key remained on disk after Forget');
    result.tokenRemovedFromDisk = true;
    result.aiKeyRemovedFromDisk = true;
    result.passed = true;
  } catch (error) {
    result.error = error.stack || String(error);
    throw error;
  } finally {
    try { await Promise.all([logging?.close(), quickLogin?.close(), events?.close()]); }
    finally {
      fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(result, null, 2));
      console.log((result.passed ? 'PASS: ' : 'FAIL: ') + path.join(run, 'result.json'));
    }
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
