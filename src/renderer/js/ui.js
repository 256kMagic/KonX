// Small DOM helpers, icons, dialogs, menus and formatting shared by every view.

export const api = window.api;

// The DOM turns null/undefined/false children into the text "null" etc. Views here pass
// optional parts as `cond ? node : null`, so skip those, as h() already does.
for (const name of ['replaceChildren', 'append']) {
  const orig = Element.prototype[name];
  Element.prototype[name] = function (...nodes) {
    return orig.apply(this, nodes.filter((n) => n != null && n !== false));
  };
}

/** h('div.cls#id', {attrs, on*: handlers}, ...children) */
export function h(spec, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) children.unshift(attrs);
    attrs = {};
  }
  const m = spec.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  terminal: '<path d="m4 17 6-5-6-5"/><path d="M12 19h8"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  'folder-open': '<path d="M3 7.5V6.2A1.2 1.2 0 0 1 4.2 5h4.5l2 2.2h7.8A1.5 1.5 0 0 1 20 8.7V10"/><path d="M3.3 19 5.6 11a1.4 1.4 0 0 1 1.4-1h13.6a1 1 0 0 1 1 1.3L19.4 18a1.4 1.4 0 0 1-1.4 1z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/>',
  download: '<path d="M12 4v12M6 10l6 6 6-6"/><path d="M4 20h16"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 18.5 5.5"/><circle cx="12" cy="12" r="1"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>',
  route: '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H17a3.5 3.5 0 0 0 0-7H7a3.5 3.5 0 0 1 0-7h8.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  network: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2h12v2"/>',
  'chev-right': '<path d="m9 6 6 6-6 6"/>',
  'chev-left': '<path d="m15 6-6 6 6 6"/>',
  'chev-down': '<path d="m6 9 6 6 6-6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M16 7l3 3M14 9l2 2"/>',
  log: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  'button-bar': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 13h18M7 16.5h2M11 16.5h2M15 16.5h2"/>',
  command: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 10 3 2-3 2M12 15h5"/>',
  'file-transfer': '<path d="M7 4v13M3 13l4 4 4-4M17 20V7M13 11l4-4 4 4"/>',
  usb: '<path d="M12 3v14"/><circle cx="12" cy="19" r="2"/><path d="m8 8 4-5 4 5M12 13l-4-2V8M12 11l4-2V7"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"/>',
  unplug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5M3 3l18 18"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  wifi: '<path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01"/>',
  cloud: '<path d="M7 18h11a4 4 0 0 0 .5-8 6.5 6.5 0 0 0-12.6-1.5A4.8 4.8 0 0 0 7 18z"/>',
  'file-plus': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
  wrap: '<path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4"/><path d="m16 16-2 2 2 2M3 18h7"/>',
  pilcrow: '<path d="M13 4v16M17 4v16M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/>',
  map: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18M18 7h-1M18 10h-1M18 13h-1"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  replace: '<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/>',
  capture: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M6 14h2l1.5-4 2.5 7 2-5 1 2h3"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  save: '<path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
  insight: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;
  return span.firstChild;
}

// ---------------------------------------------------------------- formatting

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}

export function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtMs(ms) {
  if (ms == null) return '';
  return ms < 1 ? '<1 ms' : ms < 10 ? ms.toFixed(1) + ' ms' : Math.round(ms) + ' ms';
}

export function errMsg(e) {
  const m = (e && e.message) || String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function csv(rows) {
  return rows.map((r) => r.map((v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : v ?? '')).join(',')).join('\r\n');
}

// ---------------------------------------------------------------- toast

export function toast(msg, type = '') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div#toasts');
    document.body.append(box);
  }
  const t = h('div.toast', { class: type }, msg);
  box.append(t);
  setTimeout(() => t.remove(), type === 'err' ? 7000 : 3500);
}

// ---------------------------------------------------------------- context menu

let openMenu = null;
export function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

