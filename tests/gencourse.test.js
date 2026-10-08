import test from 'node:test';
import assert from 'node:assert/strict';
import { towParts, buildCourse, randomTowCourse } from '../sim/gencourse.mjs';
import { encodeSlice } from '../behavior_pack/scripts/core/capsule.js';
import { capsuleCourse } from '../sim/replay_capsule.mjs';

test('random tow courses: same seed, same course; parts can be dropped', () => {
  assert.deepEqual(towParts(7), towParts(7));
  assert.notDeepEqual(towParts(7), towParts(8));
  const p = towParts(3), a = buildCourse(p, 100, 150, 100), b = buildCourse(p.slice(1), 100, 150, 100);
  assert.ok(a.goal.x > b.goal.x && a.cmds.length > b.cmds.length);
  assert.equal(randomTowCourse(3, 100, 150, 100).desc, a.desc);
});

test('a capsule becomes a sim course (blocks, bot, boat, goal)', () => {
  const slice = encodeSlice({ x1: 0, y1: 0, z1: 0, x2: 3, y2: 3, z2: 3 }, (x, y) => (y === 0 ? 'stone' : x === 2 && y === 1 ? 'dirt' : 'air'));
  const c = capsuleCourse({ why: 't', build: 'x', slice, entities: [], samples: [{ tick: 1, p: [1, 1, 1], boat: [0.5, 1, 1] }], watch: { goal: [3, 1, 3] } });
  assert.ok(c.cmds.includes('fill 2 1 0 2 1 0 dirt') || c.cmds.some((s) => s.includes('dirt')));
  assert.deepEqual(c.goal, { x: 3, y: 1, z: 3 });
  assert.throws(() => capsuleCourse({ why: 't', build: 'x', slice, entities: [], samples: [], watch: null }));
});

import { towTune, tuneDefaults, TOW_TUNE } from '../behavior_pack/scripts/core/towtune.js';
test('tow tuning: defaults, clamped overrides, unknown keys ignored', () => {
  assert.equal(towTune().loFloor, 5.4);
  assert.equal(towTune({ loFloor: 99 }).loFloor, TOW_TUNE.loFloor.max);
  assert.equal(towTune({ nonsense: 1 }).nonsense, undefined);
  assert.equal(towTune({ guardMax: NaN }).guardMax, tuneDefaults().guardMax);
});
test('level 2 courses have pits and a block kit; level 1 are unchanged by the level argument', () => {
  let pit = false; for (let s = 1; s < 30; s++) if (towParts(s, 2).some((p) => p.kind === 'pit')) { pit = true; assert.ok(buildCourse(towParts(s, 2), 100, 150, 100).kit.some(([id]) => id === 'dirt')); break; }
  assert.ok(pit);
  assert.deepEqual(towParts(5), towParts(5, 1));
});
