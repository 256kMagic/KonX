'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/main/store');

async function runHomeSettingsTests(test) {
  await test('Home preference boundary: malformed and unknown saved values cannot hide unrelated groups', async () => {
    const { HOME_SECTIONS, hiddenHomeSections } = await import('../src/renderer/js/home-sections.mjs');
    for (const input of [undefined, null, false, 'quick-connect', { 'quick-connect': true }]) assert.deepEqual(hiddenHomeSections(input), []);
    const input = ['keyboard', 'unknown-future-section', 'quick-connect', 'keyboard', 0, null, { id: 'sessions' }];
    assert.deepEqual(hiddenHomeSections(input), ['quick-connect', 'keyboard']);
    assert.equal(input.length, 7, 'normalization must not mutate the saved input');
    assert.equal(new Set(HOME_SECTIONS.map(section => section.id)).size, 6);
  });

  await test('Home preferences: existing profiles show all groups and persist section choices without changing other settings', () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-home-store-'));
    try {
      fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ uiTheme: 'ion-storm', fontSize: 19,
        colorScheme: 'solarized', copyOnSelect: false, buttons: [{ label: 'Retained', send: 'help\\r' }] }));
      const store = new Store(root, { available: () => false });
      assert.deepEqual(store.getSettings().homeHiddenSections, []);
      store.setSettings({ homeHiddenSections: ['quick-connect', 'keyboard'] });
      const saved = new Store(root, { available: () => false }).getSettings();
      assert.deepEqual(saved.homeHiddenSections, ['quick-connect', 'keyboard']);
      assert.equal(saved.uiTheme, 'ion-storm'); assert.equal(saved.fontSize, 19);
      assert.equal(saved.colorScheme, 'solarized'); assert.equal(saved.copyOnSelect, false);
      assert.deepEqual(saved.buttons, [{ label: 'Retained', send: 'help\\r' }]);
      store.setSettings({ homeHiddenSections: [] });
      assert.deepEqual(new Store(root, { available: () => false }).getSettings().homeHiddenSections, []);
    } finally {
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-home-store-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  await test('Home settings publication: failed replacement preserves live and saved state, then a retry publishes the complete patch', () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-home-store-'));
    const rename = fs.renameSync;
    try {
      const store = new Store(root, { available: () => false });
      store.setSettings({ homeHiddenSections: ['introduction'], fontSize: 18, copyOnSelect: false });
      const prior = store.getSettings(), bytes = fs.readFileSync(path.join(root, 'settings.json'));
      fs.renameSync = (from, to) => {
        if (path.resolve(to) === path.join(root, 'settings.json')) throw Object.assign(new Error('Synthetic settings replacement denied'), { code: 'EACCES' });
        return rename(from, to);
      };
      assert.throws(() => store.setSettings({ homeHiddenSections: ['introduction', 'network-tools'], fontSize: 21 }), /replacement denied/);
      assert.equal(store.getSettings(), prior, 'failed publication retains original live object');
      assert.deepEqual(store.getSettings().homeHiddenSections, ['introduction']); assert.equal(store.getSettings().fontSize, 18);
      assert.deepEqual(fs.readFileSync(path.join(root, 'settings.json')), bytes);
      fs.renameSync = rename;
      store.setSettings({ homeHiddenSections: ['introduction', 'network-tools'], fontSize: 21 });
      const current = new Store(root, { available: () => false }).getSettings();
      assert.deepEqual(current.homeHiddenSections, ['introduction', 'network-tools']); assert.equal(current.fontSize, 21);
      assert.equal(current.copyOnSelect, false);
    } finally {
      fs.renameSync = rename;
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-home-store-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
module.exports = { runHomeSettingsTests };
if (require.main === module) (async () => {
  let passed = 0, failed = 0;
  await runHomeSettingsTests(async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name, error); } });
  console.log(`${passed}/${passed + failed} Home settings checks passed`); process.exitCode = failed ? 1 : 0;
})();
