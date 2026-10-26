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
  'ion-storm', 'solar-flare', 'aurora-flux', 'hyperdrive', 'ghost-circuit',
];
const staticIds = ['obsidian-gold', 'arctic-glass', 'deep-ocean', 'sandstone', 'crimson-circuit'];
const customIds = [...animatedIds, ...staticIds];
function contrast(foreground, background) {
  const luminance = hex => {
    const rgb = hex.slice(1).match(/../g).map(value => Number.parseInt(value, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
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

function visibilityOwner(themes) {
  const filename = path.join(__dirname, '../src/renderer/js/theme-effects.js');
  const source = fs.readFileSync(filename, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ ...themes });
  vm.runInContext(source + '\nglobalThis.owner = { applyThemeVisibility, applyApplicationTheme };', context, { filename });
  return context.owner;
}

async function runThemeTests(test) {
  const themes = await loadThemes();
  const { APP_THEMES, SCHEMES, applicationTheme, scheme, terminalTheme, usesThemeEffects } = themes;

  await test('themes: native and browser hiding independently stop motion and survive theme saves per document', () => {
    const { applyThemeVisibility, applyApplicationTheme } = visibilityOwner(themes);
    const document = () => ({ hidden: false, documentElement: { dataset: {},
      classList: { toggle() {} }, style: { setProperty() {}, removeProperty() {} } } });
    const primary = document(), child = document();
    applyThemeVisibility(primary, false); applyThemeVisibility(child, true);
    assert.equal(primary.documentElement.dataset.themeVisible, 'false', 'Native-hidden unthrottled primary must pause');
    assert.equal(child.documentElement.dataset.themeVisible, 'true', 'Visible child stays independent');
    applyApplicationTheme({ uiTheme: 'ghost-circuit', themeAnimations: true }, primary);
    assert.equal(primary.documentElement.dataset.themeVisible, 'false', 'Saving a theme cannot restart native-hidden output');
    child.hidden = true; applyThemeVisibility(child);
    assert.equal(child.documentElement.dataset.themeVisible, 'false', 'Browser-hidden output pauses even with a native-visible snapshot');
    applyApplicationTheme({ uiTheme: 'ion-storm', themeAnimations: true }, child);
    assert.equal(child.documentElement.dataset.themeVisible, 'false');
    child.hidden = false; applyThemeVisibility(child);
    assert.equal(child.documentElement.dataset.themeVisible, 'true');
    applyThemeVisibility(primary);
    assert.equal(primary.documentElement.dataset.themeVisible, 'false', 'Fallback browser events cannot erase native authority');
    applyThemeVisibility(primary, true);
    assert.equal(primary.documentElement.dataset.themeVisible, 'true');
  });

  await test('themes: five static and eleven animated choices coexist with classic Dark and Light', () => {
    assert.deepEqual(Object.keys(APP_THEMES).sort(), ['dark', 'light', ...customIds].sort());
    assert.equal(applicationTheme('dark').animated, false);
    assert.equal(applicationTheme('light').animated, false);
    const signatures = new Set();
    for (const id of customIds) {
      const value = applicationTheme(id);
      assert.equal(value.id, id);
      assert.equal(value.animated, animatedIds.includes(id));
      assert.ok(value.label.length > 3);
      for (const field of ['background', 'foreground', 'accent', 'muted', 'selection', 'secondary']) {
        assert.match(value[field], /^#[\da-f]{6}$/i, id + '.' + field);
      }
      signatures.add(value.background + value.accent);
    }
    assert.equal(signatures.size, 16, 'Each custom theme must have its own palette');
  });

  await test('themes: new static palettes remain opaque, distinguish light and dark, and keep output readable', () => {
    for (const id of staticIds) {
      const theme = applicationTheme(id), colors = scheme('app', id);
      assert.equal(theme.appearance, ['arctic-glass', 'sandstone'].includes(id) ? 'light' : 'dark', id);
      assert.equal(usesThemeEffects({ uiTheme: id, colorScheme: 'app', themeAnimations: true }), false, id);
      assert.deepEqual(terminalTheme({ uiTheme: id, colorScheme: 'app' }), colors, id);
      assert.equal(colors.background, theme.background, id);
      assert.notDeepEqual(colors, scheme('konx'), id + ' must not silently become classic Dark');
      assert.notDeepEqual(colors, scheme('light'), id + ' must not silently become classic Light');
      for (const channel of ['foreground', 'brightBlack', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan',
        'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan']) {
        const ratio = contrast(colors[channel], colors.background);
        assert.ok(ratio >= 4.5, `${id}.${channel} contrast ${ratio.toFixed(2)}:1 is below 4.5:1`);
      }
      for (const palette of Object.keys(classicPalettes)) {
        assert.deepEqual(terminalTheme({ uiTheme: id, colorScheme: 'app' }, { colorScheme: palette }), scheme(palette), id + ':' + palette);
      }
    }
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
    for (const uiTheme of customIds) {
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
    for (const uiTheme of ['dark', 'light', ...customIds]) {
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

  await test('themes: a new profile follows the app, preserves classic UI defaults and persists every custom choice', () => {
    withStore((store, reload) => {
      assert.equal(store.getSettings().uiTheme, 'dark');
      assert.equal(store.getSettings().colorScheme, 'app');
      assert.equal(store.getSettings().themeAnimations, true);
      for (const uiTheme of customIds) {
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
    let refits = 0, highlightBackground, highlighting;
    Object.assign(tab, {
      meta: { colorScheme: 'classic', fontSize: 22 },
      term: { options: {} },
      ciscoSwitch: { setAttribute() {} }, ciscoState: {},
      ciscoHighlighter: {
        setBackground(value) { highlightBackground = value; },
        setEnabled(value) { highlighting = value; },
      },
      wrap: { style: {}, classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } } },
      refit() { refits++; },
    });
    const settings = { uiTheme: 'chroma-rgb', colorScheme: 'app', fontSize: 14,
      fontFamily: 'Consolas', cursorStyle: 'bar', cursorBlink: false, scrollback: 2000 };
    tab.applySettings(settings);
    assert.deepEqual(tab.term.options.theme, scheme('classic'));
    assert.equal(tab.wrap.style.background, scheme('classic').background);
    assert.equal(highlightBackground, scheme('classic').background);
    assert.equal(highlighting, true);
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
    assert.equal(highlightBackground, applicationTheme('chroma-rgb').background, 'highlight contrast uses the real background, not the transparent xterm layer');
    assert.equal(classes.has('theme-output-enabled'), true);
    assert.equal(tab.term.options.fontSize, 14);
    tab.applySettings({ ...settings, uiTheme: 'light' });
    assert.deepEqual(tab.term.options.theme, scheme('light'));
    assert.equal(tab.wrap.style.background, scheme('light').background);
    assert.equal(highlightBackground, scheme('light').background);
    assert.equal(classes.has('theme-output-enabled'), false, 'Classic themes must remove the animated output layer');
    for (const uiTheme of customIds) {
      tab.applySettings({ ...settings, uiTheme });
      const colors = scheme('app', uiTheme);
      assert.deepEqual(tab.term.options.theme, terminalTheme({ ...settings, uiTheme }));
      assert.equal(tab.wrap.style.background, colors.background);
      assert.equal(highlightBackground, colors.background, 'Cisco highlighting must use the actual terminal surface');
      assert.equal(classes.has('theme-output-enabled'), animatedIds.includes(uiTheme));
    }
    assert.equal(refits, 3 + customIds.length);
  });
}

module.exports = { runThemeTests };
