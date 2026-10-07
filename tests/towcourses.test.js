import { test } from 'node:test';
import assert from 'node:assert/strict';
import { towCourse, TOW_NAMES, TOW_META } from '../behavior_pack/scripts/core/towcourses.js';

// A tiny world from the commands: air unless filled.
function world(c) {
  const m = new Map();
  for (const cmd of c.cmds) {
    const p = cmd.split(' ');
    if (p[0] === 'fill') { const [x1, y1, z1, x2, y2, z2] = p.slice(1, 7).map(Number); for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) m.set(`${x},${y},${z}`, p[7]); }
    else if (p[0] === 'setblock') m.set(`${p[1]},${p[2]},${p[3]}`, p[4]);
  }
  return (x, y, z) => m.get(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`) ?? 'air';
}
const solid = (id) => id !== 'air' && id !== 'gold_block' ? true : id === 'gold_block';
/** Walk with a 1-up jump and drops up to 3, from the start; the goal reached? `dig`: 'bridge' also lets it cross a gap up to n wide. */
function walk(id, c, { gap = 0 } = {}) {
  const standable = (x, y, z) => !solid(id(x, y, z)) && !solid(id(x, y + 1, z)) && solid(id(x, y - 1, z));
  const s = { x: Math.floor(c.start.x), y: Math.floor(c.start.y), z: Math.floor(c.start.z) };
  const seen = new Set([`${s.x},${s.y},${s.z}`]), q = [s];
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    if (Math.abs(p.x + 0.5 - c.goal.x) < 2 && Math.abs(p.z + 0.5 - c.goal.z) < 2 && Math.abs(p.y - Math.floor(c.goal.y)) <= 1) return true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let k = 1; k <= 1 + gap; k++) {
        for (let dy = 1; dy >= -3; dy--) {
          const n = { x: p.x + dx * k, y: p.y + dy, z: p.z + dz * k };
          if (dy === 1 && solid(id(p.x, p.y + 2, p.z))) continue;
          if (!standable(n.x, n.y, n.z)) continue;
          // (over a gap: every cell between is open air at this level and below, nothing solid in the way at body height)
          if (k > 1 && ![...Array(k - 1).keys()].every((j) => !solid(id(p.x + dx * (j + 1), p.y, p.z + dz * (j + 1))) && !solid(id(p.x + dx * (j + 1), p.y + 1, p.z + dz * (j + 1))))) continue;
          const key = `${n.x},${n.y},${n.z}`;
          if (!seen.has(key)) { seen.add(key); q.push(n); }
          break;
        }
      }
    }
  }
  return false;
}

test('every course has its text, kit, and a start, boat and goal that are clear with a floor under them', () => {
  for (const name of TOW_NAMES) {
    const c = towCourse(name, 100, 64, 200), id = world(c);
    assert.ok(TOW_META[name].text.length > 80 && TOW_META[name].short, name);
    assert.ok(TOW_META[name].kit.some(([k]) => k === 'lead'), `${name} gives a lead`);
    for (const [what, p] of [['start', c.start], ['boat', c.boat], ['goal', c.goal]]) {
      const y = Math.floor(p.y);
      assert.ok(!solid(id(p.x, y, p.z)) && !solid(id(p.x, y + 1, p.z)), `${name} ${what} is in the open`);
      assert.ok(solid(id(p.x, y - 1, p.z)), `${name} ${what} has a floor`);
    }
    // inside the slab the site reaches
    const { w, e, r } = TOW_META[name].ext;
    assert.ok(c.goal.x < 100 + e && Math.abs(c.goal.z - 200) < r, `${name} goal inside the site`);
  }
});

test('the courses with no gap can be walked from the start to the goal; the ledge cannot without building over its pit', () => {
  for (const name of ['leadstep', 'leadstair', 'leadturn', 'leadgate']) {
    const c = towCourse(name, 100, 64, 200);
    assert.ok(walk(world(c), c), `${name} can be walked`);
  }
  const c = towCourse('leadledge', 100, 64, 200), id = world(c);
  assert.ok(!walk(id, c), 'the ledge course is closed to walking');
  assert.ok(walk(id, c, { gap: 6 }), 'and open when the pit is bridged');
});

test('the corners and gates are real obstacles: a straight line from the boat to the goal is blocked', () => {
  for (const name of ['leadturn', 'leadgate', 'leadstep']) {
    const c = towCourse(name, 100, 64, 200), id = world(c);
    let blocked = false;
    for (let t = 0; t <= 100 && !blocked; t++) { const x = c.boat.x + (c.goal.x - c.boat.x) * t / 100, z = c.boat.z + (c.goal.z - c.boat.z) * t / 100; if (solid(id(x, c.boat.y, z))) blocked = true; }
    assert.ok(blocked, `${name}: the straight line is blocked`);
  }
});

test('u242 live: nothing beside the lane can be walked along on the outside (the bot walked round the walls and left the boat behind)', () => {
  for (const name of TOW_NAMES) {
    const c = towCourse(name, 100, 64, 200), id = world(c), { r } = TOW_META[name].ext;
    // ground-level walk (no climbing) from the start, over the open start area
    const s = { x: Math.floor(c.start.x), y: Math.floor(c.start.y), z: Math.floor(c.start.z) };
    const seen = new Set([`${s.x},${s.z}`]), q = [s];
    const ok = (x, z) => !solid(id(x, s.y, z)) && !solid(id(x, s.y + 1, z)) && solid(id(x, s.y - 1, z));
    for (let i = 0; i < q.length; i++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: q[i].x + dx, z: q[i].z + dz };
      if (!ok(n.x, n.z) || seen.has(`${n.x},${n.z}`)) continue;
      seen.add(`${n.x},${n.z}`); q.push(n);
    }
    const outside = [...seen].map((k) => k.split(',').map(Number)).filter(([x, z]) => x >= 100 && (z - 200 >= 5 || z - 200 <= -5) && !(name === 'leadturn'));
    assert.equal(outside.length, 0, `${name}: ${outside.length} ground cells beside the lane, e.g. ${outside[0]}`);
    if (name === 'leadturn') assert.ok([...seen].every((k) => { const [x, z] = k.split(',').map(Number); return x < 100 || (z - 200 >= -1 && z - 200 <= 9); }), 'leadturn: only the corridor can be walked');
  }
});
