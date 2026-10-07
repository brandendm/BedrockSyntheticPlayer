import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROBES, PROBE_NAMES } from '../behavior_pack/scripts/core/probes.js';

test('every probe has a floor, an extent that holds it, and a run', () => {
  assert.ok(PROBE_NAMES.length >= 8);
  for (const n of PROBE_NAMES) {
    const p = PROBES[n];
    assert.ok(p.ext.w > 0 && p.ext.e > 0 && p.ext.r > 0, n);
    assert.equal(typeof p.run, 'function', n);
    const cmds = [...p.floor(0, 100, 0), ...(p.cmds ? p.cmds(0, 100, 0) : [])];
    for (const c of cmds) {
      let nums = c.split(' ').slice(1, 7).map(Number);
      if (c.startsWith('setblock')) nums = [...nums.slice(0, 3), ...nums.slice(0, 3)];
      assert.ok(nums[0] >= -p.ext.w && nums[3] <= p.ext.e && Math.abs(nums[2]) <= p.ext.r && Math.abs(nums[5]) <= p.ext.r, `${n}: ${c} is outside the slab`);
    }
  }
});
