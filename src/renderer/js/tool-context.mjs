// Only the explicitly chosen tool's existing result is offered to the AI view.
// Never inspect saved sessions, editor documents, credentials or packet bytes.
// Preserve whole bounded strings until main-process redaction. Cutting a raw
// string first can hide a credential's full identity from the redactor.
export const MAX_CONTEXT_INPUT_BYTES = 256 * 1024;
const FIELD_BYTES = 64 * 1024, LABEL_BYTES = 4096, KEY_BYTES = 512;
const MAX_NODES = 1500, MAX_DEPTH = 8, MAX_ITEMS = 100;
const encoder = new TextEncoder();
const size = value => encoder.encode(value).length;
const excluded = /token|password|passphrase|secret|authorization|api.?key|cookie|psk|community|^(?:bytes|payload|raw|__proto__|constructor|prototype)$/i;
const summaries = new Set(['snapshots', 'incidents', 'capture-compare', 'sites', 'topology', 'events', 'change-validation']);

export function toolContext(tab) {
  const omissions = new Set();
  let remaining = MAX_CONTEXT_INPUT_BYTES - 8192, nodes = 0;
  const ancestors = new WeakSet();
  const charge = text => {
    const bytes = size(text);
    if (bytes > remaining) { omissions.add('serialized output limit'); return false; }
    remaining -= bytes; return true;
  };
  const omitted = reason => {
    omissions.add(reason);
    const value = '[Omitted: ' + reason + ']';
    return charge(JSON.stringify(value)) ? value : undefined;
  };
  const copy = (value, depth = 0) => {
    if (++nodes > MAX_NODES) return omitted('node limit');
    if (depth > MAX_DEPTH) return omitted('depth limit');
    if (typeof value === 'string') {
      if (value.length > FIELD_BYTES || size(value) > FIELD_BYTES) return omitted('whole field exceeds 64 KiB');
      return charge(JSON.stringify(value)) ? value : undefined;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return charge(JSON.stringify(value)) ? value : undefined;
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return omitted('unsupported value or binary data');
    if (ancestors.has(value)) return omitted('cyclic value');
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return omitted('unsupported object');
    if (!charge(array ? '[]' : '{}')) return undefined;
    const result = array ? [] : Object.create(null); ancestors.add(value);
    try {
      if (array) {
        if (value.length > MAX_ITEMS) omissions.add('array limit: first 100 entries only');
        for (let index = 0; index < Math.min(value.length, MAX_ITEMS); index++) {
          if (nodes >= MAX_NODES) { omissions.add('node limit'); break; }
          const separator = index ? 1 : 0;
          if (remaining <= separator) { omissions.add('serialized output limit'); break; }
          remaining -= separator;
          const item = copy(value[index], depth + 1);
          if (item === undefined) { remaining += separator; break; }
          result.push(item);
        }
      } else {
        let examined = 0, included = 0;
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue;
          if (++examined > MAX_ITEMS) { omissions.add('property limit: first 100 properties examined'); break; }
          if (nodes >= MAX_NODES) { omissions.add('node limit'); break; }
          if (excluded.test(key) || tab.toolKind === 'device' && key === 'commands') { omissions.add('credential-labelled fields, packet bytes or device transcripts excluded'); continue; }
          if (key.length > KEY_BYTES || size(key) > KEY_BYTES) { omissions.add('whole property label exceeds 512 bytes'); continue; }
          const prefix = JSON.stringify(key) + ':' + (included ? ',' : '');
          if (!charge(prefix)) break;
          const item = copy(value[key], depth + 1);
          if (item === undefined) { remaining += size(prefix); break; }
          result[key] = item; included++;
        }
      }
    } finally { ancestors.delete(value); }
    return result;
  };
  const rawTitle = tab.title || tab.toolKind || 'KonX tool';
  let title = rawTitle;
  if (typeof title !== 'string' || title.length > LABEL_BYTES || size(title) > LABEL_BYTES) { title = '[Tool label omitted]'; omissions.add('whole tool label exceeds 4 KiB or is not text'); }
  let source;
  if (summaries.has(tab.toolKind)) {
    // Summary owners choose metadata/counts; never inspect their full evidence.
    source = tab.aiContext || { message: 'No evidence summary selected.' };
  } else if (tab.report && typeof tab.report === 'object') source = tab.report;
  else if (tab.kind === 'capture') source = { statistics: tab.statsEl?.innerText || '', displayedAnalysis: tab.sideBody?.innerText || '' };
  else source = tab.el?.innerText || 'No collected result is available yet.';
  const selected = copy(source);
  const output = selected === undefined ? '[Output omitted]' : typeof selected === 'string' ? selected : JSON.stringify(selected);
  // Notices precede evidence so the main-process preview limit cannot silently
  // hide the fact that this builder omitted fields, rows or unexamined content.
  const coverage = omissions.size ? `\nCoverage: partial. Omitted content: ${[...omissions].join('; ')}. Review the complete result in its tool tab.` : '';
  return `Tool: ${title}\nSnapshot of the selected tool's displayed results. This may be incomplete.${coverage}\n\n${output}`;
}
