/** Geometry only: runtime tabs, session specifications and content never persist. */
export const SPLIT_LAYOUTS = Object.freeze(['workbench', 'incident-desk', 'operations-wall']);
const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export function normalizeWorkspaceGeometry(value) {
  const source = value?.version === 1 ? value : {};
  const ratios = Object.fromEntries(SPLIT_LAYOUTS.map(layout => [layout, {
    columns: clamp(finite(source.ratios?.[layout]?.columns, 0.5), 0.2, 0.8),
    rows: clamp(finite(source.ratios?.[layout]?.rows, 0.5), 0.2, 0.8),
  }]));
  const rect = source.lastFloatRect;
  const width = clamp(finite(rect?.width, 0.72), 0.2, 1), height = clamp(finite(rect?.height, 0.78), 0.2, 1);
  return { version: 1, ratios, lastFloatRect: { x: clamp(finite(rect?.x, 0.08), 0, 1 - width),
    y: clamp(finite(rect?.y, 0.08), 0, 1 - height), width, height } };
}
export function clampFloatBounds(value, viewport) {
  const availableWidth = Math.max(1, finite(viewport.width, 1)), availableHeight = Math.max(1, finite(viewport.height, 1));
  const width = clamp(finite(value?.width, availableWidth * 0.72), Math.min(300, availableWidth), availableWidth);
  const height = clamp(finite(value?.height, availableHeight * 0.78), Math.min(220, availableHeight), availableHeight);
  return { x: clamp(finite(value?.x, 0), 0, availableWidth - width), y: clamp(finite(value?.y, 0), 0, availableHeight - height), width, height };
}
export function expandFloatBounds(rect, viewport) {
  return clampFloatBounds({ x: rect.x * viewport.width, y: rect.y * viewport.height,
    width: rect.width * viewport.width, height: rect.height * viewport.height }, viewport);
}
export function contractFloatBounds(rect, viewport) {
  const bounded = clampFloatBounds(rect, viewport);
  return { x: bounded.x / Math.max(1, viewport.width), y: bounded.y / Math.max(1, viewport.height),
    width: bounded.width / Math.max(1, viewport.width), height: bounded.height / Math.max(1, viewport.height) };
}
