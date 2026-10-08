import test from 'node:test';
import assert from 'node:assert/strict';
import { select, depsOf } from '../tools/impact.mjs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
test('a change to a core module selects the tests that import it, and the gate when the sim reaches it', () => {
  const s = select(['behavior_pack/scripts/core/vanilla.js']);
  assert.ok(s.unit.includes('tests/vanilla.test.js'));
  assert.equal(s.gate, false); // (nothing the sim loads reads it)
  const g = select(['behavior_pack/scripts/core/towline.js']);
  assert.equal(g.gate, true);
});
test('docs are skipped, the brain has its own tests, an unreached game file runs everything', () => {
  assert.deepEqual(select(['README.md']).unit, []);
  assert.equal(select(['brain/autorun.py']).brain, true);
  const s = select(['behavior_pack/scripts/main.js']);
  assert.equal(s.all, false); // (main.js cannot load off the game: the import check covers it)
  assert.ok(s.notes.some((n) => /check_imports/.test(n)));
});
test('depsOf follows dynamic imports with literal paths', () => {
  assert.ok(depsOf(path.join(root, 'sim/run_tow.mjs')).has(path.join(root, 'behavior_pack/scripts/game/agent.js')));
});
