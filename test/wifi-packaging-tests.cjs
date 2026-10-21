'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PREFIX = 'konx-wifi-asar-';

async function runWifiPackagingTests(test) {
  await test('Wi-Fi child collector loads its packaged ASAR source and returns a synthetic report without querying WLAN', async () => {
    const parent = path.resolve(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, PREFIX));
    try {
      const sourceRoot = path.join(root, 'source');
      const mainRoot = path.join(sourceRoot, 'src', 'main');
      fs.mkdirSync(path.join(mainRoot, 'security'), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '../src/main/security/common.js'), path.join(mainRoot, 'security/common.js'));
      const facts = { adapters: [{ id: 'synthetic-adapter', name: 'Synthetic Wi-Fi adapter', state: 'Connected', connection: { ssid: 'ASAR Fixture', bssid: '01:02:03:04:05:06', signalPercent: 80, rxMbps: 100, txMbps: 100, authentication: 'WPA3-Personal', encryption: 'CCMP-128' }, issues: [] }], networks: [{ adapterId: 'synthetic-adapter', ssid: 'ASAR Fixture', hidden: false, bssid: '01:02:03:04:05:06', frequencyMHz: 5955, channel: 1, signalPercent: 80, rssiDbm: -60, authentication: 'WPA3-Personal', encryption: 'CCMP-128', securityEnabled: true }] };
      // Override the native collector in this disposable copy only. The real
      // collectInventory implementation and its nested Electron child are used.
      const source = fs.readFileSync(path.join(__dirname, '../src/main/wifi.js'), 'utf8');
      fs.writeFileSync(path.join(mainRoot, 'wifi.js'), `${source}\nmodule.exports.collectNative = () => (${JSON.stringify(facts)});\n`);
      const archive = path.join(root, 'Wi-Fi fixture.asar');
      await require('@electron/asar').createPackage(sourceRoot, archive);
      const entry = path.join(archive, 'src', 'main', 'wifi.js');
      const script = `require(${JSON.stringify(entry)}).collectInventory('survey', {}).then(report=>process.stdout.write(JSON.stringify(report)),error=>{console.error(error.stack);process.exitCode=1});`;
      const output = await new Promise((resolve, reject) => {
        execFile(require('electron'), ['-e', script], {
          windowsHide: true,
          timeout: 35000,
          maxBuffer: 256 * 1024,
          encoding: 'utf8',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KONX_USERDATA: path.join(root, 'profile'), KONX_DEMO: '', KONX_CAPTURE: '' },
        }, (error, stdout, stderr) => error ? reject(new Error(`Packaged Wi-Fi fixture failed: ${String(stderr).slice(-4000) || error.message}`)) : resolve(stdout));
      });
      const report = JSON.parse(output);
      assert.equal(report.kind, 'wifi');
      assert.equal(report.adapters[0].name, 'Synthetic Wi-Fi adapter');
      assert.equal(report.networks[0].ssid, 'ASAR Fixture');
      assert.equal(report.networks[0].band, '6 GHz');
      assert.equal(report.channels[0].channel, 1);
      assert.equal(report.channels[0].bssidCount, 1);
    } finally {
      const target = path.resolve(root);
      assert.equal(path.dirname(target), parent, 'Remove only the fresh fixture directory');
      assert.ok(path.basename(target).startsWith(PREFIX));
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

module.exports = { runWifiPackagingTests };
