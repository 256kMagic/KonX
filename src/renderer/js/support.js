import { h, api, modal, errMsg } from './ui.js';

/** A local, editable report. Nothing is uploaded or submitted by this dialog. */
export async function supportDialog(app) {
  let closed = false, busy = false;
  const logs = h('input', { type: 'checkbox', 'aria-label': 'Include JavaScript error logs' });
  const description = h('textarea.input', { rows: 3, maxLength: 12000, 'aria-label': 'Problem description',
    placeholder: 'What happened? Include the steps, what you expected, and what you saw. Leave out passwords and sensitive traffic.' });
  const preview = h('textarea.input', { rows: 12, spellcheck: false, 'aria-label': 'Diagnostic report preview',
    style: { width: '100%', minHeight: '180px', fontFamily: 'monospace', resize: 'vertical' } });
  const status = h('p.hint', { role: 'status' }, 'Preparing local diagnostics…');
  const refresh = h('button.btn', { onclick: () => rebuild() }, 'Rebuild preview');
  const save = h('button.btn.primary', { disabled: true, onclick: () => exportReport() }, 'Save report…');
  const issue = h('button.btn', { onclick: () => api.invoke('app:openExternal', 'https://github.com/256kMagic/KonX/issues/new') }, 'Open issue page');
  const controls = () => { refresh.disabled = logs.disabled = description.disabled = busy; save.disabled = busy || !preview.value; };
  const rebuild = async () => {
    if (busy || closed) return;
    busy = true; controls();
    try {
      const report = await api.invoke('app:supportPreview', { includeLogs: logs.checked, tabs: app.tabs.length });
      if (closed) return;
      report.problem = description.value;
      preview.value = JSON.stringify(report, null, 2);
      status.textContent = 'Review and edit this report before saving. Rebuilding replaces preview edits.';
    } catch (error) { if (!closed) status.textContent = errMsg(error); }
    finally { busy = false; if (!closed) controls(); }
  };
  const exportReport = async () => {
    if (busy || closed) return;
    busy = true; controls();
    try {
      const file = await api.invoke('app:supportExport', preview.value);
      if (!closed) status.textContent = file ? 'Report saved. Attach it yourself when reporting the issue.' : 'Save cancelled. Your preview is still here.';
    } catch (error) { if (!closed) status.textContent = errMsg(error); }
    finally { busy = false; if (!closed) controls(); }
  };
  logs.addEventListener('change', () => { status.textContent = 'Choose Rebuild preview to apply the log selection.'; });
  description.addEventListener('input', () => { status.textContent = 'Choose Rebuild preview to include the updated description.'; });
  preview.addEventListener('input', controls);
  const done = modal({ title: 'Report a problem', icon: 'info', width: 800, submitOnEnter: false,
    body: h('div.support-report',
      h('p', 'Create a local report with the KonX version, runtime, display sizes, and activity counts. Sessions, credentials, captures, and terminal contents are excluded.'),
      description,
      h('label.check', logs, 'Include JavaScript error logs'),
      h('p.hint', 'Optional logs may contain identifying information. Common credentials and local profile paths are masked, but review the preview before sharing.'),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '8px 0' } }, refresh, save, issue),
      preview, status), buttons: [{ label: 'Close', value: null }],
  });
  void rebuild();
  await done; closed = true;
}
