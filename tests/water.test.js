import test from 'node:test';
import assert from 'node:assert/strict';
import { waterReflex, airFloor, ownsWater, AIR_FLOOR, OWN_AIR_FLOOR, SWIM_AIR_FLOOR } from '../behavior_pack/scripts/core/water.js';

// The state of a bot swimming about with the motor free (the tow course's pond, a raw walk into it): the case that took u204's leadboat run.
const wet = (o = {}) => ({ task: 'auto', crossing: false, inBoat: false, inWater: true, headUnder: false, air: 1, swims: false, motorBusy: false, onGround: false, idle: 0, step: 4, ...o });
/** Run the reflex for `ticks` ticks of the same state; the first tick it acts, or null. */
const firstAct = (s, ticks = 400) => { let idle = s.idle; for (let t = 4; t <= ticks; t += 4) { const r = waterReflex({ ...s, idle }); if (r.act) return { act: r.act, at: t }; idle = r.idle; } return null; };

test('an ordinary job in water with the motor free is taken to the shore after 0.6 s (as before)', () => {
  assert.deepEqual(firstAct(wet()), { act: 'shore', at: 12 });
  assert.deepEqual(firstAct(wet({ task: 'explore' })), { act: 'shore', at: 12 });
});

test('a test, a tow, an arena or a calibration is never taken to the shore, however long it is in water (the u204 leadboat run, swim_out at 0.6 s)', () => {
  for (const task of ['test', 'tow', 'arena', 'calibrate']) {
    assert.equal(firstAct(wet({ task }), 4000), null, task);
    assert.equal(ownsWater(task), true, task);
  }
  assert.equal(firstAct(wet({ task: 'test', headUnder: true, onGround: true }), 4000), null); // (underwater at the pond's bottom, air still full)
});

test('our own boat crossing is left alone too, in the water or not', () => {
  assert.equal(firstAct(wet({ task: 'goto', crossing: true }), 4000), null);
  assert.equal(firstAct(wet({ task: 'auto', crossing: true, headUnder: true, air: 0.4 }), 4000), null);
  assert.equal(ownsWater('goto', true), true);
  assert.equal(ownsWater('goto', false), false);
});

test('but a job of its own in water is pulled up for air when it is really short of it', () => {
  assert.deepEqual(waterReflex(wet({ task: 'test', headUnder: true, air: OWN_AIR_FLOOR - 0.01 })), { act: 'air', idle: 0 });
  assert.equal(waterReflex(wet({ task: 'test', headUnder: true, air: OWN_AIR_FLOOR + 0.05 })).act, null);
  assert.equal(waterReflex(wet({ task: 'tow', headUnder: true, air: 0.1, inWater: true })).act, 'air');
  // ...and an ordinary job at the old half
  assert.equal(waterReflex(wet({ task: 'auto', headUnder: true, air: AIR_FLOOR - 0.01 })).act, 'air');
  assert.equal(waterReflex(wet({ task: 'auto', headUnder: true, air: AIR_FLOOR + 0.01 })).act, null);
});

test('an arena that dives keeps its lower floor; the swim-out already running is not started again', () => {
  assert.equal(airFloor('arena', true), SWIM_AIR_FLOOR);
  assert.equal(airFloor('auto', true), SWIM_AIR_FLOOR);
  assert.equal(airFloor('auto'), AIR_FLOOR);
  assert.equal(airFloor('test'), OWN_AIR_FLOOR);
  assert.equal(waterReflex(wet({ task: 'swim_out', headUnder: true, air: 0.1 })).act, null);
  assert.equal(waterReflex(wet({ task: 'auto', swims: true, headUnder: true, air: 0.3 })).act, null);
  assert.equal(waterReflex(wet({ task: 'auto', swims: true, headUnder: true, air: 0.2 })).act, 'air');
});

test('sitting in a boat, a busy motor, standing on the bottom with the head in the air, or being dry: nothing to swim out of', () => {
  assert.deepEqual(waterReflex(wet({ inBoat: true, headUnder: true, air: 0.1 })), { act: null, idle: 0 });
  assert.equal(firstAct(wet({ motorBusy: true }), 4000), null);
  assert.equal(firstAct(wet({ onGround: true, headUnder: false }), 4000), null);
  assert.deepEqual(waterReflex(wet({ inWater: false, idle: 8 })), { act: null, idle: 0 });
});

test('the idle count resets when the conditions lapse', () => {
  let r = waterReflex(wet({ idle: 0 }));
  assert.deepEqual(r, { act: null, idle: 4 });
  r = waterReflex(wet({ idle: r.idle }));
  assert.deepEqual(r, { act: null, idle: 8 });
  assert.deepEqual(waterReflex(wet({ idle: 8, motorBusy: true })), { act: null, idle: 0 });
  assert.deepEqual(waterReflex(wet({ idle: 8 })), { act: 'shore', idle: 0 });
});
