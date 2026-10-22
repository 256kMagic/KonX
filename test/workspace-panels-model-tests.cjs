'use strict';
const assert = require('node:assert/strict');
async function runWorkspacePanelsModelTests(test) {
  const { normalizeWorkspaceGeometry, clampFloatBounds, expandFloatBounds, contractFloatBounds } = await import('../src/renderer/js/workspace-panels-model.mjs');
  await test('workspace geometry strips runtime content and validates ratios and rectangle coordinates', () => {
    const value = normalizeWorkspaceGeometry({ version: 1, tabId: 'secret', spec: { password: 'secret' },
      ratios: { workbench: { columns: Infinity, rows: -42, password: 'secret' } },
      lastFloatRect: { x: 8, y: -2, width: 3, height: NaN, content: 'secret' } });
    assert.equal(value.ratios.workbench.columns, 0.5); assert.equal(value.ratios.workbench.rows, 0.2);
    assert.equal(value.lastFloatRect.width, 1); assert.equal(value.lastFloatRect.x, 0); assert.equal(value.lastFloatRect.y, 0);
    assert.doesNotMatch(JSON.stringify(value), /secret|password|tabId|content/);
    assert.deepEqual(normalizeWorkspaceGeometry({ version: 9, ratios: value.ratios }), normalizeWorkspaceGeometry(null));
  });
  await test('workspace floating bounds stay reachable after viewport shrink and normalized geometry round-trips', () => {
    for (const viewport of [{ width: 640, height: 410 }, { width: 180, height: 120 }, { width: 1, height: 1 }]) {
      const rect = clampFloatBounds({ x: 3000, y: -400, width: 5000, height: 5000 }, viewport);
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height);
      assert.deepEqual(expandFloatBounds(contractFloatBounds(rect, viewport), viewport), rect);
    }
  });
}
module.exports = { runWorkspacePanelsModelTests };
if (require.main === module) runWorkspacePanelsModelTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
