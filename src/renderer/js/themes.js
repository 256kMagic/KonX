// Terminal color schemes.
export const SCHEMES = {
  app: { label: 'Follow application theme' },
  konx: {
    label: 'KonX Dark',
    background: '#13161b', foreground: '#d9dfe8', cursor: '#3b9cf2', cursorAccent: '#13161b', selectionBackground: '#2b4f75',
    black: '#1c2028', red: '#f0645b', green: '#3fbf6a', yellow: '#e0a83a', blue: '#3b9cf2', magenta: '#b77ee0', cyan: '#3cc4c4', white: '#c9d1dc',
    brightBlack: '#5f6878', brightRed: '#ff8a80', brightGreen: '#6ee08f', brightYellow: '#f5c76a', brightBlue: '#73b9ff', brightMagenta: '#d3a6f5', brightCyan: '#74e0e0', brightWhite: '#f2f5f9',
  },
  classic: {
    label: 'Classic (white on black)',
    background: '#000000', foreground: '#c0c0c0', cursor: '#c0c0c0', cursorAccent: '#000000', selectionBackground: '#3a3a8a',
    black: '#000000', red: '#c00000', green: '#00c000', yellow: '#c0c000', blue: '#0000c0', magenta: '#c000c0', cyan: '#00c0c0', white: '#c0c0c0',
    brightBlack: '#808080', brightRed: '#ff0000', brightGreen: '#00ff00', brightYellow: '#ffff00', brightBlue: '#5c5cff', brightMagenta: '#ff00ff', brightCyan: '#00ffff', brightWhite: '#ffffff',
  },
  green: {
    label: 'Green Phosphor',
    background: '#050d05', foreground: '#33ff66', cursor: '#33ff66', cursorAccent: '#050d05', selectionBackground: '#1d5a2c',
    black: '#050d05', red: '#22cc55', green: '#33ff66', yellow: '#88ff99', blue: '#22aa44', magenta: '#55dd77', cyan: '#66ffaa', white: '#99ffbb',
    brightBlack: '#1f5f2f', brightRed: '#44ff77', brightGreen: '#66ff88', brightYellow: '#aaffbb', brightBlue: '#44cc66', brightMagenta: '#77ee99', brightCyan: '#88ffcc', brightWhite: '#ccffdd',
  },
  solarized: {
    label: 'Solarized Dark',
    background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#0b4f60',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#839496', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  monokai: {
    label: 'Monokai',
    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', cursorAccent: '#272822', selectionBackground: '#49483e',
    black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
    brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
  },
  light: {
    label: 'Light',
    background: '#fbfbfc', foreground: '#26303c', cursor: '#1f7ad6', cursorAccent: '#ffffff', selectionBackground: '#bcd8f5',
    black: '#26303c', red: '#c8312a', green: '#1f8a45', yellow: '#9a6b0e', blue: '#1f6fc2', magenta: '#8b46b8', cyan: '#127f86', white: '#a8b0bb',
    brightBlack: '#6a7482', brightRed: '#e0473f', brightGreen: '#2aa85a', brightYellow: '#b8860b', brightBlue: '#3388e0', brightMagenta: '#a660d4', brightCyan: '#1b9aa1', brightWhite: '#26303c',
  },
};

// Application themes are independent of explicit terminal/session palettes.
export const APP_THEMES = Object.fromEntries([
  ['dark', 'Dark (classic)', false, '#13161b', '#d9dfe8', '#3b9cf2', '#8b95a5', '#2b4f75', '#b77ee0'],
  ['light', 'Light (classic)', false, '#fbfbfc', '#26303c', '#1f7ad6', '#637083', '#bcd8f5', '#8b46b8'],
  ['arc-reactor', 'Arc Reactor', true, '#020711', '#e7f8ff', '#4ceaff', '#a5c6d8', '#163b50', '#006aff'],
  ['chroma-rgb', 'Chroma RGB', true, '#05050e', '#f4f5ff', '#63f4ff', '#b8bdd8', '#233848', '#ff3cb4'],
  ['matrix-mainframe', 'Matrix Mainframe', true, '#020804', '#e8ffe9', '#9aff50', '#a1caa9', '#25452b', '#00f4a8'],
  ['synthwave-grid', 'Synthwave Grid', true, '#0a0315', '#f9eeff', '#ff9adf', '#c7b2d7', '#472740', '#00deff'],
  ['hologram-prism', 'Hologram Prism', true, '#060512', '#f3f0ff', '#d0b0ff', '#c4bbe2', '#3a3058', '#54fff0'],
  ['plasma-forge', 'Plasma Forge', true, '#100510', '#fff0e9', '#ffbe87', '#d7b7c2', '#53352f', '#d35aff'],
].map(([id, label, animated, background, foreground, accent, muted, selection, secondary]) =>
  [id, { id, label, animated, background, foreground, accent, muted, selection, secondary,
    appearance: id === 'light' ? 'light' : 'dark',
    terminalScheme: id === 'dark' ? 'konx' : id === 'light' ? 'light' : null }]));