/** items: [{label, icon, action, disabled, danger, shortcut} | '-'] */
export function contextMenu(x, y, items) {
  closeMenu();
  const menu = h('div.ctx');
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      menu.append(h('div.sep'));
      continue;
    }
    const row = h(
      'div.item',
      { class: [it.disabled && 'disabled', it.danger && 'danger'].filter(Boolean).join(' ') },
      it.icon ? icon(it.icon) : h('span', { style: { width: '16px' } }),
      it.label,
      it.shortcut ? h('span.sc', it.shortcut) : null
    );
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => {
      closeMenu();
      it.action && it.action();
    });
    menu.append(row);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  openMenu = menu;
}
addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});
addEventListener('blur', closeMenu);
addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());

// ---------------------------------------------------------------- modal

const modalStack = [];

/**
 * Generic modal. buttons: [{label, value, primary, danger}] ; resolves with the value
 * of the clicked button, or null on Escape / close. onEnter picks the primary button.
 */
export function modal({ title, icon: ic, body, buttons = [{ label: 'OK', value: true, primary: true }], width, footerLeft, onSubmit, onReady, submitOnEnter = true }) {
  return new Promise((resolve) => {
    const back = h('div.modal-back');
    const box = h('div.modal', { style: width ? { width: `min(${width}px, calc(100vw - 40px))` } : {} });
    const entry = {
      back,
      prevFocus: document.activeElement,
      focus: () => {
        if (!back.isConnected) return;
        const first = box.querySelector('input:not([type=checkbox]), select, textarea') || box.querySelector('.btn.primary');
        if (first) first.focus();
      },
    };
    let closed = false;
    let focusTimer;
    let observer;
    const isTop = () => !closed && back.isConnected && modalStack[modalStack.length - 1] === entry;
    const close = (v) => {
      if (closed) return;
      closed = true;
      const wasTop = modalStack[modalStack.length - 1] === entry;
      modalStack.splice(modalStack.indexOf(entry), 1);
      // If a covered dialog is removed, its child dialog should still restore
      // focus to a live element when it closes.
      for (const other of modalStack) {
        if (back.contains(other.prevFocus)) other.prevFocus = entry.prevFocus;
      }
      clearTimeout(focusTimer);
      if (observer) observer.disconnect();
      back.remove();
      removeEventListener('keydown', onKey, true);
      if (wasTop) {
        const top = modalStack[modalStack.length - 1];
        const prev = entry.prevFocus;
        if (prev && prev.isConnected && (!top || top.back.contains(prev))) prev.focus();
        else if (top) top.focus();
      }
      resolve(v);
    };
    const submit = (v) => {
      if (!isTop()) return;
      if (onSubmit) {
        const ok = onSubmit(v);
        if (ok === false) return;
      }
      close(v);
    };
    const onKey = (e) => {
      if (!isTop()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close(null);
      } else if (submitOnEnter && e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
        const p = buttons.find((b) => b.primary);
        if (p) {
          e.preventDefault();
          e.stopImmediatePropagation();
          submit(p.value);
        }
      }
    };
    addEventListener('keydown', onKey, true);
    box.append(
      h('header', ic ? icon(ic) : null, h('span', title), h('button.x', { onclick: () => close(null), title: 'Close' }, icon('x'))),
      h('div.body', body),
      h(
        'footer',
        footerLeft ? h('div.left', footerLeft) : null,
        buttons.map((b) =>
          h('button.btn', { class: b.primary ? 'primary' : b.danger ? 'danger' : '', onclick: () => (b.value === null ? close(null) : submit(b.value)) }, b.label)
        )
      )
    );
    back.append(box);
    back.addEventListener('mousedown', (e) => {
      if (e.target === back) close(null);
    });
    document.body.append(back);
    modalStack.push(entry);
    focusTimer = setTimeout(() => { if (isTop()) entry.focus(); }, 0);
    // Keep listeners, promises and focus tidy if a view removes a dialog.
    observer = new MutationObserver(() => { if (!back.isConnected) close(null); });
    observer.observe(document.body, { childList: true });
    if (onReady) onReady({ close });
  });
}

