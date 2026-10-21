// Offline signaling analysis and export checks; no capture driver or live traffic.
import { runSdpTests } from './sdp-tests.mjs';
import { runSipTests } from './sip-tests.mjs';
import { runSipIntegrationTests } from './sip-integration-tests.mjs';
import { runSipReviewRegressionTests } from './sip-review-regression-tests.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
await runSdpTests(test);
await runSipTests(test);
await runSipIntegrationTests(test);
await require('./sip-navigation-tests.cjs').runSipNavigationTests(test);
await runSipReviewRegressionTests(test);
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
