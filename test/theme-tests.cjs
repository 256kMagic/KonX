'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Store } = require('../src/main/store');

const animatedIds = [
  'arc-reactor', 'chroma-rgb', 'matrix-mainframe',
  'synthwave-grid', 'hologram-prism', 'plasma-forge',
];
const classicPalettes = {
  konx: ['#13161b', '#d9dfe8', '#3b9cf2'],
  classic: ['#000000', '#c0c0c0', '#c0c0c0'],
  green: ['#050d05', '#33ff66', '#33ff66'],
  solarized: ['#002b36', '#93a1a1', '#93a1a1'],
  monokai: ['#272822', '#f8f8f2', '#f8f8f0'],
  light: ['#fbfbfc', '#26303c', '#1f7ad6'],
};

async function loadThemes() {
  const filename = path.join(__dirname, '../src/renderer/js/themes.js');
  // Import the real browser-only ES module without changing this CommonJS repo.
  return import('data:text/javascript;base64,' + fs.readFileSync(filename).toString('base64'));
}

function withStore(fn, savedSettings) {
  const parent = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'konx-theme-test-'));
  const crypt = { available: () => false };
  try {
    if (savedSettings) fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(savedSettings));
    return fn(new Store(directory, crypt), () => new Store(directory, crypt));
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.ok(path.basename(directory).startsWith('konx-theme-test-'));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function terminalPrototype(themes) {
  const filename = path.join(__dirname, '../src/renderer/js/terminal.js');
  const source = fs.readFileSync(filename, 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export class TerminalTab', 'class TerminalTab');
  const context = vm.createContext({ ...themes });
  vm.runInContext(source + '\nglobalThis.TestTerminalTab = TerminalTab;', context, { filename });
  return context.TestTerminalTab.prototype;
}

async function runThemeTests(test) {
  const themes = await loadThemes();
  const { APP_THEMES, SCHEMES, applicationTheme, scheme, terminalTheme, usesThemeEffects } = themes;

  await test('themes: six animated choices coexist with classic Dark and Light', () => {
    assert.deepEqual(Object.keys(APP_THEMES).sort(), ['dark', 'light', ...animatedIds].sort());
    assert.equal(applicationTheme('dark').animated, false);
    assert.equal(applicationTheme('light').animated, false);
    const signatures = new Set();
    for (const id of animatedIds) {
      const value = applicationTheme(id);
      assert.equal(value.id, id);
      assert.equal(value.animated, true);
      assert.ok(value.label.length > 3);
      for (const field of ['background', 'foreground', 'accent', 'muted', 'selection', 'secondary']) {
        assert.match(value[field], /^#[\da-f]{6}$/i, id + '.' + field);
      }
      signatures.add(value.background + value.accent);
    }
    assert.equal(signatures.size, 6, 'Each animated theme must have its own palette');
  });

  await test('themes: all established terminal palettes keep their colors and ANSI channels', () => {
    assert.ok(Object.hasOwn(SCHEMES, 'app'));
    for (const [id, expected] of Object.entries(classicPalettes)) {
      assert.ok(Object.hasOwn(SCHEMES, id));
      const value = scheme(id, 'plasma-forge');
      assert.deepEqual([value.background, value.foreground, value.cursor], expected, id);
      assert.equal(Object.hasOwn(value, 'label'), false, 'UI labels must not enter xterm options');
      for (const field of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
        'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']) {
        assert.match(value[field], /^#[\da-f]{6}$/i, id + '.' + field);
      }
    }
  });

  await test('themes: invalid and inherited object names safely fall back to the classic defaults', () => {
    for (const name of [undefined, null, '', 'missing-theme', '__proto__', 'constructor', 'toString']) {
      assert.equal(applicationTheme(name).id, 'dark', String(name));
      assert.deepEqual(scheme(name), scheme('konx'), String(name));
    }
    assert.deepEqual(scheme('app', 'missing-theme'), scheme('konx'));
  });

  await test('themes: following the application selects its opaque palette without mutating shared schemes', () => {
    assert.deepEqual(scheme('app', 'dark'), scheme('konx'));
    assert.deepEqual(scheme('app', 'light'), scheme('light'));
    for (const uiTheme of animatedIds) {
      const value = scheme('app', uiTheme);
      assert.equal(value.background, applicationTheme(uiTheme).background);
      assert.equal(value.foreground, applicationTheme(uiTheme).foreground);
      assert.equal(value.cursor, applicationTheme(uiTheme).accent);
      value.background = '#ffffff';
      assert.equal(scheme('app', uiTheme).background, applicationTheme(uiTheme).background);
    }
    const classic = scheme('classic'); classic.red = '#123456';
    assert.equal(scheme('classic').red, '#c00000');
  });

  await test('themes: session palettes override global choices and application following is explicit', () => {
    const settings = { uiTheme: 'arc-reactor', colorScheme: 'app', themeAnimations: true };
    assert.deepEqual(terminalTheme(settings, { colorScheme: 'classic' }), scheme('classic'));
    assert.equal(usesThemeEffects(settings, { colorScheme: 'classic' }), false);
    settings.colorScheme = 'solarized';
    assert.deepEqual(terminalTheme(settings), scheme('solarized'));
    assert.equal(usesThemeEffects(settings), false);
    const follows = terminalTheme(settings, { colorScheme: 'app' });
    assert.equal(follows.background, '#00000000');
    assert.equal(follows.foreground, applicationTheme('arc-reactor').foreground);
    assert.equal(usesThemeEffects(settings, { colorScheme: 'app' }), true);
    assert.deepEqual(terminalTheme(settings, { colorScheme: '' }), scheme('solarized'));
  });

  await test('themes: transparent terminal output is limited to animated application-following palettes', () => {
    for (const uiTheme of ['dark', 'light', ...animatedIds]) {
      for (const colorScheme of ['app', ...Object.keys(classicPalettes)]) {
        const settings = { uiTheme, colorScheme };
        const animatedOutput = colorScheme === 'app' && animatedIds.includes(uiTheme);
        assert.equal(usesThemeEffects(settings), animatedOutput, uiTheme + ':' + colorScheme);
        assert.equal(terminalTheme(settings).background === '#00000000', animatedOutput, uiTheme + ':' + colorScheme);
      }
    }
    assert.equal(terminalTheme({ uiTheme: 'matrix-mainframe' }).background, '#00000000');
    assert.deepEqual(terminalTheme({}), scheme('konx'));
  });

  await test('themes: pausing effects keeps the chosen palette and output layers available', () => {
    const settings = { uiTheme: 'synthwave-grid', colorScheme: 'app', themeAnimations: false };
    assert.equal(usesThemeEffects(settings), true, 'Pause must freeze the background rather than switch palettes');
    assert.deepEqual(terminalTheme(settings), terminalTheme({ ...settings, themeAnimations: true }));
  });

  await test('themes: a new profile follows the app, preserves classic UI defaults and persists all six choices', () => {
    withStore((store, reload) => {
      assert.equal(store.getSettings().uiTheme, 'dark');
      assert.equal(store.getSettings().colorScheme, 'app');
      assert.equal(store.getSettings().themeAnimations, true);
      for (const uiTheme of animatedIds) {
        store.setSettings({ uiTheme, themeAnimations: false });
        const saved = reload().getSettings();
        assert.equal(saved.uiTheme, uiTheme);
        assert.equal(saved.themeAnimations, false);
        assert.equal(saved.colorScheme, 'app');
      }
    });
  });

  await test('themes: upgrading an existing profile preserves explicit terminal colors and unrelated preferences', () => {
    withStore((store, reload) => {
      assert.equal(store.getSettings().colorScheme, 'solarized');
      assert.equal(store.getSettings().themeAnimations, true);
      store.setSettings({ uiTheme: 'hologram-prism', themeAnimations: false });
      const saved = reload().getSettings();
      assert.equal(saved.uiTheme, 'hologram-prism');
      assert.equal(saved.colorScheme, 'solarized');
      assert.equal(saved.themeAnimations, false);
      assert.equal(saved.fontSize, 19);
      assert.deepEqual(saved.buttons, [{ label: 'Custom', send: 'help\\r' }]);
    }, { uiTheme: 'light', colorScheme: 'solarized', fontSize: 19, buttons: [{ label: 'Custom', send: 'help\\r' }] });
  });

  await test('themes: changing an open terminal updates its palette without losing session font overrides', () => {
    const tab = Object.create(terminalPrototype(themes));
    const classes = new Set();
    let refits = 0;
    Object.assign(tab, {
      meta: { colorScheme: 'classic', fontSize: 22 },
      term: { options: {} },
      wrap: { style: {}, classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } } },
      refit() { refits++; },
    });
    const settings = { uiTheme: 'chroma-rgb', colorScheme: 'app', fontSize: 14,
      fontFamily: 'Consolas', cursorStyle: 'bar', cursorBlink: false, scrollback: 2000 };
    tab.applySettings(settings);
    assert.deepEqual(tab.term.options.theme, scheme('classic'));
    assert.equal(tab.wrap.style.background, scheme('classic').background);
    assert.equal(classes.has('theme-output-enabled'), false);
    assert.equal(tab.term.options.fontSize, 22);
    assert.equal(tab.term.options.fontFamily, 'Consolas');
    assert.equal(tab.term.options.cursorStyle, 'bar');
    assert.equal(tab.term.options.cursorBlink, false);
    assert.equal(tab.term.options.scrollback, 2000);
    tab.meta = {};
    tab.applySettings(settings);
    assert.equal(tab.term.options.theme.background, '#00000000');
    assert.equal(tab.wrap.style.background, applicationTheme('chroma-rgb').background);
    assert.equal(classes.has('theme-output-enabled'), true);
    assert.equal(tab.term.options.fontSize, 14);
    tab.applySettings({ ...settings, uiTheme: 'light' });
    assert.deepEqual(tab.term.options.theme, scheme('light'));
    assert.equal(tab.wrap.style.background, scheme('light').background);
    assert.equal(classes.has('theme-output-enabled'), false, 'Classic themes must remove the animated output layer');
    assert.equal(refits, 3);
  });
}

module.exports = { runThemeTests };
