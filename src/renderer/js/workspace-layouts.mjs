/** Workspace structure is independent of application and terminal colors. */
export const APP_LAYOUTS = Object.freeze({
  classic: Object.freeze({ label: 'Classic', description: 'Session sidebar and top tabs, with one active tool at a time.' }),
  workbench: Object.freeze({ label: 'Docked Workbench', description: 'Keep the active tool beside a chosen companion, with context and running work nearby.' }),
  'incident-desk': Object.freeze({ label: 'Incident Desk', description: 'Keep an incident and its evidence alongside the tool you are investigating with.' }),
  'operations-wall': Object.freeze({ label: 'Operations Wall', description: 'Arrange up to four open views together, with one clearly focused input destination.' }),
  focus: Object.freeze({ label: 'Focus Workspace', description: 'Give one tool the full canvas, with a bottom tab dock and panels available on demand.' }),
});

export function normalizeLayout(value) {
  return typeof value === 'string' && Object.hasOwn(APP_LAYOUTS, value) ? value : 'classic';
}
