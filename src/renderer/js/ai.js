import { h, icon, api, toast, errMsg, confirmDialog } from './ui.js';

const string = (value) => typeof value === 'string' ? value : '';
const field = (label, control) => h('label.field', h('span', label), control);

export class AITab {
  constructor(app, { question = '', context = '', label = '' } = {}) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'ai'; this.icon = 'insight'; this.title = 'AI & Knowledge';
    this.id = 'ai-' + Math.random().toString(36).slice(2); this.state = 'idle'; this.jobId = null; this.seq = 0; this.disposed = false;
    this.config = null; this.configBusy = true; this.libraryBusy = false; this.librarySeq = 0; this.articleSeq = 0; this.previewSeq = 0;
    this.report = null; this.currentDocument = null; this.previewValue = null;
    this.provider = h('select.input', { 'aria-label': 'AI provider', onchange: () => this.providerChanged() });
    this.model = h('input.input', { maxlength: 160, spellcheck: false, 'aria-label': 'AI model', oninput: () => this.updateControls() });
    this.baseUrl = h('input.input', { maxlength: 2048, type: 'url', placeholder: 'https://your-api.example/v1', spellcheck: false, 'aria-label': 'Custom AI API base URL', oninput: () => this.updateControls() });
    this.key = h('input.input', { type: 'password', maxlength: 1024, autocomplete: 'off', spellcheck: false, 'data-lpignore': 'true', placeholder: 'Paste API key', 'aria-label': 'AI API key' });
    this.saveButton = h('button.btn', { onclick: () => this.configure(false) }, icon('save'), 'Save connection');
    this.forgetButton = h('button.btn', { onclick: () => this.configure(true) }, icon('trash'), 'Forget key');
    this.keyStatus = h('div.ai-key-status', { role: 'status' }, 'Reading local AI settings…');
    this.providerHelp = h('p.hint');
    this.baseUrlField = field('Custom API base URL', this.baseUrl);
    this.connection = h('details.ai-connection', { open: true }, h('summary', 'AI connection'),
      h('div.ai-form', field('Provider', this.provider), field('Model', this.model), this.baseUrlField),
      h('div.ai-form', field('API key', this.key), this.saveButton, this.forgetButton), this.keyStatus, this.providerHelp,
      h('p.hint', 'Keys are encrypted for this Windows user. Saved keys are never returned to this tab. Saving settings does not contact the provider.'));
    this.question = h('textarea.input.ai-question', { maxlength: 8000, rows: 3, placeholder: 'Ask about a KonX tool, a vendor, or a finding…', 'aria-label': 'Question for AI', oninput: () => this.updateControls() });
    this.question.value = string(question).slice(0, 8000);
    this.context = h('textarea.input.ai-context', { maxlength: 24000, rows: 5, spellcheck: false, placeholder: 'Paste optional tool output or notes. Preview before sharing.', 'aria-label': 'Optional AI context', oninput: () => this.contextChanged() });
    this.context.value = string(context).slice(0, 24000);
    this.contextLabel = h('p.hint', label ? `${string(label)} · prepared locally for your review.` : 'Context stays local until you preview it, select Send this context, and ask.');
    this.previewButton = h('button.btn.sm', { onclick: () => this.previewContext() }, icon('eye'), 'Preview context');
    this.shareContext = h('input', { type: 'checkbox', disabled: true, 'aria-label': 'Send this context', onchange: () => this.updateControls() });
    this.preview = h('pre.ai-context-preview', { tabindex: 0 }, 'No context selected for sharing.');
    this.contextDetails = h('details.ai-context-details', { open: Boolean(this.context.value) }, h('summary', 'Optional context'), this.contextLabel,
      field('Tool output or notes', this.context), h('div.ai-actions', this.previewButton, h('label.ai-check', this.shareContext, 'Send this context')),
      h('p.hint', 'Preview removes recognized secrets. Review it for other private information before sending.'), this.preview);
    this.askButton = h('button.btn.primary', { onclick: () => this.start() }, icon('send'), 'Ask AI');
    this.cancelButton = h('button.btn.hidden', { onclick: () => this.stop() }, icon('stop'), 'Cancel');
    this.status = h('div.ai-status', { role: 'status', 'aria-live': 'polite' }, 'Ask a question when ready. The local library works without an API key.');
    this.answerMeta = h('p.hint');
    this.answer = h('div.ai-answer', { tabindex: 0 }, 'Answers will appear here. AI can be mistaken; check the evidence and vendor documentation before changing a system.');
    this.sourceList = h('div.ai-sources');
    this.answerLimitations = h('div.ai-limitations');
    this.librarySearch = h('input.input', { type: 'search', maxlength: 2000, placeholder: 'Search tools, vendors, and explanations', 'aria-label': 'Search local knowledge library', oninput: () => {
      clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.loadLibrary(), 180);
    } });
    this.libraryStatus = h('div.ai-library-status', { role: 'status', 'aria-live': 'polite' }, 'Reading the local knowledge index…');
    this.libraryList = h('div.ai-library-list', { 'aria-label': 'Knowledge articles' });
    this.documentTitle = h('h4', 'Read an article');
    this.documentMeta = h('p.hint');
    this.documentContent = h('div.ai-document-content', { tabindex: 0 }, 'Choose an article to understand tool results, terminology, and vendor behavior.');
    this.documentAskButton = h('button.btn.sm', { disabled: true, onclick: () => this.askAboutDocument() }, icon('insight'), 'Ask about this');
    this.documentSourceButton = h('button.btn.sm.hidden', { onclick: () => this.openDocumentSource() }, icon('globe'), 'Open source');
    this.documentEditButton = h('button.btn.sm.hidden', { onclick: () => this.editDocument(this.currentDocument) }, icon('edit'), 'Edit note');
    this.documentRemoveButton = h('button.btn.sm.hidden', { onclick: () => this.removeDocument() }, icon('trash'), 'Remove note');
    this.newDocumentButton = h('button.btn.sm', { onclick: () => this.editDocument(null) }, icon('plus'), 'Add note');
    this.rebuildButton = h('button.btn.sm', { onclick: () => this.rebuildLibrary() }, icon('refresh'), 'Rebuild index');
    this.noteTitle = h('input.input', { maxlength: 160, 'aria-label': 'Knowledge note title' });
    this.noteVendor = h('input.input', { maxlength: 80, placeholder: 'Optional vendor or topic', 'aria-label': 'Knowledge note vendor' });
    this.noteSource = h('input.input', { type: 'url', maxlength: 2048, placeholder: 'https://… (optional)', 'aria-label': 'Knowledge note source URL' });
    this.noteContent = h('textarea.input', { maxlength: 32000, rows: 8, spellcheck: false, placeholder: 'Paste reference text or write a note. Do not include API keys or passwords.', 'aria-label': 'Knowledge note content' });
    this.noteSaveButton = h('button.btn.primary.sm', { onclick: () => this.saveDocument() }, icon('save'), 'Save local note');
    this.noteCancelButton = h('button.btn.sm', { onclick: () => this.closeEditor() }, 'Cancel editing');
    this.noteEditor = h('div.ai-note-editor.hidden', field('Title', this.noteTitle), field('Vendor or topic', this.noteVendor), field('Source URL', this.noteSource), field('Reference text', this.noteContent),
      h('p.hint', 'Notes join the local search index and may be used as references when you ask AI. Pasted text is stored locally; links are opened only when you choose Open source.'),
      h('div.ai-actions', this.noteSaveButton, this.noteCancelButton));
    this.article = h('article.ai-document', this.documentTitle, this.documentMeta,
      h('div.ai-actions', this.documentAskButton, this.documentSourceButton, this.documentEditButton, this.documentRemoveButton), this.documentContent);
    this.el = h('div.view.ai-view', h('div.tool-head', h('div.tool-title', icon('insight'), h('h2', 'AI & Knowledge'), h('span.sub', 'Explain findings with local references'))),
      h('div.ai-workspace', h('section.ai-assistant', { 'aria-label': 'AI assistant' }, this.connection,
        field('Your question', this.question), this.contextDetails,
        h('div.ai-actions', this.askButton, this.cancelButton), h('p.hint', 'Ask AI sends your question and relevant library excerpts to your selected provider. Optional tool context is sent only when selected. AI suggests actions; it does not run tools or change settings.'),
        this.status, h('h3', 'Answer'), this.answerMeta, this.answer, this.sourceList, this.answerLimitations),
      h('section.ai-library', { 'aria-label': 'Offline knowledge library' }, h('div.ai-section-title', h('h3', 'Knowledge library'), h('span.ai-local-badge', 'Local')),
        h('p.hint', 'Search and read offline. The background index uses TF-IDF vectors, not neural embeddings.'),
        this.librarySearch, h('div.ai-actions', this.newDocumentButton, this.rebuildButton), this.libraryStatus, this.libraryList, this.noteEditor, this.article)));
    this.updateControls(); this.loadConfig(); this.loadLibrary();
  }

  savedKey(provider = this.provider.value) {
    return Boolean(this.config?.keyPresence?.[provider] ?? (this.config?.provider === provider && this.config?.hasKey));
  }

  dirty() {
    return !this.config || this.provider.value !== this.config.provider || this.model.value.trim() !== this.config.model ||
      (this.provider.value === 'custom' && this.baseUrl.value.trim() !== string(this.config.baseUrl));
  }

  async loadConfig() {
    if (this.disposed || this.jobId || this.configBusy && this.config) return;
    this.configBusy = true; this.updateControls();
    try {
      const config = await api.invoke('tools:aiConfig');
      if (this.disposed) return;
      if (!this.config || config.revision !== this.config.revision) { this.key.value = ''; this.applyConfig(config); }
      else this.config = config;
    } catch (error) { if (!this.disposed) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed) { this.configBusy = false; this.updateControls(); } }
  }

  applyConfig(config) {
    if (!config || typeof config.hasKey !== 'boolean' || !Array.isArray(config.providers) || !config.providers.some((provider) => provider.id === config.provider)) throw new Error('Invalid AI connection settings.');
    const changed = this.config && config.revision !== this.config.revision;
    this.config = config;
    this.provider.replaceChildren(...config.providers.map((provider) => h('option', { value: provider.id }, provider.label)));
    this.provider.value = config.provider; this.model.value = string(config.model); this.baseUrl.value = string(config.baseUrl);
    if (changed) this.contextChanged();
  }

  providerChanged() {
    this.key.value = '';
    const provider = this.config?.providers.find((item) => item.id === this.provider.value);
    this.model.value = this.provider.value === this.config?.provider ? string(this.config.model) : string(provider?.model ?? provider?.defaultModel);
    this.baseUrl.value = this.provider.value === this.config?.provider ? string(this.config.baseUrl) : string(provider?.baseUrl ?? provider?.defaultBaseUrl);
    this.updateControls();
  }

  updateControls() {
    const busy = this.configBusy || Boolean(this.jobId), ready = Boolean(this.config);
    for (const control of [this.provider, this.model, this.baseUrl, this.key, this.saveButton, this.forgetButton]) control.disabled = busy || !ready;
    this.forgetButton.disabled = busy || !ready || !(this.savedKey() || this.config?.warning);
    this.askButton.disabled = busy || !ready || this.dirty() || !this.savedKey() || !this.question.value.trim();
    this.question.disabled = Boolean(this.jobId); this.context.disabled = Boolean(this.jobId);
    this.previewButton.disabled = busy || !this.context.value.trim() || this.previewBusy;
    this.shareContext.disabled = busy || this.previewBusy || this.previewValue === null || this.previewValue !== this.context.value;
    this.cancelButton.classList.toggle('hidden', !this.jobId); this.cancelButton.disabled = Boolean(this.cancelRequested);
    this.baseUrlField.classList.toggle('hidden', this.provider.value !== 'custom');
    if (ready) {
      const label = this.config.providers.find((provider) => provider.id === this.provider.value)?.label || this.provider.value;
      this.keyStatus.textContent = this.savedKey() ? `An encrypted key is saved for ${label}.` : `No API key saved for ${label}.`;
      if (this.dirty()) this.keyStatus.textContent += ' Save this connection before asking.';
      if (this.config.warning) this.keyStatus.textContent += ' ' + this.config.warning;
      this.providerHelp.textContent = this.provider.value === 'nyquest' ? 'Nyquest: create a personal access token in app.nyquest.ai → Settings → API Keys. Requests use the Nyquest developer API.' : this.provider.value === 'custom' ? 'Custom uses an OpenAI-compatible Chat Completions endpoint. Enter its base URL and model ID; HTTPS is required except for loopback servers.' : '';
    }
    for (const control of [this.noteTitle, this.noteVendor, this.noteSource, this.noteContent, this.noteSaveButton, this.noteCancelButton, this.newDocumentButton, this.rebuildButton, this.documentRemoveButton, this.documentEditButton]) control.disabled = this.libraryBusy;
  }

  async configure(forget) {
    const key = this.key.value; this.key.value = '';
    if (this.disposed || this.configBusy || this.jobId || !this.config) return;
    if (!forget && !this.savedKey() && !key.trim()) return toast('Enter an API key for this provider.', 'err');
    this.configBusy = true; this.updateControls(); this.status.textContent = forget ? 'Removing the saved key…' : 'Saving AI connection settings…';
    try {
      const params = { provider: this.provider.value, model: this.model.value.trim() };
      if (this.provider.value === 'custom') params.baseUrl = this.baseUrl.value.trim();
      if (forget) params.key = null;
      else if (key.trim()) params.key = key.trim();
      const config = await api.invoke('tools:aiConfigure', params);
      if (this.disposed) return;
      this.applyConfig(config); this.status.textContent = forget ? 'Saved API key removed.' : 'Connection saved. Ask a question when ready.';
    } catch (error) { if (!this.disposed) { this.status.textContent = errMsg(error); toast(errMsg(error), 'err'); } }
    finally { this.key.value = ''; if (!this.disposed) { this.configBusy = false; this.updateControls(); } }
  }

  contextChanged() {
    this.previewSeq++; this.previewValue = null; this.shareContext.checked = false;
    this.preview.textContent = 'Preview the current context before sharing.'; this.updateControls();
  }

  async previewContext() {
    if (this.disposed || this.jobId || this.previewBusy || !this.context.value.trim()) return;
    const input = this.context.value, seq = ++this.previewSeq;
    this.previewBusy = true; this.shareContext.checked = false; this.updateControls();
    try {
      const result = await api.invoke('tools:aiPreview', { context: input });
      if (this.disposed || seq !== this.previewSeq || this.context.value !== input) return;
      if (typeof result?.context !== 'string' || result.context.length > 24000) throw new Error('Invalid context preview.');
      this.context.value = result.context; this.previewValue = result.context;
      this.preview.textContent = result.context || 'No context remains after redaction.';
      this.status.textContent = 'Review the context above, then select Send this context if you want to include it.';
    } catch (error) { if (!this.disposed && seq === this.previewSeq) { this.previewValue = null; this.status.textContent = errMsg(error); toast(errMsg(error), 'err'); } }
    finally { if (!this.disposed) { this.previewBusy = false; this.updateControls(); } }
  }

  async start() {
    if (this.disposed || this.jobId || this.configBusy) return;
    if (this.dirty() || !this.savedKey()) return toast('Save an API key and connection settings before asking.', 'err');
    const question = this.question.value.trim(), shareContext = this.shareContext.checked;
    if (!question || question.length > 8000) return toast('Enter a question up to 8,000 characters.', 'err');
    if (shareContext && (this.previewValue === null || this.previewValue !== this.context.value)) return toast('Preview the context again before sharing.', 'err');
    const params = { revision: this.config.revision, question, context: shareContext ? this.previewValue : '', shareContext };
    const id = this.id + ':' + ++this.seq;
    this.cancelRequested = false; this.reportError = null; this.reportReceived = false;
    this.jobId = id; this.app.registerJob(id, this); this.state = 'running'; this.updateControls(); this.app.tabStateChanged(this);
    this.status.textContent = 'Finding local references and requesting an answer…';
    try { await api.invoke('tools:start', 'ai', params, id); }
    catch (error) { if (!this.disposed && this.jobId === id) this.onJobEvent('error', { message: errMsg(error) }); }
  }

  async stop() {
    if (!this.jobId) return;
    const id = this.jobId; this.cancelRequested = true; this.status.textContent = 'Cancelling AI request…'; this.updateControls();
    try { await api.invoke('tools:stop', id); }
    catch (error) { if (!this.disposed && this.jobId === id) toast(errMsg(error), 'err'); }
  }

  onJobEvent(type, data = {}) {
    if (this.disposed || !this.jobId) return;
    if (type === 'progress' && !this.cancelRequested) this.status.textContent = string(data.phase) || 'Waiting for AI…';
    if (type === 'report' && !this.cancelRequested) {
      try {
        if (typeof data.answer !== 'string' || !Array.isArray(data.sources)) throw new Error('AI returned an invalid answer.');
        this.report = data; this.reportReceived = true; this.renderReport();
      } catch (error) { this.reportError = errMsg(error); }
    }
    if (type === 'done' || type === 'error') {
      this.app.unregisterJob(this.jobId); this.jobId = null; this.state = 'idle'; this.updateControls(); this.app.tabStateChanged(this);
      this.status.textContent = this.cancelRequested || data.stopped ? 'AI request cancelled. Previous answers remain visible.' : type === 'error' ? string(data.message) || 'AI request failed.' : this.reportError || (this.reportReceived ? 'Answer complete. Review the references and verify suggested actions.' : 'No new answer was produced.');
      if (type === 'error' && !this.cancelRequested) toast(string(data.message) || 'AI request failed.', 'err');
    }
  }

  renderReport() {
    const label = this.config?.providers.find((provider) => provider.id === this.report.provider)?.label || this.report.provider;
    this.answerMeta.textContent = [label, string(this.report.model), this.report.servedModel ? `Served model: ${this.report.servedModel}` : ''].filter(Boolean).join(' · ');
    this.answer.textContent = this.report.answer;
    this.sourceList.replaceChildren();
    if (this.report.sources.length) this.sourceList.append(h('h4', 'Local references used'), h('p.hint', 'These articles supplied context. Their inclusion does not independently verify the AI answer.'),
      ...this.report.sources.map((source, index) => h('button.ai-source', { onclick: () => this.readDocument(source.id) }, `[${string(source.citation) || `K${index + 1}`}] ${string(source.title) || source.id}`)));
    this.answerLimitations.replaceChildren(...(Array.isArray(this.report.limitations) ? this.report.limitations : []).filter((line) => typeof line === 'string').map((line) => h('p.hint', line)));
  }

  async loadLibrary() {
    if (this.disposed) return;
    const seq = ++this.librarySeq, query = this.librarySearch.value.trim();
    try {
      const results = await Promise.allSettled([api.invoke('tools:knowledgeList', { query }), api.invoke('tools:knowledgeStatus')]);
      if (this.disposed || seq !== this.librarySeq) return;
      const [list, status] = results;
      if (list.status === 'rejected') throw list.reason;
      if (!Array.isArray(list.value)) throw new Error('Invalid knowledge library response.');
      this.libraryList.replaceChildren(...list.value.map((doc) => h('button.ai-library-item', { onclick: () => this.readDocument(doc.id) }, h('strong', string(doc.title) || doc.id), h('span', [string(doc.vendor), doc.builtin === false ? 'Personal note' : 'Built-in reference'].filter(Boolean).join(' · ')))));
      if (!list.value.length) this.libraryList.append(h('p.hint', query ? 'No articles matched. Try another term or add a local note.' : 'No knowledge articles yet. Add a note or rebuild the index.'));
      if (status.status === 'fulfilled') {
        const value = status.value || {}, documents = value.documents ?? value.documentCount ?? value.docs, chunks = value.chunks ?? value.chunkCount;
        this.libraryStatus.textContent = value.state === 'error' || value.error ? string(value.error) || 'The local knowledge index is unavailable.' :
          `${Number.isFinite(documents) ? `${documents} articles · ` : ''}${Number.isFinite(chunks) ? `${chunks} chunks · ` : ''}Local TF-IDF vector index${value.state === 'indexing' || value.building || value.indexing ? ' · Updating in the background…' : ''}`;
        if (value.warning) this.libraryStatus.textContent += ' · ' + value.warning;
      } else this.libraryStatus.textContent = 'Articles available. Index status unavailable: ' + errMsg(status.reason);
    } catch (error) { if (!this.disposed && seq === this.librarySeq) this.libraryStatus.textContent = errMsg(error); }
  }

  async readDocument(id) {
    if (this.disposed || typeof id !== 'string') return;
    const seq = ++this.articleSeq;
    try {
      const doc = await api.invoke('tools:knowledgeGet', id);
      if (this.disposed || seq !== this.articleSeq) return;
      if (!doc || typeof doc.id !== 'string' || typeof doc.content !== 'string') throw new Error('Knowledge article is unavailable.');
      this.currentDocument = doc; this.documentTitle.textContent = string(doc.title) || doc.id;
      this.documentMeta.textContent = [string(doc.vendor), doc.builtin === false ? 'Personal note' : 'Built-in reference', string(doc.sourceUrl)].filter(Boolean).join(' · ');
      this.documentContent.textContent = doc.content; this.documentAskButton.disabled = false;
      this.documentSourceButton.classList.toggle('hidden', !doc.sourceUrl);
      this.documentEditButton.classList.toggle('hidden', doc.builtin !== false); this.documentRemoveButton.classList.toggle('hidden', doc.builtin !== false);
      this.article.scrollIntoView({ block: 'nearest' });
    } catch (error) { if (!this.disposed && seq === this.articleSeq) toast(errMsg(error), 'err'); }
  }

  askAboutDocument() {
    if (!this.currentDocument || this.jobId) return;
    this.question.value = `Explain “${this.currentDocument.title}” and how I can use this information in KonX.`.slice(0, 8000);
    this.context.value = `${this.currentDocument.title}\n\n${this.currentDocument.content}`.slice(0, 24000);
    this.contextLabel.textContent = 'Local article prepared for your review. Preview it before choosing whether to send this context.';
    this.contextDetails.open = true; this.contextChanged(); this.question.focus();
  }

  async openDocumentSource() {
    if (!this.currentDocument) return;
    try { await api.invoke('tools:knowledgeOpenSource', this.currentDocument.id); }
    catch (error) { if (!this.disposed) toast(errMsg(error), 'err'); }
  }

  editDocument(doc) {
    if (this.libraryBusy || doc?.builtin !== false && doc) return;
    this.editingId = doc?.id || null; this.noteTitle.value = string(doc?.title); this.noteVendor.value = string(doc?.vendor);
    this.noteSource.value = string(doc?.sourceUrl); this.noteContent.value = string(doc?.content);
    this.noteEditor.classList.remove('hidden'); this.noteTitle.focus();
  }

  closeEditor() {
    this.editingId = null; this.noteTitle.value = ''; this.noteVendor.value = ''; this.noteSource.value = ''; this.noteContent.value = '';
    this.noteEditor.classList.add('hidden');
  }

  async saveDocument() {
    if (this.disposed || this.libraryBusy) return;
    if (!this.noteTitle.value.trim() || !this.noteContent.value.trim()) return toast('Enter a title and reference text.', 'err');
    this.libraryBusy = true; this.updateControls();
    try {
      const params = { title: this.noteTitle.value.trim(), vendor: this.noteVendor.value.trim(), sourceUrl: this.noteSource.value.trim(), content: this.noteContent.value };
      if (this.editingId) params.id = this.editingId;
      const doc = await api.invoke('tools:knowledgeSave', params);
      if (this.disposed) return;
      this.closeEditor(); await this.loadLibrary();
      if (doc?.id) await this.readDocument(doc.id);
      toast('Saved local knowledge note.', 'ok');
    } catch (error) { if (!this.disposed) toast(errMsg(error), 'err'); }
    finally { if (!this.disposed) { this.libraryBusy = false; this.updateControls(); } }
  }

  async removeDocument() {
    const doc = this.currentDocument;
    if (this.disposed || this.libraryBusy || !doc || doc.builtin !== false) return;
    if (!await confirmDialog(`Remove “${doc.title}” from your local knowledge library?`, { title: 'Remove note', okLabel: 'Remove note', danger: true })) return;
    if (this.disposed || this.libraryBusy) return;
    this.libraryBusy = true; this.updateControls();
    try {
      await api.invoke('tools:knowledgeRemove', doc.id);
      if (this.disposed) return;
      if (this.currentDocument?.id === doc.id) {
        this.articleSeq++; this.currentDocument = null; this.documentTitle.textContent = 'Read an article'; this.documentMeta.textContent = '';
        this.documentContent.textContent = 'Choose an article from the library.'; this.documentAskButton.disabled = true;
        for (const button of [this.documentSourceButton, this.documentEditButton, this.documentRemoveButton]) button.classList.add('hidden');
      }
      if (this.editingId === doc.id) this.closeEditor();
      await this.loadLibrary();
    } catch (error) { if (!this.disposed) toast(errMsg(error), 'err'); }
    finally { if (!this.disposed) { this.libraryBusy = false; this.updateControls(); } }
  }

  async rebuildLibrary() {
    if (this.disposed || this.libraryBusy) return;
    this.libraryBusy = true; this.libraryStatus.textContent = 'Rebuilding the local vector index…'; this.updateControls();
    try { await api.invoke('tools:knowledgeRebuild'); if (!this.disposed) await this.loadLibrary(); }
    catch (error) { if (!this.disposed) this.libraryStatus.textContent = errMsg(error); }
    finally { if (!this.disposed) { this.libraryBusy = false; this.updateControls(); } }
  }

  show() { this.active = true; if (this.config && !this.jobId && !this.configBusy) this.loadConfig(); this.loadLibrary(); }
  hide() { this.active = false; }
  focus() { this.question.focus(); }
  statusSegments() { return [{ icon: 'insight', text: 'AI & Knowledge' }, { text: this.state === 'running' ? 'Requesting…' : 'Ready' }]; }
  dispose() {
    this.disposed = true; this.key.value = ''; this.context.value = ''; this.previewValue = null; this.preview.textContent = ''; this.noteContent.value = '';
    clearTimeout(this.searchTimer); this.previewSeq++; this.librarySeq++; this.articleSeq++;
    if (this.jobId) { this.stop(); this.app.unregisterJob(this.jobId); this.jobId = null; }
  }
}
