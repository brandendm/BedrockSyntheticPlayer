import test from 'node:test';
import assert from 'node:assert/strict';
import { VANILLA } from '../behavior_pack/scripts/core/vanilla.js';
import { MOBS } from '../behavior_pack/scripts/core/threat.js';

// Our hp table is held to Mojang's data (bedrock-samples, via tools/gen_vanilla.mjs). Slimes and magma cubes vary with size (the data holds the biggest).
const SIZED = new Set(['slime', 'magma_cube']);
test('every MOBS entry is a real entity with the vanilla hp', () => {
  for (const [k, m] of Object.entries(MOBS)) {
    if (k === 'evoker') continue; // (kept beside evocation_illager, the real id)
    const v = VANILLA[k];
    assert.ok(v, `${k} is not a vanilla entity`);
    if (!SIZED.has(k)) assert.equal(m.hp, v.hp, `${k} hp`);
  }
});
test('every hostile (monster-family) vanilla mob is in MOBS, or the bot does not see it at all', () => {
  const ok = new Set(); // (nothing is exempt today)
  const missing = Object.entries(VANILLA).filter(([k, v]) => (v.family ?? []).includes('monster') && !MOBS[k] && !ok.has(k)).map(([k]) => k);
  assert.deepEqual(missing, []);
});
test('melee mobs hit for what the data says, give or take the cadence', () => {
  // dps is a tuned estimate (hits a second x damage); a melee mob whose estimate is far under a single vanilla hit is wrong
  for (const [k, m] of Object.entries(MOBS)) {
    const v = VANILLA[k]; if (!v || m.kind !== 'melee' || k === 'phantom') continue; // (a phantom's 6 comes once a swoop, every few seconds)
    const hit = v.atk ?? v.atkMax; if (hit === undefined) continue;
    assert.ok(m.dps >= hit * 0.45, `${k}: dps ${m.dps} vs a hit of ${hit}`);
  }
});
test('creepers close at 0.25 (0.2 x 1.25), a hair faster than a zombie: the "half its pace" assumption is gone', () => {
  assert.equal(VANILLA.creeper.chase, 0.25);
  assert.ok(VANILLA.creeper.chase > VANILLA.zombie.chase);
  assert.equal(VANILLA.creeper.swell.stop, 6);
});
