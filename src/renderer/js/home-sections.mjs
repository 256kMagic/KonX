// Stable IDs own Home visibility independently of labels, themes and layouts.
export const HOME_SECTIONS = Object.freeze([
  ['introduction', 'Introduction'],
  ['quick-connect', 'Quick connect'],
  ['recent-sessions', 'Recent sessions'],
  ['sessions', 'Sessions'],
  ['network-tools', 'Network tools'],
  ['keyboard', 'Keyboard'],
].map(([id, label]) => Object.freeze({ id, label })));

export function hiddenHomeSections(value) {
  const hidden = new Set(Array.isArray(value) ? value : []);
  return HOME_SECTIONS.filter(section => hidden.has(section.id)).map(section => section.id);
}
