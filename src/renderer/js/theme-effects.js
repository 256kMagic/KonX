// Decorative layers never receive pointer/keyboard events or enter tool output.
import { applicationTheme } from './themes.js';

export function applyApplicationTheme(settings, doc = document) {
  const theme = applicationTheme(settings.uiTheme);
  const root = doc.documentElement;
  root.dataset.theme = theme.id;
  root.classList.toggle('theme-animated', theme.animated);
  root.dataset.themeMotion = settings.themeAnimations === false ? 'paused' : 'running';
  root.dataset.themeVisible = String(!doc.hidden);
  return theme;
}

export function mountThemeOutput(host) {
  if (host.querySelector(':scope > .theme-output-fx')) return;
  const doc = host.ownerDocument;
  const make = (name, parent) => { const el = doc.createElement('div'); el.className = name; parent.append(el); return el; };
  const fx = doc.createElement('div');
  fx.className = 'theme-output-fx';
  fx.setAttribute('aria-hidden', 'true');
  const rain = make('theme-code-rain', fx);
  for (let i = 0; i < 6; i++) {
    const col = doc.createElement('span');
    const text = Array.from({ length: 24 }, (_, j) => (j * 7 + i * 3) % 5 > 1 ? '1' : '0').join('\n');
    col.textContent = text + '\n' + text;
    rain.append(col);
  }
  make('theme-horizon', fx);
  const engine = make('theme-engine', fx);
  for (const name of ['theme-engine-glow', 'theme-plasma-field', 'theme-orbit', 'theme-orbit theme-orbit-inner', 'theme-engine-core']) make(name, engine);
  host.prepend(fx);
}

const registeredEditors = new WeakMap();
export function editorTheme(monaco, settings) {
  const theme = applicationTheme(settings.uiTheme);
  if (!theme.animated) return theme.id === 'light' ? 'konx-light' : 'konx-dark';
  let registered = registeredEditors.get(monaco);
  if (!registered) registeredEditors.set(monaco, registered = new Set());
  const name = 'konx-' + theme.id;
  if (!registered.has(name)) {
    monaco.editor.defineTheme(name, {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: theme.muted.slice(1), fontStyle: 'italic' },
        { token: 'keyword', foreground: theme.accent.slice(1) },
        { token: 'keyword.section', foreground: theme.accent.slice(1), fontStyle: 'bold' },
        { token: 'keyword.sub', foreground: 'd5a8ff' },
        { token: 'keyword.no', foreground: 'f3cf73' },
        { token: 'keyword.permit', foreground: '8fe0ad' },
        { token: 'keyword.deny', foreground: 'ff9a9a' },
        { token: 'number.ip', foreground: '8dcbff' },
        { token: 'number.mac', foreground: 'd5a8ff' },
        { token: 'type.interface', foreground: 'f3cf73' },
        { token: 'date', foreground: theme.muted.slice(1) },
        { token: 'log.error', foreground: 'ff9a9a' },
        { token: 'log.warn', foreground: 'f3cf73' },
        { token: 'log.info', foreground: '8fe0ad' },
        { token: 'log.debug', foreground: theme.muted.slice(1) },
      ],
      colors: {
        'editor.background': '#00000000', 'editor.foreground': theme.foreground,
        'editorGutter.background': '#00000000', 'minimap.background': theme.background,
        'editor.lineHighlightBackground': theme.accent + '0c', 'editor.lineHighlightBorder': '#00000000',
        'editorLineNumber.foreground': theme.muted, 'editorLineNumber.activeForeground': theme.accent,
        'editorCursor.foreground': theme.accent, 'editor.selectionBackground': theme.selection,
        'editor.inactiveSelectionBackground': theme.selection + '88',
        'editorWidget.background': theme.background, 'editorWidget.border': theme.accent + '66',
        'editorSuggestWidget.background': theme.background, 'editorHoverWidget.background': theme.background,
        'input.background': theme.background, 'input.foreground': theme.foreground,
        'editorIndentGuide.background1': theme.muted + '30',
      },
    });
    registered.add(name);
  }
  return name;
}
