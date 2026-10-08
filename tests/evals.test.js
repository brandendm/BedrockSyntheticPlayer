import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCombat, jobSets } from '../sim/evals.mjs';

test('parses the fixed suite: failures cost, deaths cost more, hits cost a little', () => {
  const out = [
    'ok   skeleton in the open, stone sword: lived (14 hp), killed 1/1, hits taken 2, blocked 0, gave up 0, longest idle while hunted 0.2 s, 5 s',
    'FAIL down a mine tunnel: skeleton behind two zombies, stone sword: DIED, killed 0/3, hits taken 8, blocked 0, gave up 0, longest idle while hunted 0.0 s, 6 s',
    'FAIL squeezed in the open: lived (20 hp), killed 0/3, hits taken 0, blocked 0, gave up 0, longest idle while hunted 1.6 s, 60 s',
  ].join('\n');
  const r = parseCombat({ kind: 'base' }, out);
  assert.deepEqual(r.lost, ['down a mine tunnel: skeleton behind two zombies, stone sword', 'squeezed in the open']);
  assert.ok(Math.abs(r.cost - (0.3 + 3 + 4 + 1.2 + 3)) < 1e-9, `cost ${r.cost}`);
});
test('parses the zombie and creeper summaries', () => {
  const z = parseCombat({ kind: 'zombies' }, '60 zombie fights: 0.30 hits taken a fight, a zombie inside its reach 0.12 s a fight, killed 50/84, 20.7 s a fight, died 0');
  assert.ok(Math.abs(z.cost - (1.8 + 0 + (1 - 50 / 84) * 3 + 20.7 / 40)) < 1e-9);
  const c = parseCombat({ kind: 'creepers' }, '32/40 without an explosion (80.0%), 2 died\n  forest 12/12');
  assert.ok(Math.abs(c.cost - (2 + 10)) < 1e-9);
  assert.equal(parseCombat({ kind: 'zombies' }, 'garbage').cost, 99);
});
test('train and held-out sets never share a random seed', () => {
  for (const g of ['tow', 'combat']) {
    const { train, held } = jobSets(g);
    const seeds = (js) => new Set(js.filter((j) => j.seed !== undefined).map((j) => `${j.kind}${j.seed}`));
    for (const s of seeds(train)) assert.ok(!seeds(held).has(s), s);
    assert.ok(train.length > 0 && held.length > 0);
  }
});