export async function confirmDialog(message, { title = 'Confirm', okLabel = 'OK', danger = false, detail } = {}) {
  const r = await modal({
    title,
    body: [h('div.message', message), detail ? h('div.hint', detail) : null],
    buttons: [
      { label: 'Cancel', value: null },
      { label: okLabel, value: true, primary: !danger, danger },
    ],
  });
  return r === true;
}

/**
 * Build form fields. field: {name, label, type: text|password|number|select|checkbox|textarea,
 * options: [[value,label]], value, placeholder, hint, span, browse: 'file'|'dir'}
 */
export function buildFields(fields, values = {}) {
  const inputs = {};
  const els = fields.map((f) => {
    const v = values[f.name] ?? f.value ?? '';
    let input;
    if (f.type === 'select') {
      input = h('select', f.options.map(([val, label]) => h('option', { value: val, selected: String(val) === String(v) }, label)));
    } else if (f.type === 'checkbox') {
      input = h('input', { type: 'checkbox', checked: !!(values[f.name] ?? f.value) });
      inputs[f.name] = input;
      return h('label.check', { class: f.span ? 'span' + f.span : '' }, input, f.label);
    } else if (f.type === 'textarea') {
      input = h('textarea', { rows: f.rows || 4, placeholder: f.placeholder || '' });
      input.value = v;
    } else {
      input = h('input', { type: f.type || 'text', placeholder: f.placeholder || '', spellcheck: false, autocomplete: 'off' });
      input.value = v;
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
    }
    inputs[f.name] = input;
    let control = input;
    if (f.browse) {
      control = h(
        'div.input-with-btn',
        input,
        h('button.btn.sm', {
          type: 'button',
          onclick: async () => {
            const p = await api.invoke(f.browse === 'dir' ? 'dialog:openDir' : 'dialog:openFile', {});
            if (p) input.value = p;
          },
        }, 'Browse…')
      );
    }
    return h('label.field', { class: f.span ? 'span' + f.span : '' }, h('span', f.label), control, f.hint ? h('div.hint', f.hint) : null);
  });
  const read = () => {
    const out = {};
    for (const f of fields) {
      const el = inputs[f.name];
      if (f.type === 'checkbox') out[f.name] = el.checked;
      else if (f.type === 'number') out[f.name] = el.value === '' ? '' : Number(el.value);
      else out[f.name] = el.value;
    }
    return out;
  };
  return { els, inputs, read };
}

export async function formDialog({ title, message, fields, okLabel = 'OK', icon: ic, width, values }) {
  const { els, read } = buildFields(fields, values);
  const r = await modal({
    title,
    icon: ic,
    width,
    body: [message ? h('div.message', message) : null, ...els],
    buttons: [
      { label: 'Cancel', value: null },
      { label: okLabel, value: 'ok', primary: true },
    ],
  });
  return r ? read() : null;
}

export async function promptText(title, label, value = '', okLabel = 'OK') {
  const r = await formDialog({ title, fields: [{ name: 'v', label, value }], okLabel });
  return r ? r.v.trim() : null;
}

/** Sortable, selectable table. columns: [{key, label, width, num, render(row), sort(row)}] */
export class DataTable {
  constructor({ columns, rowKey, onActivate, onContext, multi = true, emptyText = '' }) {
    this.columns = columns;
    this.rowKey = rowKey;
    this.onActivate = onActivate;
    this.onContext = onContext;
    this.multi = multi;
    this.emptyText = emptyText;
    this.rows = [];
    this.selected = new Set();
    this.sortKey = null;
    this.sortDir = 1;
    this.anchor = null;
    this.thead = h('thead');
    this.tbody = h('tbody');
    this.table = h('table.tbl', h('colgroup', columns.map((c) => h('col', { style: c.width ? { width: c.width + 'px' } : {} }))), this.thead, this.tbody);
    this.el = h('div.tbl-wrap', { tabIndex: 0 }, this.table);
    this.renderHead();
    this.el.addEventListener('contextmenu', (e) => {
      if (e.target.closest('tr[data-k]')) return;
      e.preventDefault();
      this.selected.clear();
      this.render();
      this.onContext && this.onContext(e, []);
    });
  }

