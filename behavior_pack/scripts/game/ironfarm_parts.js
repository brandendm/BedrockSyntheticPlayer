// The pieces of the iron farm builder (game/ironfarm.js) that have to cope with the game not doing quite what the plan assumes: a slab that has
// another name, signs that hang the other way round, fence gates that will not open, a door that will not go in, two chests that do not pair,
// water that will not flow. Each tries the next thing, reads the result back, and says what it found.
import {
  blockArg, settleWater, render, waterSources, SIGNS, HOPPERS, CHESTS, CHEST_FACING, CAMPFIRES, DOOR, DOOR_ID, STEP, WATER_Y, HOLE, GATES, GATE_ID,
  LAVA, CHAMBER_WATER, CHAMBER_WET, CHAMBER_FLOOR_Y,
} from '../core/ironfarm.js';
import { wait, run, W, idAt, stateAt, kick, isWater, chestSize } from './ironfarm_world.js';

export const VILLAGERS = ['minecraft:villager_v2', 'minecraft:villager'];
export const WANT = 10;
/** Ways the cobblestone slab is spelt in the game's block names, tried in this order until one is accepted. */
export const SLAB_IDS = ['cobblestone_slab', 'stone_block_slab ["stone_slab_type"="cobblestone"]', 'oak_slab', 'wooden_slab'];
export const SIGN_IDS = ['wall_sign', 'oak_wall_sign', 'spruce_wall_sign'];
export const DOOR_IDS = [DOOR_ID, 'oak_door'];
export const GATE_IDS = [GATE_ID, 'oak_fence_gate'];
/** Ways to say "an open fence gate" in block states, tried in this order (the plan's own first). */
export const GATE_STATES = [{ direction: 0, open_bit: true, in_wall_bit: false }, { open_bit: true }, { 'minecraft:cardinal_direction': 'north', open_bit: true }];
export const OPPOSITE = { 2: 3, 3: 2, 4: 5, 5: 4 };

/** Find a spelling of the cobblestone slab the game accepts: the first slab run is tried with each, and read back. Returns it, or null. */
export async function findSlab(dim, a, b, notes) {
  for (const cand of SLAB_IDS) {
    const why = run(dim, `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${cand}`);
    await wait(1);
    if (!why && idAt(dim, a).includes('slab')) return cand;
    run(dim, `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} air`);
  }
  notes.push('NO slab spelling was accepted: the bare tops are not covered, so golems may also spawn on them.');
  return null;
}

/**
 * The wall signs: the four that cap the hole in the platform's floor, the two that keep the hallway's water off the campfire and the three that
 * hold the lava. Each is placed facing the way the plan says, given a block update from a neighbour (a sign with nothing to hang on stays until it
 * gets one), and read back; if it is gone the other way round is tried, then the next spelling of the name. Returns { ok, holeOk, chamberOk, lavaOk, id }.
 */
export async function placeSigns(dim, off, notes) {
  let id = null, flip = false, first = true;
  const done = new Map();
  for (const s of SIGNS) {
    const q = W(off, s);
    let ok = false;
    for (const cand of id ? [id] : SIGN_IDS) {
      for (const facing of flip ? [OPPOSITE[s.facing], s.facing] : [s.facing, OPPOSITE[s.facing]]) {
        const why = run(dim, `setblock ${q.x} ${q.y} ${q.z} ${blockArg(cand, { facing_direction: facing })}`);
        if (why) { if (!id) notes.push(`Sign ${cand} facing ${facing}: ${why}.`); continue; }
        await wait(2);
        await kick(dim, q);
        if (idAt(dim, q).endsWith('wall_sign')) { ok = true; id = cand; if (facing !== s.facing && first) flip = true; break; }
        notes.push(`Sign ${cand} facing ${facing} at ${s.x},${s.y},${s.z} would not stay.`);
        run(dim, `setblock ${q.x} ${q.y} ${q.z} air`);
      }
      if (ok) break;
    }
    if (ok) first = false;
    done.set(s, ok);
    if (!ok) notes.push(`The sign at ${s.x},${s.y},${s.z} (plan coordinates; ${s.group}) would not stay on its wall.`);
  }
  const group = (g) => SIGNS.filter((s) => s.group === g).every((s) => done.get(s));
  const holeOk = group('hole'), chamberOk = group('chamber'), lavaOk = group('lava');
  if (flip && holeOk && chamberOk && lavaOk) notes.push('(The signs hold the other way round to the plan: facing_direction names the side the sign hangs on here.)');
  return { ok: holeOk && chamberOk && lavaOk, holeOk, chamberOk, lavaOk, id };
}

