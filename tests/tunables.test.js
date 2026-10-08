import test from 'node:test';
import assert from 'node:assert/strict';
import { TUNABLES, live, applyPolicy, diffFromDefaults, keysOf, toUnit, fromUnit, defaults } from '../behavior_pack/scripts/core/tunables.js';
import { decide } from '../behavior_pack/scripts/core/threat.js';

test('every tunable has a default inside its range and a group', () => {
  for (const [k, d] of Object.entries(TUNABLES)) {
    assert.ok(d.min < d.max, k);
    assert.ok(d.v >= d.min && d.v <= d.max, `${k} default ${d.v} outside ${d.min}..${d.max}`);
    assert.ok(['tow', 'combat', 'cave'].includes(d.group), k);
  }
});
test('applyPolicy: known numbers only, clamped, and a second call starts from the defaults', () => {
  const a = applyPolicy({ fightMargin: 0.5, fleeHealth: 99, nonsense: 3, keepFightingMargin: 'x', guardMax: NaN });
  assert.equal(a.fightMargin, 0.5);
  assert.equal(a.fleeHealth, TUNABLES.fleeHealth.max);
  assert.equal(a.keepFightingMargin, TUNABLES.keepFightingMargin.v);
  assert.equal(a.guardMax, TUNABLES.guardMax.v);
  assert.equal('nonsense' in a, false);
  assert.deepEqual(diffFromDefaults(), { fightMargin: 0.5, fleeHealth: TUNABLES.fleeHealth.max });
  applyPolicy({});
  assert.deepEqual(diffFromDefaults(), {});
  assert.equal(live.fightMargin, TUNABLES.fightMargin.v);
});
test('the unit cube round-trips', () => {
  const keys = keysOf('combat');
  const u = toUnit({ fightMargin: 0.8 }, keys);
  assert.ok(u.every((x) => x >= 0 && x <= 1));
  const back = fromUnit(u, keys);
  assert.ok(Math.abs(back.fightMargin - 0.8) < 1e-3);
  assert.deepEqual(fromUnit(toUnit(defaults(), keys), keys, {}), Object.fromEntries(keys.map((k) => [k, TUNABLES[k].v])));
});
test('the fight-or-run logic really reads the live values', () => {
  const mob = { id: 1, type: 'zombie', dist: 5, visible: true, hp: 20 };
  const base = { health: 7, damage: 4, mobs: [mob] };
  applyPolicy({ fleeHealth: 9 });
  const timid = decide({ ...base });
  applyPolicy({ fleeHealth: 3 });
  const bold = decide({ ...base });
  applyPolicy({});
  assert.notEqual(timid.reason, bold.reason);
});
