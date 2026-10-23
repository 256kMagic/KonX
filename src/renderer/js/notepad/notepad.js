// KonX Notepad: a Notepad++-style editor built on Monaco. Document tabs, encodings and
// line endings, line tools, Find in Files, Compare, session restore with unsaved backups,
// remote (SFTP) files, and sending text to terminal sessions.
import { h, icon, api, contextMenu, modal, toast, errMsg, confirmDialog, buildFields, debounce } from '../ui.js';
import { loadMonaco } from './monaco.js';
import * as T from './textops.mjs';
import { toolsMenu, findInFilesDialog, sendToTerminalDialog, hashDialog } from './notepad-tools.js';
import { editorTheme, mountThemeOutput } from '../theme-effects.js';
import { createWorkspaceEvidence, captureNotepadContext, workspaceCopilotItems, workspaceContextChoices } from '../copilot-workspace.mjs';

let seq = 0;
const newId = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;
const basename = (p) => String(p).split(/[\\/]/).pop();
const EOL_LABEL = { CRLF: 'Windows (CR LF)', LF: 'Unix (LF)', CR: 'Macintosh (CR)' };

export class NotepadTab {
  constructor(app) {
    this.app = app;
    this.kind = 'notepad';
    this.id = 'notepad';
    this.title = 'Notepad';
    this.icon = 'edit';
    this.state = 'idle';
    this.disposed = false;
    this.visibilityGeneration = 0;
    this.restoring = true;
    this.docs = [];
    this.current = null;
    this.closed = [];
    this.copilot = createWorkspaceEvidence(this, 'Notepad text');
    this.opts = { wordWrap: false, minimap: true, whitespace: false, fontSize: null, sendDelay: 150, ...(app.settings.notepad || {}) };
    this.build();
    this.hostWindow = this.el.ownerDocument.defaultView;
    this.ready = this.init().catch((e) => {
      if (!this.disposed) this.host.replaceChildren(h('div.np-loading', `The editor could not start: ${errMsg(e)}`));
      throw e;
    });
  }

  // ------------------------------------------------------------ layout

  build() {
    const menu = (label, items) => h('button.np-menu', { onclick: (e) => this.openMenu(e, items) }, label);
    this.menubar = h(
      'div.np-menubar',
      menu('File', () => this.fileMenu()),
      menu('Edit', () => this.editMenu()),
      menu('Search', () => this.searchMenu()),
      menu('View', () => this.viewMenu()),
      menu('Encoding', () => this.encodingMenu()),
      menu('Language', () => this.languageMenu()),
      menu('Tools', () => toolsMenu(this)),
      menu('Ask Copilot', () => workspaceCopilotItems(this)),
      h('div.np-sep'),
      this.iconBtn('file-plus', 'New (Ctrl+N)', () => this.newDoc()),
      this.iconBtn('folder-open', 'Open (Ctrl+O)', () => this.open()),
      this.iconBtn('save', 'Save (Ctrl+S)', () => this.save()),
      h('div.np-sep'),
      this.iconBtn('undo', 'Undo (Ctrl+Z)', () => this.run('undo')),
      this.iconBtn('redo', 'Redo (Ctrl+Y)', () => this.run('redo')),
      h('div.np-sep'),
      this.iconBtn('search', 'Find (Ctrl+F)', () => this.action('actions.find')),
      this.iconBtn('replace', 'Replace (Ctrl+H)', () => this.action('editor.action.startFindReplaceAction')),
      h('div.np-sep'),
      (this.wrapBtn = this.iconBtn('wrap', 'Word wrap', () => this.toggleOpt('wordWrap'))),
      (this.wsBtn = this.iconBtn('pilcrow', 'Show whitespace', () => this.toggleOpt('whitespace'))),
      (this.mapBtn = this.iconBtn('map', 'Document map', () => this.toggleOpt('minimap'))),
      h('div.np-sep'),
      this.iconBtn('columns', 'Compare with another document', () => this.compareDialog()),
      this.iconBtn('send', 'Send to terminal…', () => sendToTerminalDialog(this)),
      h('div', { style: { flex: 1 } })
    );
    this.tabsEl = h('div.np-tabs');
    this.tabsEl.addEventListener('dblclick', (e) => e.target === this.tabsEl && this.newDoc());
    this.host = h('div.np-editor', h('div.np-loading', 'Loading editor…'));
    this.diffBar = h('div.np-diffbar.hidden');
    this.diffHost = h('div.np-editor.hidden');
    this.results = h('div.np-results.hidden');
    this.statusEl = h('div.np-status');
    this.el = h('div.view', h('div.np', this.menubar, this.tabsEl, this.diffBar, this.host, this.diffHost, this.results, this.statusEl));
    this.el.addEventListener('dragover', (e) => e.dataTransfer.types.includes('Files') && e.preventDefault());
    this.el.addEventListener('drop', (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      for (const f of e.dataTransfer.files) {
        const p = api.pathForFile(f);
        if (p) this.openFile(p);
      }
    });
    this.syncToggles();
  }

  iconBtn(name, title, fn) {
    return h('button.icon-btn', { title, onclick: fn }, icon(name));
  }