// Catalog palettes own chrome and output colors together; animation is a
// separate capability, not a consequence of having a custom palette.
function catalogTheme({ id, label, animated = false, appearance = 'dark', background, panel, terminal,
  foreground, muted, accent, selection, secondary, third, ok, warn, error, radius, palette }) {
  const light = appearance === 'light';
  return { id, label, animated, appearance, background: terminal, foreground,
    accent, muted, selection, secondary, palette,
    ...(animated ? { effect: id } : {}),
    ui: {
      '--bg': background, '--panel': panel,
      '--panel-2': `color-mix(in srgb, ${panel} 80%, ${background})`,
      '--panel-3': `color-mix(in srgb, ${accent} 8%, ${panel})`,
      '--text': foreground, '--text-strong': foreground, '--muted': muted, '--faint': muted,
      '--accent': accent, '--accent-strong': accent,
      '--accent-soft': `color-mix(in srgb, ${accent} 12%, ${panel})`,
      '--sel': `color-mix(in srgb, ${accent} 12%, ${panel})`,
      '--hover': `color-mix(in srgb, ${accent} 7%, transparent)`,
      '--border': `color-mix(in srgb, ${muted} 24%, ${panel})`,
      '--border-strong': `color-mix(in srgb, ${muted} 43%, ${panel})`,
      '--ok': ok, '--warn': warn, '--err': error,
      '--theme-button-text': light ? '#ffffff' : terminal,
      '--theme-danger-text': light ? '#ffffff' : terminal,
      '--theme-secondary': secondary, '--radius': radius + 'px',
      ...(animated ? { '--theme-third': third, '--theme-output-background': terminal } : {}),
      '--shadow': light ? '0 12px 40px #18283a2e' : '0 12px 40px #0008',
    },
  };
}

for (const value of [
  { id: 'obsidian-gold', label: 'Obsidian Gold', background: '#0d1014', panel: '#171c22', terminal: '#090c10',
    foreground: '#e9edf2', muted: '#9ba5b4', accent: '#d5b36a', selection: '#46402f', secondary: '#88baf0',
    ok: '#72caa4', warn: '#e7a55a', error: '#ed7e86', radius: 6,
    palette: { red: '#ed7e86', green: '#72caa4', yellow: '#e7a55a', blue: '#88baf0', magenta: '#c4a0e5', cyan: '#75ccd2' } },
  { id: 'arctic-glass', label: 'Arctic Glass', appearance: 'light', background: '#edf3fa', panel: '#fafcff', terminal: '#e6eef8',
    foreground: '#17273c', muted: '#52667e', accent: '#225ad8', selection: '#c0d2f1', secondary: '#7145a2',
    ok: '#16734b', warn: '#865b00', error: '#b42337', radius: 10,
    palette: { red: '#b42337', green: '#16734b', yellow: '#865b00', blue: '#225ad8', magenta: '#7145a2', cyan: '#156d78' } },
  { id: 'deep-ocean', label: 'Deep Ocean', background: '#0b1b22', panel: '#142a33', terminal: '#07151c',
    foreground: '#e1f0ee', muted: '#91b2b9', accent: '#71c9b6', selection: '#244d50', secondary: '#9bbef3',
    ok: '#98d693', warn: '#e7be78', error: '#f28c87', radius: 8,
    palette: { red: '#f28c87', green: '#98d693', yellow: '#e7be78', blue: '#9bbef3', magenta: '#c4afe5', cyan: '#71c9b6' } },
  { id: 'sandstone', label: 'Sandstone', appearance: 'light', background: '#ede6da', panel: '#faf5ec', terminal: '#e6dccc',
    foreground: '#332a24', muted: '#675549', accent: '#97482c', selection: '#d2baa5', secondary: '#7a437d',
    ok: '#286747', warn: '#805b16', error: '#b12c34', radius: 3,
    palette: { red: '#b12c34', green: '#286747', yellow: '#805b16', blue: '#3c608d', magenta: '#7a437d', cyan: '#25666c' } },
  { id: 'crimson-circuit', label: 'Crimson Circuit', background: '#171317', panel: '#241d24', terminal: '#100e12',
    foreground: '#f2e8ef', muted: '#b3a0b1', accent: '#e87089', selection: '#52303f', secondary: '#96bdf3',
    ok: '#79cbaa', warn: '#e6bc70', error: '#ff9582', radius: 2,
    palette: { red: '#ff9582', green: '#79cbaa', yellow: '#e6bc70', blue: '#96bdf3', magenta: '#d5a3e7', cyan: '#82cad0' } },
]) APP_THEMES[value.id] = catalogTheme(value);

