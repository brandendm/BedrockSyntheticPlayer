import test from 'node:test';
import assert from 'node:assert/strict';
import { caveCourse, reachable, caveCommands, CAVE_KINDS, CAVE_EXT, UP, LOW } from '../behavior_pack/scripts/core/caves.js';

test('every cave can be walked from the start to the goal, for many seeds and levels', () => {
  for (const kind of CAVE_KINDS) for (let seed = 1; seed <= 40; seed++) for (const level of [1, 2, 3]) {
    const c = caveCourse(kind, seed, level);
    const path = reachable(c);
    assert.ok(path, `${kind} seed ${seed} level ${level}: no way through`);
    assert.ok(path.length >= 10, `${kind} seed ${seed}: the walk is only ${path.length} cells`);
  }
});
test('the walk never steps on lava, and the lava courses have lava next to the path', () => {
  for (let seed = 1; seed <= 20; seed++) for (const kind of ['cavedeep', 'caveascent']) {
    const c = caveCourse(kind, seed, 2);
    const lava = new Set();
    for (const f of c.fill) if (f.block === 'lava') for (let x = f.x1; x <= f.x2; x++) for (let y = f.y1; y <= f.y2; y++) for (let z = f.z1; z <= f.z2; z++) lava.add(`${x},${y},${z}`);
    assert.ok(lava.size >= 6);
    for (const [x, y, z] of reachable(c)) assert.ok(!lava.has(`${x},${y},${z}`), `${seed}: walks on lava at ${x},${y},${z}`);
  }
});
test('the same seed gives the same cave, another seed another', () => {
  assert.deepEqual(caveCourse('cavewalk', 7, 2), caveCourse('cavewalk', 7, 2));
  assert.notDeepEqual(caveCourse('cavewalk', 7, 2).air, caveCourse('cavewalk', 8, 2).air);
});
test('everything is inside the slab: rock above and below, within the extent', () => {
  for (const kind of CAVE_KINDS) for (let seed = 1; seed <= 25; seed++) {
    const c = caveCourse(kind, seed, 3);
    for (const b of [...c.air, ...c.fill]) {
      assert.ok(b.y1 >= -9 || b.y1 >= LOW - 2, `${kind} ${seed}: floor too low ${b.y1}`);
      if (kind !== 'caveescape' && kind !== 'caveascent') assert.ok(b.y2 <= UP + 2, `${kind} ${seed}: roof too high ${b.y2}`);
      assert.ok(b.x1 >= -c.ext.w && b.x2 <= c.ext.e, `${kind} ${seed}: x ${b.x1}..${b.x2} outside ${-c.ext.w}..${c.ext.e}`);
      assert.ok(b.z1 >= -c.ext.r && b.z2 <= c.ext.r, `${kind} ${seed}: z ${b.z1}..${b.z2} outside ±${c.ext.r}`);
    }
  }
});
test('mobs stand in the open, on the cave floor', () => {
  for (const kind of ['cavemobs', 'cavedeep', 'caveescape', 'caveascent']) for (let seed = 1; seed <= 25; seed++) {
    const c = caveCourse(kind, seed, 3);
    assert.ok(c.mobs.length >= 1, kind);
    const open = (x, y, z) => [...c.air, ...c.fill].some((b) => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2 && z >= b.z1 && z <= b.z2);
    for (const m of c.mobs) assert.ok(open(m.x, m.y, m.z) && open(m.x, m.y + 1, m.z), `${kind} ${seed}: ${m.type} at ${m.x},${m.y},${m.z} is in rock`);
  }
});
test('the escape cave starts deep and ends on the surface; the others end on a gold block in the rock', () => {
  const e = caveCourse('caveescape', 3, 2);
  assert.equal(e.start.y, LOW); assert.equal(e.goal.y, 1); assert.equal(e.exitFeetY, 1);
  const w = caveCourse('cavewalk', 3, 1);
  assert.equal(w.exitFeetY, null);
  assert.ok(caveCommands(w, 100, 150, 200).some((cmd) => /setblock \d+ \d+ \d+ gold_block/.test(cmd)));
  assert.ok(!caveCommands(e, 100, 150, 200).some((cmd) => /gold_block/.test(cmd)));
});
test('a caved-in cave is caught: block the squeeze and nothing gets through', () => {
  const c = caveCourse('cavewalk', 5, 1);
  const sq = c.air.find((b) => b.z2 === b.z1 && b.y1 === UP && b.x2 - b.x1 >= 3);
  assert.ok(sq, 'the one-wide squeeze exists');
  c.air = c.air.filter((b) => b !== sq);
  assert.equal(reachable(c), null);
});

test('every cave fits the one slab size the scenarios build', () => {
  for (const kind of CAVE_KINDS) for (let seed = 1; seed <= 40; seed++) for (const level of [1, 2, 3]) {
    const c = caveCourse(kind, seed, level);
    assert.deepEqual(c.ext, CAVE_EXT);
    assert.ok(CAVE_EXT.w + CAVE_EXT.e <= 62 && 2 * CAVE_EXT.r <= 62);
  }
});