/**
 * The four open fence gates over the hole. Each is placed with the plan's states, read back (is it a gate, is it open?); if it is not, the next way
 * of saying "open" is tried, then the next spelling of the name. Returns { ok (all four there and open), id, open (how many read as open) }.
 */
export async function placeGates(dim, off, notes) {
  let id = null, states = null, there = 0, open = 0;
  for (const g of GATES) {
    const q = W(off, g);
    let done = false;
    for (const cand of id ? [id] : GATE_IDS) {
      for (const st of states ? [states] : GATE_STATES) {
        const why = run(dim, `setblock ${q.x} ${q.y} ${q.z} ${blockArg(cand, st)}`);
        if (why) { notes.push(`Gate ${blockArg(cand, st)}: ${why}.`); continue; }
        await wait(1);
        if (idAt(dim, q).endsWith('fence_gate')) {
          if (stateAt(dim, q, 'open_bit') === true) { done = true; id = cand; states = st; break; }
          notes.push(`Gate ${blockArg(cand, st)}: placed, but it reads back shut (open_bit ${stateAt(dim, q, 'open_bit')}).`);
        }
        run(dim, `setblock ${q.x} ${q.y} ${q.z} air`);
      }
      if (done) break;
    }
    if (idAt(dim, q).endsWith('fence_gate')) { there++; if (stateAt(dim, q, 'open_bit') === true) open++; }
    if (!done) notes.push(`The gate at ${g.x},${g.y},${g.z} (plan coordinates) would not go in open.`);
  }
  if (open < GATES.length) notes.push(`Only ${open} of ${GATES.length} gates over the hole are in and open: the water will meet over the hole as before (u211) and the golems will go down slowly. Put open fence gates there by hand.`);
  return { ok: open === GATES.length, id, open, there };
}

/**
 * The door in the room's wall: both halves, read back. If no spelling is accepted the doorway is left open (2 high) and that is said.
 * `lower` and `upper` are the plan's two door ops.
 */
export async function placeDoor(dim, off, lower, upper, notes) {
  const lo = W(off, DOOR), hi = W(off, { x: DOOR.x, y: DOOR.y + 1, z: DOOR.z });
  const clear = () => { run(dim, `setblock ${lo.x} ${lo.y} ${lo.z} air`); run(dim, `setblock ${hi.x} ${hi.y} ${hi.z} air`); };
  for (const cand of DOOR_IDS) {
    clear();
    const a = run(dim, `setblock ${lo.x} ${lo.y} ${lo.z} ${blockArg(cand, lower.states)}`);
    const b = run(dim, `setblock ${hi.x} ${hi.y} ${hi.z} ${blockArg(cand, upper.states)}`);
    await wait(2);
    if (!a && !b && idAt(dim, lo).endsWith('door') && idAt(dim, hi).endsWith('door')) {
      const dir = stateAt(dim, lo, 'direction'), up = stateAt(dim, hi, 'upper_block_bit');
      if (up === false) notes.push('(The upper half of the door reads as a lower half: the door may not be whole.)');
      return { ok: true, id: cand, direction: dir };
    }
    if (!a && !b) notes.push(`Door ${cand}: placed, but it reads back as ${idAt(dim, lo)} / ${idAt(dim, hi)}.`);
    else notes.push(`Door ${cand}: ${a || b}.`);
  }
  clear();
  notes.push('NO door was accepted: the room has an open doorway in its east wall (2 high). Put a door in it by hand.');
  return { ok: false, id: null, direction: undefined };
}

