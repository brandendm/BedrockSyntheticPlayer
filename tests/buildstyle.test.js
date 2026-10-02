import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseStyle, mergeStyle, describeStyle, kindOf } from '../behavior_pack/scripts/core/buildstyle.js';

// A small room: walls placed 8 ticks apart standing 2.5 away, a door, a chest against the north wall with a sign above it,
// a furnace beside the table, and a pause of 3 s before each furnishing.
function rows() {
  const out = [];
  let t = 0;
  const wall = (x, y, z) => { t += 8; out.push({ t, id: 'minecraft:cobblestone', x, y, z, face: 'Up', px: x + 0.5, py: y - 1, pz: z + 2.5, g: 1, sn: 0 }); };
  for (let x = 0; x < 5; x++) for (let y = 65; y < 68; y++) { wall(x, y, 0); wall(x, y, 4); }
  for (let z = 1; z < 4; z++) for (let y = 65; y < 68; y++) { wall(0, y, z); wall(4, y, z); }
  const furn = (id, x, y, z, st) => { t += 60; out.push({ t, id: `minecraft:${id}`, x, y, z, face: 'Up', st, px: 2.5, py: 65, pz: 2.5, g: 1, sn: 0 }); };
  furn('oak_door', 2, 65, 4, null);
  furn('chest', 2, 65, 1, { 'minecraft:cardinal_direction': 'south' });
  furn('oak_wall_sign', 2, 66, 1, null);
  furn('crafting_table', 1, 65, 1, null);
  furn('furnace', 1, 65, 2, { 'minecraft:cardinal_direction': 'east' });
  return out;
}

test('kinds', () => { assert.equal(kindOf('minecraft:chest'), 'chest'); assert.equal(kindOf('oak_wall_sign'), 'sign'); assert.equal(kindOf('cobblestone'), null); });

test('the habits are read off the placements, not the plan', () => {
  const s = analyseStyle(rows());
  assert.ok(s);
  assert.equal(s.rhythm.blockGapTicks, 8);
  assert.ok(s.stand.reachWalls >= 2 && s.stand.reachWalls < 4.5, `reach ${s.stand.reachWalls}`);
  assert.equal(s.furnishings.chest.againstWall, 1);
  assert.equal(s.furnishings.sign.relationToChest.aboveChest, 1);
  assert.ok(s.furnishings.chest.toDoor >= 2 && s.furnishings.chest.toDoor <= 4);
  assert.equal(s.furnishings.furnace.toNearestOther, 1);
  assert.equal(s.furnishings.furnace.facesInward, 1); // (an east-facing furnace on the west side of the room)
  assert.ok(s.furnishings.chest.pauseBeforeTicks >= 50);
  assert.match(describeStyle(s), /signs: 1, 1 above chest/);
});

test('too few placements say nothing; sessions fold together', () => {
  assert.equal(analyseStyle(rows().slice(0, 5)), null);
  const s = analyseStyle(rows());
  const m = mergeStyle(s, { ...s, rhythm: { ...s.rhythm, blockGapTicks: 12 } });
  assert.equal(m.sessions, 2);
  assert.equal(m.rhythm.blockGapTicks, 10);
});
