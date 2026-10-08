// Small dense linear algebra for the calibration analysis (n is ~16): symmetric eigen (Jacobi), Cholesky, solve. Plain arrays of arrays.
export const zeros = (n, m = n) => Array.from({ length: n }, () => new Array(m).fill(0));
export const eye = (n) => { const a = zeros(n); for (let i = 0; i < n; i++) a[i][i] = 1; return a; };
export const transpose = (a) => a[0].map((_, j) => a.map((r) => r[j]));
export const matmul = (a, b) => a.map((r) => b[0].map((_, j) => r.reduce((s, v, k) => s + v * b[k][j], 0)));
/** Jᵀ J for a matrix whose rows are residual samples and columns are parameters, without forming the transpose. */
export function gram(J, n) {
  const g = zeros(n);
  for (const r of J) for (let i = 0; i < n; i++) { const ri = r[i]; if (!ri) continue; for (let j = i; j < n; j++) g[i][j] += ri * r[j]; }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) g[i][j] = g[j][i];
  return g;
}
/** Eigenvalues (descending) and eigenvectors (columns of `vectors`, same order) of a symmetric matrix, by cyclic Jacobi rotations. */
export function eigSym(A, sweeps = 60) {
  const n = A.length, a = A.map((r) => [...r]), v = eye(n);
  for (let s = 0; s < sweeps; s++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), sn = t * c;
      for (let k = 0; k < n; k++) { const kp = a[k][p], kq = a[k][q]; a[k][p] = c * kp - sn * kq; a[k][q] = sn * kp + c * kq; }
      for (let k = 0; k < n; k++) { const pk = a[p][k], qk = a[q][k]; a[p][k] = c * pk - sn * qk; a[q][k] = sn * pk + c * qk; }
      for (let k = 0; k < n; k++) { const kp = v[k][p], kq = v[k][q]; v[k][p] = c * kp - sn * kq; v[k][q] = sn * kp + c * kq; }
    }
  }
  const order = a.map((_, i) => i).sort((x, y) => a[y][y] - a[x][x]);
  return { values: order.map((i) => a[i][i]), vectors: v.map((r) => order.map((i) => r[i])) };
}
/** Lower-triangular L with L Lᵀ = A (A symmetric positive definite), or null. */
export function cholesky(A) {
  const n = A.length, L = zeros(n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j];
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    if (i === j) { if (s <= 0) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
  }
  return L;
}
/** A⁻¹ for a symmetric positive-definite A (via its eigen-decomposition; eigenvalues under `floor` are raised to it). */
export function invSym(A, floor = 1e-12) {
  const { values, vectors } = eigSym(A), n = A.length, out = zeros(n);
  for (let k = 0; k < n; k++) { const w = 1 / Math.max(values[k], floor); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i][j] += w * vectors[i][k] * vectors[j][k]; }
  return out;
}
export const logdet = (A, floor = 1e-12) => eigSym(A).values.reduce((s, x) => s + Math.log(Math.max(x, floor)), 0);