  renderHead() {
    this.thead.replaceChildren(
      h(
        'tr',
        this.columns.map((c) =>
          h(
            'th',
            {
              class: [c.num && 'num', c.sortable !== false && 'sortable'].filter(Boolean).join(' '),
              onclick: () => {
                if (c.sortable === false) return;
                if (this.sortKey === c.key) this.sortDir = -this.sortDir;
                else {
                  this.sortKey = c.key;
                  this.sortDir = 1;
                }
                this.renderHead();
                this.render();
              },
            },
            c.label,
            this.sortKey === c.key ? h('span.arrow', this.sortDir > 0 ? '▲' : '▼') : null
          )
        )
      )
    );
  }

  setRows(rows) {
    this.rows = rows;
    const keys = new Set(rows.map((r) => this.rowKey(r)));
    for (const k of [...this.selected]) if (!keys.has(k)) this.selected.delete(k);
    this.render();
  }

  sorted() {
    const rows = [...this.rows];
    if (this.sortKey) {
      const col = this.columns.find((c) => c.key === this.sortKey);
      const get = col.sort || ((r) => r[col.key]);
      rows.sort((a, b) => {
        if (this.pin) {
          const p = this.pin(a) - this.pin(b);
          if (p) return p;
        }
        const x = get(a);
        const y = get(b);
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * this.sortDir;
        return String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true, sensitivity: 'base' }) * this.sortDir;
      });
    } else if (this.defaultSort) rows.sort(this.defaultSort);
    return rows;
  }

  render() {
    const rows = this.sorted();
    this.view = rows;
    if (!rows.length && this.emptyText) {
      this.tbody.replaceChildren(h('tr', h('td', { colSpan: this.columns.length, style: { color: 'var(--muted)', height: '60px', textAlign: 'center' } }, this.emptyText)));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const k = this.rowKey(r);
      const tr = h(
        'tr',
        { 'data-k': k, class: this.selected.has(k) ? 'selected' : '' },
        this.columns.map((c) => {
          const v = c.render ? c.render(r) : r[c.key];
          return h('td', { class: [c.num && 'num', c.mono && 'mono'].filter(Boolean).join(' '), title: typeof v === 'string' ? v : '' }, v);
        })
      );
      tr.addEventListener('mousedown', (e) => this._click(e, k));
      tr.addEventListener('dblclick', () => this.onActivate && this.onActivate(r));
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!this.selected.has(k)) {
          this.selected = new Set([k]);
          this.render();
        }
        this.onContext && this.onContext(e, this.selectedRows());
      });
      if (this.decorate) this.decorate(tr, r);
      frag.append(tr);
    }
    this.tbody.replaceChildren(frag);
  }

  _click(e, k) {
    if (e.button === 2 && this.selected.has(k)) return;
    if (this.multi && (e.ctrlKey || e.metaKey)) {
      this.selected.has(k) ? this.selected.delete(k) : this.selected.add(k);
      this.anchor = k;
    } else if (this.multi && e.shiftKey && this.anchor != null) {
      const keys = this.view.map((r) => this.rowKey(r));
      const a = keys.indexOf(this.anchor);
      const b = keys.indexOf(k);
      this.selected = new Set(keys.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else {
      this.selected = new Set([k]);
      this.anchor = k;
    }
    this.render();
    this.onSelect && this.onSelect(this.selectedRows());
  }

  selectedRows() {
    return this.rows.filter((r) => this.selected.has(this.rowKey(r)));
  }

  selectAll() {
    this.selected = new Set(this.rows.map((r) => this.rowKey(r)));
    this.render();
  }
}