  openMenu(e, items) {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 2, typeof items === 'function' ? items() : items);
  }

  async init() {
    const monaco = await loadMonaco();
    if (this.disposed) return;
    this.monaco = monaco;
    this.host.replaceChildren();
    this.editor = monaco.editor.create(this.host, {
      model: null,
      automaticLayout: true,
      theme: this.theme(),
      fontFamily: this.app.settings.fontFamily,
      fontSize: this.opts.fontSize || this.app.settings.fontSize,
      minimap: { enabled: this.opts.minimap },
      wordWrap: this.opts.wordWrap ? 'on' : 'off',
      renderWhitespace: this.opts.whitespace ? 'all' : 'selection',
      renderControlCharacters: true,
      lineNumbersMinChars: 4,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      smoothScrolling: true,
      mouseWheelZoom: true,
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: false },
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true },
      stickyScroll: { enabled: false },
      find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection', autoFindInSelection: 'multiline' },
      folding: true,
      showFoldingControls: 'mouseover',
      fixedOverflowWidgets: true,
      dragAndDrop: true,
      wordBasedSuggestions: 'currentDocument',
      quickSuggestions: false,
      emptySelectionClipboard: true,
    });
    mountThemeOutput(this.host);
    this.bindKeys();
    this.editor.onDidChangeCursorSelection(() => { this.updateStatus(); this.copilot.touch(); });
    this.editor.onDidChangeModelContent(() => this.onContentChange());
    this.saveSessionSoon = debounce(() => this.saveSession(), 400);
    this.backupSoon = debounce(() => this.backupDirty(), 800);
    this.unwatch = [
      api.on('np:changed', (p, info) => this.onDiskChange(p, info)),
      api.on('np:found', (job, rows) => this.findPanel && this.findPanel.add(job, rows)),
      api.on('np:findDone', (job, s) => this.findPanel && this.findPanel.done(job, s)),
    ];
    this.beforeUnload = () => this.flush();
    addEventListener('beforeunload', this.beforeUnload);
    if (this.hostWindow && this.hostWindow !== window) this.hostWindow.addEventListener('beforeunload', this.beforeUnload);
    await this.restore();
    this.restoring = false;
  }

  theme() {
    return editorTheme(this.monaco, this.app.settings);
  }

  bindKeys() {
    const m = this.monaco;
    const K = m.KeyCode;
    const C = m.KeyMod.CtrlCmd;
    const S = m.KeyMod.Shift;
    const A = m.KeyMod.Alt;
    const cmd = (keys, fn) => this.editor.addCommand(keys, fn);
    cmd(C | K.KeyN, () => this.newDoc());
    cmd(C | K.KeyO, () => this.open());
    cmd(C | K.KeyS, () => this.save());
    cmd(C | A | K.KeyS, () => this.saveAs());
    cmd(C | S | K.KeyS, () => this.saveAll());
    cmd(C | K.KeyW, () => this.closeDoc(this.current));
    cmd(C | S | K.KeyT, () => this.reopenClosed());
    // Notepad++ habits
    cmd(C | K.KeyD, () => this.action('editor.action.copyLinesDownAction'));
    cmd(C | K.KeyL, () => this.action('editor.action.deleteLines'));
    cmd(C | S | K.UpArrow, () => this.action('editor.action.moveLinesUpAction'));
    cmd(C | S | K.DownArrow, () => this.action('editor.action.moveLinesDownAction'));
    cmd(C | K.KeyQ, () => this.action('editor.action.commentLine'));
    cmd(C | K.KeyU, () => this.transform(T.toLower, { lines: false }));
    cmd(C | S | K.KeyU, () => this.transform(T.toUpper, { lines: false }));
    cmd(C | K.KeyJ, () => this.transform(T.joinLines));
    cmd(C | S | K.KeyF, () => findInFilesDialog(this));
    cmd(C | K.Equal, () => this.zoom(1));
    cmd(C | K.Minus, () => this.zoom(-1));
    cmd(C | K.Digit0, () => this.zoom(0));
  }

  /** Called by the app before its own shortcuts: Ctrl+Tab cycles documents here. */
  onGlobalKey(e) {
    if (e.ctrlKey && (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp') && this.docs.length > 1) {
      const back = e.shiftKey || e.key === 'PageUp';
      const i = this.docs.indexOf(this.current);
      this.activate(this.docs[(i + (back ? this.docs.length - 1 : 1)) % this.docs.length]);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ documents

  isDirty(d) {
    return d.model.getAlternativeVersionId() !== d.savedVersion;
  }

  untitledName() {
    const used = new Set(this.docs.filter((d) => d.untitled).map((d) => d.title));
    let n = 1;
    while (used.has(`new ${n}`)) n++;
    return `new ${n}`;
  }

  /** Create a document. Clean unless opts.dirty. */
  createDoc({ id = newId(), text = '', title, path = null, remote = null, language, encoding = 'utf-8', eol, mtime = null, dirty = false, readOnly = false }) {
    const m = this.monaco;
    const detectedEol = eol || T.detectEol(text, 'CRLF');
    const lang = language || T.detectLanguage(title || path || '', text);
    const model = m.editor.createModel(text, lang);
    model.setEOL(detectedEol === 'CRLF' ? m.editor.EndOfLineSequence.CRLF : m.editor.EndOfLineSequence.LF);
    model.updateOptions({ tabSize: lang === 'ios' ? 1 : 4, insertSpaces: true });
    const doc = { id, title: title || (path ? basename(path) : this.untitledName()), path, remote, model, encoding, eol: detectedEol, mtime, readOnly, untitled: !path && !remote, viewState: null };
    doc.savedVersion = dirty ? -1 : model.getAlternativeVersionId();
    this.docs.push(doc);
    return doc;
  }

  newDoc({ text = '', title, language } = {}) {
    const d = this.createDoc({ text, title, language: language || (text ? undefined : 'plaintext'), dirty: !!text });
    d.untitled = true;
    this.activate(d);
    this.changed();
    return d;
  }

  activate(doc) {
    if (this.disposed || !doc || !this.editor) return;
    if (this.diffEditor) this.closeCompare();
    if (this.current && this.current !== doc) this.current.viewState = this.editor.saveViewState();
    this.current = doc;
    this.copilot.begin({ documentId: doc.id, source: 'current editor model' }, `${this.id}:${doc.id}`);
    this.copilot.finish();
    this.editor.setModel(doc.model);
    this.editor.updateOptions({ readOnly: !!doc.readOnly });
    if (doc.viewState) this.editor.restoreViewState(doc.viewState);
    this.focus();
    this.renderTabs();
    this.updateStatus();
    this.app.setTabTitle(this, `Notepad — ${doc.title}`);
    this.saveSessionSoon && this.saveSessionSoon();
  }

  findDoc(pred) {
    return this.docs.find(pred);
  }

  async open() {
    const files = await api.invoke('np:open', { defaultPath: this.current && this.current.path ? this.current.path : undefined });
    for (const f of files) {
      if (f.error) toast(`${basename(f.path)}: ${f.error}`, 'err');
      else this.openBytes(f.bytes, { path: f.path, mtime: f.mtime });
    }
  }

  async openFile(path, { line, col, len } = {}) {
    await this.ready;
    let d = this.findDoc((x) => x.path && x.path.toLowerCase() === path.toLowerCase());
    if (!d) {
      try {
        const f = await api.invoke('np:read', path);
        d = this.openBytes(f.bytes, { path, mtime: f.mtime });
      } catch (e) {
        toast(errMsg(e), 'err');
        return null;
      }
    } else this.activate(d);
    if (d && line) this.reveal(line, col || 1, len || 0);
    return d;
  }

  openBytes(bytes, { path = null, remote = null, mtime = null, title } = {}) {
    const dec = T.decodeBytes(bytes);
    if (dec.binary) toast(`${title || basename(path || 'file')} looks like a binary file; it is opened read-only.`, 'err');
    // Replace an untouched empty "new 1" like Notepad++ does.
    const blank = this.docs.length === 1 && this.docs[0].untitled && !this.docs[0].model.getValueLength() ? this.docs[0] : null;
    const d = this.createDoc({ text: dec.text, path, remote, mtime, title: title || (path ? basename(path) : undefined), encoding: dec.encoding, readOnly: dec.binary });
    this.activate(d);
    if (blank) this.removeDoc(blank);
    this.remember(path);
    this.changed();
    return d;
  }

  /** Open a file from an SFTP tab; saving writes it back over SFTP. */
  async openRemote(sftpId, remotePath, host) {
    await this.ready;
    const existing = this.findDoc((x) => x.remote && x.remote.sftpId === sftpId && x.remote.path === remotePath);
    if (existing) return this.activate(existing);
    try {
      const bytes = await api.invoke('sftp:readFile', sftpId, remotePath);
      const d = this.openBytes(bytes, { remote: { sftpId, path: remotePath, host }, title: `${basename(remotePath)} (${host})` });
      toast(`Editing ${host}:${remotePath}. Ctrl+S saves it back to the server.`, 'ok');
      return d;
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  }

  reveal(line, col = 1, len = 0) {
    if (this.disposed) return;
    const m = this.monaco;
    const range = new m.Range(line, col, line, col + len);
    this.editor.setSelection(range);
    this.editor.revealRangeInCenter(range);
    this.focus();
  }

  encodeDoc(d) {
    const m = this.monaco;
    let text = d.model.getValue(m.editor.EndOfLinePreference.TextDefined);
    if (d.eol === 'CR') text = text.replace(/\r?\n/g, '\r');
    return T.encodeText(text, d.encoding);
  }

  async save(d = this.current) {
    if (!d) return false;
    return this.queueSave(d, false);
  }

  async saveAs(d = this.current) {
    if (!d) return false;
    return this.queueSave(d, true);
  }

  async queueSave(d, saveAs) {
    // Keep writes (including Save As dialogs) in order for each document. A late
    // completion must never overwrite a newer save or change its destination.
    const pending = d.savePending || Promise.resolve();
    const saving = pending.then(() => this.writeDoc(d, saveAs), () => this.writeDoc(d, saveAs));
    d.savePending = saving;
    try {
      return await saving;
    } finally {
      if (d.savePending === saving) d.savePending = null;
    }
  }

  async writeDoc(d, saveAs) {
    const isOpen = () => this.docs.includes(d) && !d.model.isDisposed();
    if (!isOpen()) return false;
    if (!saveAs && d.readOnly) return toast('This document is read-only', 'err'), false;
    saveAs = saveAs || (!d.path && !d.remote);
    try {
      const bytes = this.encodeDoc(d);
      const version = d.model.getAlternativeVersionId();
      const encoding = d.encoding;
      const eol = d.eol;
      if (bytes.lossy && !(await confirmDialog(`${bytes.lossy} character(s) cannot be stored in ANSI and will be saved as "?".`, { title: 'Characters will be lost', okLabel: 'Save anyway', detail: 'Choose Encoding → UTF-8 to keep them.' }))) return false;
      if (!isOpen()) return false;
      let result;
      if (saveAs) {
        const suggested = d.path || (d.untitled ? `${d.title}.txt` : basename(d.remote ? d.remote.path : d.title));
        result = await api.invoke('np:saveAs', suggested, bytes);
        if (!result) return false;
      } else if (d.remote) {
        await api.invoke('sftp:writeFile', d.remote.sftpId, d.remote.path, bytes);
      } else {
        result = await api.invoke('np:write', d.path, bytes);
      }
      // Closing the editor may dispose its models while IPC is still pending.
      if (!isOpen()) return false;
      if (result) d.mtime = result.mtime;
      if (saveAs) {
        d.path = result.path;
        d.remote = null;
        d.untitled = false;
        d.title = basename(result.path);
        if (d.model.getLanguageId() === 'plaintext') this.setLanguage(T.detectLanguage(result.path, d.model.getValue()), d);
        this.remember(result.path);
        if (this.current === d) this.app.setTabTitle(this, `Notepad — ${d.title}`);
      }
      // Only the text and format captured above reached disk. Edits made during
      // the write stay dirty and must retain a current recovery copy.
      d.savedVersion = d.encoding === encoding && d.eol === eol ? version : -1;
      const dirty = this.isDirty(d);
      api.send('np:backup', d.id, dirty ? d.model.getValue() : null);
      d.backedUpVersion = dirty ? d.model.getAlternativeVersionId() : null;
      this.changed();
      this.flashStatus(`Saved ${d.remote ? d.remote.host + ':' + d.remote.path : d.path}`);
      return true;
    } catch (e) {
      toast(`Save failed: ${errMsg(e)}${d.remote ? ' (is the SFTP tab still connected?)' : ''}`, 'err');
      return false;
    }
  }

  async saveAll() {
    for (const d of this.docs) if (this.isDirty(d)) await this.save(d);
  }

  async closeDoc(d, { force = false } = {}) {
    if (!d) return true;
    if (!force) while (d.savePending) await d.savePending;
    if (!this.docs.includes(d) || d.model.isDisposed()) return true;
    if (!force && this.isDirty(d)) {
      this.activate(d);
      const r = await modal({
        title: 'Save changes?',
        icon: 'save',
        body: h('div.message', `Save changes to "${d.title}"?`),
        buttons: [
          { label: 'Cancel', value: null },
          { label: "Don't save", value: 'discard' },
          { label: 'Save', value: 'save', primary: true },
        ],
      });
      if (!r) return false;
      if (r === 'save') {
        if (!(await this.save(d))) return false;
        if (!this.docs.includes(d) || d.model.isDisposed()) return true;
        if (this.isDirty(d)) return false;
      }
    }
    if (d.path) this.closed.push(d.path);
    this.removeDoc(d);
    return true;
  }

  removeDoc(d) {
    const i = this.docs.indexOf(d);
    if (i < 0) return;
    this.docs.splice(i, 1);
    api.send('np:backup', d.id, null);
    if (this.current === d) {
      this.current = null;
      if (this.docs.length) this.activate(this.docs[Math.min(i, this.docs.length - 1)]);
    }
    d.model.dispose();
    if (!this.docs.length) this.newDoc();
    this.changed();
  }

  async closeOthers(keep) {
    for (const d of [...this.docs]) if (d !== keep && !(await this.closeDoc(d))) return;
  }

  async closeAll() {
    for (const d of [...this.docs]) if (!(await this.closeDoc(d))) return;
  }

  reopenClosed() {
    const p = this.closed.pop();
    if (p) this.openFile(p);
  }

  async reload(d = this.current, { ask = true, encoding = null } = {}) {
    if (!d || !d.path) return;
    if (ask && this.isDirty(d) && !(await confirmDialog(`Reload "${d.title}" from disk and lose your changes?`, { okLabel: 'Reload', danger: true }))) return;
    const isOpen = () => this.docs.includes(d) && !d.model.isDisposed();
    if (!isOpen()) return;
    const file = d.path;
    const version = d.model.getAlternativeVersionId();
    const previousEncoding = d.encoding;
    const previousEol = d.eol;
    const request = d.reloadRequest = (d.reloadRequest || 0) + 1;
    try {
      const f = await api.invoke('np:read', file);
      if (!isOpen() || d.reloadRequest !== request) return;
      // Reading the file is asynchronous. Never overwrite typing or a changed
      // destination/format that arrived after the reload was requested.
      if (d.path !== file || d.model.getAlternativeVersionId() !== version || d.encoding !== previousEncoding || d.eol !== previousEol || d.savePending) {
        toast(`"${d.title}" changed while loading. Reload again to replace those changes.`, 'err');
        return;
      }
      let dec;
      if (encoding) {
        const bytes = new Uint8Array(f.bytes);
        const bom = encoding.startsWith('utf-16')
          ? bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) ? 2 : 0
          : encoding === 'utf-8' && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
        dec = { text: new TextDecoder(encoding).decode(bytes.subarray(bom)), encoding };
      } else dec = T.decodeBytes(f.bytes);
      const view = this.current === d ? this.editor.saveViewState() : d.viewState;
      d.model.setValue(dec.text);
      d.encoding = dec.encoding;
      d.eol = T.detectEol(dec.text, d.eol);
      d.mtime = f.mtime;
      d.savedVersion = d.model.getAlternativeVersionId();
      if (this.current === d && view) this.editor.restoreViewState(view);
      this.changed();
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  }

  /** Reopen the file from disk, decoding it with a specific encoding. */
  async reopenWithEncoding(enc, d = this.current) {
    if (!d || !d.path) return toast('Save the document first', 'err');
    return this.reload(d, { encoding: enc });
  }

  setEncoding(enc, d = this.current) {
    if (!d || d.encoding === enc) return;
    d.encoding = enc;
    d.savedVersion = -1; // saving is needed to apply it
    this.changed();
  }

  setEol(eol, d = this.current) {
    if (!d || d.eol === eol) return;
    const m = this.monaco;
    d.eol = eol;
    d.model.pushEOL(eol === 'CRLF' ? m.editor.EndOfLineSequence.CRLF : m.editor.EndOfLineSequence.LF);
    d.savedVersion = -1;
    this.changed();
  }

  setLanguage(lang, d = this.current) {
    if (!d) return;
    this.monaco.editor.setModelLanguage(d.model, lang);
    d.model.updateOptions({ tabSize: lang === 'ios' ? 1 : 4 });
    this.changed();
  }

  async onDiskChange(path, info) {
    const d = this.findDoc((x) => x.path === path);
    if (!d || d.diskPrompt) return;
    if (info.deleted) {
      toast(`"${d.title}" was deleted or moved. Save to recreate it.`, 'err');
      d.savedVersion = -1;
      this.changed();
      return;
    }
    if (!this.isDirty(d)) {
      await this.reload(d, { ask: false });
      this.flashStatus(`Reloaded "${d.title}" (changed by another program)`);
      return;
    }
    d.diskPrompt = true;
    const ok = await confirmDialog(`"${d.title}" was changed by another program. Reload it and lose your unsaved changes?`, { title: 'File changed on disk', okLabel: 'Reload' });
    d.diskPrompt = false;
    if (ok) this.reload(d, { ask: false });
  }

  // ------------------------------------------------------------ editing helpers

  run(cmd) {
    this.focus();
    this.editor.trigger('konx', cmd, null);
  }

  action(id) {
    const a = this.editor && this.editor.getAction(id);
    if (a) {
      this.focus();
      a.run();
    } else if (this.editor) this.editor.trigger('konx', id, null);
  }

  /**
   * Apply fn(text) to each selection (expanded to whole lines when lines=true), or the whole
   * document when nothing is selected. Undoable as one step.
   */
  transform(fn, { lines = true, whole = false } = {}) {
    const ed = this.editor;
    const m = this.monaco;
    const model = ed.getModel();
    if (!model || this.current.readOnly) return;
    const sels = ed.getSelections();
    const edits = [];
    try {
      if (whole || sels.every((s) => s.isEmpty())) {
        edits.push({ range: model.getFullModelRange(), text: fn(model.getValue(m.editor.EndOfLinePreference.LF)) });
      } else {
        for (const s of sels) {
          if (s.isEmpty()) continue;
          const endLine = lines && s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber;
          const range = lines ? new m.Range(s.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine)) : s;
          edits.push({ range, text: fn(model.getValueInRange(range, m.editor.EndOfLinePreference.LF)) });
        }
      }
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
    ed.pushUndoStop();
    ed.executeEdits('konx', edits);
    ed.pushUndoStop();
    this.focus();
  }

  /** The selection, or the whole document when nothing is selected. */
  selectionOrAll() {
    const ed = this.editor;
    const model = ed.getModel();
    const sel = ed.getSelection();
    return sel && !sel.isEmpty() ? model.getValueInRange(sel, this.monaco.editor.EndOfLinePreference.LF) : model.getValue(this.monaco.editor.EndOfLinePreference.LF);
  }

  insertText(text) {
    const ed = this.editor;
    ed.executeEdits('konx', ed.getSelections().map((s) => ({ range: s, text, forceMoveMarkers: true })));
    this.focus();
  }

  toggleOpt(name) {
    this.opts[name] = !this.opts[name];
    this.applyEditorOpts();
    this.persistOpts();
  }

  applyEditorOpts() {
    this.syncToggles();
    if (!this.editor) return;
    this.editor.updateOptions({
      wordWrap: this.opts.wordWrap ? 'on' : 'off',
      minimap: { enabled: this.opts.minimap },
      renderWhitespace: this.opts.whitespace ? 'all' : 'selection',
      fontSize: this.opts.fontSize || this.app.settings.fontSize,
      fontFamily: this.app.settings.fontFamily,
    });
  }

  syncToggles() {
    this.wrapBtn && this.wrapBtn.classList.toggle('on', !!this.opts.wordWrap);
    this.wsBtn && this.wsBtn.classList.toggle('on', !!this.opts.whitespace);
    this.mapBtn && this.mapBtn.classList.toggle('on', !!this.opts.minimap);
  }

  zoom(delta) {
    const base = this.app.settings.fontSize;
    const cur = this.opts.fontSize || base;
    this.opts.fontSize = delta === 0 ? null : Math.max(7, Math.min(40, cur + delta));
    this.applyEditorOpts();
    this.persistOpts();
    this.updateStatus();
  }

  persistOpts() {
    this.app.settings.notepad = { ...this.opts };
    api.invoke('settings:set', { notepad: this.opts });
  }

  applySettings() {
    if (!this.monaco) return;
    this.monaco.editor.setTheme(this.theme());
    this.applyEditorOpts();
  }

  remember(path) {
    if (!path) return;
    try {
      const list = JSON.parse(localStorage.getItem('konx.np.recent') || '[]').filter((p) => p.toLowerCase() !== path.toLowerCase());
      list.unshift(path);
      localStorage.setItem('konx.np.recent', JSON.stringify(list.slice(0, 15)));
    } catch {}
  }

  recent() {
    try {
      return JSON.parse(localStorage.getItem('konx.np.recent') || '[]');
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------ compare

  async compareDialog() {
    if (!this.current) return;
    const others = this.docs.filter((d) => d !== this.current);
    const fields = others.length ? buildFields([{ name: 'doc', label: 'Compare with', type: 'select', options: others.map((d) => [d.id, d.title]) }]) : null;
    const r = await modal({
      title: `Compare "${this.current.title}"`,
      icon: 'columns',
      body: fields ? fields.els : h('div.hint', 'No other documents are open. Pick a file on disk.'),
      buttons: [{ label: 'Cancel', value: null }, { label: 'File on disk…', value: 'file', primary: !others.length }, ...(others.length ? [{ label: 'Compare', value: 'doc', primary: true }] : [])],
    });
    if (r === 'doc') return this.compare(others.find((d) => d.id === fields.read().doc));
    if (r === 'file') {
      const p = await api.invoke('np:pickFile');
      if (!p) return;
      const f = await api.invoke('np:read', p);
      const other = this.createDoc({ text: T.decodeBytes(f.bytes).text, path: p, mtime: f.mtime });
      this.renderTabs();
      return this.compare(other);
    }
  }
  compare(other, base = this.current) {
    if (!other || !base || other === base) return;
    const m = this.monaco;
    if (!this.diffEditor) {
      this.diffEditor = m.editor.createDiffEditor(this.diffHost, {
        automaticLayout: true,
        theme: this.theme(),
        fontFamily: this.app.settings.fontFamily,
        fontSize: this.opts.fontSize || this.app.settings.fontSize,
        renderSideBySide: true,
        originalEditable: false,
        ignoreTrimWhitespace: false,
        renderIndicators: true,
        minimap: { enabled: false },
      });
      mountThemeOutput(this.diffHost);
      this.diffEditor.onDidUpdateDiff(() => this.renderDiffBar());
    }
    this.diffPair = { other, base };
    this.diffEditor.setModel({ original: other.model, modified: base.model });
    this.host.classList.add('hidden');
    this.diffHost.classList.remove('hidden');
    this.diffBar.classList.remove('hidden');
    this.renderDiffBar();
  }

  renderDiffBar() {
    if (!this.diffPair) return;
    const changes = this.diffEditor.getLineChanges() || [];
    const go = (dir) => (this.diffEditor.goToDiff ? this.diffEditor.goToDiff(dir) : null);
    this.diffBar.replaceChildren(
      icon('columns'),
      h('span', h('b', this.diffPair.other.title), ' ↔ ', h('b', this.diffPair.base.title)),
      h('span.pill', { class: changes.length ? 'warn' : 'ok' }, changes.length ? `${changes.length} difference${changes.length === 1 ? '' : 's'}` : 'Identical'),
      h('span', { style: { flex: 1 } }),
      h('button.btn.sm', { onclick: () => go('previous') }, icon('up'), 'Previous'),
      h('button.btn.sm', { onclick: () => go('next') }, icon('chev-down'), 'Next'),
      h('button.btn.sm', { onclick: () => ((this.diffInline = !this.diffInline), this.diffEditor.updateOptions({ renderSideBySide: !this.diffInline })) }, this.diffInline ? 'Side by side' : 'Inline view'),
      h('button.btn.sm.primary', { onclick: () => this.closeCompare() }, icon('x'), 'Close compare')
    );
  }

  closeCompare() {
    if (!this.diffPair) return;
    this.diffEditor.setModel(null);
    this.diffPair = null;
    this.diffHost.classList.add('hidden');
    this.diffBar.classList.add('hidden');
    this.host.classList.remove('hidden');
    this.focus();
  }

  // ------------------------------------------------------------ tabs + status

  changed() {
    this.copilot.touch();
    this.renderTabs();
    this.updateStatus();
    this.saveSessionSoon && this.saveSessionSoon();
    api.invoke('np:watch', this.docs.filter((d) => d.path).map((d) => ({ path: d.path, mtime: d.mtime })));
  }

  copilotContextChoices() { return workspaceContextChoices(this); }

  captureCopilotContext(options) { return captureNotepadContext(this, options); }

  onContentChange() {
    this.copilot.touch();
    const d = this.current;
    if (!d) return;
    const dirty = this.isDirty(d);
    if (dirty !== d.wasDirty) {
      d.wasDirty = dirty;
      this.renderTabs();
      this.saveSessionSoon();
    }
    this.updateStatus();
    this.backupSoon();
  }

  renderTabs() {
    this.tabsEl.replaceChildren(
      ...this.docs.map((d) => {
        const dirty = this.isDirty(d);
        const el = h(
          'div.np-tab',
          { class: [d === this.current && 'active', dirty && 'dirty'].filter(Boolean).join(' '), title: d.remote ? `${d.remote.host}:${d.remote.path}` : d.path || d.title },
          h('span.np-tabicon', icon(d.remote ? 'server' : d.readOnly ? 'lock' : 'file')),
          h('span.title', d.title),
          h('button.close', { title: 'Close (Ctrl+W)', onclick: (e) => (e.stopPropagation(), this.closeDoc(d)) }, dirty ? h('span.np-dot') : icon('x'))
        );
        el.addEventListener('mousedown', (e) => {
          if (e.button === 0) this.activate(d);
          if (e.button === 1) {
            e.preventDefault();
            this.closeDoc(d);
          }
        });
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Save', icon: 'save', action: () => this.save(d) },
            { label: 'Save As…', action: () => this.saveAs(d) },
            d.path && { label: 'Reload from disk', icon: 'refresh', action: () => this.reload(d) },
            '-',
            { label: 'Close', icon: 'x', action: () => this.closeDoc(d) },
            { label: 'Close all but this', action: () => this.closeOthers(d) },
            { label: 'Close all', action: () => this.closeAll() },
            '-',
            d.path && { label: 'Copy full path', icon: 'copy', action: () => api.invoke('clipboard:write', d.path) },
            d.path && { label: 'Open containing folder', icon: 'folder-open', action: () => api.invoke('app:showItem', d.path) },
            d !== this.current && { label: `Compare with "${this.current.title}"`, icon: 'columns', action: () => this.compare(d) },
          ]);
        });
        return el;
      })
    );
    const active = this.tabsEl.querySelector('.np-tab.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  updateStatus() {
    if (this.disposed) return;
    const d = this.current;
    if (!d || !this.editor) return;
    const pos = this.editor.getPosition() || { lineNumber: 1, column: 1 };
    const model = d.model;
    const sel = this.editor.getSelections() || [];
    const selChars = sel.reduce((n, s) => n + model.getValueLengthInRange(s), 0);
    const selLines = sel.reduce((n, s) => n + (s.isEmpty() ? 0 : s.endLineNumber - s.startLineNumber + 1), 0);
    const lang = this.monaco.languages.getLanguages().find((l) => l.id === model.getLanguageId());
    const seg = (text, onclick, title) => h('span.np-seg', { class: onclick ? 'click' : '', onclick, title: title || '' }, text);
    this.statusEl.replaceChildren(
      seg(`Ln ${pos.lineNumber}, Col ${pos.column}`, () => this.action('editor.action.gotoLine'), 'Go to line (Ctrl+G)'),
      seg(sel.length > 1 ? `${sel.length} selections · ${selChars} chars` : `Sel ${selChars}${selLines ? ` | ${selLines}` : ''}`),
      seg(`length ${model.getValueLength().toLocaleString()}   lines ${model.getLineCount().toLocaleString()}`),
      this.statusMsg ? h('span.np-seg.msg', this.statusMsg) : null,
      h('span', { style: { flex: 1 } }),
      this.sending ? h('span.np-seg.warn', `Sending to ${this.sending.target}: ${this.sending.done}/${this.sending.total}`, h('button.btn.sm', { style: { marginLeft: '6px', height: '18px' }, onclick: () => (this.sending.cancel = true) }, 'Stop')) : null,
      d.remote ? seg(`SFTP ${d.remote.host}`, null, d.remote.path) : null,
      seg(EOL_LABEL[d.eol], (e) => this.openMenu(e, () => this.eolItems()), 'Line endings'),
      seg(T.ENCODINGS.find(([k]) => k === d.encoding)[1], (e) => this.openMenu(e, () => this.encodingMenu()), 'Encoding'),
      seg(lang ? (lang.aliases && lang.aliases[0]) || lang.id : model.getLanguageId(), (e) => this.openMenu(e, () => this.languageMenu()), 'Language'),
      seg(`${Math.round(((this.opts.fontSize || this.app.settings.fontSize) / this.app.settings.fontSize) * 100)}%`, () => this.zoom(0), 'Zoom (Ctrl+= / Ctrl+- / Ctrl+0)')
    );
  }

  flashStatus(msg) {
    this.statusMsg = msg;
    this.updateStatus();
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.statusMsg = '';
      this.updateStatus();
    }, 4000);
  }

  // ------------------------------------------------------------ session + backups

  backupDirty() {
    if (this.disposed) return;
    for (const d of this.docs) {
      const dirty = this.isDirty(d);
      if (dirty || (d.untitled && d.model.getValueLength())) {
        if (d.backedUpVersion !== d.model.getAlternativeVersionId()) {
          api.send('np:backup', d.id, d.model.getValue());
          d.backedUpVersion = d.model.getAlternativeVersionId();
        }
      } else if (d.backedUpVersion != null) {
        api.send('np:backup', d.id, null);
        d.backedUpVersion = null;
      }
    }
  }

  sessionData() {
    return {
      active: this.current && this.current.id,
      docs: this.docs
        .filter((d) => !(d.untitled && !d.model.getValueLength() && this.docs.length > 1))
        .map((d) => {
          const vs = d === this.current && this.editor ? this.editor.saveViewState() : d.viewState;
          const pos = vs && vs.cursorState && vs.cursorState[0] ? vs.cursorState[0].position : null;
          return {
            id: d.id,
            title: d.title,
            path: d.path,
            remote: d.remote ? { host: d.remote.host, path: d.remote.path } : null,
            untitled: d.untitled,
            dirty: this.isDirty(d),
            language: d.model.getLanguageId(),
            encoding: d.encoding,
            eol: d.eol,
            line: pos ? pos.lineNumber : 1,
            col: pos ? pos.column : 1,
          };
        }),
    };
  }

  saveSession() {
    if (this.disposed || this.restoring || !this.monaco) return;
    this.backupDirty();
    api.invoke('np:session:set', this.sessionData()).catch(() => {});
  }

  flush() {
    if (this.disposed || this.restoring || !this.monaco) return;
    this.backupDirty();
    api.invoke('np:session:set', this.sessionData()).catch(() => {});
  }

  async restore() {
    const s = await api.invoke('np:session:get').catch(() => ({ docs: [] }));
    if (this.disposed) return;
    for (const e of s.docs || []) {
      let text = null;
      let meta = {};
      if (e.dirty || e.untitled || e.remote) text = await api.invoke('np:backup:read', e.id);
      if (this.disposed) return;
      if (e.path) {
        try {
          const f = await api.invoke('np:read', e.path);
          if (this.disposed) return;
          meta = { mtime: f.mtime };
          if (text == null) {
            const dec = T.decodeBytes(f.bytes);
            text = dec.text;
            meta.encoding = dec.encoding;
          }
        } catch {
          if (text == null) continue; // file gone and nothing unsaved
        }
      }
      if (this.disposed) return;
      if (text == null && !e.untitled) continue;
      if (e.remote && text == null) continue;
      const d = this.createDoc({
        id: e.id,
        text: text || '',
        title: e.remote ? `${e.title} (unsaved copy)` : e.title,
        path: e.path,
        language: e.language,
        encoding: meta.encoding || e.encoding,
        eol: e.eol,
        mtime: meta.mtime,
        dirty: !!e.dirty || (!!e.remote && text != null),
      });
      d.untitled = !e.path;
      d.viewState = null;
      d.restorePos = { line: e.line || 1, col: e.col || 1 };
    }
    if (!this.docs.length) this.newDoc();
    else {
      const active = this.docs.find((d) => d.id === s.active) || this.docs[0];
      this.activate(active);
      if (active.restorePos) {
        this.editor.setPosition({ lineNumber: active.restorePos.line, column: active.restorePos.col });
        this.editor.revealPositionInCenter({ lineNumber: active.restorePos.line, column: active.restorePos.col });
      }
      this.changed();
    }
  }

  // ------------------------------------------------------------ menus

  fileMenu() {
    const recent = this.recent();
    return [
      { label: 'New', icon: 'file-plus', shortcut: 'Ctrl+N', action: () => this.newDoc() },
      { label: 'Open…', icon: 'folder-open', shortcut: 'Ctrl+O', action: () => this.open() },
      recent.length && { label: 'Open recent…', icon: 'refresh', action: () => this.recentDialog(recent) },
      { label: 'Reload from disk', icon: 'refresh', disabled: !this.current || !this.current.path, action: () => this.reload() },
      '-',
      { label: 'Save', icon: 'save', shortcut: 'Ctrl+S', action: () => this.save() },
      { label: 'Save As…', shortcut: 'Ctrl+Alt+S', action: () => this.saveAs() },
      { label: 'Save All', shortcut: 'Ctrl+Shift+S', action: () => this.saveAll() },
      '-',
      { label: 'Close', icon: 'x', shortcut: 'Ctrl+W', action: () => this.closeDoc(this.current) },
      { label: 'Close all but current', action: () => this.closeOthers(this.current) },
      { label: 'Close all', action: () => this.closeAll() },
      { label: 'Reopen closed file', shortcut: 'Ctrl+Shift+T', disabled: !this.closed.length, action: () => this.reopenClosed() },
      '-',
      this.current && this.current.path && { label: 'Open containing folder', icon: 'folder-open', action: () => api.invoke('app:showItem', this.current.path) },
      this.current && this.current.path && { label: 'Copy full path', icon: 'copy', action: () => api.invoke('clipboard:write', this.current.path) },
    ];
  }

  async recentDialog(list) {
    const { els, read } = buildFields([{ name: 'p', label: 'Recent files', type: 'select', options: list.map((p) => [p, p]) }]);
    const r = await modal({ title: 'Open recent', icon: 'refresh', width: 640, body: els, buttons: [{ label: 'Cancel', value: null }, { label: 'Open', value: true, primary: true }] });
    if (r) this.openFile(read().p);
  }
  editMenu() {
    return [
      { label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z', action: () => this.run('undo') },
      { label: 'Redo', icon: 'redo', shortcut: 'Ctrl+Y', action: () => this.run('redo') },
      '-',
      { label: 'Select all', shortcut: 'Ctrl+A', action: () => this.action('editor.action.selectAll') },
      { label: 'Column / multi-cursor: Shift+Alt+drag, Alt+click', disabled: true },
      '-',
      { label: 'Duplicate line', shortcut: 'Ctrl+D', action: () => this.action('editor.action.copyLinesDownAction') },
      { label: 'Delete line', shortcut: 'Ctrl+L', action: () => this.action('editor.action.deleteLines') },
      { label: 'Move line up', shortcut: 'Ctrl+Shift+Up', action: () => this.action('editor.action.moveLinesUpAction') },
      { label: 'Move line down', shortcut: 'Ctrl+Shift+Down', action: () => this.action('editor.action.moveLinesDownAction') },
      { label: 'Join lines', shortcut: 'Ctrl+J', action: () => this.transform(T.joinLines) },
      { label: 'Toggle comment', shortcut: 'Ctrl+Q', action: () => this.action('editor.action.commentLine') },
      '-',
      { label: 'Sort lines A → Z', action: () => this.transform((t) => T.sortLines(t)) },
      { label: 'Sort lines Z → A', action: () => this.transform((t) => T.sortLines(t, { desc: true })) },
      { label: 'Sort lines by IP address', action: () => this.transform((t) => T.sortIpLines(t)) },
      { label: 'Remove duplicate lines', action: () => this.transform((t) => T.uniqueLines(t)) },
      { label: 'Remove empty lines', action: () => this.transform((t) => T.removeEmptyLines(t)) },
      { label: 'Reverse line order', action: () => this.transform(T.reverseLines) },
      '-',
      { label: 'Trim trailing spaces', action: () => this.transform(T.trimTrailing) },
      { label: 'Trim leading spaces', action: () => this.transform(T.trimLeading) },
      { label: 'Tabs → spaces', action: () => this.transform((t) => T.tabsToSpaces(t, 4)) },
      { label: 'Leading spaces → tabs', action: () => this.transform((t) => T.spacesToTabs(t, 4)) },
      '-',
      { label: 'UPPERCASE', shortcut: 'Ctrl+Shift+U', action: () => this.transform(T.toUpper, { lines: false }) },
      { label: 'lowercase', shortcut: 'Ctrl+U', action: () => this.transform(T.toLower, { lines: false }) },
      { label: 'Title Case', action: () => this.transform(T.toTitle, { lines: false }) },
      { label: 'Sentence case', action: () => this.transform(T.toSentence, { lines: false }) },
      { label: 'iNVERT cASE', action: () => this.transform(T.invertCase, { lines: false }) },
      '-',
      { label: 'Insert date/time', action: () => this.insertText(new Date().toLocaleString()) },
      this.current && this.current.readOnly
        ? { label: 'Make editable', icon: 'lock', action: () => ((this.current.readOnly = false), this.editor.updateOptions({ readOnly: false }), this.renderTabs()) }
        : { label: 'Make read-only', icon: 'lock', action: () => ((this.current.readOnly = true), this.editor.updateOptions({ readOnly: true }), this.renderTabs()) },
    ];
  }

  searchMenu() {
    return [
      { label: 'Find…', icon: 'search', shortcut: 'Ctrl+F', action: () => this.action('actions.find') },
      { label: 'Replace…', icon: 'replace', shortcut: 'Ctrl+H', action: () => this.action('editor.action.startFindReplaceAction') },
      { label: 'Find next', shortcut: 'F3', action: () => this.action('editor.action.nextMatchFindAction') },
      { label: 'Find previous', shortcut: 'Shift+F3', action: () => this.action('editor.action.previousMatchFindAction') },
      { label: 'Select all occurrences', shortcut: 'Ctrl+Shift+L', action: () => this.action('editor.action.selectHighlights') },
      '-',
      { label: 'Find in Files…', icon: 'folder-open', shortcut: 'Ctrl+Shift+F', action: () => findInFilesDialog(this) },
      '-',
      { label: 'Go to line…', shortcut: 'Ctrl+G', action: () => this.action('editor.action.gotoLine') },
      { label: 'Go to matching bracket', shortcut: 'Ctrl+Shift+\\', action: () => this.action('editor.action.jumpToBracket') },
      { label: 'Command palette…', shortcut: 'F1', action: () => this.action('editor.action.quickCommand') },
    ];
  }

  viewMenu() {
    const check = (on) => (on ? 'check' : null);
    return [
      { label: 'Word wrap', icon: check(this.opts.wordWrap), action: () => this.toggleOpt('wordWrap') },
      { label: 'Show whitespace and tabs', icon: check(this.opts.whitespace), action: () => this.toggleOpt('whitespace') },
      { label: 'Document map', icon: check(this.opts.minimap), action: () => this.toggleOpt('minimap') },
      '-',
      { label: 'Fold all', action: () => this.action('editor.foldAll') },
      { label: 'Unfold all', action: () => this.action('editor.unfoldAll') },
      { label: 'Fold current level', action: () => this.action('editor.fold') },
      '-',
      { label: 'Zoom in', shortcut: 'Ctrl+=', action: () => this.zoom(1) },
      { label: 'Zoom out', shortcut: 'Ctrl+-', action: () => this.zoom(-1) },
      { label: 'Restore zoom', shortcut: 'Ctrl+0', action: () => this.zoom(0) },
      '-',
      { label: 'Compare with…', icon: 'columns', action: () => this.compareDialog() },
      this.diffPair && { label: 'Close compare', action: () => this.closeCompare() },
    ];
  }

  encodingMenu() {
    const d = this.current;
    if (!d) return [];
    return [
      ...T.ENCODINGS.map(([k, label]) => ({ label: `Encode in ${label}`, icon: d.encoding === k ? 'check' : null, action: () => this.setEncoding(k) })),
      '-',
      ...T.ENCODINGS.filter(([k]) => k !== 'utf-8-bom').map(([k, label]) => ({ label: `Reopen as ${label}`, disabled: !d.path, action: () => this.reopenWithEncoding(k) })),
      '-',
      ...this.eolItems(),
    ];
  }

  eolItems() {
    const d = this.current;
    return Object.entries(EOL_LABEL).map(([k, label]) => ({ label: `Line endings: ${label}`, icon: d && d.eol === k ? 'check' : null, action: () => this.setEol(k) }));
  }

  languageMenu() {
    const cur = this.current && this.current.model.getLanguageId();
    const all = this.monaco.languages.getLanguages();
    const name = (l) => (l.aliases && l.aliases[0]) || l.id;
    const top = ['plaintext', 'ios', 'log', 'json', 'yaml', 'xml', 'ini', 'shell', 'powershell', 'python'];
    const items = top.map((id) => all.find((l) => l.id === id)).filter(Boolean).map((l) => ({ label: name(l), icon: l.id === cur ? 'check' : null, action: () => this.setLanguage(l.id) }));
    return [
      ...items,
      '-',
      { label: 'Detect from content', icon: 'search', action: () => this.setLanguage(T.detectLanguage(this.current.path || this.current.title, this.current.model.getValue())) },
      { label: 'All languages…', action: () => this.languagePicker(all, cur) },
    ];
  }

  async languagePicker(all, cur) {
    const sorted = [...all].sort((a, b) => ((a.aliases && a.aliases[0]) || a.id).localeCompare((b.aliases && b.aliases[0]) || b.id));
    const { els, read } = buildFields([{ name: 'lang', label: 'Language', type: 'select', options: sorted.map((l) => [l.id, (l.aliases && l.aliases[0]) || l.id]) }], { lang: cur });
    const r = await modal({ title: 'Language', icon: 'edit', body: els, buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', value: true, primary: true }] });
    if (r) this.setLanguage(read().lang);
  }

  // ------------------------------------------------------------ tab interface

  show({ focus = true } = {}) {
    if (this.disposed) return;
    this.active = true;
    const generation = ++this.visibilityGeneration;
    if (focus && this.editor) setTimeout(() => {
      if (generation === this.visibilityGeneration) this.focus();
    }, 0);
  }

  hide() {
    this.active = false;
    this.visibilityGeneration++;
    this.flush();
  }

  onHostWindowChanged(hostWindow) {
    if (this.disposed || !hostWindow || this.el.ownerDocument.defaultView !== hostWindow) return;
    if (this.hostWindow !== hostWindow) {
      ++this.visibilityGeneration;
      if (this.beforeUnload) {
        // Keep the primary window's final flush, and track the current pop-out
        // separately so an unexpected child close also saves unsaved backups.
        if (this.hostWindow && this.hostWindow !== window) this.hostWindow.removeEventListener('beforeunload', this.beforeUnload);
        if (hostWindow !== window) hostWindow.addEventListener('beforeunload', this.beforeUnload);
      }
      this.hostWindow = hostWindow;
    }
    this.refit();
  }

  refit() {
    if (this.disposed || !this.active) return;
    if (this.host?.offsetParent) this.editor?.layout();
    if (this.diffHost?.offsetParent) this.diffEditor?.layout();
  }

  focus() {
    if (this.disposed || !this.active || this.app.active !== this) return;
    if (this.editor) this.editor.focus();
  }

  statusSegments() {
    const d = this.current;
    if (!d) return [{ icon: 'edit', text: 'Notepad' }];
    const dirty = this.docs.filter((x) => this.isDirty(x)).length;
    return [{ icon: 'edit', text: 'Notepad' }, { text: d.remote ? `${d.remote.host}:${d.remote.path}` : d.path || d.title }, dirty ? { text: `${dirty} unsaved`, cls: 'warn' } : { text: 'All saved', cls: 'ok' }];
  }

  dispose() {
    if (this.disposed) return;
    // Closing the Notepad keeps the session (and unsaved work) for next time, like Notepad++.
    this.flush();
    this.disposed = true;
    this.copilot.finish('stopped');
    this.active = false;
    this.visibilityGeneration++;
    clearTimeout(this.statusTimer);
    if (this.beforeUnload) removeEventListener('beforeunload', this.beforeUnload);
    if (this.beforeUnload && this.hostWindow && this.hostWindow !== window) this.hostWindow.removeEventListener('beforeunload', this.beforeUnload);
    (this.unwatch || []).forEach((u) => u());
    if (this.diffEditor) this.diffEditor.dispose();
    if (this.editor) this.editor.dispose();
    for (const d of this.docs) d.model.dispose();
    api.invoke('np:watch', []);
  }
}

