import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tracker, kindOfBlock, scoreEvidence, isVillage, mergeKnown, pickVillage, offers, lootWanted, takeableBed, isVillager, isRaider } from '../behavior_pack/scripts/core/village.js';

const ev = (kind, x, z, y = 64) => ({ kind, x, y, z });
/** A constructed village around (cx, cz): a bell, paths, hay, farms, beds, villagers. */
const village = (cx, cz) => [
  ev('bell', cx, cz), ev('path', cx + 3, cz), ev('path', cx - 3, cz + 2), ev('path', cx, cz + 6), ev('hay', cx + 10, cz + 4),
  ev('farm', cx + 12, cz + 6), ev('farm', cx + 13, cz + 6), ev('bed', cx - 8, cz - 3), ev('bed', cx - 8, cz - 5), ev('villager', cx + 2, cz + 2),
  ev('villager', cx - 4, cz + 1), ev('chest', cx + 5, cz - 5),
];

test('blocks that are village evidence', () => {
  assert.equal(kindOfBlock('minecraft:bell'), 'bell');
  assert.equal(kindOfBlock('dirt_path'), 'path');
  assert.equal(kindOfBlock('grass_path'), 'path');
  assert.equal(kindOfBlock('hay_block'), 'hay');
  assert.equal(kindOfBlock('farmland'), 'farm');
  assert.equal(kindOfBlock('red_bed'), 'bed');
  assert.equal(kindOfBlock('blast_furnace'), 'job');
  assert.equal(kindOfBlock('oak_door'), null);
  assert.equal(kindOfBlock('cobblestone'), null);
  assert.equal(kindOfBlock('oak_planks'), null);
});

test('villagers and raiders by entity type', () => {
  assert.ok(isVillager('minecraft:villager_v2'));
  assert.ok(!isVillager('zombie_villager'));
  assert.ok(isRaider('pillager') && isRaider('minecraft:ravager') && !isRaider('zombie'));
});

test('one kind of evidence is not a village, however much of it', () => {
  const s = scoreEvidence([ev('path', 0, 0), ev('path', 1, 0), ev('path', 2, 0), ev('path', 3, 0)]);
  assert.ok(!isVillage(s));
  assert.ok(!isVillage(scoreEvidence([ev('farm', 0, 0), ev('farm', 1, 0), ev('farm', 2, 0)])));
  assert.ok(!isVillage(scoreEvidence([ev('chest', 0, 0), ev('chest', 3, 0)])));
});

test('a few kinds together are: paths and hay, a bell and a villager, three villagers and a farm', () => {
  assert.ok(isVillage(scoreEvidence([ev('path', 0, 0), ev('path', 1, 0), ev('hay', 4, 4), ev('hay', 6, 4)])));
  assert.ok(isVillage(scoreEvidence([ev('bell', 0, 0), ev('villager', 3, 3)])));
  assert.ok(isVillage(scoreEvidence([ev('villager', 0, 0), ev('villager', 9, 0), ev('villager', 20, 0), ev('farm', 5, 5)])));
  // Two villagers alone (a trading hall?) and a lone bell are not enough.
  assert.ok(!isVillage(scoreEvidence([ev('villager', 0, 0), ev('villager', 9, 0)])));
  assert.ok(!isVillage(scoreEvidence([ev('bell', 0, 0)])));
});

test('the tracker finds a constructed village, at about its middle', () => {
  const t = new Tracker();
  t.add(village(200, -300));
  const v = t.villages();
  assert.equal(v.length, 1);
  assert.ok(Math.hypot(v[0].x - 200, v[0].z + 300) < 8, `${v[0].x},${v[0].z}`);
  assert.ok(v[0].kinds.bell === 1 && v[0].kinds.path === 3);
});

test('evidence arriving a little at a time ends up the same village, and seeing it twice counts once', () => {
  const t = new Tracker();
  const all = village(0, 0);
  for (const e of all) { t.add([e]); t.add([e]); }
  const v = t.villages();
  assert.equal(v.length, 1);
  assert.equal(v[0].kinds.path, 3);
  assert.equal(v[0].kinds.bell, 1);
});

test('two villages 150 blocks apart stay two; a stray hay bale in the open is nothing', () => {
  const t = new Tracker();
  t.add(village(0, 0)); t.add(village(150, 20)); t.add([ev('hay', -300, 0)]);
  assert.equal(t.villages().length, 2);
});