/** Do the two chests make a double chest (54 slots)? If not, put the second one in again, then the first. Returns a sentence. */
export async function pairChests(dim, off) {
  const [a, b] = CHESTS.map((c) => W(off, c));
  const put = (q) => run(dim, `setblock ${q.x} ${q.y} ${q.z} ${blockArg('chest', { 'minecraft:cardinal_direction': CHEST_FACING })}`);
  let n = chestSize(dim, a);
  if (n === 54) return { ok: true, note: 'Chest: a double chest (54 slots).' };
  const tried = [`as placed: ${n} slots`];
  for (const { name, redo } of [{ name: 'the second chest re-placed', redo: b }, { name: 'the first chest re-placed', redo: a }]) {
    run(dim, `setblock ${redo.x} ${redo.y} ${redo.z} air`);
    await wait(2);
    put(redo);
    await wait(2);
    n = chestSize(dim, a);
    tried.push(`${name}: ${n} slots`);
    if (n === 54) return { ok: true, note: `Chest: a double chest (54 slots) after the nudge (${tried.join('; ')}).` };
  }
  return { ok: false, note: `Chest: the two chests did NOT join into a double chest (${tried.join('; ')}). They work as two single chests side by side: the hoppers fill the near one (${CHESTS[0].x},${CHESTS[0].z} plan) and the far one stays empty. Break the far chest and put it back by hand to join them.` };
}

// ---- the water ----
/**
 * The water on the platform floor: how many of the cells it should reach have it, the depth in each, and how many of them are SOURCES (depth 0).
 * `holeWet` is how many of the four cells over the hole have water in them (none, with the gates in). More sources than planned means cells have turned into sources (Bedrock's infinite-water rule: a flowing cell that touches two sources): the
 * water then lies still where that happened. "Wet" alone cannot tell (u209 was wet in all 252 cells and had no current).
 */
export function waterOnPlatform(dim, off, plan) {
  const field = settleWater(render(plan), waterSources(), WATER_Y).field;
  let have = 0, sources = 0;
  /** @type {Record<string, number | undefined>} */
  const depth = {};
  for (const [k] of field) {
    const [x, z] = k.split(',').map(Number);
    const q = W(off, { x, y: WATER_Y, z });
    if (isWater(idAt(dim, q))) { have++; depth[k] = stateAt(dim, q, 'liquid_depth'); if (depth[k] === 0) sources++; }
  }
  const planned = waterSources().length;
  let holeWet = 0;
  for (let x = HOLE.x1; x <= HOLE.x2; x++) for (let z = HOLE.z1; z <= HOLE.z2; z++) if (isWater(idAt(dim, W(off, { x, y: WATER_Y, z })))) holeWet++;
  return { have, want: field.size, field, depth, holeWet, sources, planned, pooled: sources > planned };
}

const waterRows = (plan) => plan.ops.filter((o) => o.tag === 'water');

/** Water in the shaft above the hallway (the signs were meant to stop it): how many wet cells there are below the platform's floor, from one layer over the hallway's up. */
export function shaftWater(dim, off) {
  let n = 0;
  for (let x = HOLE.x1; x <= HOLE.x2; x++) for (let z = HOLE.z1; z <= HOLE.z2; z++) for (let y = CHAMBER_FLOOR_Y + 1; y <= 2; y++) if (isWater(idAt(dim, W(off, { x, y, z })))) n++;
  return n;
}

/**
 * The hallway's one water source: put in, given time to run (it should wet its two neighbours and nothing else: the signs keep it off the
 * campfire's cell), a block update if it does not, the two flowing cells laid by hand if that does not work either. Says what it found.
 * Returns { ok, note }.
 */
