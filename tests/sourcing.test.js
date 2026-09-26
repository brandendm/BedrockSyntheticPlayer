import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseSource, chooseSourceSticky, sourceKey, costOf, trustFor, DIG_DOWN_S, EXPLORE_S } from '../behavior_pack/scripts/core/sourcing.js';

test('logs lying on the ground beat chopping a tree the same distance away', () => {
  const best = chooseSource([
    { kind: 'visible', name: 'tree', dist: 20, units: 5, perUnitS: 3.5 },
    { kind: 'item', name: 'dropped logs', dist: 20, units: 3 },
  ], 3);
  assert.equal(best.name, 'dropped logs');
});

test('remembered surface stone vs digging down: distance decides', () => {
  const dig = { kind: 'dig', name: 'dig', dist: 0, units: Infinity, perUnitS: 1.1, fixedS: DIG_DOWN_S };
  const near = { kind: 'memory', name: 'stone', dist: 60, units: 20, perUnitS: 1.1 };
  const far = { ...near, dist: 250 };
  assert.equal(chooseSource([dig, near], 8).name, 'stone'); // 14 s walk + 9 s vs 25 s + 9 s
  assert.equal(chooseSource([dig, far], 8).name, 'dig');    // 58 s walk loses
});

test('a small stash that cannot cover the need is priced with the shortfall', () => {
  const small = { kind: 'item', name: 'two cobble', dist: 5, units: 2 };
  const dig = { kind: 'dig', name: 'dig', dist: 0, units: Infinity, perUnitS: 1.1, fixedS: DIG_DOWN_S };
  assert.ok(costOf(small, 8) > costOf(small, 2));
  assert.ok(Number.isFinite(costOf(small, 8)));
  assert.equal(chooseSource([small, dig], 2).name, 'two cobble');
});

test('old item memories are worth less; stale ones are worthless', () => {
  assert.equal(trustFor('item', 6 * 60_000), 0);
  assert.ok(trustFor('item', 60_000) > trustFor('item', 4 * 60_000));
  const fresh = { kind: 'item', dist: 30, units: 4, trust: trustFor('item', 10_000) };
  const stale = { kind: 'item', dist: 30, units: 4, trust: trustFor('item', 290_000) };
  assert.ok(costOf(stale, 4) > costOf(fresh, 4));
  assert.ok(costOf(stale, 4) < 30 / 4.3 + EXPLORE_S + 1);
});

test('sticky choice never sticks to exploring once a tree is in sight', () => {
  const explore = { kind: 'explore', dist: 0, units: Infinity, perUnitS: 3.5, fixedS: EXPLORE_S };
  const first = chooseSourceSticky([explore], 12, null);
  assert.equal(first.kind, 'explore');
  const tree = { kind: 'visible', dist: 10, units: 6, perUnitS: 3.5, target: { x: 10, y: 64, z: 0 } };
  const next = chooseSourceSticky([explore, tree], 12, sourceKey(first));
  assert.equal(next.kind, 'visible', 'goes for the tree it can see');
});

test('a tree right next to us beats a bigger remembered forest, even with a commitment to it', () => {
  const tree = { kind: 'visible', dist: 2, units: 3, perUnitS: 3.5, target: { x: 2, y: 64, z: 0 } };
  const forest = { kind: 'memory', dist: 30, units: 20, perUnitS: 3.5, trust: 0.98, entry: { pos: { x: 30, y: 64, z: 0 } } };
  const explore = { kind: 'explore', dist: 0, units: Infinity, perUnitS: 3.5, fixedS: EXPLORE_S };
  assert.equal(chooseSource([explore, tree, forest], 10).kind, 'visible');
  assert.equal(chooseSourceSticky([explore, tree, forest], 10, sourceKey(forest)).kind, 'visible');
});

test('a small far tree does not beat a big near memory: the shortfall is priced by the next source', () => {
  const small = { kind: 'visible', dist: 20, units: 2, perUnitS: 3.5, target: { x: 20, y: 64, z: 0 } };
  const forest = { kind: 'memory', dist: 12, units: 20, perUnitS: 3.5, trust: 1, entry: { pos: { x: 12, y: 64, z: 0 } } };
  assert.equal(chooseSource([small, forest], 10).kind, 'memory');
});
