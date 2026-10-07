import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ring, encodeSlice, decodeSlice, renderSlice, makeCapsule, capsuleLines } from '../behavior_pack/scripts/core/capsule.js';

test('the ring keeps only the last ticks', () => {
  const r = new Ring(100);
  for (let t = 0; t < 400; t += 5) r.push({ tick: t });
  assert.ok(r.items.every((i) => i.tick >= 295));
  assert.ok(r.length <= 22);
  assert.deepEqual(r.since(380).map((i) => i.tick), [380, 385, 390, 395]);
});

test('a slice round-trips and is small for flat ground', () => {
  const box = { x1: 0, y1: 0, z1: 0, x2: 20, y2: 14, z2: 20 };
  const get = (x, y, z) => (y === 2 ? 'grass_block' : y < 2 ? 'dirt' : (x === 10 && z === 10 && y < 6 ? 'stone' : null));
  const s = encodeSlice(box, get), g = decodeSlice(s);
  for (let x = 0; x <= 20; x += 3) for (let y = 0; y <= 14; y++) for (let z = 0; z <= 20; z += 4) assert.equal(g(x, y, z), get(x, y, z) ?? 'air', `${x},${y},${z}`);
  assert.equal(g(30, 0, 0), null);
  assert.ok(JSON.stringify(s).length < 9000, `size ${JSON.stringify(s).length}`);
});

test('a capsule renders with the bot and the boat marked, and keeps the last seconds only', () => {
  const box = { x1: -10, y1: 0, z1: -10, x2: 10, y2: 8, z2: 10 };
  const s = encodeSlice(box, (x, y) => (y === 0 ? 'stone' : y === 1 && x > 2 ? 'stone' : null));
  const ring = new Ring(1000);
  for (let t = 0; t < 600; t += 5) ring.push({ tick: t, p: [t / 100, 1, 0], held: 'lead', boat: [t / 100 - 4, 1, 0] });
  const c = makeCapsule({ why: 'test', build: 'u250', tick: 600, at: { x: 0, y: 1, z: 0 }, bot: { hp: 20 }, ring, traces: [{ tick: 10, msg: 'old' }, { tick: 590, msg: 'tow: stuck' }], slice: s, entities: [{ type: 'boat', p: [-4, 1, 0], leashed: true }], secs: 10 });
  assert.ok(c.samples[0].tick >= 400, 'ten seconds');
  assert.deepEqual(c.trace.map((t) => t.msg), ['tow: stuck']);
  const text = capsuleLines(c).join('\n');
  assert.match(text, /@/); assert.match(text, /B/); assert.match(text, /CAPSULE JSON/);
  const back = JSON.parse(text.split('CAPSULE JSON: ')[1]);
  assert.equal(back.why, 'test');
  assert.equal(decodeSlice(back.slice)(3, 1, 0), 'stone');
  assert.ok(renderSlice(s, { x: 0, y: 1, z: 0 }).length > 20);
});
