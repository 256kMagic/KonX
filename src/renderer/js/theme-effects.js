// Decorative layers never receive pointer/keyboard events or enter tool output.
import { APP_THEMES, applicationTheme, scheme } from './themes.js';
import { mountThemeAtmospheres } from './theme-atmospheres.js';

const chromeProperties = new Set(Object.values(APP_THEMES).flatMap(theme => Object.keys(theme.ui || {})));
const nativeVisibility = new WeakMap();

// Either native or browser-hidden state pauses motion. Native snapshots cover
// minimized unthrottled windows whose document.hidden remains false; browser
// state still covers occlusion. Theme saves and DOM adoption use this same owner.
export function applyThemeVisibility(doc = document, visible) {
  if (typeof visible === 'boolean') nativeVisibility.set(doc, visible);
  doc.documentElement.dataset.themeVisible = String(nativeVisibility.get(doc) !== false && !doc.hidden);
}

export function applyApplicationTheme(settings, doc = document) {
  const theme = applicationTheme(settings.uiTheme);
  const root = doc.documentElement;
  root.dataset.theme = theme.id;
  root.dataset.appearance = theme.appearance;
  root.classList.toggle('theme-animated', theme.animated);
  root.classList.toggle('theme-static', !!theme.ui && !theme.animated);
  root.classList.toggle('theme-atmospheric', !!theme.effect);
  for (const name of chromeProperties) {
    if (theme.ui?.[name]) root.style.setProperty(name, theme.ui[name]);
    else root.style.removeProperty(name);
  }
  root.dataset.themeMotion = settings.themeAnimations === false ? 'paused' : 'running';
  applyThemeVisibility(doc);
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
  mountThemeAtmospheres(fx);
  host.prepend(fx);
}

const registeredEditors = new WeakMap();
export function editorTheme(monaco, settings) {
  const theme = applicationTheme(settings.uiTheme);
  if (theme.terminalScheme) return theme.id === 'light' ? 'konx-light' : 'konx-dark';
  const palette = scheme('app', theme.id);
  let registered = registeredEditors.get(monaco);
  if (!registered) registeredEditors.set(monaco, registered = new Set());
  const name = 'konx-' + theme.id;
  if (!registered.has(name)) {
    monaco.editor.defineTheme(name, {
      base: theme.appearance === 'light' ? 'vs' : 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: theme.muted.slice(1), fontStyle: 'italic' },
        { token: 'keyword', foreground: theme.accent.slice(1) },
        { token: 'keyword.section', foreground: theme.accent.slice(1), fontStyle: 'bold' },
        { token: 'keyword.sub', foreground: palette.magenta.slice(1) },
        { token: 'keyword.no', foreground: palette.yellow.slice(1) },
        { token: 'keyword.permit', foreground: palette.green.slice(1) },
        { token: 'keyword.deny', foreground: palette.red.slice(1) },
        { token: 'number.ip', foreground: (theme.animated ? palette.blue : theme.accent).slice(1) },
        { token: 'number.mac', foreground: palette.magenta.slice(1) },
        { token: 'type.interface', foreground: palette.yellow.slice(1) },
        ...(theme.palette || !theme.animated ? [
          { token: 'number', foreground: palette.blue.slice(1) },
          { token: 'string', foreground: palette.green.slice(1) },
        ] : []),
        { token: 'date', foreground: theme.muted.slice(1) },
        { token: 'log.error', foreground: palette.red.slice(1) },
        { token: 'log.warn', foreground: palette.yellow.slice(1) },
        { token: 'log.info', foreground: palette.green.slice(1) },
        { token: 'log.debug', foreground: theme.muted.slice(1) },
      ],
      colors: {
        'editor.background': theme.animated ? '#00000000' : theme.background, 'editor.foreground': theme.foreground,
        'editorGutter.background': theme.animated ? '#00000000' : theme.background, 'minimap.background': theme.background,
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
