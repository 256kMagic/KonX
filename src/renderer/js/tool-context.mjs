// Only the explicitly chosen tool's existing result is offered to the AI view.
// Never inspect saved sessions, editor documents, credentials or packet bytes.
const LIMIT = 23000;
export function toolContext(tab) {
  const title = String(tab.title || tab.toolKind || 'KonX tool').slice(0, 200);
  let output;
  if (tab.report && typeof tab.report === 'object') {
    let nodes = 0;
    const copy = (value, depth = 0) => {
      if (++nodes > 1500 || depth > 8) return '[Omitted]';
      if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
      if (typeof value === 'string') return value.slice(0, 4000);
      if (Array.isArray(value)) return value.slice(0, 100).map((item) => copy(item, depth + 1));
      if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[Omitted]';
      const result = {};
      for (const key of Object.keys(value).slice(0, 100)) {
        if (/token|password|passphrase|secret|authorization|api.?key|cookie|psk|community|^(?:bytes|payload|raw|__proto__|constructor|prototype)$/i.test(key)) continue;
        result[key] = copy(value[key], depth + 1);
      }
      return result;
    };
    output = JSON.stringify(copy(tab.report), null, 2);
  } else if (tab.kind === 'capture') {
    output = [tab.statsEl?.innerText, tab.sideBody?.innerText].filter(Boolean).join('\n\n');
  } else {
    // innerText excludes hidden panes and input values (including password fields).
    output = tab.el?.innerText || '';
  }
  const trimmed = String(output || 'No collected result is available yet.').trim();
  return `Tool: ${title}\nSnapshot of the selected tool's displayed results. This may be incomplete.\n\n${trimmed.slice(0, LIMIT)}${trimmed.length > LIMIT ? '\n[Context truncated; review the full result in its tool tab.]' : ''}`;
}
