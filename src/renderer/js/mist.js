import { installTrafficContext, trafficCopilotButton } from './copilot-traffic-ui.js';
import { h, icon, api, DataTable, toast, errMsg } from './ui.js';

const shown = (value, suffix = '') => value == null || value === '' ? 'Unknown' : String(value) + suffix;
const names = { self: 'Mist connection', sites: 'Mist sites', aps: 'Access points', clients: 'Wireless clients', marvis: 'Marvis Troubleshoot' };

export class MistTab {
  constructor(app) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'mist'; this.icon = 'insight'; this.title = 'Mist & Marvis';
    this.id = 'mist-' + Math.random().toString(36).slice(2); this.state = 'idle'; this.jobId = null; this.seq = 0; this.disposed = false;
    this.report = null; this.config = null; this.configBusy = true; this.identity = null; this.siteRows = [];
    installTrafficContext(this);
    this.region = h('select.input', { 'aria-label': 'Mist cloud region', onchange: () => { this.clearReport(); this.updateControls(); } });
    this.token = h('input.input', { type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'Paste Mist API token', 'aria-label': 'Mist API token' });
    this.saveButton = h('button.btn', { onclick: () => this.configure(false) }, icon('save'), 'Save token');
    this.forgetButton = h('button.btn', { onclick: () => this.configure(true) }, icon('trash'), 'Forget token');
    this.testButton = h('button.btn.primary', { onclick: () => this.start('self') }, icon('link'), 'Test connection');
    this.cancelButton = h('button.btn.hidden', { onclick: () => this.stop() }, icon('stop'), 'Cancel request');
    this.tokenStatus = h('div.mist-token-state', 'Reading local connection settings…');
    this.status = h('div.wireless-status', { role: 'status', 'aria-live': 'polite' }, 'Configure a token, then test the connection when ready.');
    this.org = h('select.input', { 'aria-label': 'Mist organization', onchange: () => { this.manualOrg.value = ''; this.manualSite.value = ''; this.orgChanged(); } }, h('option', { value: '' }, 'Test connection to discover organizations'));
    this.site = h('select.input', { 'aria-label': 'Mist site', onchange: () => { this.manualSite.value = ''; this.clearReport(); this.updateControls(); } }, h('option', { value: '' }, 'Choose a site'));
    this.manualOrg = h('input.input', { placeholder: 'Organization UUID', spellcheck: false, 'aria-label': 'Manual Mist organization ID', oninput: () => this.manualOrgChanged() });
    this.manualSite = h('input.input', { placeholder: 'Site UUID', spellcheck: false, 'aria-label': 'Manual Mist site ID', oninput: () => { this.clearReport(); this.updateControls(); } });
    this.sitesButton = h('button.btn', { onclick: () => this.start('sites') }, 'Load sites');
    this.apsButton = h('button.btn', { onclick: () => this.start('aps') }, 'Access points');
    this.clientsButton = h('button.btn', { onclick: () => this.start('clients') }, 'Wireless clients');
    this.mac = h('input.input', { placeholder: 'Optional device MAC', spellcheck: false, 'aria-label': 'Marvis device MAC address' });
    this.type = h('select.input', { 'aria-label': 'Marvis service type' }, [['wireless', 'Wireless'], ['wired', 'Wired'], ['wan', 'WAN']].map(([value, label]) => h('option', { value }, label)));
    this.duration = h('select.input', { 'aria-label': 'Marvis troubleshooting time range' }, [['1h', 'Last hour'], ['1d', 'Last day'], ['7d', 'Last 7 days']].map(([value, label]) => h('option', { value }, label)));
    this.marvisButton = h('button.btn.primary', { onclick: () => this.start('marvis') }, icon('insight'), 'Ask Marvis Troubleshoot');
    this.jsonButton = h('button.btn', { disabled: true, onclick: () => this.export() }, icon('download'), 'Export JSON');
    this.heading = h('div.wireless-heading', 'Cloud results');
    this.tableSlot = h('div.mist-table');
    this.detail = h('div.wireless-detail', 'Connect to your Mist cloud to retrieve authorized site and device information.');
    this.limitations = h('div.wireless-limitations');
    this.el = h('div.view.wireless-view.mist-view',
      h('div.tool-head', h('div.tool-title', icon('insight'), h('h2', 'Mist & Marvis'), h('span.sub', 'Direct Mist cloud API access')),
        h('div.mist-config', h('div.wireless-form', h('label.field', h('span', 'Mist cloud region'), this.region),
          h('label.field.wireless-key', h('span', 'API token'), this.token), this.saveButton, this.forgetButton),
          this.tokenStatus, h('p.notice', 'Tokens are encrypted for this Windows user and stay in the main process after saving. Requests use the selected Mist cloud.')),
        h('div.wireless-actions', trafficCopilotButton(this), this.testButton, this.cancelButton, this.jsonButton), this.status),
      h('div.wireless-content', h('div.wireless-form', h('label.field', h('span', 'Organization'), this.org), this.sitesButton,
        h('label.field', h('span', 'Site'), this.site), this.apsButton, this.clientsButton),
        h('details.mist-manual', h('summary', 'Use known organization or site IDs'),
          h('p.hint', 'For access that does not appear in discovery, enter known IDs. A manual ID takes precedence over the corresponding selection; Mist still enforces the token’s permissions.'),
          h('div.wireless-form', h('label.field', h('span', 'Organization ID (optional)'), this.manualOrg), h('label.field', h('span', 'Site ID (optional)'), this.manualSite))),
        h('h3', 'Marvis Troubleshoot'), h('p.mist-marvis-help', 'Choose an organization and a site or device MAC, then request structured troubleshooting. Results depend on your Mist permissions and Marvis entitlement.'),
        h('div.wireless-form', h('label.field', h('span', 'Device MAC (optional with a site)'), this.mac),
          h('label.field', h('span', 'Service'), this.type), h('label.field', h('span', 'Time range'), this.duration), this.marvisButton),
        h('p.hint', 'This uses the documented Marvis Troubleshoot API. It does not provide a free-form conversational chat API or upload local Wi-Fi snapshots.'),
        this.heading, this.tableSlot, this.detail, this.limitations));
    this.updateControls(); this.loadConfig();
  }

  async loadConfig() {
    if (this.disposed || this.jobId) return;
    this.configBusy = true; this.updateControls();
    try {
      const config = await api.invoke('tools:mistConfig');
      if (this.disposed) return;
      if (this.config && config.revision === this.config.revision) this.config = config;
      else {
        if (this.config) { this.token.value = ''; this.clearCloudState(); }
        this.applyConfig(config);
      }
    } catch (error) { if (!this.disposed) { this.status.textContent = errMsg(error); toast(errMsg(error), 'err'); } }
    finally { if (!this.disposed) { this.configBusy = false; this.updateControls(); } }
  }

  applyConfig(config) {
    if (!config || typeof config.hasToken !== 'boolean' || !Array.isArray(config.regions) || !config.regions.some((region) => region.id === config.region)) throw new Error('Invalid Mist connection settings');
    this.config = config;
    this.region.replaceChildren(...config.regions.map((region) => h('option', { value: region.id }, region.label)));
    this.region.value = config.region;
  }

  updateControls() {
    const busy = this.configBusy || Boolean(this.jobId);
    const dirty = Boolean(this.config && this.region.value !== this.config.region);
    const connected = Boolean(this.config?.hasToken && !dirty);
    for (const control of [this.region, this.token, this.saveButton, this.forgetButton, this.org, this.site, this.manualOrg, this.manualSite, this.mac, this.type, this.duration]) control.disabled = busy || !this.config;
    this.forgetButton.disabled = busy || !(this.config?.hasToken || this.config?.warning);
    this.testButton.disabled = busy || !connected;
    this.sitesButton.disabled = busy || !connected || !(this.manualOrg.value.trim() || this.org.value);
    this.apsButton.disabled = this.clientsButton.disabled = busy || !connected || !(this.manualSite.value.trim() || this.site.value);
    this.marvisButton.disabled = busy || !connected || !(this.manualOrg.value.trim() || this.org.value);
    this.cancelButton.classList.toggle('hidden', !this.jobId);
    this.cancelButton.disabled = Boolean(this.cancelRequested);
    this.jsonButton.disabled = !this.report;
    if (this.config) this.tokenStatus.textContent = dirty ? 'Cloud region changed. Enter and save a token for this region before making requests.' : this.config.hasToken ? 'An encrypted token is saved for this cloud. The saved token is never returned to this tab.' : 'No API token saved. Paste a token for the selected Mist cloud.';
    if (this.config?.warning) this.tokenStatus.textContent += ' ' + this.config.warning;
  }

  async configure(forget) {
    // Clear the DOM value before the first await, including validation failures.
    const token = this.token.value; this.token.value = '';
    if (this.disposed || this.configBusy || this.jobId || !this.config) return;
    if (!forget && (!this.config.hasToken || this.region.value !== this.config.region) && !token.trim()) return toast('Enter an API token for the selected Mist cloud.', 'err');
    const previousRegion = this.config.region;
    this.configBusy = true; this.updateControls(); this.status.textContent = forget ? 'Removing the saved token…' : 'Saving the encrypted token…';
    try {
      const params = { region: this.region.value };
      if (forget) params.token = null;
      else if (token.trim()) params.token = token.trim();
      const config = await api.invoke('tools:mistConfigure', params);
      if (this.disposed) return;
      this.applyConfig(config);
      if (forget || previousRegion !== config.region || token.trim()) this.clearCloudState();
      this.status.textContent = forget ? 'Saved Mist token removed.' : 'Token settings saved. Test connection to discover your access.';
    } catch (error) { if (!this.disposed) { this.status.textContent = errMsg(error); toast(errMsg(error), 'err'); } }
    finally { this.token.value = ''; if (!this.disposed) { this.configBusy = false; this.updateControls(); } }
  }

  clearCloudState() {
    this.identity = null; this.siteRows = []; this.report = null;
    this.manualOrg.value = ''; this.manualSite.value = ''; this.mac.value = '';
    this.org.replaceChildren(h('option', { value: '' }, 'Test connection to discover organizations'));
    this.site.replaceChildren(h('option', { value: '' }, 'Choose a site'));
    this.clearReport('Test the connection to discover your current cloud access.');
  }

  orgChanged() {
    this.mac.value = '';
    this.populateSites((this.identity?.sites || []).filter((site) => !this.org.value || site.orgId === this.org.value));
    this.clearReport();
    this.updateControls();
  }

  manualOrgChanged() {
    this.manualSite.value = ''; this.mac.value = '';
    const orgId = this.manualOrg.value.trim() || this.org.value;
    this.populateSites((this.identity?.sites || []).filter((site) => orgId && site.orgId === orgId));
    this.clearReport(); this.updateControls();
  }

  clearReport(message = 'Choose a request to retrieve information for this scope.') {
    this.report = null; this.copilot.acceptReport(null); this.table = null; this.heading.textContent = 'Cloud results'; this.tableSlot.replaceChildren();
    this.detail.replaceChildren(h('p.hint', message)); this.limitations.replaceChildren(); this.jsonButton.disabled = true;
  }

  populateSites(sites) {
    const previous = this.site.value; this.siteRows = sites;
    this.site.replaceChildren(h('option', { value: '' }, 'Choose a site'), ...sites.map((site) => h('option', { value: site.id }, site.name || site.id)));
    if (sites.some((site) => site.id === previous)) this.site.value = previous;
    else if (sites.length === 1) this.site.value = sites[0].id;
  }

  params(action) {
    if (!this.config?.hasToken || this.region.value !== this.config.region) throw new Error('Save an API token for the selected Mist cloud first.');
    const params = { action };
    if (typeof this.config.revision === 'string') params.configRevision = this.config.revision;
    const orgId = this.manualOrg.value.trim() || this.org.value, siteId = this.manualSite.value.trim() || this.site.value;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (this.manualOrg.value.trim() && !uuid.test(orgId) || this.manualSite.value.trim() && !uuid.test(siteId)) throw new Error('Enter valid organization and site UUIDs.');
    if (['sites', 'marvis'].includes(action)) { params.orgId = orgId; if (!params.orgId) throw new Error('Choose a Mist organization.'); }
    if (['aps', 'clients'].includes(action)) { params.siteId = siteId; if (!params.siteId) throw new Error('Choose a Mist site.'); }
    if (action === 'marvis') {
      if (siteId) params.siteId = siteId;
      if (this.mac.value.trim()) params.mac = this.mac.value.trim();
      if (!params.siteId && !params.mac) throw new Error('Choose a site or enter a device MAC for Marvis.');
      if (params.mac && !/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})$/i.test(params.mac)) throw new Error('Enter a 12-digit device MAC, optionally separated by colons or hyphens.');
      params.type = this.type.value; params.duration = this.duration.value;
    }
    return params;
  }

  async start(action) {
    if (this.disposed || this.jobId || this.configBusy) return;
    let params;
    try { params = this.params(action); } catch (error) { return toast(errMsg(error), 'err'); }
    const id = this.id + ':' + ++this.seq;
    this.action = action; this.cancelRequested = false; this.reportError = null; this.reportReceived = false;
    this.jobId = id; this.app.registerJob(id, this); this.state = 'running'; this.updateControls(); this.app.tabStateChanged(this);
    this.status.textContent = `Requesting ${names[action] || action} from Mist…`;
    try { await api.invoke('tools:start', 'mist', params, id); }
    catch (error) { if (!this.disposed && this.jobId === id) this.onJobEvent('error', { message: errMsg(error) }); }
  }

  async stop() {
    if (!this.jobId) return;
    const id = this.jobId; this.cancelRequested = true; this.status.textContent = 'Cancelling Mist request…'; this.updateControls();
    try { await api.invoke('tools:stop', id); }
    catch (error) { if (!this.disposed && this.jobId === id) toast(errMsg(error), 'err'); }
  }

  onJobEvent(type, data = {}) {
    if (this.disposed) return;
    if (type === 'progress' && !this.cancelRequested) this.status.textContent = data.phase || 'Waiting for Mist…';
    if (type === 'report' && !this.cancelRequested) {
      try {
        if (data.action !== this.action || !names[data.action] || typeof data.region !== 'string' || !Array.isArray(data.limitations)) throw new Error('Mist returned an invalid report.');
        if (data.action === 'self' && (!data.data || !Array.isArray(data.data.orgs) || !Array.isArray(data.data.sites))) throw new Error('Mist returned invalid access details.');
        if (['sites', 'aps', 'clients'].includes(data.action) && !Array.isArray(data.data)) throw new Error('Mist returned an invalid inventory.');
        if (data.action === 'self') {
          this.identity = data.data;
          const orgs = data.data.orgs;
          this.org.replaceChildren(h('option', { value: '' }, orgs.length ? 'Choose an organization' : 'No organization-level access'),
            ...orgs.map((org) => h('option', { value: org.id }, org.name || org.id)));
          if (orgs.length === 1) this.org.value = orgs[0].id;
          this.orgChanged();
        }
        if (data.action === 'sites') this.populateSites(data.data);
        this.report = data; this.reportReceived = true;
        this.renderReport(); this.updateControls();
      } catch (error) { this.reportError = errMsg(error); }
    }
    if (type === 'done' || type === 'error') {
      this.app.unregisterJob(this.jobId); this.jobId = null; this.state = 'idle'; this.updateControls(); this.app.tabStateChanged(this);
      this.status.textContent = this.cancelRequested || data.stopped ? 'Mist request cancelled. Previous results remain visible.' : type === 'error' ? data.message : this.reportError || (this.reportReceived ? `${names[this.action]} request complete.` : 'No new Mist report was produced. Previous results remain visible.');
      if (type === 'error' && !this.cancelRequested) toast(data.message, 'err');
    }
  }

  renderReport() {
    this.copilot.acceptReport(this.report);
    const report = this.report;
    const scope = report.scope ? Object.entries(report.scope).filter(([, value]) => value != null && value !== '').map(([key, value]) => `${key}: ${value}`).join(' · ') : '';
    this.heading.textContent = `${names[report.action]} · ${report.region} · ${new Date(report.fetchedAt).toLocaleString()}${scope ? ' · ' + scope : ''}${report.limited ? ' · limited results' : ''}`;
    this.tableSlot.replaceChildren(); this.table = null;
    let rows = [], columns = [];
    if (report.action === 'self') {
      rows = [...report.data.orgs.map((org) => ({ ...org, access: 'Organization' })), ...report.data.sites.map((site) => ({ ...site, access: 'Site' }))];
      columns = [{ key: 'name', label: 'Name' }, { key: 'access', label: 'Access scope', width: 130 }, { key: 'role', label: 'Role', width: 160 }, { key: 'id', label: 'ID', width: 280 }];
    }
    if (report.action === 'sites') { rows = report.data; columns = [{ key: 'name', label: 'Site' }, { key: 'timezone', label: 'Timezone', width: 200 }, { key: 'id', label: 'ID', width: 280 }]; }
    if (report.action === 'aps') { rows = report.data; columns = [
      { key: 'name', label: 'Access point' }, { key: 'model', label: 'Model', width: 90 }, { key: 'status', label: 'Status', width: 100 },
      { key: 'ip', label: 'IP address', width: 140 }, { key: 'mac', label: 'MAC', width: 140 }, { key: 'numClients', label: 'Clients', width: 80, render: (row) => shown(row.numClients) },
    ]; }
    if (report.action === 'clients') { rows = report.data; columns = [
      { key: 'hostname', label: 'Client' }, { key: 'mac', label: 'MAC', width: 140 }, { key: 'ip', label: 'IP address', width: 130 },
      { key: 'ssid', label: 'SSID', width: 130 }, { key: 'band', label: 'Band', width: 70 }, { key: 'rssi', label: 'RSSI', width: 75, render: (row) => shown(row.rssi, ' dBm') },
    ]; }
    if (columns.length) {
      this.table = new DataTable({ columns, rowKey: (row) => (row.access || '') + ':' + (row.id || row.mac), multi: false, emptyText: 'No results returned for this scope.' });
      this.table.onSelect = (selected) => this.renderDetail(selected[0]);
      this.table.setRows(rows); this.tableSlot.append(this.table.el);
    }
    this.renderDetail(report.action === 'marvis' ? report.data : null);
    this.limitations.replaceChildren(h('h3', 'API coverage'), h('ul', report.limitations.map((line) => h('li', line))));
  }

  renderDetail(row) {
    if (!row) return this.detail.replaceChildren(h('p.hint', this.report?.action === 'self' ? `Connected${this.report.data.name ? ' as ' + this.report.data.name : ''}. Select a row for access details, or choose an organization and load its sites.` : 'Select a row to view the returned details.'));
    this.detail.replaceChildren(h('h3', this.report.action === 'marvis' ? 'Marvis troubleshooting response' : 'Returned details'), h('pre', JSON.stringify(row, null, 2)));
  }

  async export() {
    if (!this.report) return;
    const report = this.report; const text = JSON.stringify(report, null, 2);
    try {
      const file = await api.invoke('dialog:saveText', `konx-mist-${report.action}-${String(report.fetchedAt).slice(0, 10)}.json`, text);
      if (file && !this.disposed) toast('Saved ' + file, 'ok');
    } catch (error) { if (!this.disposed) toast(errMsg(error), 'err'); }
  }

  show() { this.active = true; if (this.config && !this.jobId && !this.configBusy) this.loadConfig(); }
  hide() { this.active = false; }
  focus() { (this.config?.hasToken ? this.testButton : this.token).focus(); }
  statusSegments() { return [{ icon: 'insight', text: 'Mist & Marvis' }, { text: this.state === 'running' ? 'Requesting…' : 'Ready' }]; }
  dispose() { this.disposed = true; this.token.value = ''; if (this.jobId) { this.stop(); this.app.unregisterJob(this.jobId); this.jobId = null; } }
}

export function createMistTool(app, params) { return new MistTab(app, params); }