export async function chamberWater(dim, off) {
  const src = W(off, CHAMBER_WATER);
  const wet = () => CHAMBER_WET.filter((c) => isWater(idAt(dim, W(off, c)))).length;
  const stray = () => {
    const out = [];
    for (let x = 7; x <= 9; x++) for (let z = 7; z <= 8; z++) {
      if (CHAMBER_WET.some((c) => c.x === x && c.z === z)) continue;
      const t = idAt(dim, W(off, { x, y: CHAMBER_FLOOR_Y, z }));
      if (isWater(t) || (CAMPFIRES.some((c) => c.x === x && c.z === z) && t === 'campfire' && stateAt(dim, W(off, { x, y: CHAMBER_FLOOR_Y, z }), 'extinguished') === true)) out.push(`${x},${z}`);
    }
    return out;
  };
  const tried = [];
  run(dim, `setblock ${src.x} ${src.y} ${src.z} water`);
  await wait(40);
  tried.push(`source placed: ${wet()} of ${CHAMBER_WET.length} cells wet`);
  if (wet() < CHAMBER_WET.length) {
    await kick(dim, src);
    await wait(40);
    tried.push(`block update beside it: ${wet()} of ${CHAMBER_WET.length}`);
  }
  let hand = false;
  if (wet() < CHAMBER_WET.length) {
    hand = true;
    for (const c of CHAMBER_WET) {
      const q = W(off, c);
      if (c.level > 0 && !isWater(idAt(dim, q))) run(dim, `setblock ${q.x} ${q.y} ${q.z} flowing_water ["liquid_depth"=${c.level}]`);
    }
    await wait(20);
    tried.push(`flowing cells laid by hand: ${wet()} of ${CHAMBER_WET.length}`);
  }
  const bad = stray();
  const ok = wet() === CHAMBER_WET.length && !bad.length;
  const note = `Hallway water: ${ok ? 'running (north and east of its source)' : 'NOT right'} (${wet()} of ${CHAMBER_WET.length} cells wet). ${tried.join('; ')}.${bad.length ? ` WATER OR A PUT-OUT CAMPFIRE WHERE IT SHOULD BE DRY at ${bad.join(' ')}: the signs did not keep the water off the campfire.` : ''}${ok && hand ? ' It would not spread by itself, so the two flowing cells are placed by hand.' : ''}`;
  return { ok, note, wet: wet(), stray: bad };
}

/**
 * Put the water sources in and make sure they flow over the whole platform. Each remedy is tried only if the one before left some of the cells dry;
 * returns what worked (or that nothing did) in words.
 */
export async function ensureWater(dim, off, plan) {
  const rows = waterRows(plan);
  const put = (id) => { for (const o of rows) { const a = W(off, { x: o.box.x1, y: o.box.y1, z: o.box.z1 }), b = W(off, { x: o.box.x2, y: o.box.y2, z: o.box.z2 }); run(dim, `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${id}`); } };
  const tried = [];
  const settle = async (name, ticks) => {
    await wait(ticks);
    const s = waterOnPlatform(dim, off, plan);
    tried.push(`${name}: ${s.have} of ${s.want} cells`);
    return s;
  };
  put('water');
  let s = await settle('sources placed', 60);
  if (s.have < s.want) {
    // 1: a block update beside some of the sources (a source made by a command may not know it should spread until something next to it changes).
    // (A row of blocks laid on top of each row of sources and taken off again: one update for every source in it.)
    for (const o of rows) { const a = W(off, { x: o.box.x1, y: o.box.y1 + 1, z: o.box.z1 }), b = W(off, { x: o.box.x2, y: o.box.y2 + 1, z: o.box.z2 }); run(dim, `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} cobblestone`); }
    await wait(2);
    for (const o of rows) { const a = W(off, { x: o.box.x1, y: o.box.y1 + 1, z: o.box.z1 }), b = W(off, { x: o.box.x2, y: o.box.y2 + 1, z: o.box.z2 }); run(dim, `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} air`); }
    s = await settle('block update beside the sources', 60);
  }
  if (s.have < s.want) {
    // 2: the sources out and in again.
    put('air');
    await wait(10);
    put('water');
    s = await settle('sources taken out and put back', 60);
  }
  let hand = false;
  if (s.have < s.want) {
    // 3: lay the flowing water by hand, nearest the sources first, each at the depth it would have.
    hand = true;
    const cells = [...s.field].filter(([, l]) => l > 0).sort((a, b) => a[1] - b[1]);
    let bad = 0;
    for (const [k, l] of cells) {
      const [x, z] = k.split(',').map(Number);
      const q = W(off, { x, y: WATER_Y, z });
      if (isWater(idAt(dim, q))) continue;
      if (run(dim, `setblock ${q.x} ${q.y} ${q.z} flowing_water ["liquid_depth"=${l}]`)) bad++;
    }
    s = await settle(`flowing water laid by hand${bad ? ` (${bad} cells refused)` : ''}`, 40);
  }
  const down = shaftWater(dim, off);
  const ok = s.have >= s.want && !s.pooled;
  const pool = s.pooled ? ` THE WATER IS POOLING: ${s.sources} source blocks, ${s.planned} planned, so ${s.sources - s.planned} cells turned into sources (the game makes a flowing cell that touches two sources a source) and the water lies still there.` : '';
  const note = `Water: ${ok ? 'flowing over the whole platform' : 'NOT right'} (${s.have} of ${s.want} cells wet, ${s.sources} sources of ${s.planned} planned, ${s.holeWet ? `${s.holeWet} of the 4 cells over the hole wet: THE GATES DO NOT KEEP THE WATER OUT` : 'the hole itself dry, kept so by the gates'}). ${tried.join('; ')}.${pool}${ok && hand ? ' It would not spread by itself, so the flowing water is placed cell by cell: if it dries up, the game does not treat command-placed water as water that flows.' : ''}${ok && !hand && tried.length > 1 ? ' (It needed the nudge: the first placement alone did not spread.)' : ''}${down ? ` WATER GOT INTO THE SHAFT (${down} cells): the signs over the hole did not stop it, and it will put the campfire out and meet the lava.` : ''}`;
  return { ok, note, state: s, shaftWet: down };
}

