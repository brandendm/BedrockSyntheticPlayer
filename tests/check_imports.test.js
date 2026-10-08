import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, exportsOf, importsOf } from '../tools/check_imports.mjs';

test('exportsOf / importsOf read the usual forms', () => {
  const e = exportsOf("export const A = 1;\nexport async function b() {}\nexport class C {}\nexport { d, e as f };\n");
  assert.deepEqual([...e].sort(), ['A', 'C', 'b', 'd', 'f']);
  const i = importsOf("import { x, y as z } from './m.js';\nimport def, { q } from './n.js';\nimport { w } from '@minecraft/server';");
  assert.deepEqual(i[0].named, ['x', 'y']);
  assert.equal(i[1].def, 'def');
});
test('check finds a missing export and a missing file, and passes the real pack', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  fs.writeFileSync(path.join(d, 'a.js'), "import { nope, yes } from './b.js';\nimport './missing.js';\n".replace("import './missing.js';", "import { z } from './missing.js';"));
  fs.writeFileSync(path.join(d, 'b.js'), 'export const yes = 1;\n');
  const p = check(d);
  assert.equal(p.length, 2);
  assert.match(p.join('\n'), /nope/);
  assert.deepEqual(check(new URL('../behavior_pack/scripts', import.meta.url).pathname), []);
});
