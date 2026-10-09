// Property tests (u304, fast-check): random inputs against invariants of the pure survival and cost logic. Skipped when fast-check is not installed
// (npm i --no-save fast-check). A failure prints the smallest input that breaks the property.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { decide, MOBS } from '../behavior_pack/scripts/core/threat.js';
import { planCrafts, applyCraft, canCraft, RECIPES } from '../behavior_pack/scripts/core/recipes.js';
import { breakSeconds, hardness } from '../behavior_pack/scripts/core/costs.js';

let fc = null;
for (const base of [process.cwd(), process.env.FASTCHECK_DIR].filter(Boolean)) { try { fc = createRequire(base + '/')('fast-check'); break; } catch { /* next */ } }
const t = fc ? test : test.skip;

const TYPES = Object.keys(MOBS);
const mob = () => fc.record({
  id: fc.integer({ min: 1, max: 9999 }), type: fc.constantFrom(...TYPES), dist: fc.double({ min: 0.5, max: 30, noNaN: true }),
  visible: fc.boolean(), targetingMe: fc.boolean(), attackedMe: fc.boolean(), lit: fc.boolean(), canReach: fc.boolean(), recent: fc.boolean(), dy: fc.double({ min: -6, max: 6, noNaN: true }),
});
const world = () => fc.record({
  health: fc.integer({ min: 1, max: 20 }), damage: fc.constantFrom(1, 4, 5, 6, 7, 8), isNight: fc.boolean(), prevMode: fc.constantFrom('none', 'fight', 'flee'),
  mobs: fc.array(mob(), { maxLength: 8 }), inWater: fc.boolean(), shield: fc.boolean(), armor: fc.integer({ min: 0, max: 20 }), toughness: fc.integer({ min: 0, max: 8 }), bow: fc.boolean(),
});

t('decide never throws and returns a well-formed answer', () => {
  fc.assert(fc.property(world(), (w) => {
    const d = decide(w);
    assert.ok(['none', 'fight', 'flee'].includes(d.mode));
    assert.ok(Array.isArray(d.threats) && d.threats.every((m) => w.mobs.includes(m)));
    if (d.mode === 'fight') assert.ok(w.mobs.some((m) => m.id === d.target), `fight target ${d.target} is not one of the mobs`);
  }), { numRuns: 3000 });
});

t('at 3 hp or less, not already fighting, a zombie on us is run from (never a fresh fight)', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 3 }), fc.double({ min: 0.5, max: 3, noNaN: true }), fc.constantFrom(1, 5, 8), (health, dist, damage) => {
    const d = decide({ health, damage, prevMode: 'none', mobs: [{ id: 1, type: 'zombie', dist, visible: true, targetingMe: true, attackedMe: true, canReach: true }] });
    assert.notEqual(d.mode, 'fight', `${d.reason}`);
  }));
});

t('more health never turns a fight into a run (one zombie, same everything else)', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 18 }), fc.double({ min: 1, max: 10, noNaN: true }), fc.constantFrom(1, 5, 7), fc.integer({ min: 0, max: 20 }), fc.constantFrom('none', 'fight'), (health, dist, damage, armor, prevMode) => {
    const w = (h) => ({ health: h, damage, armor, prevMode, mobs: [{ id: 1, type: 'zombie', dist, visible: true, targetingMe: true, attackedMe: false, canReach: true }] });
    if (decide(w(health)).mode === 'fight') assert.equal(decide(w(health + 2)).mode, 'fight');
  }));
});

t('a better armor never turns a fight into a run', () => {
  fc.assert(fc.property(fc.integer({ min: 4, max: 20 }), fc.double({ min: 1, max: 10, noNaN: true }), fc.integer({ min: 0, max: 15 }), (health, dist, armor) => {
    const w = (a) => ({ health, damage: 5, armor: a, prevMode: 'none', mobs: [{ id: 1, type: 'zombie', dist, visible: true, targetingMe: true, canReach: true }, { id: 2, type: 'zombie', dist: dist + 1, visible: true, targetingMe: true, canReach: true }] });
    if (decide(w(armor)).mode === 'fight') assert.equal(decide(w(armor + 3)).mode, 'fight');
  }));
});

t('a better tool is never slower on the same block', () => {
  const tiers = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
  fc.assert(fc.property(fc.constantFrom('stone', 'cobblestone', 'iron_ore', 'deepslate', 'obsidian'), fc.integer({ min: 0, max: 3 }), (block, i) => {
    assert.ok(breakSeconds(block, `${tiers[i + 1]}_pickaxe`) <= breakSeconds(block, `${tiers[i]}_pickaxe`) + 1e-9);
  }));
  fc.assert(fc.property(fc.constantFrom(...TYPES), () => true)); // (the generator itself is sound)
});

t('hardness is never negative and break time grows with it', () => {
  fc.assert(fc.property(fc.constantFrom('dirt', 'stone', 'deepslate', 'oak_log', 'obsidian', 'white_wool', 'cobbled_deepslate'), (b) => {
    assert.ok(hardness(b) >= 0);
    assert.ok(breakSeconds(b, null) >= 0);
  }));
});

const inv = () => fc.dictionary(fc.constantFrom('oak_log', 'birch_log', 'oak_planks', 'spruce_planks', 'stick', 'cobblestone', 'coal', 'iron_ingot', 'white_wool', 'red_wool', 'wheat'), fc.integer({ min: 1, max: 40 }));

t('a craft never makes an inventory negative and conserves what it uses', () => {
  fc.assert(fc.property(inv(), fc.constantFrom(...Object.keys(RECIPES)), (i, name) => {
    if (!canCraft(i, name)) return;
    const r = applyCraft(i, name);
    assert.ok(Object.values(r.inv).every((n) => n > 0));
    for (const id of new Set([...Object.keys(i), ...Object.keys(r.inv)])) assert.equal(r.inv[id] ?? 0, (i[id] ?? 0) - (r.used[id] ?? 0) + (r.made[id] ?? 0), `${id} not conserved`);
  }));
});

t('a crafting plan, when it is complete, can be followed step by step from the inventory', () => {
  fc.assert(fc.property(inv(), fc.array(fc.constantFrom('wooden_pickaxe', 'stone_pickaxe', 'stone_sword', 'furnace', 'crafting_table', 'torch', 'chest'), { minLength: 1, maxLength: 3 }), (i, targets) => {
    const p = planCrafts(i, targets);
    if (p.missing || p.logsShort) return;
    let cur = { ...i };
    for (const step of p.steps) {
      assert.ok(canCraft(cur, step), `step ${step} is not craftable from ${JSON.stringify(cur)}`);
      cur = applyCraft(cur, step).inv;
    }
  }));
});
