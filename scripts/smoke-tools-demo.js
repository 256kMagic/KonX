(async () => {
  const options = window.__KONX_TOOLS_SMOKE;
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (test, description) => {
    const deadline = Date.now() + 15000;
    while (!test()) {
      if (Date.now() > deadline) throw new Error('Timed out: ' + description);
      await pause();
    }
  };
  const terminalContains = (tab, marker) => {
    const buffer = tab.term.buffer.active, lines = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '');
    return lines.join('').includes(marker);
  };
  await until(() => window.__app, 'application initialization');
  const app = window.__app;
  const { api } = await import('./js/ui.js');
  const { exportReport, validateReport } = await import('./js/security-report.mjs');
  const { TOOLS } = await import('./js/tools.js');
  const complete = async (checks) => {
    if (sessionManagement) checks.sessionManagement = sessionManagement;
    if (logging) checks.logging = logging;
    if (quickLogin) checks.quickLogin = quickLogin;
    if (ciscoHighlighting) checks.ciscoHighlighting = ciscoHighlighting;
    if (serialAutoBaud) checks.serialAutoBaud = serialAutoBaud;
    if (workspaceWindows) checks.workspaceWindows = workspaceWindows;
    if (supportReport) checks.supportReport = supportReport;
    if (siteWorkspaces) checks.siteWorkspaces = siteWorkspaces;
    if (visualTopology) checks.visualTopology = visualTopology;
    if (liveEvents) checks.liveEvents = liveEvents;
    if (changeValidation) checks.changeValidation = changeValidation;
    if (aiContextSafety) checks.aiContextSafety = aiContextSafety;
    if (copilotChecks) checks.copilot = copilotChecks;
    // Portable launchers do not necessarily forward their app's stdout. Write
    // test evidence only to the parent-provided private artifact file.
    await api.invoke('np:write', options.resultPath, new TextEncoder().encode(JSON.stringify(checks, null, 2)));
    console.log('KONX_TOOLS_PACKAGE_SMOKE_PASS ' + JSON.stringify(checks));
  };
  const info = await api.invoke('app:info');
  assert(info.version === options.version && app.info.version === options.version, 'Unexpected application version');
  assert(info.encryption, 'Windows credential encryption must be available');
  for (const kind of ['security', 'wifi', 'mist', 'ai']) assert(TOOLS.some((tool) => tool.kind === kind), 'Missing tool entry: ' + kind);
  assert(app.jobs.size === 0, 'Fresh app unexpectedly started a tool job');
  const security = app.openTool('security');
  assert(security.audit.options.length === 8, 'Expected eight security assessments');
  assert(security.audit.value === 'windows' && !security.runButton.disabled, 'Local Windows assessment is unavailable');
  const wifi = app.openTool('wifi');
  assert(!wifi.runButton.disabled && !wifi.report && !wifi.jobId, 'Wi-Fi tool is not ready for an explicit refresh');
  const mist = app.openTool('mist');
  await until(() => !mist.configBusy && mist.config, 'Mist connection settings');
  assert(mist.region.options.length === 12 && mist.config.regions.length === 12, 'Mist cloud regions are missing');
  assert(mist.token.type === 'password', 'Mist credential input must mask its value');
  assert(app.jobs.size === 0, 'Opening tool tabs unexpectedly started a job');
  const ai = app.openTool('ai');
  await until(() => !ai.configBusy && ai.config, 'AI connection settings');
  assert(ai.provider.options.length === 5 && ai.key.type === 'password', 'Five AI providers and a masked key input are required');
  const knowledge = await api.invoke('tools:knowledgeStatus');
  assert(knowledge.state === 'ready' && knowledge.documents >= 30 && knowledge.chunks > 0, 'Packaged background knowledge database is not ready');
  assert(knowledge.algorithm === 'Local TF-IDF cosine vectors', 'Unexpected vector index algorithm');
  assert((await api.invoke('tools:knowledgeList', { query: 'RSSI' })).length > 0, 'Offline reference search found no signal guidance');
  const noteTitle = 'Package smoke synthetic reference';
  const versionParts = info.version.split('.').map(Number);
  const supportsDeviceInspector = versionParts[0] > 0 || versionParts[1] >= 7;
  const supportsSnapshots = versionParts[0] > 0 || versionParts[1] >= 8;
  const supportsRtp = versionParts[0] > 0 || versionParts[1] >= 9;
  const supportsIncidents = versionParts[0] > 0 || versionParts[1] >= 10;
  const supportsRemoteCapture = versionParts[0] > 0 || versionParts[1] >= 11;
  const supportsRunbooks = versionParts[0] > 0 || versionParts[1] >= 12;
  const supportsComparison = versionParts[0] > 0 || versionParts[1] >= 13;
  const supportsLayouts = versionParts[0] > 0 || versionParts[1] >= 14;
  const supportsSessionManagement = versionParts[0] > 0 || versionParts[1] >= 15;
  const supportsLoggingSwitch = versionParts[0] > 0 || versionParts[1] > 15 ||
    (versionParts[1] === 15 && parseInt(info.version.split('.')[2], 10) >= 1);
  const supportsQuickLogin = versionParts[0] > 0 || versionParts[1] > 15 ||
    (versionParts[1] === 15 && parseInt(info.version.split('.')[2], 10) >= 2);
  const supportsCiscoHighlighting = versionParts[0] > 0 || versionParts[1] >= 16;
  const supportsSerialAutoBaud = versionParts[0] > 0 || versionParts[1] >= 17;
  const supportsWorkspaceWindows = versionParts[0] > 0 || versionParts[1] >= 18;
  const supportsSupport = versionParts[0] > 0 || versionParts[1] > 18 || (versionParts[1] === 18 && versionParts[2] >= 1);
  const supportsSites = versionParts[0] > 0 || versionParts[1] >= 19;
  const supportsTopology = versionParts[0] > 0 || versionParts[1] >= 20;
  let visualTopology = null;
  const supportsEvents = versionParts[0] > 0 || versionParts[1] >= 21;
  const supportsChangeValidation = versionParts[0] > 0 || versionParts[1] >= 22;
  const supportsAiContextSafety = versionParts[0] > 0 || versionParts[1] > 22 || (versionParts[1] === 22 && versionParts[2] >= 1);
  let aiContextSafety = null;
  const supportsCopilot = versionParts[0] > 0 || versionParts[1] >= 23;
  let copilotChecks = null;
  let liveEvents = null;
  let changeValidation = null;
  const changeName = 'Synthetic package smoke change validation';
  const changeScope = 'Owned offline branch fixture; no equipment touched.';
  const changeMaintenance = 'Synthetic manual maintenance acknowledgment; no commands were sent.';
  const changeRationale = 'Unknown: offline differences do not establish service health.';
  let siteWorkspaces = null;
  let supportReport = null;
  if (supportsSupport) {
    const { supportDialog } = await import('./js/support.js');
    const opened = supportDialog(app);
    await until(() => document.querySelector('[aria-label="Diagnostic report preview"]')?.value, 'support preview');
    const report = JSON.parse(document.querySelector('[aria-label="Diagnostic report preview"]').value);
    assert(report.kind === 'konx-support-report' && report.runtime.version === info.version &&
      report.logs.requested === false && report.logs.entries.length === 0 && report.privacy.uploaded === false, 'Support preview must be local and omit error logs by default');
    assert(report.counts.jobs === 0 && Array.isArray(report.displays) && report.displays.length > 0, 'Support preview is missing display/activity diagnostics');
    document.querySelector('.support-report').closest('.modal').querySelector('header .x').click(); await opened;
    supportReport = { preview: true, localOnly: true, logsOptIn: true, runtimeAndDisplays: true };
  }
  let sessionManagement = null;
  let logging = null;
  let quickLogin = null;
  let ciscoHighlighting = null;
  let serialAutoBaud = null;
  let workspaceWindows = null;
  const sessionName = 'Package smoke synthetic saved session';
  const serialName = 'Package smoke serial auto fixture';
  const serialControl = name => document.querySelector('.modal [name="' + name + '"]');
  const setSerialControl = (name, value) => {
    const input = serialControl(name); assert(input, 'Missing serial editor input: ' + name);
    input.value = String(value); input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const serialFooter = label => {
    const button = [...document.querySelectorAll('.modal footer button')].find(button => button.textContent === label);
    assert(button, 'Missing serial editor action: ' + label); button.click();
  };
  const checkSavedSerialEditor = async saved => {
    const editing = app.editSession(saved);
    await until(() => !!serialControl('baudRate'), 'saved serial editor');
    assert(serialControl('baudRate').value === 'auto' && serialControl('serialAutoBaudProbe')?.checked === true,
      'Serial automatic rate and explicit Enter probe did not reopen');
    assert(serialControl('dataBits').value === '7' && serialControl('parity').value === 'even' &&
      serialControl('stopBits').value === '2' && serialControl('flowControl').value === 'xonxoff', 'Serial framing changed on reopen');
    serialFooter('Cancel'); await editing;
  };

  if (options.phase === 'save') {
    if (supportsSerialAutoBaud) {
      assert(info.serial === true, 'Packaged native serial module is unavailable');
      const terminalCount = app.tabs.filter(tab => tab.kind === 'terminal').length;
      const editing = app.editSession(); await until(() => !!serialControl('baudRate'), 'new serial editor');
      setSerialControl('protocol', 'serial');
      assert(serialControl('baudRate').value === '9600' && !serialControl('serialAutoBaudProbe').checked,
        'Serial auto detection or Enter probes must not be enabled by default');
      setSerialControl('name', serialName); setSerialControl('serialPort', 'COM9999'); setSerialControl('baudRate', 'auto');
      const probe = serialControl('serialAutoBaudProbe');
      assert(!probe.disabled && probe.getBoundingClientRect().width > 0, 'Explicit Enter-probe checkbox is unavailable'); probe.click();
      setSerialControl('dataBits', 7); setSerialControl('parity', 'even'); setSerialControl('stopBits', 2); setSerialControl('flowControl', 'xonxoff');
      serialFooter('Save'); await editing;
      const saved = app.sessions.data.sessions.find(session => session.name === serialName);
      assert(saved?.baudRate === 'auto' && saved.serialAutoBaudProbe === true, 'Serial editor did not save automatic detection settings');
      await checkSavedSerialEditor(saved);
      assert(app.tabs.filter(tab => tab.kind === 'terminal').length === terminalCount, 'Saving a serial session opened a connection');
      serialAutoBaud = { savedId: saved.id, nativeSerialAvailable: true, manualDefault: true, autoAndProbeSaved: true, framingRetained: true, reopened: true, noPortOpened: true };
    }
    if (supportsSessionManagement) {
      const saved = await api.invoke('sessions:save', { name: sessionName, protocol: 'ssh', host: '192.0.2.15', port: 22, username: 'fixture-user', auth: 'password', password: options.token + '-session' });
      assert(saved.hasPassword && saved.username === 'fixture-user' && !Object.hasOwn(saved, 'password') && !Object.hasOwn(saved, 'passwordEnc'), 'Saved session exposed credentials or omitted its username');
      await app.sessions.load(); app.rememberRecent(saved.id);
      assert(app.recentSessions().some(item => item.id === saved.id), 'Saved session did not enter recent history');
      localStorage.setItem('konx.session-smoke-marker', 'retained');
      assert(app.clearRecentSessions() && app.recentSessions().length === 0, 'Recent history did not clear');
      assert((await api.invoke('sessions:list')).sessions.some(item => item.id === saved.id && item.hasPassword), 'Clearing history removed a saved credential');
      sessionManagement = { usernameSaved: true, passwordPresencePrivate: true, historyCleared: true, savedSessionRetained: true };
    }
    if (supportsSites) {
      const sites = app.openTool('sites'); await sites.ready;
      assert(sites.workspaces.length === 0 && !sites.isDirty(), 'Fresh site library is not empty and idle');
      const savedSession = app.sessions.data.sessions.find(s => s.name === sessionName);
      const record = await api.invoke('tools:siteSave', { name: 'Synthetic package smoke site', notes: 'Retained site notes',
        sessions: [{ id: savedSession.id, name: savedSession.name, group: 'Core' }],
        layout: { preset: 'workbench', panels: [
          { key: 'session', kind: 'session', referenceId: savedSession.id, sessionMode: 'sftp', slot: 'primary' },
          { key: 'notes', kind: 'notes', slot: 'companion' }] } });
      await sites.select(record.id);
      const original = [...app.tabs], terminals = app.tabs.filter(t => ['terminal', 'sftp'].includes(t.kind)).length;
      await sites.open();
      const panels = app.tabs.filter(t => t.siteWorkspace?.workspaceId === record.id);
      assert(panels.length === 2 && panels.find(t => t.siteWorkspace.panel.key === 'notes').el.innerText.includes('Retained site notes'), 'Saved reference panels did not restore');
      assert(original.every(t => app.tabs.includes(t)) && app.jobs.size === 0 && app.tabs.filter(t => ['terminal', 'sftp'].includes(t.kind)).length === terminals, 'Opening a site closed work or connected automatically');
      await sites.open(); assert(app.tabs.filter(t => t.siteWorkspace?.workspaceId === record.id).length === 2, 'Site reopen duplicated its panels');
      const duplicate = await api.invoke('tools:siteDuplicate', record.id, {});
      assert(duplicate.id !== record.id && duplicate.layout.panels[0].sessionMode === 'sftp', 'Duplicate lost identity or SFTP mode');
      await api.invoke('tools:siteRemove', duplicate.id);
      assert(!JSON.stringify(record).includes(options.token) && !Object.hasOwn(record.sessions[0], 'password'), 'Workspace copied credential data');
      for (const panel of panels) await app.closeTab(panel);
      await app.closeTab(sites);
      siteWorkspaces = { referencePanelsRestored: true, existingTabsRetained: true, explicitConnectionsRequired: true, reopenReusesPanels: true, duplicateIndependent: true, credentialsExcluded: true };
    }
    if (supportsQuickLogin) {
      const fixture = options.quickLogin;
      assert(fixture?.host === '127.0.0.1' && Number.isInteger(fixture.port) && fixture.password && fixture.fingerprint,
        'Saved Quick Connect requires the parent-owned synthetic SSH fixture');
      app.showHome();
      const home = app.active, form = home.el.querySelector('.qc-form');
      const password = form?.querySelector('input[name="quickPassword"]');
      const remember = form?.querySelector('input[name="saveQuickSession"]');
      const username = form?.querySelector('input[name="quickUsername"]');
      const connect = form?.querySelector('button[data-action="quick-connect"]');
      assert(password?.type === 'password' && remember?.type === 'checkbox' && !remember.checked && !remember.disabled && username && connect,
        'Home needs a masked password and unchecked saved-login checkbox');
      form.querySelector('select').value = 'ssh';
      form.querySelector('select').dispatchEvent(new Event('change'));
      form.querySelector('input[placeholder="Hostname, IP or COM port"]').value = fixture.host;
      form.querySelector('input[type="number"]').value = String(fixture.port);
      username.value = fixture.username; password.value = fixture.password;
      remember.click(); assert(remember.checked, 'Saved-login checkbox did not select');
      const existingTabs = new Set(app.tabs.map(tab => tab.id));
      let consoleTab;
      try {
        connect.click();
        await until(() => {
          assert(!home.el.querySelector('.qc-error')?.textContent.trim(), 'Quick Connect rejected the synthetic fixture');
          consoleTab = app.tabs.find(tab => tab.kind === 'terminal' && !existingTabs.has(tab.id));
          return !!consoleTab;
        }, 'Home saved-login terminal');
        await until(() => document.querySelector('.modal .fp'), 'synthetic SSH host verification');
        const hostPrompt = document.querySelector('.modal');
        assert(hostPrompt.querySelector('.fp').textContent.includes(fixture.fingerprint), 'Quick Connect presented a different host identity');
        const accept = [...hostPrompt.querySelectorAll('button')].find(button => button.textContent.trim() === 'Accept & save');
        assert(accept, 'Host verification save control is missing'); accept.click();
        await until(() => ['connected', 'disconnected'].includes(consoleTab.state), 'Home SSH authentication');
        assert(consoleTab.state === 'connected', 'Home did not authenticate with its entered username and password');
        await until(() => terminalContains(consoleTab, fixture.marker), 'authenticated synthetic shell output');
        const saved = (await api.invoke('sessions:list')).sessions.find(item => item.id === consoleTab.spec.sessionId);
        assert(saved?.host === fixture.host && Number(saved.port) === fixture.port && saved.username === fixture.username && saved.hasPassword,
          'Home opt-in did not save the selected host, username and password presence');
        assert(!Object.hasOwn(saved, 'password') && !Object.hasOwn(saved, 'passwordEnc') && !Object.hasOwn(saved, '_oncePassword') &&
          !JSON.stringify(saved).includes(fixture.password), 'Home returned saved credential material in public metadata');
        assert(password.value === '', 'Home password input retained the secret after connecting');
        quickLogin = { savedId: saved.id, optInInitiallyOff: true, connected: true, passwordCleared: true, publicMetadataPrivate: true };
      } finally {
        if (consoleTab) { await api.invoke('conn:close', consoleTab.id); await app.closeTab(consoleTab); }
      }
      // Keep the existing clear-history restart invariant after this explicitly
      // saved connection has exercised the recent-session path.
      app.clearRecentSessions();
    }
    if (supportsLoggingSwitch) {
      const fixture = options.logging;
      assert(fixture?.host === '127.0.0.1' && Number.isInteger(fixture.port) && fixture.port > 0 && fixture.logPath,
        'Console logging requires the parent-owned loopback fixture and log file');
      const consoleTab = app.openTerminal({ name: 'Synthetic logging console', protocol: 'raw', host: fixture.host, port: fixture.port,
        logging: { enabled: false, path: fixture.logPath, timestamps: false } }, { name: 'Synthetic logging console', protocol: 'raw' });
      try {
        await until(() => ['connected', 'disconnected'].includes(consoleTab.state), 'synthetic raw console connection');
        assert(consoleTab.state === 'connected', 'Local synthetic console did not connect');
        const toggle = consoleTab.el.querySelector('button[role="switch"][aria-label="Log console to text file"]');
        assert(toggle && !toggle.disabled && toggle.getBoundingClientRect().width > 0, 'Visible logging switch is missing');
        const track = toggle.querySelector('.term-log-track');
        assert(track && toggle.getAttribute('aria-checked') === 'false' &&
          !(await api.invoke('conn:info', consoleTab.id)).logging, 'Fresh console logging must be off');
        assert(getComputedStyle(track).boxShadow === 'none', 'Logging indicator is lit before logging starts');
        toggle.click();
        await until(() => toggle.getAttribute('aria-checked') === 'true' && toggle.getAttribute('aria-busy') === 'false', 'logging switch on');
        const activeInfo = await api.invoke('conn:info', consoleTab.id);
        assert(activeInfo.logging === fixture.logPath && consoleTab.info.logging === activeInfo.logging,
          'Lit logging switch does not match the confirmed backend log file');
        assert(getComputedStyle(track).boxShadow !== 'none' && consoleTab.logState.textContent === 'On', 'Active logging indicator did not light up');
        assert(consoleTab.el.querySelector('.term-log-path').textContent === fixture.logPath, 'Confirmed log path is not visible');
        consoleTab.sendText(fixture.onMarker + '\r\n');
        await until(() => terminalContains(consoleTab, fixture.onMarker), 'echoed marker while logging is on');
        if (supportsCiscoHighlighting) {
          const ciscoToggle = consoleTab.el.querySelector('button.term-cisco-switch[role="switch"][aria-label="Highlight Cisco output"]');
          assert(ciscoToggle?.getAttribute('aria-checked') === 'true' && ciscoToggle.getBoundingClientRect().width > 0,
            'Cisco highlighting must be visible and enabled by default');
          assert(fixture.ciscoSample && fixture.ciscoMarker, 'Missing parent-owned Cisco output fixture');
          const rendered = () => [...consoleTab.el.querySelectorAll('.konx-cisco-highlight')].filter(element => element.getBoundingClientRect().width > 0);
          const hasKinds = () => ['error', 'down', 'up', 'ip'].every(kind => rendered().some(element => element.dataset.kind === kind));
          const paintedGlyphs = () => {
            const rows = [...consoleTab.wrap.querySelectorAll('.xterm-rows > div')];
            return [['192.0.2.16', 'rgb(103, 183, 255)'], ['up up', 'rgb(85, 217, 139)'],
              ['administratively down', 'rgb(255, 107, 107)'], ['% Invalid input', 'rgb(255, 107, 107)']].every(([text, color]) => {
              const row = rows.find(row => row.textContent.includes(text)); if (!row) return false;
              const start = row.textContent.indexOf(text);
              const colors = [...row.children].flatMap(span => Array(span.textContent.length).fill(getComputedStyle(span).color));
              return colors.slice(start, start + text.length).every((actual, index) => text[index] === ' ' || actual === color);
            });
          };
          consoleTab.sendText(fixture.ciscoSample);
          await until(() => terminalContains(consoleTab, fixture.ciscoMarker) && hasKinds() && paintedGlyphs(), 'packaged Cisco colored text glyphs');
          const text = () => Array.from({ length: consoleTab.term.buffer.active.length }, (_, i) => consoleTab.term.buffer.active.getLine(i)?.translateToString(true) || '').join('\n');
          const original = text(); consoleTab.term.selectAll(); const selection = consoleTab.term.getSelection(); consoleTab.term.clearSelection();
          assert(!selection.includes('\x1b') && selection.includes('192.0.2.16') && selection.includes('% Invalid input'),
            'Cisco colors changed copied console text');
          ciscoToggle.click(); await until(() => ciscoToggle.getAttribute('aria-checked') === 'false' && rendered().length === 0, 'packaged Cisco toggle off');
          assert(text() === original, 'Disabling Cisco colors changed the terminal buffer');
          ciscoToggle.click(); await until(() => ciscoToggle.getAttribute('aria-checked') === 'true' && hasKinds() && paintedGlyphs(), 'packaged Cisco toggle on');
          assert(text() === original, 'Enabling Cisco colors changed the terminal buffer');
          ciscoHighlighting = { rendered: true, paintedGlyphs: true, toggled: true, bufferUnchanged: true, copiedTextUnchanged: true };
        }
        toggle.click();
        await until(() => toggle.getAttribute('aria-checked') === 'false' && toggle.getAttribute('aria-busy') === 'false', 'logging switch off');
        assert(!(await api.invoke('conn:info', consoleTab.id)).logging && !consoleTab.info.logging,
          'Logging switch turned off before the backend stopped logging');
        assert(getComputedStyle(track).boxShadow === 'none' && consoleTab.logState.textContent === 'Off', 'Stopped logging indicator remained lit');
        consoleTab.sendText(fixture.offMarker + '\r\n');
        await until(() => terminalContains(consoleTab, fixture.offMarker), 'echoed marker while logging is off');
        logging = { path: fixture.logPath, switchedOn: true, switchedOff: true, litStateMatchesStatus: true, bothMarkersDisplayed: true };
      } finally {
        await api.invoke('conn:close', consoleTab.id);
        await app.closeTab(consoleTab);
      }
      assert(!app.byId.has(consoleTab.id), 'Synthetic console tab failed to close');
    }
    if (supportsCiscoHighlighting) await app.saveSettings({ terminalHighlighting: 'off' });
    if (supportsLayouts) {
      const originalTabs = [...app.tabs], theme = app.settings.uiTheme, palette = app.settings.colorScheme;
      for (const uiLayout of ['workbench', 'incident-desk', 'operations-wall', 'focus', 'classic']) {
        await app.saveSettings({ uiLayout });
        assert(app.workspaceLayout.get().layout === uiLayout, 'Packaged layout did not apply: ' + uiLayout);
        assert(originalTabs.every(tab => app.tabs.includes(tab) && app.byId.get(tab.id) === tab), 'Layout replaced an existing tool');
        assert(app.settings.uiTheme === theme && app.settings.colorScheme === palette, 'Layout changed theme or terminal palette');
      }
      await app.saveSettings({ uiLayout: 'focus' });
      assert(app.jobs.size === 0, 'Layout started a tool job');
    }
    if (supportsEvents) {
      assert((await api.invoke('tools:eventsList')).listeners.length === 0, 'Opening KonX started an event listener');
      const events = app.openTool('events'); await events.ready;
      assert(getComputedStyle(events.el.querySelector('.events-body')).display === 'grid' && getComputedStyle(events.el.querySelector('.events-table-scroll')).overflow === 'auto', 'Packaged Event Console styles are missing');
      assert(!events.jobId && !events.summary, 'Event console was not passive on open');
      events.address.value = '127.0.0.1'; events.port.value = options.events.port; await events.start();
      await until(() => events.summary?.state === 'listening', 'packaged event socket listening');
      await until(() => events.records.some(record => record.message === options.events.marker), 'packaged loopback syslog');
      const record = events.records.find(record => record.message === options.events.marker);
      assert(record.parseStatus === 'parsed' && record.source.address === '127.0.0.1' && record.severity === 6, 'Packaged syslog fields are incorrect');
      events.select(record, true); events.detailSequence = record.sequence; events.renderDetails();
      assert(events.report?.selectedRecords.some(item => item.message === options.events.marker), 'Selected event evidence is missing');
      assert(events.updateBlockers().length > 0, 'Running event socket does not block update');
      const { toolContext } = await import('./js/tool-context.mjs');
      assert(!toolContext(events).includes(options.events.marker), 'Event AI summary included payload');
      assert(await events.stop(), 'Packaged listener did not close'); await until(() => app.jobs.size === 0, 'event job cleanup');
      assert(!(await api.invoke('tools:eventsSnapshot', events.listenerId)).hasOwnership, 'Stopped socket ownership remained');
      await api.invoke('tools:eventsClear', events.listenerId); assert((await api.invoke('tools:eventsSnapshot', events.listenerId)).records.length === 0, 'Clear event history failed');
      await app.closeTab(events);
      liveEvents = { explicitStart: true, realLoopbackSyslog: true, parsedDetails: true, selectedEvidence: true, summaryOnlyAI: true, stoppedAndCleared: true };
    }
    let deviceInspector = null;
    let deviceSnapshots = null;
    let rtpMedia = null;
    let incidentWorkspace = null;
    let remoteCapture = null;
    let runbooks = null;
    let captureComparison = null;
    const changeEvidence = [];
    if (supportsComparison) {
      assert(TOOLS.some(tool => tool.kind === 'capture-compare'), 'Capture Comparison tool is missing');
      const comparison = app.openTool('capture-compare'); await comparison.ready; await comparison.loadDemo();
      assert(comparison.report?.summary.matchedServices === 2 && comparison.report.summary.changed >= 8, 'Packaged working/failing demo did not compare');
      assert(comparison.sources.before.packets.length === 11 && comparison.sources.after.packets.length === 11, 'Demo source packets were not retained');
      assert(['dns', 'tcp', 'http'].every(category => comparison.report.changes.some(row => row.category === category && row.status === 'changed')), 'Expected DNS/TCP/HTTP observations are missing');
      assert(comparison.aiContext && !Object.hasOwn(comparison.aiContext, 'changes') && !Object.hasOwn(comparison.aiContext, 'packets'), 'Comparison AI context must contain only its summary');
      const row = comparison.report.changes.find(item => item.category === 'http' && item.status === 'changed' && item.afterSources.length);
      assert(row, 'HTTP source-frame evidence is missing');
      await comparison.openSource('after', row.afterSources[0].frame);
      const evidence = app.active;
      assert(evidence.kind === 'capture' && evidence.packets.length === 11 && evidence.captureCoverage?.examinedAllRecords === true, 'Retained comparison source did not open with coverage');
      await app.closeTab(evidence);
      captureComparison = { matchedServices: comparison.report.summary.matchedServices, changes: comparison.report.summary.changed,
        dnsTcpHttp: true, retainedSourceOpened: true, summaryOnlyAI: true, noNetworkCollection: app.jobs.size === 0 };
      if (supportsChangeValidation) changeEvidence.push({ label: 'Reviewed offline capture comparison', report: structuredClone(comparison.report) });
      await app.closeTab(comparison); assert(!app.byId.has(comparison.id), 'Comparison tab failed to close');
    }
    if (supportsRunbooks) {
      assert(TOOLS.some(tool => tool.kind === 'runbook'), 'Troubleshooting Runbooks tool is missing');
      const runbook = app.openTool('runbook'); await runbook.ready;
      assert(runbook.templates.length === 3 && runbook.saved.length === 0 && app.jobs.size === 0, 'Built-in runbooks are missing or started automatically');
      const definition = { schemaVersion: 1, name: 'Synthetic package smoke procedure', inputs: [], steps: [
        { id: 'review', title: 'Review synthetic evidence', kind: 'checklist', instructions: 'Manual evidence remains unknown.' }
      ] };
      const saved = await api.invoke('tools:runbookSave', { definition });
      await runbook.refresh(); await runbook.select('saved:' + saved.id);
      assert(runbook.definition.name === definition.name && !runbook.isDirty(), 'Saved procedure did not load cleanly');
      await runbook.start(); await until(() => !runbook.jobId && runbook.report, 'packaged manual procedure');
      assert(runbook.report.complete && runbook.report.steps.length === 1 && runbook.report.steps[0].status === 'unknown', 'Manual procedure invented a passing observation');
      assert(runbook.updateBlockers().length === 0, 'Saved idle runbook still blocks updating');
      if (supportsChangeValidation) changeEvidence.push({ label: 'Reviewed manual procedure result', report: structuredClone(runbook.report) });
      await app.closeTab(runbook); assert(!app.byId.has(runbook.id), 'Saved idle runbook failed to close');
      runbooks = { templates: 3, customDefinitionSaved: true, manualObservationUnknown: true, noNetworkCollection: true };
    }
    if (supportsRemoteCapture) {
      assert(TOOLS.some(tool => tool.kind === 'remote-capture'), 'Remote Capture tool is missing');
      const remote = app.openTool('remote-capture'); await remote.ready;
      assert(remote.connections.length === 0 && remote.startButton.disabled && !remote.jobId, 'Remote capture must require a connected session and explicit start');
      assert(!remote.report && remote.openButton.disabled && remote.deleteButton.disabled, 'Fresh remote tool exposed a retained result');
      assert(remote.updateBlockers().length === 0 && app.jobs.size === 0, 'Idle remote tool blocks updates or started a job');
      let rejected = false;
      try { await api.invoke('tools:remoteCaptureRead', 'unknown-result'); } catch { rejected = true; }
      assert(rejected, 'Remote capture reader accepted an unknown result');
      await app.closeTab(remote);
      assert(!app.byId.has(remote.id), 'Idle remote tab failed to close');
      remoteCapture = { explicitStartRequired: true, unknownResultRejected: true, noNetworkCollection: true };
    }
    if (supportsDeviceInspector) {
      assert(TOOLS.some((tool) => tool.kind === 'device'), 'Device Inspector entry is missing');
      const device = app.openTool('device');
      await device.ready;
      assert(!device.report && !device.jobId && app.jobs.size === 0, 'Device Inspector must not automatically collect SSH output');
      await device.load('tools:deviceDemo');
      assert(device.report?.devices.length === 2, 'Packaged Device Inspector demo is unavailable: ' + device.status.textContent);
      assert(device.report.devices.every((entry) => entry.facts.interfaces.length > 0 && entry.facts.mac.length > 0), 'Packaged Cisco demo facts are missing');
      device.query.value = '192.0.2.100'; await device.find();
      assert(device.trace?.matches.length >= 2 && device.trace.paths.length >= 1, 'Packaged endpoint trace did not connect the synthetic switches');
      assert(device.traceResults.querySelector('.device-match button'), 'Packaged endpoint evidence controls are missing');
      deviceInspector = { demoDevices: device.report.devices.length, endpointMatches: device.trace.matches.length, paths: device.trace.paths.length, noNetworkCollection: !device.jobId };
      if (supportsTopology) {
        device.topologyButton.click();
        const map = app.tabs.find(tab => tab.toolKind === 'topology'); assert(map, 'Device Inspector topology action is missing'); await map.ready;
        assert(map.report?.nodes.length === 2 && map.report.links.length === 2 && app.jobs.size === 0, 'Topology did not reuse captured device evidence');
        map.query.value = '192.0.2.100'; await map.rebuild();
        assert(map.report.endpoint.matches.length >= 2 && map.report.nodes.some(node => node.kind === 'endpoint'), 'Topology endpoint overlay is missing');
        const link = map.report.links.find(link => link.kind === 'neighbor'); map.select('link', link.id);
        assert(map.detail.textContent.includes('Source evidence') && map.detail.querySelector('button'), 'Topology selection evidence is missing');
        map.openInspector(link.evidence[0].deviceId, link.evidence[0]);
        const inspector = app.tabs.find(tab => tab.toolKind === 'device' && tab !== device);
        assert(inspector?.evidence.open && inspector.raw.textContent.includes('Device ID'), 'Topology command evidence did not open in Device Inspector');
        const { toolContext } = await import('./js/tool-context.mjs');
        assert(!toolContext(map).includes('192.0.2.100') && toolContext(map).includes('nodeCount'), 'Topology AI context leaked raw evidence');
        visualTopology = { reusedInspectorEvidence: true, clickableLinks: true, endpointOverlay: true, sourceInspector: true, summaryOnlyAI: true, noNetworkCollection: app.jobs.size === 0 };
        await app.closeTab(inspector); await app.closeTab(map);
      }
      await app.closeTab(device);
      assert(!app.byId.has(device.id) && app.jobs.size === 0, 'Device Inspector smoke did not close cleanly');
    }
    if (supportsSnapshots) {
      assert(TOOLS.some((tool) => tool.kind === 'snapshots'), 'Device Snapshots entry is missing');
      const snapshots = app.openTool('snapshots'); await snapshots.ready;
      assert(snapshots.snapshots.length === 0, 'Fresh smoke profile unexpectedly contains device snapshots');
      await snapshots.loadDemo();
      assert(snapshots.report?.kind === 'device-snapshot-comparison' && snapshots.report.devices.length === 2 && snapshots.report.changes.length > 0,
        'Packaged snapshot demo comparison failed: ' + snapshots.status.textContent);
      assert(snapshots.report.changes.some((change) => change.category === 'configuration'), 'Packaged configuration comparison is missing');
      assert(snapshots.report.changes.some((change) => change.category === 'routes'), 'Packaged route comparison is missing');
      assert(snapshots.aiContext?.summary && !Object.hasOwn(snapshots.aiContext, 'changes'), 'Snapshot AI context must contain a summary without changed values');
      const saved = await api.invoke('tools:snapshotList');
      assert(saved.snapshots.length === 2 && saved.issues.length === 0, 'Demo snapshots were not stored correctly');
      if (supportsTopology) {
        await snapshots.open(saved.snapshots[0].id, 'topology'); const map = app.tabs.find(tab => tab.toolKind === 'topology'); await map.ready;
        assert(map.report.nodes.length >= 2 && !map.report.sourceReport, 'Saved snapshot topology is missing or embeds raw evidence in the graph');
        visualTopology.savedSnapshotOpened = true; await app.closeTab(map);
      }
      deviceSnapshots = { savedSnapshots: saved.snapshots.length, comparedDevices: snapshots.report.devices.length, changes: snapshots.report.changes.length,
        configurationAndRoutesCompared: true, aiSummaryOnly: true, noNetworkCollection: app.jobs.size === 0 };
      await app.closeTab(snapshots);
      assert(!app.byId.has(snapshots.id) && app.jobs.size === 0, 'Snapshot smoke did not close cleanly');
    }
    if (supportsRtp) {
      const { makeRtpDemo } = await import('./js/capture/sample-rtp.mjs');
      const { analyzeSipCalls } = await import('./js/capture/sip.mjs');
      const { analyzeRtp, buildRtpAudio, encodeWav } = await import('./js/capture/rtp.mjs');
      const capture = app.openTool('capture'), demo = makeRtpDemo();
      await capture.loadBytes(demo.bytes, demo.name);
      const sip = analyzeSipCalls(capture.packets), media = analyzeRtp(capture.packets, { sipCalls: sip.calls });
      assert(capture.packets.length === 401 && sip.calls.length === 1 && media.streams.length === 2, 'Packaged RTP demo did not decode');
      assert(media.streams.some(stream => stream.sequenceGaps === 3 && stream.outOfOrderPackets === 1 && stream.duplicatePackets === 1), 'Packaged RTP capture findings are missing');
      const audio = buildRtpAudio(media.streams[0]), wav = encodeWav(audio);
      assert(audio.samples.length === 32000 && wav.length === 64044, 'Packaged G.711 WAV reconstruction failed');
      const opened = capture.openRtpMedia();
      await until(() => document.querySelector('.rtp-workspace'), 'packaged RTP viewer');
      assert(document.querySelectorAll('.rtp-stream').length === 2, 'Packaged RTP stream list is missing');
      [...document.querySelectorAll('.rtp-workspace button')].find(button => button.textContent === 'Build waveform').click();
      assert(document.querySelector('.rtp-wave') && document.querySelector('.rtp-silence'), 'Packaged audio waveform or gap markers are missing');
      document.querySelector('.modal > header .x').click(); await opened;
      assert(!document.querySelector('.rtp-workspace'), 'Packaged RTP viewer failed to close');
      rtpMedia = { packets: capture.packets.length, calls: sip.calls.length, streams: media.streams.length, rtcp: media.rtcp.length,
        samples: audio.samples.length, wavBytes: wav.length, waveformAndGaps: true, noPlayback: true, noNetworkCollection: app.jobs.size === 0 };
      await app.closeTab(capture);
    }
    if (supportsIncidents) {
      assert(TOOLS.some(tool => tool.kind === 'incidents'), 'Incident Workspace tool is missing');
      const incidents = app.openTool('incidents'); await incidents.ready;
      assert(incidents.incidents.length === 0, 'Fresh smoke profile unexpectedly contains incidents');
      const created = await api.invoke('tools:incidentCreate', { title: 'Synthetic package smoke incident', description: 'Offline evidence persistence fixture' });
      await incidents.refresh(created.id);
      incidents.noteText.value = 'Synthetic observation: audio gap seen in a local sample.';
      incidents.noteLabel.value = 'Package smoke note'; await incidents.addText();
      assert(incidents.report.evidence.length === 1 && incidents.report.timeline[0].observedAt === null, 'Untimed note must stay unknown');
      const { makeRtpDemo } = await import('./js/capture/sample-rtp.mjs');
      const demo = makeRtpDemo();
      incidents.acceptIncident(await api.invoke('tools:incidentAddCapture', created.id, { bytes: demo.bytes, label: demo.name }));
      assert(incidents.report.evidence.length === 2 && incidents.report.evidence.find(item => item.kind === 'note').integrity === 'verified', 'Text evidence copy was not verified');
      assert(incidents.report.evidence.find(item => item.kind === 'capture').integrity === 'not-checked', 'Binary integrity should remain unknown until read');
      assert(incidents.aiContext.evidenceCount === 2 && !Object.hasOwn(incidents.aiContext, 'evidence'), 'Incident AI context must exclude raw evidence');
      incidentWorkspace = { savedEvidence: 2, unknownNoteTimePreserved: true, captureCopied: true, summaryOnlyAI: true, noNetworkCollection: app.jobs.size === 0 };
      await app.closeTab(incidents);
    }
    if (supportsChangeValidation) {
      assert(TOOLS.some(tool => tool.kind === 'change-validation'), 'Guided Change Validation tool is missing');
      const history = await api.invoke('tools:snapshotList'), library = await api.invoke('tools:incidentList');
      const before = history.snapshots.find(item => item.label === 'Demo before change'), after = history.snapshots.find(item => item.label === 'Demo after change');
      const incident = library.incidents.find(item => item.title === 'Synthetic package smoke incident');
      assert(before && after && incident && changeEvidence.length === 2, 'Change validation needs its owned snapshot, incident and completed report fixtures');
      const terminals = app.tabs.filter(tab => ['terminal', 'sftp'].includes(tab.kind)).length;
      const validation = app.openTool('change-validation'); await validation.ready;
      assert(validation.records.length === 0 && !validation.record && !validation.isDirty() && app.jobs.size === 0, 'Opening change validation started work or found unexpected records');
      const input = (element, value, event = 'input') => { element.value = value; element.dispatchEvent(new Event(event, { bubbles: true })); };
      input(validation.fields.name, changeName); input(validation.fields.scope, changeScope);
      input(validation.fields.expectedOutcome, 'Review saved before/after observations without an automatic health verdict.');
      input(validation.fields.rollbackPlan, 'Manual rollback remains outside this offline fixture.');
      await validation.savePlan(); assert(validation.record?.phase === 'plan' && !validation.isDirty(), 'Packaged validation plan did not save cleanly');
      await validation.advance(); assert(validation.record.phase === 'baseline', 'Baseline requires explicit advancement: ' + validation.status.textContent);
      input(validation.before, before.id, 'change'); await validation.saveSources();
      assert(validation.record.sources.beforeId === before.id && validation.record.sources.afterId === null, 'Baseline source was not retained independently');
      await validation.advance(); assert(validation.record.phase === 'maintenance', 'Manual maintenance phase is missing');
      input(validation.maintenanceText, changeMaintenance); validation.maintenanceCheck.click();
      assert(validation.isDirty() && validation.updateBlockers().length > 0, 'Uncommitted acknowledgment is not protected');
      await validation.advance(); assert(validation.record.phase === 'after' && validation.record.maintenance.reason === changeMaintenance && !validation.isDirty(), 'Explicit acknowledgment did not advance cleanly');
      input(validation.after, after.id, 'change'); await validation.saveSources(); await validation.compare();
      assert(validation.record.comparison?.report?.changes.length > 0 && validation.record.decisions.every(item => item.status === 'unknown' && !item.reviewedAt), 'Stored comparison invented a health decision');
      for (const item of changeEvidence) {
        validation.accept(await api.invoke('tools:changeAddEvidence', validation.record.id, validation.record.revision,
          { label: item.label, phase: 'after', report: item.report, reviewed: true }));
      }
      assert(validation.record.evidence.length === 2 && changeEvidence.every((item, index) => JSON.stringify(validation.record.evidence[index].report) === JSON.stringify(item.report)), 'Reviewed tool reports were truncated or changed');
      await validation.advance(); assert(validation.record.phase === 'review', 'Review was not reached explicitly');
      for (const check of validation.plan.checks) {
        input(validation.el.querySelector(`[aria-label="Decision for ${check.id}"]`), 'unknown', 'change');
        input(validation.el.querySelector(`[aria-label="Rationale for ${check.id}"]`), changeRationale);
        const refs = validation.el.querySelector(`[aria-label="Evidence for ${check.id}"]`);
        for (const option of refs.options) option.selected = option.value === validation.record.comparison.id;
        refs.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await validation.saveDecisions();
      assert(validation.record.decisions.every(item => item.status === 'unknown' && item.reviewedAt && item.rationale === changeRationale && item.sourceRefs[0] === validation.record.comparison.id), 'Explicit Unknown decisions and evidence references were not saved');
      const preview = await api.invoke('tools:changePreview', validation.record.id, validation.record.revision), report = JSON.parse(preview.text);
      assert(preview.revision === validation.record.revision && report.assessment === 'unknown' && JSON.stringify(report.workflow) === JSON.stringify(validation.record), 'Reviewed full report does not match the saved revision');
      const copied = await api.invoke('tools:changeAddToIncident', validation.record.id, preview.revision, incident.id);
      const copiedIncident = await api.invoke('tools:incidentGet', incident.id), retained = copiedIncident.evidence.find(item => item.kind === 'tool');
      assert(copied.copied && copied.evidenceCount === 3 && retained?.integrity === 'verified' && retained.bytes === new TextEncoder().encode(preview.text).length, 'Complete report was not copied to the existing incident');
      const { toolContext } = await import('./js/tool-context.mjs'); const context = toolContext(validation);
      assert(context.includes('change-validation-summary') && context.includes('checkCount') && ![changeScope, changeMaintenance, changeRationale, before.id, after.id].some(text => context.includes(text)), 'Change validation AI context exposed source identities or notes');
      app.activate(security); assert(!validation.el.classList.contains('active') && getComputedStyle(validation.el).display === 'none', 'Inactive validation overrides installed view visibility');
      assert(!validation.isDirty() && validation.updateBlockers().length === 0 && app.jobs.size === 0 && app.tabs.filter(tab => ['terminal', 'sftp'].includes(tab.kind)).length === terminals, 'Passive workflow created work or retained a phantom draft');
      const saved = validation.record; await app.closeTab(validation); assert(!app.byId.has(validation.id), 'Clean validation did not close');
      incidentWorkspace.savedEvidence = 3;
      changeValidation = { savedId: saved.id, revision: saved.revision, phase: saved.phase, evidenceCount: saved.evidence.length,
        manualAcknowledgment: true, canonicalComparison: true, fullReviewedCopies: true, explicitUnknownDecisions: true,
        previewMatchesRevision: true, incidentCopied: true, inactiveViewHidden: true, summaryOnlyAI: true, closedCleanly: true, noAutomaticJobs: true };
    }
    assert(!mist.config.hasToken && mist.testButton.disabled, 'Fresh profile must have no API token');
    app.activate(security);
    security.audit.value = 'config';
    security.audit.dispatchEvent(new Event('change'));
    security.host.value = 'Synthetic package smoke fixture';
    security.config.value = 'version 17.1\nhostname konx-smoke\nip ssh version 2\nusername fixture-user password 0 SYNTHETIC_CONFIG_SECRET\nline vty 0 4\n transport input telnet ssh\n';
    security.runButton.click();
    await until(() => security.state === 'idle' && !security.jobId, 'offline configuration assessment');
    assert(security.report, 'Packaged assessment produced no report: ' + security.status.textContent);
    const report = validateReport(security.report);
    assert(report.kind === 'config' && report.checks.length >= 5, 'Packaged offline rules were not loaded');
    assert(report.checks.some((check) => ['warning', 'fail'].includes(check.status)), 'Unsafe synthetic settings were not detected');
    assert(report.checks.some((check) => check.status === 'unknown'), 'Missing fixture settings must remain unknown');
    const json = exportReport(report, 'json'), html = exportReport(report, 'html');
    assert(JSON.parse(json).checks.length === report.checks.length && html.includes('<!doctype html>'), 'Assessment export failed');
    assert(!json.includes('SYNTHETIC_CONFIG_SECRET') && !html.includes('SYNTHETIC_CONFIG_SECRET') && !json.includes('fixture-user'), 'Assessment exposed fixture credentials');
    assert(!security.jsonButton.disabled && !security.htmlButton.disabled, 'Assessment export controls remain disabled');
    if (supportsWorkspaceWindows) {
      const workspace = app.workspaceLayout, node = security.el, originalReport = security.report;
      const source = security.config.value, originalTabs = [...app.tabs];
      assert(app.jobs.size === 0 && app.popouts.entries.size === 0, 'Workspace smoke requires idle tools and no existing popouts');
      assert(workspace.float(security, { x: 40, y: 30, width: Math.min(600, app.views.clientWidth - 80),
        height: Math.min(420, app.views.clientHeight - 60) }), 'Packaged report did not float');
      const floating = workspace.floating.get(security);
      assert(floating?.body.contains(node) && floating.el.getBoundingClientRect().width > 0 && workspace.placement(security) === 'floating',
        'Packaged floating panel did not contain the existing report');
      await workspace.saveGeometry;
      const geometry = workspace.get().geometry;
      assert(await app.popouts.open(security), 'Packaged report did not open in a native window');
      const entry = app.popouts.entries.get(security.id), child = entry?.window;
      assert(child && child !== window && !child.closed && child.opener === window && workspace.placement(security) === 'external',
        'Pop-out did not create an owned child window');
      await until(() => node.ownerDocument === child.document && node.getBoundingClientRect().width > 0 &&
        child.document.querySelector('[aria-label="Dock back to KonX"]')?.getBoundingClientRect().width > 0, 'visible packaged pop-out report');
      assert(security.report === originalReport && security.config.value === source && app.byId.get(security.id) === security &&
        originalTabs.length === app.tabs.length && originalTabs.every(tab => app.tabs.includes(tab)), 'Pop-out replaced the report, inputs or tab');
      child.document.querySelector('[aria-label="Dock back to KonX"]').click();
      await until(() => child.closed && app.popouts.entries.size === 0 && app.popouts.closing.size === 0 &&
        app.popouts.pending.size === 0 && workspace.placement(security) === 'docked', 'packaged native close acknowledgement');
      assert(security.el === node && node.ownerDocument === document && security.report === originalReport && security.config.value === source,
        'Docking changed the original report or its input');
      assert(app.jobs.size === 0 && !security.jobId, 'Floating or popping out a report started a job');
      await workspace.saveGeometry;
      assert(JSON.stringify((await api.invoke('settings:get')).workspaceGeometry) === JSON.stringify(geometry), 'Workspace geometry did not reach persistent settings');
      workspaceWindows = { floated: true, nativePopout: true, docked: true, nativeCloseAcknowledged: true,
        originalTabAndNodeRetained: true, reportAndInputRetained: true, noAutomaticJobs: true, geometrySaved: true, geometry };
    }
    app.activate(mist);
    await until(() => !mist.configBusy && !mist.saveButton.disabled, 'Mist settings after tab activation');
    mist.token.value = options.token;
    mist.saveButton.click();
    await until(() => !mist.configBusy, 'synthetic Mist credential save');
    assert(mist.config.hasToken, 'Synthetic Mist token was not encrypted and saved: ' + mist.status.textContent);
    assert(mist.token.value === '' && !mist.testButton.disabled && !mist.forgetButton.disabled, 'Mist controls did not update after saving');
    const publicConfig = await api.invoke('tools:mistConfig');
    assert(publicConfig.hasToken && !JSON.stringify(publicConfig).includes(options.token) && !Object.hasOwn(publicConfig, 'tokenEnc'), 'Mist settings exposed credential material');
    app.activate(ai);
    await until(() => !ai.configBusy, 'AI settings after activation');
    ai.provider.value = 'nyquest'; ai.provider.dispatchEvent(new Event('change'));
    ai.key.value = options.token; ai.saveButton.click();
    await until(() => !ai.configBusy, 'synthetic AI credential save');
    assert(ai.config.provider === 'nyquest' && ai.config.hasKey && ai.key.value === '', 'AI credential was not saved securely');
    assert(!JSON.stringify(await api.invoke('tools:aiConfig')).includes(options.token), 'AI settings exposed a saved key');
    ai.context.value = 'RSSI -67 dBm\npassword=synthetic_context_secret'; ai.context.dispatchEvent(new Event('input'));
    await ai.previewContext();
    assert(!ai.preview.textContent.includes('synthetic_context_secret') && ai.preview.textContent.includes('Redacted'), 'AI preview did not redact the test secret');
    assert(!ai.shareContext.checked && !ai.shareContext.disabled, 'Context must require explicit selection after preview');
    if (supportsAiContextSafety) {
      const { toolContext } = await import('./js/tool-context.mjs');
      for (const offset of [3976, 23780]) {
        const context = toolContext({ title: 'Synthetic boundary report', report: { message: 'x'.repeat(offset) + options.token + ' terminal marker' } });
        const preview = await api.invoke('tools:aiPreview', { context });
        assert(preview.context.length <= 24000 && !preview.context.includes(options.token.slice(0, 24)), 'A configured key fragment survived context shortening');
      }
      const omitted = await api.invoke('tools:aiPreview', { context: toolContext({ title: 'Synthetic oversized report', report: { observations: Array.from({ length: 160 }, (_, index) => ({ index, value: 'observation' })) } }) });
      assert(/omit|limit|truncat/i.test(omitted.context), 'The prepared context silently omitted observations');
      const draft = app.openTool('ai'); await until(() => !draft.configBusy && draft.config, 'AI draft settings');
      draft.question.value = 'Unsent synthetic investigation'; draft.question.dispatchEvent(new Event('input'));
      draft.context.value = 'Synthetic selected evidence'; draft.context.dispatchEvent(new Event('input'));
      draft.editDocument(null); draft.noteTitle.value = 'Unfinished synthetic note'; draft.noteTitle.dispatchEvent(new Event('input'));
      draft.noteContent.value = 'Retain this draft when closing is cancelled.'; draft.noteContent.dispatchEvent(new Event('input'));
      assert(draft.updateBlockers().length > 0, 'AI drafts did not block updating');
      const closing = app.closeTab(draft); await until(() => !!document.querySelector('.modal'), 'AI draft close confirmation');
      serialFooter('Cancel'); await closing;
      assert(app.byId.has(draft.id) && draft.question.value === 'Unsent synthetic investigation' && draft.context.value === 'Synthetic selected evidence' && draft.noteContent.value.includes('Retain this draft'), 'Cancelled close discarded AI input');
      const discard = app.closeTab(draft); await until(() => !!document.querySelector('.modal'), 'AI draft discard confirmation');
      const discardButton = [...document.querySelectorAll('.modal footer button')].find(button => /discard/i.test(button.textContent));
      assert(discardButton, 'AI close confirmation has no explicit discard action'); discardButton.click(); await discard;
      assert(!app.byId.has(draft.id) && app.jobs.size === 0, 'Confirmed AI draft close retained a tab or started work');
      aiContextSafety = { wholeTextRedaction: true, explicitOmissions: true, draftUpdateBlocker: true, cancelledCloseRetainsInput: true, explicitDiscard: true, noProviderRequests: true };
      app.activate(ai);
    }
    if (supportsCopilot) {
      const priorLayout = app.workspaceLayout.model.layout;
      await app.saveSettings({ uiLayout: 'workbench' });
      const source = app.openTool('subnet', { input: '192.0.2.37/26' });
      const panel = await app.explainTool(source), controller = app.copilot;
      assert(panel && app.byId.get(panel.id) === panel && controller.conversation?.attachments.length === 1, 'Copilot did not attach typed source evidence');
      assert(app.workspaceLayout.get().primaryId === source.id && app.workspaceLayout.get().companionId === panel.id, 'Copilot replaced the source instead of using the companion pane');
      controller.applyConversation(await api.invoke('tools:copilotRename', controller.conversation.id, controller.conversation.revision, 'Synthetic package Copilot'), { retainDraft: true });
      controller.selectKnowledge(true); await controller.prepare();
      const preparation = controller.prepared;
      assert(preparation && panel.requestBody.textContent === preparation.body && preparation.body.includes('192.0.2.37/26'), 'Exact request preview omitted source facts');
      assert(!preparation.body.includes(options.token) && app.jobs.size === 0, 'Preparation exposed credentials or started a provider request');
      source.input.value = '198.51.100.1/24'; source.calc();
      assert(controller.prepared === preparation && preparation.body.includes('192.0.2.37/26') && !preparation.body.includes('198.51.100.1/24'), 'Source changes silently rewrote the reviewed request');
      assert(controller.changedSources.size === 1, 'Changed source did not mark the saved evidence stale');
      const node = panel.el;
      for (const layout of ['classic', 'workbench', 'incident-desk', 'operations-wall', 'focus']) {
        await app.saveSettings({ uiLayout: layout }); app.workspaceLayout.float(panel); app.activate(source); app.activate(panel);
        assert(app.workspaceLayout.visible.has(source) && panel.el === node && controller.prepared === preparation, 'Layout movement replaced the source, conversation, or request');
      }
      assert(await app.popouts.open(panel), 'Copilot native pop-out failed');
      assert(panel.el === node && panel.el.ownerDocument !== document && controller.prepared === preparation, 'Pop-out replaced the conversation view');
      await app.popouts.dock(panel); assert(panel.el === node && node.ownerDocument === document, 'Dock back lost the canonical Copilot view');
      assert(controller.updateBlockers().length > 0, 'Unsent Copilot draft did not block updates');
      const closing = app.closeTab(panel); await until(() => !!document.querySelector('.modal'), 'Copilot close review'); serialFooter('Keep draft'); await closing;
      assert(app.byId.has(panel.id) && controller.prepared === preparation, 'Cancelled close discarded the reviewed request');
      const discard = app.closeTab(panel); await until(() => !!document.querySelector('.modal'), 'Copilot explicit discard'); serialFooter('Discard draft'); await discard;
      assert(!app.byId.has(panel.id) && app.jobs.size === 0, 'Copilot close retained a tab or started work');
      if (versionParts[1] >= 24) {
        const editor = await app.openNotepad();
        const doc = editor.newDoc({ title: 'Copilot fixture', text: 'Selected synthetic editor evidence\nDo not collect this second line' });
        editor.editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 35 });
        await app.openCopilot(editor);
        const before = doc.model.getValue(), count = controller.conversation.attachments.length;
        assert(!panel.attachButton.disabled, 'Current editor attachment button is unavailable');
        const attach = controller.attachCurrentView();
        await until(() => document.querySelector('[aria-label="Evidence to attach"]'), 'explicit workspace evidence picker');
        document.querySelector('[aria-label="Evidence to attach"]').value = 'selection'; serialFooter('Attach evidence'); await attach;
        const added = controller.conversation.attachments.at(-1);
        assert(controller.conversation.attachments.length === count + 1 && added.snapshot.kind === 'notepad' && JSON.stringify(added).includes('Selected synthetic editor evidence') && !JSON.stringify(added).includes('Do not collect this second line'), 'Explicit editor selection was not isolated');
        assert(doc.model.getValue() === before && app.jobs.size === 0, 'Attaching editor evidence changed content or started a request');
        const closingWorkspace = app.closeTab(panel); await until(() => document.querySelector('.modal'), 'discard workspace attachment selection'); serialFooter('Discard draft'); await closingWorkspace;
        for (const item of editor.docs) item.dirty = false;
        await app.closeTab(editor);
      }
      if (versionParts[1] >= 25) {
        await app.openCopilot(security);
        assert(security.copilotButton && !panel.attachButton.disabled, 'Packaged traffic Copilot entry is unavailable');
        const snapshot = security.captureCopilotContext({ choice: 'assessment' });
        await controller.attach(snapshot); const attachment = controller.conversation.attachments.at(-1);
        assert(attachment.snapshot.kind === 'security' && attachment.snapshot.facts.rows.length === security.report.checks.length && app.jobs.size === 0, 'Retained assessment facts were not attached passively');
        await controller.detach(attachment.id); await app.closeTab(panel);
      }
      if (versionParts[1] >= 26) {
        const investigation = app.openTool('change-validation', { validationId: changeValidation.savedId }); await investigation.ready;
        assert(investigation.record?.id === changeValidation.savedId && !investigation.isDirty(), 'Retained validation could not reopen for Copilot');
        await app.openCopilot(investigation);
        assert(investigation.copilotButton && !panel.attachButton.disabled, 'Packaged investigation Copilot entry is unavailable');
        const snapshot = investigation.captureCopilotContext({ choice: 'saved-plan' });
        await controller.attach(snapshot); const attachment = controller.conversation.attachments.at(-1);
        assert(attachment.snapshot.kind === 'change-validation' && attachment.snapshot.facts.rows[0].plan.name === changeName && attachment.snapshot.facts.rows[0].decisions.every(item => item.status === 'unknown') && app.jobs.size === 0, 'Saved investigation evidence or manual decisions did not survive passive attachment');
        controller.focusSource(attachment); assert(app.active === investigation, 'Investigation source link did not open its canonical view');
        await controller.detach(attachment.id); await app.closeTab(panel); await app.closeTab(investigation);
      }
      await app.closeTab(source); await app.saveSettings({ uiLayout: priorLayout }); app.activate(ai);
      copilotChecks = { typedSource: true, companionPreservesSource: true, exactRequestReview: true, immutableStaleSnapshot: true, fiveLayouts: true, nativePopoutAndDock: true,
        canonicalViewRetained: true, draftGuard: true, conversationSaved: true, noProviderRequests: true,
        ...(versionParts[1] >= 26 ? { retainedInvestigationAttached: true, manualDecisionsPreserved: true, investigationSourceOpened: true } : {}) };
    }
    if (versionParts[1] >= 27) {
      const record = (await api.invoke('tools:copilotList')).conversations.find(item => item.name === 'Synthetic package reviewed actions');
      const panel = await app.openCopilot(); const controller = app.copilot;
      await controller.selectConversation(record.id); const actions = controller.actions;
      const choose = async kind => { await actions.selectTurn(controller.conversation.turns[0]); actions.setKind(kind); };
      await choose('diagnostic.ping'); actions.setParam('host', '127.0.0.1'); actions.setParam('count', 1);
      await actions.prepare();
      assert(actions.preview?.params.host === '127.0.0.1' && actions.preview.params.count === 1 && controller.conversation.actions.length === 0 && app.jobs.size === 0, 'Action preparation caused an effect or changed its target');
      await actions.execute(); await until(() => !actions.jobId, 'reviewed loopback Ping');
      assert(controller.conversation.actions.at(-1).status === 'succeeded' && controller.conversation.actions.at(-1).result.observations.length > 0, 'Packaged reviewed diagnostic failed');
      await choose('note.saveAnswer'); actions.setParam('title', 'Synthetic package reviewed note'); await actions.prepare();
      const reviewedNote = actions.preview?.preview.article;
      assert(reviewedNote?.content, 'Exact local note was not reviewed');
      await actions.execute(); await until(() => !actions.jobId, 'reviewed local note');
      const noteAction = controller.conversation.actions.at(-1), savedNote = await api.invoke('tools:knowledgeGet', noteAction.result.articleId);
      assert(noteAction.status === 'succeeded' && savedNote.content === reviewedNote.content, 'Saved note differs from its exact preview');
      const editor = await app.openNotepad(), doc = editor.newDoc({ title: 'Reviewed edit fixture', text: 'before fixture\nretained second line' });
      editor.editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 15 });
      await app.openCopilot(editor); await choose('editor.replaceSelection'); actions.editorSelect.value = editor.id; actions.editorSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await actions.captureEditor(); assert(actions.draft?.target?.beforeText === 'before fixture', 'Editor selection was not captured: ' + actions.message); actions.setParam('replacement', 'after fixture');
      await actions.prepare(); assert(actions.preview?.preview.before === 'before fixture' && doc.model.getValue().startsWith('before fixture'), 'Editor changed before exact review');
      await actions.execute(); await until(() => !actions.jobId, 'reviewed editor replacement');
      assert(controller.conversation.actions.at(-1).status === 'succeeded' && doc.model.getValue() === 'after fixture\nretained second line', 'Packaged editor bridge did not apply the reviewed selection');
      editor.editor.trigger('package-smoke', 'undo', {}); assert(doc.model.getValue() === 'before fixture\nretained second line', 'Reviewed edit did not undo in one step');
      for (const item of editor.docs) item.dirty = false;
      await app.closeTab(editor); await app.closeTab(panel);
      copilotChecks.reviewedActions = { boundedLoopbackPing: true, exactLocalNote: true, editorBridge: true, oneUndo: true, noAutomaticProviderRequests: true };
    }
    const article = await api.invoke('tools:knowledgeSave', { title: noteTitle, vendor: 'Synthetic fixture', content: 'Wireless RSSI observations are cached evidence. Verify the adapter and collection time.' });
    await ai.readDocument(article.id);
    assert(ai.documentContent.textContent.includes('cached evidence'), 'Packaged local article did not render');
    await complete({ phase: options.phase, version: info.version, tools: supportsComparison ? 11 : supportsRunbooks ? 10 : supportsRemoteCapture ? 9 : supportsIncidents ? 8 : supportsRtp ? 7 : supportsSnapshots ? 6 : supportsDeviceInspector ? 5 : 4, ...(deviceInspector ? { deviceInspector } : {}), ...(deviceSnapshots ? { deviceSnapshots } : {}), ...(rtpMedia ? { rtpMedia } : {}), ...(incidentWorkspace ? { incidentWorkspace } : {}), ...(remoteCapture ? { remoteCapture } : {}), ...(runbooks ? { runbooks } : {}), ...(captureComparison ? { captureComparison } : {}), assessments: 8, mistRegions: 12, aiProviders: 5, knowledgeDocuments: knowledge.documents, vectorIndexReady: true, customNoteSaved: true, configChecks: report.checks.length, redactedExports: true, contextPreviewRedacted: true, encryptedTokenSaved: true, encryptedAiKeySaved: true, noAutomaticJobs: app.jobs.size === 0 });
  } else if (options.phase === 'forget') {
    if (supportsCopilot) {
      const list = await api.invoke('tools:copilotList'), record = list.conversations.find(item => item.name === 'Synthetic package Copilot');
      assert(record && list.issues.length === 0 && !app.copilot && app.jobs.size === 0, 'Copilot conversation was lost or automatically opened/sent after restart');
      const conversation = await api.invoke('tools:copilotGet', record.id);
      assert(conversation.attachments.length === (versionParts[1] >= 24 ? 2 : 1) && conversation.attachments[0].snapshot.scope.inputs.address === '192.0.2.37/26' && conversation.turns.length === 0, 'Immutable source evidence changed after restart');
      const panel = await app.openCopilot(); await app.copilot.selectConversation(record.id);
      assert(app.copilot.conversation.id === record.id && app.jobs.size === 0 && !app.copilot.prepared, 'Opening a saved conversation started work');
      await api.invoke('tools:copilotRemove', record.id, conversation.revision); app.copilot.applyConversation(null); await app.closeTab(panel);
      copilotChecks = { persistedAcrossRestart: true, immutableEvidenceRetained: true, noAutomaticRequests: true, localConversationReopened: true, removed: true };
    }
    if (versionParts[1] >= 27) {
      const record = (await api.invoke('tools:copilotList')).conversations.find(item => item.name === 'Synthetic package reviewed actions');
      const value = await api.invoke('tools:copilotGet', record.id);
      assert(value.actions.length === 3 && value.actions.every(action => action.status === 'succeeded') && app.jobs.size === 0, 'Reviewed outcomes were lost or automatically repeated after restart');
      const note = value.actions.find(action => action.kind === 'note.saveAnswer');
      assert((await api.invoke('tools:knowledgeGet', note.result.articleId)).title === 'Synthetic package reviewed note', 'Reviewed note was lost after restart');
      await api.invoke('tools:knowledgeRemove', note.result.articleId); await api.invoke('tools:copilotRemove', value.id, value.revision);
      copilotChecks.reviewedActions = { persistedAcrossRestart: true, noAutomaticRepeat: true, noteRetained: true, syntheticConversationAndNoteRemoved: true };
    }
    if (supportsEvents) {
      assert((await api.invoke('tools:eventsList')).listeners.length === 0, 'Event sockets/history were automatically restored');
      liveEvents = { noAutomaticListenersAfterRestart: true, historyIsMemoryOnly: true };
    }
    if (supportsSites) {
      const sites = app.openTool('sites'); await sites.ready;
      const record = sites.workspaces.find(w => w.name === 'Synthetic package smoke site');
      assert(record, 'Saved site did not survive packaged restart');
      await sites.select(record.id);
      assert(sites.saved.notes === 'Retained site notes' && sites.saved.sessions[0].group === 'Core' && sites.saved.layout.panels[0].sessionMode === 'sftp', 'Saved site notes/groups/SFTP mode changed');
      assert(!app.tabs.some(t => t.siteWorkspace) && app.jobs.size === 0, 'Restart automatically restored or connected site panels');
      await api.invoke('tools:siteRemove', record.id); await app.closeTab(sites);
      siteWorkspaces = { persistedAcrossRestart: true, notesAndGroupsRetained: true, sftpModeRetained: true, noAutomaticRestore: true, syntheticSiteRemoved: true };
    }
    if (supportsSerialAutoBaud) {
      assert(info.serial === true, 'Native serial support disappeared after restart');
      await app.sessions.load(); const saved = app.sessions.data.sessions.find(session => session.name === serialName);
      assert(saved?.baudRate === 'auto' && saved.serialAutoBaudProbe === true, 'Automatic serial settings did not survive restart');
      await checkSavedSerialEditor(saved);
      await api.invoke('sessions:delete', saved.id); await app.sessions.load();
      assert(!app.sessions.data.sessions.some(session => session.id === saved.id), 'Synthetic serial session was not removed');
      serialAutoBaud = { savedId: saved.id, persistedAcrossRestart: true, reopened: true, removed: true, noPortOpened: true };
    }
    if (supportsCiscoHighlighting) {
      assert(app.settings.terminalHighlighting === 'off', 'Cisco highlighting preference did not survive packaged restart');
      ciscoHighlighting = { persistedAcrossRestart: true };
    }
    if (supportsSessionManagement) {
      await app.sessions.load();
      const saved = app.sessions.data.sessions.find(item => item.name === sessionName);
      assert(saved?.username === 'fixture-user' && saved.hasPassword, 'Saved username/password presence did not survive restart');
      assert(app.recentSessions().length === 0 && localStorage.getItem('konx.recent') === null, 'Cleared recent history returned after restart');
      assert(localStorage.getItem('konx.session-smoke-marker') === 'retained', 'History clearing removed unrelated local preferences');
      const cleared = await api.invoke('sessions:save', { id: saved.id, password: null });
      assert(!cleared.hasPassword && cleared.username === 'fixture-user', 'Explicit password removal changed the saved username');
      await api.invoke('sessions:delete', saved.id); localStorage.removeItem('konx.session-smoke-marker');
      sessionManagement = { persistedAcrossRestart: true, historyStayedCleared: true, unrelatedPreferencesRetained: true, passwordRemoved: true };
    }
    if (supportsQuickLogin) {
      const fixture = options.quickLogin;
      assert(fixture?.host === '127.0.0.1' && !Object.hasOwn(fixture, 'password'), 'Restart must not receive a synthetic login password');
      await app.sessions.load();
      const saved = app.sessions.data.sessions.find(item => item.host === fixture.host && Number(item.port) === fixture.port && item.username === fixture.username);
      assert(saved?.hasPassword && !Object.hasOwn(saved, 'password') && !Object.hasOwn(saved, 'passwordEnc') && !Object.hasOwn(saved, '_oncePassword'),
        'Saved Quick Connect credentials did not survive restart privately');
      const consoleTab = app.connectSession(saved);
      try {
        await until(() => {
          assert(!document.querySelector('.modal'), 'Saved login unexpectedly requested credentials or host trust after restart');
          return ['connected', 'disconnected'].includes(consoleTab.state);
        }, 'SSH reconnect from encrypted saved login');
        assert(consoleTab.state === 'connected', 'Encrypted saved login did not authenticate after restart');
        await until(() => terminalContains(consoleTab, fixture.marker), 'restored synthetic shell output');
      } finally { await api.invoke('conn:close', consoleTab.id); await app.closeTab(consoleTab); }
      await api.invoke('sessions:delete', saved.id); await app.sessions.load(); app.clearRecentSessions();
      assert(!app.sessions.data.sessions.some(item => item.id === saved.id), 'Synthetic Home saved session was not removed');
      quickLogin = { savedId: saved.id, reconnectedWithoutPrompt: true, removed: true };
    }
    if (supportsLayouts) assert(app.settings.uiLayout === 'focus' && app.workspaceLayout.get().layout === 'focus', 'Workspace layout did not survive packaged restart');
    if (supportsWorkspaceWindows) {
      const workspace = app.workspaceLayout, expected = options.workspaceGeometry;
      assert(expected?.version === 1 && JSON.stringify(workspace.get().geometry) === JSON.stringify(expected) &&
        JSON.stringify(app.settings.workspaceGeometry) === JSON.stringify(expected), 'Workspace geometry did not survive the packaged restart');
      assert(workspace.floating.size === 0 && workspace.external.size === 0 && app.popouts.entries.size === 0,
        'Restart unexpectedly recreated live floating or native views');
      const node = security.el;
      assert(workspace.float(security), 'Saved panel geometry could not be reopened');
      const floating = workspace.floating.get(security), rect = expected.lastFloatRect;
      const width = app.views.clientWidth, height = app.views.clientHeight;
      assert(floating?.body.contains(node) && ['x', 'y', 'width', 'height'].every(key =>
        Math.abs(floating.bounds[key] - rect[key] * (['x', 'width'].includes(key) ? width : height)) <= 2),
        'Reopened floating panel did not use saved bounds');
      assert(workspace.dock(security) && workspace.placement(security) === 'docked' && security.el === node && app.jobs.size === 0,
        'Restored floating panel failed to dock without starting work');
      await workspace.saveGeometry;
      workspaceWindows = { persistedAcrossRestart: true, geometryApplied: true, docked: true, originalNodeRetained: true,
        noLiveViewsRestored: true, noAutomaticJobs: true, geometry: expected };
    }
    assert(mist.config.hasToken && !mist.testButton.disabled, 'Encrypted Mist token did not survive app restart');
    assert(mist.token.value === '', 'Saved credential must not be returned to the input');
    mist.forgetButton.click();
    await until(() => !mist.configBusy, 'synthetic Mist credential removal');
    assert(!mist.config.hasToken && mist.testButton.disabled && mist.forgetButton.disabled, 'Mist token removal did not update controls');
    const config = await api.invoke('tools:mistConfig');
    assert(!config.hasToken && !JSON.stringify(config).includes(options.token), 'Mist token remained after removal');
    app.activate(ai);
    await until(() => !ai.configBusy, 'AI settings after activation');
    assert(ai.config.provider === 'nyquest' && ai.config.hasKey && ai.key.value === '', 'Encrypted AI key did not survive restart');
    ai.forgetButton.click(); await until(() => !ai.configBusy, 'synthetic AI credential removal');
    assert(!ai.config.hasKey && !JSON.stringify(await api.invoke('tools:aiConfig')).includes(options.token), 'AI credential remained after Forget');
    const notes = await api.invoke('tools:knowledgeList', { query: noteTitle });
    const note = notes.find((article) => article.title === noteTitle && article.builtin === false);
    assert(note, 'Custom knowledge note did not survive restart');
    await api.invoke('tools:knowledgeRemove', note.id);
    assert(!(await api.invoke('tools:knowledgeGet', note.id)), 'Custom note remained after removal');
    if (supportsChangeValidation) {
      assert(!app.tabs.some(tab => tab.toolKind === 'change-validation'), 'Restart automatically restored a live validation view');
      const library = await api.invoke('tools:changeList'), saved = library.records.find(item => item.name === changeName);
      assert(library.records.length === 1 && library.issues.length === 0 && saved, 'Saved validation did not survive restart');
      const terminals = app.tabs.filter(tab => ['terminal', 'sftp'].includes(tab.kind)).length;
      const validation = app.openTool('change-validation'); await validation.ready; await validation.select(saved.id);
      const record = validation.record;
      assert(record.phase === 'review' && record.plan.scope === changeScope && record.maintenance.reason === changeMaintenance && !validation.isDirty(), 'Saved phase, plan notes or acknowledgment changed on reopen');
      assert(record.evidence.length === 2 && record.evidence.some(item => item.report.kind === 'capture-comparison' && item.report.changes.length > 0) &&
        record.evidence.some(item => item.report.kind === 'runbook' && item.report.name === 'Synthetic package smoke procedure' && item.report.steps[0].status === 'unknown'), 'Reviewed offline reports did not survive restart');
      const compared = await api.invoke('tools:snapshotCompare', record.sources);
      assert(JSON.stringify(compared) === JSON.stringify(record.comparison.report), 'Retained canonical comparison changed across restart');
      assert(record.decisions.every(item => item.status === 'unknown' && item.reviewedAt && item.rationale === changeRationale && item.sourceRefs.length === 1 && item.sourceRefs[0] === record.comparison.id), 'Reviewed decisions or references changed across restart');
      const preview = await api.invoke('tools:changePreview', record.id, record.revision);
      assert(JSON.stringify(JSON.parse(preview.text).workflow) === JSON.stringify(record), 'Reopened complete report lost retained content');
      assert(app.jobs.size === 0 && app.tabs.filter(tab => ['terminal', 'sftp'].includes(tab.kind)).length === terminals && validation.updateBlockers().length === 0, 'Reopening validation started work or fabricated an unsaved draft');
      app.activate(security); assert(getComputedStyle(validation.el).display === 'none', 'Inactive restored validation is visible');
      await api.invoke('tools:changeRemove', record.id, record.revision); await app.closeTab(validation);
      assert((await api.invoke('tools:changeList')).records.length === 0 && !app.byId.has(validation.id), 'Synthetic validation remained after cleanup');
      changeValidation = { savedId: record.id, revision: record.revision, persistedAcrossRestart: true, phaseAndNotesRetained: true,
        comparisonRetained: true, reviewedEvidenceRetained: true, decisionsAndReferencesRetained: true, noAutomaticRestore: true,
        inactiveViewHidden: true, removedBeforeSourceCleanup: true, noAutomaticJobs: true };
    }
    let deviceSnapshots = null;
    if (supportsSnapshots) {
      const history = await api.invoke('tools:snapshotList');
      assert(history.snapshots.length === 2 && history.issues.length === 0, 'Device snapshots did not survive restart');
      const before = history.snapshots.find((item) => item.label === 'Demo before change');
      const after = history.snapshots.find((item) => item.label === 'Demo after change');
      assert(before && after, 'Saved demo snapshot identities are missing');
      const comparison = await api.invoke('tools:snapshotCompare', { beforeId: before.id, afterId: after.id });
      assert(comparison.devices.length === 2 && comparison.changes.length > 0, 'Restored snapshots no longer compare correctly');
      await api.invoke('tools:snapshotRemove', before.id); await api.invoke('tools:snapshotRemove', after.id);
      assert((await api.invoke('tools:snapshotList')).snapshots.length === 0, 'Synthetic snapshots remained after removal');
      deviceSnapshots = { persistedAcrossRestart: true, comparisonRestored: true, syntheticSnapshotsRemoved: true };
    }
    let incidentWorkspace = null;
    if (supportsIncidents) {
      const library = await api.invoke('tools:incidentList');
      assert(library.incidents.length === 1 && library.issues.length === 0, 'Incident evidence did not survive restart');
      const saved = library.incidents.find(item => item.title === 'Synthetic package smoke incident');
      assert(saved, 'Synthetic incident identity missing after restart');
      const incident = await api.invoke('tools:incidentGet', saved.id);
      assert(incident.evidence.length === (supportsChangeValidation ? 3 : 2) && incident.evidence.find(item => item.kind === 'note').integrity === 'verified', 'Restored text evidence failed verification');
      if (supportsChangeValidation) {
        const retained = incident.evidence.find(item => item.kind === 'tool');
        assert(retained?.integrity === 'verified' && retained.textPreview.includes('konx-change-validation-report') && retained.textPreview.includes(changeScope), 'Independent validation report did not survive workflow removal');
        changeValidation.incidentCopyRetained = true;
      }
      const capture = incident.evidence.find(item => item.kind === 'capture');
      const bytes = await api.invoke('tools:incidentCapture', saved.id, capture.id);
      const { readCapture } = await import('./js/capture/pcapfile.mjs');
      assert(readCapture(bytes.bytes).packets.length === 401, 'Restored capture copy is unreadable');
      await api.invoke('tools:incidentRemove', saved.id);
      assert((await api.invoke('tools:incidentList')).incidents.length === 0, 'Synthetic incident remained after removal');
      incidentWorkspace = { persistedAcrossRestart: true, retainedCaptureVerified: true, syntheticIncidentRemoved: true };
    }
    assert(app.jobs.size === 0, 'Smoke left running jobs');
    let runbooks = null;
    if (supportsRunbooks) {
      const library = await api.invoke('tools:runbookList');
      assert(library.runbooks.length === 1 && library.issues.length === 0, 'Custom runbook did not survive restart');
      const saved = await api.invoke('tools:runbookGet', library.runbooks[0].id);
      assert(saved.definition.name === 'Synthetic package smoke procedure' && saved.definition.steps[0].kind === 'checklist', 'Restored runbook definition changed');
      await api.invoke('tools:runbookRemove', saved.id);
      assert((await api.invoke('tools:runbookList')).runbooks.length === 0, 'Synthetic procedure remained after removal');
      runbooks = { persistedAcrossRestart: true, syntheticProcedureRemoved: true };
    }
    await complete({ phase: options.phase, version: info.version, ...(deviceSnapshots ? { deviceSnapshots } : {}), ...(incidentWorkspace ? { incidentWorkspace } : {}), ...(runbooks ? { runbooks } : {}), encryptedTokenPersisted: true, tokenForgotten: true, encryptedAiKeyPersisted: true, aiKeyForgotten: true, customNotePersisted: true, customNoteRemoved: true, vectorIndexReady: true, noAutomaticJobs: true });
  } else throw new Error('Unknown package smoke phase');
})().catch(async error => {
  const options = window.__KONX_TOOLS_SMOKE;
  const failure = { passed: false, phase: options.phase, version: options.version,
    error: error?.stack || String(error) };
  // NSIS portable launchers do not forward the application's console. Keep
  // assertion evidence in the same parent-owned file as successful checks.
  try { await window.api.invoke('np:write', options.resultPath, new TextEncoder().encode(JSON.stringify(failure, null, 2))); }
  catch (writeError) { console.error('Could not persist package smoke failure', writeError); }
  throw error;
})
