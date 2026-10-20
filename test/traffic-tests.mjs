// Offline traffic reconstruction tests. No capture driver, Electron, or live traffic.
import { runReassemblyTests } from './reassembly-tests.mjs';
import { runHttpTests } from './http-tests.mjs';
import { runStreamPreviewTests } from './stream-preview-tests.mjs';
import { runStreamReviewRegressionTests } from './stream-review-regression-tests.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
await runReassemblyTests(test);
await runHttpTests(test);
await runStreamPreviewTests(test);
await require('./capture-export-tests.cjs').runCaptureExportTests(test);
await require('./traffic-ui-tests.cjs').runTrafficUiTests(test);
await require('./capture-auto-scroll-tests.cjs').runCaptureAutoScrollTests(test);
await runStreamReviewRegressionTests(test);
await require('./ui-v020-review-regression-tests.cjs').runUiV020ReviewRegressionTests(test);
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
