import test from 'node:test';
import assert from 'node:assert/strict';
import { eigSym, cholesky, invSym, matmul, logdet, eye } from '../sim/linalg.mjs';

const A = [[4, 1, 0.5], [1, 3, 0.2], [0.5, 0.2, 2]];
test('eigSym: A v = λ v and the eigenvalues come out descending', () => {
  const { values, vectors } = eigSym(A);
  for (let k = 0; k < 3; k++) {
    const v = vectors.map((r) => r[k]), Av = A.map((r) => r.reduce((s, x, i) => s + x * v[i], 0));
    Av.forEach((x, i) => assert.ok(Math.abs(x - values[k] * v[i]) < 1e-9));
  }
  assert.ok(values[0] >= values[1] && values[1] >= values[2]);
});
test('cholesky and invSym reproduce A and the identity', () => {
  const L = cholesky(A);
  const LLt = matmul(L, L.map((_, j, m) => m.map((r) => r[j])));
  A.forEach((r, i) => r.forEach((x, j) => assert.ok(Math.abs(x - LLt[i][j]) < 1e-9)));
  const I = matmul(A, invSym(A));
  I.forEach((r, i) => r.forEach((x, j) => assert.ok(Math.abs(x - eye(3)[i][j]) < 1e-8)));
  assert.equal(cholesky([[1, 2], [2, 1]]), null);
  assert.ok(Math.abs(logdet(A) - Math.log(4 * (3 * 2 - 0.04) - 1 * (2 - 0.1) + 0.5 * (0.2 - 1.5))) < 1e-9);
});