test('scattered evidence over a wide area (a farm here, a path there) does not add up to a village', () => {
  const t = new Tracker();
  t.add([ev('path', 0, 0), ev('hay', 200, 0), ev('farm', 0, 200), ev('bed', 200, 200), ev('villager', -200, 0)]);
  assert.equal(t.villages().length, 0);
});

test('raiders near a village mark it dangerous for ten minutes', () => {
  const t = new Tracker();
  const now = 1e9;
  t.add(village(0, 0), now);
  t.raiders([{ x: 20, z: 10 }], now);
  assert.ok(t.villages(now + 60_000)[0].danger);
  assert.ok(!t.villages(now + 11 * 60_000)[0].danger);
  t.raiders([{ x: 500, z: 500 }], now + 11 * 60_000);
  assert.ok(!t.villages(now + 11 * 60_000)[0].danger);
});

test('remembering: the same place updates, a new one is added, the best 8 kept', () => {
  const t = new Tracker();
  t.add(village(0, 0));
  let known = mergeKnown([], t.villages(), 'overworld', 1000);
  assert.equal(known.length, 1);
  known[0].visited = 5;
  const t2 = new Tracker(); t2.add(village(10, 5));
  known = mergeKnown(known, t2.villages(), 'overworld', 2000);
  assert.equal(known.length, 1);
  assert.equal(known[0].visited, 5);
  assert.equal(known[0].seen, 2000);
  const far = new Tracker(); far.add(village(400, 0));
  known = mergeKnown(known, far.villages(), 'overworld', 3000);
  assert.equal(known.length, 2);
  // Another dimension is another place.
  known = mergeKnown(known, t.villages(), 'nether', 3000);
  assert.equal(known.length, 3);
  let many = [];
  for (let i = 0; i < 12; i++) { const tt = new Tracker(); tt.add(village(i * 300, 0)); many = mergeKnown(many, tt.villages(), 'overworld', i); }
  assert.equal(many.length, 8);
});

test('picking where to go: near beats far, what it offers pulls, raiders and recent visits rule it out', () => {
  const mk = (x, kinds, extra = {}) => ({ d: 'overworld', x, y: 64, z: 0, score: 20, kinds, seen: 0, ...extra });
  const known = [mk(100, { bed: 4, bell: 1 }), mk(60, { path: 3, hay: 2 }), mk(300, { bed: 4 })];
  const o = { dim: 'overworld', now: 1e9 };
  assert.equal(pickVillage(known, { x: 0, z: 0 }, 'sheep', o).x, 100);   // a village with beds, a bit further
  assert.equal(pickVillage(known, { x: 0, z: 0 }, 'food', o).x, 60);     // hay and farms
  assert.equal(pickVillage(known, { x: 0, z: 0 }, 'sheep', { ...o, maxDist: 80 })?.x, 60); // only the near one is in range
  known[0].dangerAt = 1e9 - 60_000;
  assert.equal(pickVillage(known, { x: 0, z: 0 }, 'sheep', o).x, 60);
  known[1].visited = 1e9 - 60_000;
  assert.equal(pickVillage(known, { x: 0, z: 0 }, 'sheep', o), null);     // 300 is past 220
  assert.equal(pickVillage(known, { x: 0, z: 0 }, 'sheep', { ...o, dim: 'nether' }), null);
  assert.equal(pickVillage(known, { x: 0, z: 0 }, 'gold', o), null);
  // Night: only the close ones.
  assert.equal(pickVillage([mk(100, { bed: 4 })], { x: 0, z: 0 }, 'sheep', { ...o, night: true }), null);
  assert.ok(pickVillage([mk(30, { bed: 4 })], { x: 0, z: 0 }, 'sheep', { ...o, night: true }));
});

test('offers, loot and beds', () => {
  assert.deepEqual(offers({ kinds: { bed: 3, hay: 1, farm: 2, villager: 2 } }), { bed: 3, food: 4, chest: 0, villagers: 2, smith: 0 });
  assert.ok(lootWanted('iron_ingot') && lootWanted('minecraft:bread') && lootWanted('iron_pickaxe') && lootWanted('cooked_beef'));
  assert.ok(!lootWanted('oak_sapling') && !lootWanted('stick') && !lootWanted('wooden_pickaxe'));
  assert.ok(takeableBed('red_bed', { x: 100, z: 0 }, { x: 0, z: 0 }));
  assert.ok(!takeableBed('red_bed', { x: 5, z: 0 }, { x: 0, z: 0 }));  // our own house's bed
  assert.ok(!takeableBed('oak_planks', { x: 100, z: 0 }, null));
});