/** Read back what matters: a list of what is not as it should be. */
export function verify(dim, off, plan) {
  const bad = [];
  const typeAt = (q) => idAt(dim, W(off, q));
  let beds = 0, comps = 0;
  for (const b of plan.beds) { if (typeAt(b.head) === 'bed') beds++; if (typeAt(b.foot) === 'bed') beds++; }
  for (const s of plan.stations) if (typeAt(s) === 'composter') comps++;
  if (beds !== plan.beds.length * 2) bad.push(`${beds} of ${plan.beds.length * 2} bed halves in place`);
  if (comps !== plan.stations.length) bad.push(`${comps} of ${plan.stations.length} composters`);
  for (const s of SIGNS) {
    const t = typeAt(s);
    if (!t.endsWith('wall_sign')) bad.push(`${t} where a sign should be at ${s.x},${s.y},${s.z}`);
  }
  for (const q of GATES) {
    const t = typeAt(q);
    if (!t.endsWith('fence_gate')) bad.push(`${t} where a gate should be at ${q.x},${q.z}`);
    else if (stateAt(dim, W(off, q), 'open_bit') !== true) bad.push(`the gate at ${q.x},${q.z} is shut`);
  }
  const lt = typeAt(LAVA);
  if (lt !== 'lava') bad.push(`${lt} where the lava should be`);
  const cw = typeAt(CHAMBER_WATER);
  if (!isWater(cw)) bad.push(`${cw} where the hallway's water source should be`);
  for (const h of HOPPERS) {
    const f = stateAt(dim, W(off, h), 'facing_direction');
    if (typeAt(h) !== 'hopper') bad.push(`${typeAt(h)} where the hopper should be at ${h.x},${h.z}`);
    else if (f !== h.facing) bad.push(`the hopper at ${h.x},${h.z} reads facing_direction ${f}, not ${h.facing}`);
  }
  for (const c of CHESTS) if (typeAt(c) !== 'chest') bad.push(`${typeAt(c)} where a chest should be at ${c.x},${c.z}`);
  for (const c of CAMPFIRES) {
    const t = typeAt(c);
    if (t !== 'campfire') bad.push(`${t} where a campfire should be at ${c.x},${c.z}`);
    else if (stateAt(dim, W(off, c), 'extinguished') === true) bad.push(`the campfire at ${c.x},${c.z} is out`);
  }
  let src = 0;
  const sources = waterSources();
  for (const s of sources) if (typeAt({ x: s.x, y: WATER_Y, z: s.z }) === 'water') src++;
  if (src !== sources.length) bad.push(`${src} of ${sources.length} water sources`);
  const torchOps = plan.ops.filter((o) => o.id === 'torch');
  const torches = torchOps.filter((o) => typeAt(o) === 'torch').length;
  if (torches !== torchOps.length) bad.push(`${torches} of ${torchOps.length} torches`);
  if (!typeAt(STEP).includes('slab')) bad.push(`${typeAt(STEP)} where the step should be`);
  return bad;
}

