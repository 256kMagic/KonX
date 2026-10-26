'use strict';
const assert = require('node:assert/strict');

const atmospheric = {
  'ion-storm': 'konx-ion-current',
  'solar-flare': 'konx-solar-flare',
  'aurora-flux': 'konx-aurora-flow',
  hyperdrive: 'konx-hyperdrive-flight',
  'ghost-circuit': 'konx-circuit-packet',
};

// Serialized into the real renderer. Observe the compositor-owned animation
// timelines and their produced geometry/paint values, rather than only CSS names.
function motionSnapshot(selector) {
  const root = document.querySelector(selector);
  if (!root) throw new Error('Missing effect surface: ' + selector);
  return root.getAnimations({ subtree: true }).map(animation => {
    const target = animation.effect.target, style = getComputedStyle(target), rect = target.getBoundingClientRect();
    return { name: animation.animationName, state: animation.playState, pending: animation.pending, time: animation.currentTime,
      visual: [style.transform, style.opacity, style.strokeDashoffset, style.backgroundPosition,
        rect.x, rect.y, rect.width, rect.height] };
  });
}

function assertMoving(before, after, expectedName, label) {
  const a = before.filter(item => item.name === expectedName), b = after.filter(item => item.name === expectedName);
  assert.ok(a.length > 0, label + ': expected visible effect animation ' + expectedName);
  assert.equal(a.length, b.length, label + ': motion ownership changed unexpectedly');
  assert.ok(a.every(item => item.state === 'running'), label + ': animations must run');
  assert.ok(a.some((item, i) => b[i].time > item.time + 20), label + ': animation clock did not advance');
  assert.notDeepEqual(a.map(item => item.visual), b.map(item => item.visual), label + ': animation did not change actual geometry or paint');
}

function assertFrozen(before, after, label) {
  assert.deepEqual(after, before, label + ': decorative work advanced while suspended');
  assert.ok(after.every(item => item.state === 'paused' || item.state === 'finished'), label + ': retained animation must be paused');
}

module.exports = { atmospheric, motionSnapshot, assertMoving, assertFrozen };