for (const value of [
  { id: 'ion-storm', label: 'Ion Storm', background: '#080a1b', panel: '#11162b', terminal: '#060915',
    accent: '#a9bcff', secondary: '#50dfff', third: '#b875ff', selection: '#323d68', radius: 7,
    blue: '#a9bcff', magenta: '#d0a9ff', cyan: '#50dfff' },
  { id: 'solar-flare', label: 'Solar Flare', background: '#160c08', panel: '#241711', terminal: '#100907',
    accent: '#ffd18b', secondary: '#ff7657', third: '#ffe8ba', selection: '#58402a', radius: 4,
    blue: '#a9d5ff', magenta: '#f6b5dc', cyan: '#9ee5e5' },
  { id: 'aurora-flux', label: 'Aurora Flux', background: '#071715', panel: '#102521', terminal: '#06110f',
    accent: '#86f7cb', secondary: '#c9a0ff', third: '#48c9d9', selection: '#254c45', radius: 10,
    blue: '#a7d9ff', magenta: '#c9a0ff', cyan: '#79deeb' },
  { id: 'hyperdrive', label: 'Hyperdrive', background: '#060c19', panel: '#111c30', terminal: '#050914',
    accent: '#b9e3ff', secondary: '#718fff', third: '#d4b4ff', selection: '#2c4164', radius: 3,
    blue: '#a9c2ff', magenta: '#d4b4ff', cyan: '#9ae6ff' },
  { id: 'ghost-circuit', label: 'Ghost Circuit', background: '#101516', panel: '#1b2425', terminal: '#090f10',
    accent: '#cbf5e8', secondary: '#ffca7b', third: '#6cbaa5', selection: '#344e47', radius: 2,
    blue: '#a5ceff', magenta: '#d7b4f2', cyan: '#a0dfcf' },
]) APP_THEMES[value.id] = catalogTheme({
  ...value, animated: true, foreground: '#ebf3ff', muted: '#a9bbcb',
  ok: '#83e8b7', warn: '#ffd08b', error: '#ff989f',
  palette: { red: '#ff989f', green: '#83e8b7', yellow: '#ffd08b', blue: value.blue, magenta: value.magenta, cyan: value.cyan },
});

export function applicationTheme(name) {
  return Object.hasOwn(APP_THEMES, name) ? APP_THEMES[name] : APP_THEMES.dark;
}

export function scheme(name, uiTheme = 'dark') {
  if (name === 'app') {
    const theme = applicationTheme(uiTheme);
    if (theme.terminalScheme) return scheme(theme.terminalScheme);
    if (theme.palette) {
      const colors = { background: theme.background, foreground: theme.foreground,
        cursor: theme.accent, cursorAccent: theme.background, selectionBackground: theme.selection,
        black: theme.muted, brightBlack: theme.muted, white: theme.foreground, brightWhite: theme.foreground };
      for (const [name, color] of Object.entries(theme.palette)) {
        colors[name] = color;
        colors['bright' + name[0].toUpperCase() + name.slice(1)] = color;
      }
      return colors;
    }
    return {
      ...scheme('konx'), background: theme.background, foreground: theme.foreground,
      cursor: theme.accent, cursorAccent: theme.background, selectionBackground: theme.selection,
      black: theme.background, brightBlack: theme.muted, white: theme.foreground, brightWhite: '#ffffff',
      blue: '#8dcbff', brightBlue: '#b4e0ff', cyan: theme.accent, brightCyan: theme.accent,
      magenta: '#d5a8ff', brightMagenta: '#ebcaff', red: '#ff9a9a', brightRed: '#ffbbbb',
      green: '#8fe0ad', brightGreen: '#b2efc8', yellow: '#f3cf73', brightYellow: '#ffe6a6',
    };
  }
  const s = Object.hasOwn(SCHEMES, name) ? SCHEMES[name] : SCHEMES.konx;
  const { label, ...colors } = s;
  return colors;
}

export function usesThemeEffects(settings, meta = {}) {
  return (meta.colorScheme || settings.colorScheme || 'app') === 'app' && applicationTheme(settings.uiTheme).animated;
}

export function terminalTheme(settings, meta = {}) {
  const colors = scheme(meta.colorScheme || settings.colorScheme || 'app', settings.uiTheme);
  return usesThemeEffects(settings, meta) ? { ...colors, background: '#00000000' } : colors;
}