// The profession reading (the skin, `variant`, is the biome's and differs from villager to villager; it says nothing about a nitwit).
const markOf = (e) => { try { return e.getComponent('minecraft:mark_variant')?.value ?? null; } catch { return null; } };
export const isBaby = (e) => { try { return e.hasComponent('minecraft:is_baby'); } catch { return false; } };

/**
 * Ten villagers, all adults, none a nitwit. A villager made with a command gets a random profession (nitwits among them) and may be a baby.
 * Each is told to grow up and to become unskilled (no profession: it takes a workstation of its own from the composters); one that is then
 * still a baby, or whose profession reading differs from the rest (a nitwit does not take that change) is killed, and replaced.
 */
export async function spawnVillagers(dim, off, plan, existing = []) {
  const stats = { spawned: 0, babies: 0, odd: 0, events: { grow: 0, unskilled: 0 }, marks: /** @type {Record<string, number>} */ ({}) };
  const spots = plan.villagers.map((v) => W(off, v));
  let type = null, baseline = null;
  const kept = [...existing];
  for (let round = 0; round < 5 && kept.length < WANT; round++) {
    const need = WANT - kept.length, n = need + (round === 0 ? 4 : 2);
    const batch = [];
    for (let i = 0; i < n; i++) {
      const s = spots[(kept.length + i) % spots.length];
      let e = null;
      for (const t of type ? [type] : VILLAGERS) { try { e = dim.spawnEntity(t, s); type = t; break; } catch { /* next type */ } }
      if (e) batch.push(e);
    }
    stats.spawned += batch.length;
    await wait(4);
    for (const e of batch) {
      try { e.triggerEvent('minecraft:ageable_grow_up'); stats.events.grow++; } catch { /* an adult has no such event */ }
      try { e.triggerEvent('minecraft:become_unskilled'); stats.events.unskilled++; } catch { /* */ }
    }
    await wait(6);
    const adults = [];
    for (const e of batch) {
      if (!e.isValid) continue;
      if (isBaby(e)) { stats.babies++; try { e.kill(); } catch { /* */ } continue; }
      adults.push({ e, key: String(markOf(e)) });
    }
    for (const a of adults) stats.marks[a.key] = (stats.marks[a.key] ?? 0) + 1;
    if (baseline === null && adults.length) {
      const tally = {};
      for (const a of adults) tally[a.key] = (tally[a.key] ?? 0) + 1;
      baseline = Object.entries(tally).sort((x, y) => y[1] - x[1])[0][0];
    }
    for (const a of adults) {
      // (If the profession reset was refused for every one of them the readings are all over the place and mean nothing: keep the adults.)
      const odd = stats.events.unskilled > 0 && a.key !== baseline;
      if (odd) { stats.odd++; try { a.e.kill(); } catch { /* */ } continue; }
      if (kept.length < WANT) kept.push(a.e); else { try { a.e.kill(); } catch { /* */ } }
    }
  }
  const dist = Object.entries(stats.marks).map(([k, v]) => `${v} with profession reading ${k}`).join(', ');
  const unreadable = Object.keys(stats.marks).length === 1 && Object.keys(stats.marks)[0] === 'null';
  const note = `Villagers: ${kept.length} of ${WANT} adults in the pod (made ${stats.spawned}; ${stats.babies} babies and ${stats.odd} with a different profession reading, nitwits among them, killed). Readings: ${dist || 'none'}. Become-unskilled event ${stats.events.unskilled ? 'accepted' : 'REFUSED (nitwits cannot be told apart this way)'}.${unreadable ? ' The profession reading is not available either, so nitwits could not be told apart: check the villagers yourself.' : ''}`;
  return { kept, note, stats };
}
