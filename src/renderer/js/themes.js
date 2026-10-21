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
  [id, { id, label, animated, background, foreground, accent, muted, selection, secondary }]));

export function applicationTheme(name) {
  return Object.hasOwn(APP_THEMES, name) ? APP_THEMES[name] : APP_THEMES.dark;
}

export function scheme(name, uiTheme = 'dark') {
  if (name === 'app') {
    const theme = applicationTheme(uiTheme);
    if (!theme.animated) return scheme(theme.id === 'light' ? 'light' : 'konx');
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
