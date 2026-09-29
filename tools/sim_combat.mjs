// Combat arena: the bot's real survival logic (core/threat.js decide, core/tactics.js moves, the
// motor, the pathfinder) against simulated zombies, skeletons and creepers, in terrain that trips
// things up (a quarry mouth, a 1-wide tunnel, a forest). Each scenario reports whether it lived,
// what it killed, and any stretch where it stood doing nothing while something was after it.
//
//   node tools/sim_combat.mjs            all scenarios, a line each
//   node tools/sim_combat.mjs <name> -v  one scenario, with a trace
//
// The mobs are simple (walk the path, hit in range; stand and shoot on line of sight; walk in and
// blow up), but they do what matters: they chase, they shoot along a line walls stop, they hiss.
import { MotorController, EYE_HEIGHT } from '../behavior_pack/scripts/core/motor.js';
import { findPath, searchJob, smoothPath, Cell } from '../behavior_pack/scripts/core/pathfinder.js';
import { decide, MOBS, weaponDamage, REACH_HIT } from '../behavior_pack/scripts/core/threat.js';
import { readFileSync } from 'node:fs';
import { fleeJabOrder, avoidCreepers, towerWorth, TOWER_H, fightMove, creeperMove, creeperFight, Stalemate, pickRefuge, barricadeCells, awayPath, weaponReach, creeperWeapon, bestWeapon, pickCreeperSwing, knockbackRoom, blockOffCells, fleeJab, killSlotCells, killSlotWorth, dodgeArrow, guardCell, blastDamage, bowFight, aimBow, bowPower, BOW_FULL } from '../behavior_pack/scripts/core/tactics.js';
import { makeRng, dist3D } from '../behavior_pack/scripts/core/mathutil.js';
import { SimBody } from '../tests/helpers.js';

const VERBOSE = process.argv.includes('-v');
// --old: the fight logic as it was (aim at a point on the straight line to the mob; archers always
// count as reachable), to check the arena reproduces what went wrong in game.
const OLD = process.argv.includes('--old');
// Running from several things (each can be switched off to compare): TOWER=0 no pillar up out of
// zombies' reach; AVOID=0 routes that pass by creepers; CJAB=0 no jabbing creepers while running.
const TOWER = process.env.TOWER !== '0', AVOID = process.env.AVOID !== '0', CJAB = process.env.CJAB !== '0';
// CLIMB=0: running routes that only walk (no putting a block down to get up a ledge).
const CLIMB = process.env.CLIMB !== '0';
const ONLY = process.argv.slice(2).find((a) => !a.startsWith('-'));

// ---------- line of sight over the classifier (a voxel walk) ----------
function clear(classify, a, b) {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const len = Math.hypot(d.x, d.y, d.z);
  const n = Math.ceil(len / 0.1);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const c = classify(Math.floor(a.x + d.x * t), Math.floor(a.y + d.y * t), Math.floor(a.z + d.z * t));
    if (c === Cell.SOLID || c === Cell.STEP || c === Cell.SLAB) return false;
  }
  return true;
}

function runPath(classify, from, to, tol, maxNodes = 1500) {
  const r = findPath(classify, from, to, { tolerance: tol, maxNodes });
  return r;
}

// Knockback from a hit, in half blocks (4: two blocks). KB=2 to check nothing hangs on the guess.
// Measured in the game (`!bot test creeper` -> tools/calibration.json) where we have it; the guesses
// otherwise. { creeperSpeed, fuseStart, fuseStop, knockback: { sword, spear }, reachFeet: { sword, spear } }
const CAL = (() => { try { return JSON.parse(readFileSync(new URL('./calibration.json', import.meta.url), 'utf8')); } catch { return {}; } })();
const KNOCKBACK_STEPS = Number(process.env.KB ?? 4);
// Knockback in blocks for a weapon (calibrated), else the half-block steps above.
const knockbackFor = (spear) => CAL.knockback?.[spear ? 'spear' : 'sword'] ?? KNOCKBACK_STEPS * 0.5;
const FUSE_START = CAL.fuseStart ?? 2.5, FUSE_STOP = CAL.fuseStop ?? 6;
// The game, not an idealised one: a path planned in the game arrives LAG ticks later (the search runs
// as a job); the body coasts after a stop (ground friction, 0.546 a tick); a swing lands only if the
// mob's hitbox is within 3 blocks of our eye (a miss still costs the swing). CSPEED: creeper walk,
// blocks a tick.
const LAG = Number(process.env.LAG ?? 3);
const CSPEED = Number(process.env.CSPEED ?? CAL.creeperSpeed ?? 0.13);
// STALE_OK=1: a path that lands after a stop still runs (what the game did before the fix).
const STALE_OK = process.env.STALE_OK === '1';
const SPEAR = process.env.SPEAR === '1';
// WALLS=0: no walling a creeper off (what the game did before it).
const WALLS = process.env.WALLS !== '0';
// Cornered by a creeper a hit won't move: GUARD=1 (default) one block at our feet toward it and fight
// on; GUARD=0 wall it off (what the game did before).
const GUARD = process.env.GUARD !== '0';
// WITCHFLEE=1: witches run from, never fought (what the game did before).
if (process.env.WITCHFLEE === '1') MOBS.witch.never = true;
// FLEEJAB=0: running from something catching up, no turning to jab it.
const FLEEJAB = process.env.FLEEJAB !== '0';
// SLOT=0: no kill slot (a block at the feet across a dead end's way in, the gap at eye level).
const SLOT = process.env.SLOT !== '0';
// Arrows fly (1.6 blocks a tick, drag and gravity, a little spread; aimed where we are, no lead).
// HITSCAN=1: they land the moment they're loosed (what the arena did before). DODGE=0: the bot
// doesn't step out of their way.
const HITSCAN = process.env.HITSCAN === '1';
const DODGE = process.env.DODGE !== '0';
// The body speeds up and slows down like a player's (each tick: 0.546 of last tick's speed plus
// 0.454 of what it's asked for). ACCEL=0: full speed at once, and a coast after a stop.
const ACCEL = process.env.ACCEL !== '0';

// ---------- the arena ----------
function arena({ classify: base, bot, mobs, weapon = 'stone_sword', shield = false, ticks = 1200, night = true, health = 20, blocks = 16 }) {
  // Blocks the bot puts down (a barricade) are solid to everyone from then on.
  const placed = new Set();
  // Blocks the bot puts down, and blocks a blast took out.
  const blown = new Set();
  const classify = (x, y, z) => { const k = `${x},${y},${z}`; return placed.has(k) ? Cell.SOLID : blown.has(k) ? Cell.AIR : base(x, y, z); };
  let crater = 0;
  let walls = 0;
  // A kill slot we built: { cells, slot, stand, dir }. Holds while its block is there and we're in the cell.
  let slot = null, slots = 0;
  const slotHolds = () => !!slot && placed.has(`${slot.cells[0].x},${slot.cells[0].y},${slot.cells[0].z}`) &&
    Math.floor(body.pos.x) === Math.floor(slot.stand.x) && Math.floor(body.pos.z) === Math.floor(slot.stand.z);
  const rng = makeRng(7);
  const body = new SimBody({ classify }, { ...bot }, bot.yaw ?? 0, { hw: 0.3 });
  const motor = new MotorController(body, {}, rng);
  let hp = health, mode = 'none', foughtAtDeath = false, nextRoute = 0, nextSwing = 0, corneredUntil = 0, blocking = false;
  // Paths in flight (the game's plan() is a job): { at, path, urgent, seq }. A stop bumps routeSeq;
  // a path planned before it is dropped when it lands (the game's routeTo does the same).
  const inFlight = [];
  let routeSeq = 0, misses = 0;
  // A running route up a ledge: walk the flat parts, a block under our feet at each step up.
  let climbRoute = null, climbs = 0;
  const FLEE_ACTIONS = () => ({ breakCost: () => Infinity, placeCost: 1.5, budget: Math.min(blocks, 4), unitsPerSecond: 4.3 });
  const route = (goal, tolerance, urgent, maxNodes, now = false, walk = false, cls = classify, climb = false) => {
    const r = runPath(cls, body.pos, goal, tolerance, maxNodes);
    if (climb && !r.complete) {
      const a = findPath(cls, body.pos, goal, { tolerance, maxNodes, actions: FLEE_ACTIONS(), weight: 2 });
      if (a.complete && a.path.some((p) => p.move?.type === 'pillar') && a.path.every((p) => !p.move || ['pillar', 'leap', 'stair'].includes(p.move.type))) {
        routeSeq++; if (motor.busy) motor.stop();
        climbRoute = { path: a.path, i: 1, at: t }; climbs++;
        if (VERBOSE) log.push(`${t}: running up a ledge (${a.path.filter((p) => p.move?.type === 'pillar').length} block(s))`);
        return;
      }
    }
    if (r.path.length < 2) return;
    const go = () => motor.followPath(smoothPath(classify, r.path), { seamless: true, urgent, walk });
    if (now || !LAG) go(); else inFlight.push({ at: t + LAG, go, seq: routeSeq });
  };
  const stopWalking = () => { routeSeq++; if (motor.busy) motor.stop(); };
  // Our eye to the nearest point of the mob's box (0.6 wide, 1.7 tall).
  const reachTo = (m) => {
    const e = eye(), cl = (v, a, b) => Math.max(a, Math.min(b, v));
    return Math.hypot(e.x - cl(e.x, m.x - 0.3, m.x + 0.3), e.y - cl(e.y, m.y, m.y + 1.7), e.z - cl(e.z, m.z - 0.3, m.z + 0.3));
  };
  // A swing needs a clear line from our eye to some of the mob (its legs, chest or head): no hitting
  // through a wall we put up.
  const canSee = (m) => [0.4, 1, 1.6].some((h) => clear(classify, eye(), { x: m.x, y: m.y + h, z: m.z }));
  const log = [];
  const stale = new Stalemate(120);
  const giveUp = new Map(); // mob id -> tick we stop counting it as reachable until
  const reachCache = new Map();
  let kills = 0, idleWhileHunted = 0, worstIdle = 0, hitsTaken = 0, blocked = 0, gaveUp = 0;
  let closeTicks = 0;
  // Weapons: the best for a fight, a spear if we carry one for creepers. `weapon` may be a list.
  const carried = (Array.isArray(weapon) ? weapon : [weapon]).filter(Boolean).filter((id) => id !== 'bow').map((id) => ({ id }));
  // A bow (and 64 arrows): shot from out of reach (core/tactics.js bowFight), the melee weapon up close.
  const hasBow = (Array.isArray(weapon) ? weapon : [weapon]).includes('bow');
  let arrowsLeft = hasBow ? 64 : 0, drawStart = -1, releaseEarly = false, bowShots = 0, bowHits = 0;
  const mainId = bestWeapon(carried), creeperId = creeperWeapon(carried, mainId);
  const prof = (m) => weaponReach(m?.type === 'creeper' ? creeperId : mainId);
  const damage = weaponReach(mainId).damage > 1 ? weaponReach(mainId).damage : 1;
  // Against a creeper: spear and sword both (HYBRID=0: the creeper weapon alone).
  let spearNext = 0;
  const HYB = process.env.HYBRID !== '0';
  const cw = (m) => {
    const d = dist3D(body.pos, m), ws = [];
    const sp = weaponReach(creeperId);
    if (sp.reach > 3.5) ws.push({ ...sp, readyAt: Math.max(spearNext, nextSwing) });
    if (!ws.length || HYB) ws.push({ ...weaponReach(mainId), readyAt: nextSwing });
    return pickCreeperSwing(ws, d, t);
  };
  mobs.forEach((m, i) => { m.id = `${m.type}${i}`; m.hp = MOBS[m.type].hp; m.cool = 0; m.fuse = -1; m.lastHitMe = -1e9; m.path = null; m.pi = 0; m.iframe = 0; });
  // Sneaking (shield up) slows the body to 0.3.
  const move0 = body.move.bind(body);
  // A witch's potions on us: slowness (-15% speed), weakness (-4 melee damage), poison (1 a second-ish, never below 1).
  const fx = { slowUntil: -1, weakUntil: -1, poisonUntil: -1 };
  let potionsThrown = 0, potionHits = 0, potionHp = 0;
  body.move = (dx, dz, s) => move0(dx, dz, (blocking ? s * 0.3 : s) * (drawStart >= 0 ? 0.2 : 1) * (tNow() < fx.slowUntil ? 0.85 : 1)); // (drawing a bow: a fifth)
  const eye = () => ({ x: body.pos.x, y: body.pos.y + EYE_HEIGHT, z: body.pos.z });
  const facingMob = (m) => {
    const yaw = Math.atan2(-(m.x - body.pos.x), m.z - body.pos.z) * 180 / Math.PI;
    return Math.abs(((yaw - body.yaw + 540) % 360) - 180) < 60;
  };
  const hurt = (n, m, what) => {
    if (blocking && facingMob(m)) { blocked++; return; }
    hp -= n; hitsTaken++; m.lastHitMe = t; lastHurt = what;
    if (VERBOSE) log.push(`${t}: hit by ${what} for ${n.toFixed(1)}, hp ${hp.toFixed(1)}`);
  };
  const at = (x, y, z) => { const c = classify(x, y, z); return c === Cell.AIR ? 'open' : c === Cell.SOLID || c === Cell.STEP || c === Cell.SLAB ? 'solid' : 'other'; };
  /** Cornered: wall off the way in, if it's a single 1-wide way and we have the blocks. */
  const wallQueue = [];
  // Up a pillar out of zombies' reach (core/tactics.js towerWorth): { x, z, top, left, base, done }.
  let lastHurt = null;
  let tower = null, towers = 0, creeperClose = 0, creeperJabs = 0, noTowerUntil = -1;
  const CANT = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'wither_skeleton', 'hoglin']);
  const towerHolds = () => !!tower?.done && Math.floor(body.pos.x) === tower.x && Math.floor(body.pos.z) === tower.z && body.pos.y >= tower.top - 0.1;
  const towerSafe = (threats) => threats.filter((m) => m.dist <= 12).every((m) => CANT.has(m.type));
  let wallNext = 0;
  function tryWall(threats) {
    if (wallQueue.length) return true;
    const near = threats.filter((m) => m.dist <= 12).sort((a, b) => a.dist - b.dist)[0];
    if (!near || blocks < 2) return false;
    const cells = barricadeCells(body.pos, near.pos, at);
    if (!cells || cells.length > blocks) return false;
    if (mobs.some((m) => m.hp > 0 && cells.some((c) => Math.floor(m.x) === c.x && Math.floor(m.z) === c.z && Math.abs(Math.floor(m.y) - c.y) <= 1))) return false;
    // Placed one at a time, 3 ticks each (aim, place), while the mob keeps walking.
    for (const c of cells) if (at(c.x, c.y, c.z) === 'open') wallQueue.push(c);
    walls++;
    motor.stop();
    if (VERBOSE) log.push(`${t}: walled off the way in (${cells.length} blocks)`);
    return true;
  }
  /** Cornered by tall melee mobs only: a kill slot rather than a sealed wall (then fight from it). */
  function trySlot(threats) {
    if (!SLOT || slot || wallQueue.length || blocks < 2) return !!slot;
    const near = threats.filter((m) => m.dist <= 12).sort((a, b) => a.dist - b.dist)[0];
    if (!near) return false;
    const ks = killSlotWorth({ threats: threats.map((m) => ({ type: m.type, dist: m.dist })), health: hp }) && killSlotCells(body.pos, near.pos, at);
    if (!ks) return false;
    slot = ks; slots++; for (const c of ks.cells) wallQueue.push(c);
    motor.stop();
    if (VERBOSE) log.push(`${t}: cornered: kill slot across the way in (${ks.cells.length} blocks)`);
    return true;
  }
  /** One fight step against tm (a seen mob): where to go, swing, shield. */
  function act(tm, seen) {
    const me = body.pos;
    const m = tm.ref;
    motor.setFocus({ x: m.x, y: m.y + 1, z: m.z });
    // Room to back off from a creeper: somewhere we can walk to 6.5+ blocks from it.
    if (m.type === 'creeper' && (m.roomAt ?? -1e9) + 20 <= t) {
      m.roomAt = t;
      const need = Math.max(6.5, dist3D(me, m) + 4); // 4 blocks further from it than we are now
      m.room = findPath(classify, me, me, { maxNodes: 400, goalTest: (x, y, z, w) => w.standable(x, y, z) && Math.hypot(x + 0.5 - m.x, z + 0.5 - m.z) >= need && Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z) < Math.hypot(x + 0.5 - m.x, z + 0.5 - m.z) }).complete; // (nearer us than it: "2 nearer" was impossible with it 2 away)
    }
    // A hit that won't send it anywhere: steps or rock right behind it (predicted), or it barely
    // moved the last time we hit it (measured, 6 ticks on).
    if (m.type === 'creeper' && m.hitAt !== undefined && t - m.hitAt >= 6 && m.kbMoved === undefined) m.kbMoved = dist3D(me, m) - m.hitD;
    const kbPoor = m.type === 'creeper' && (knockbackRoom(me, m, at) < 1 || (m.kbMoved !== undefined && m.kbMoved < 0.6));
    // The bow: from out of reach; the melee weapon once it's on us.
    if (hasBow && arrowsLeft > 0 && !slot) {
      const bf = bowFight({ me, mob: m, kind: MOBS[m.type].kind, sees: canSee(m), drawn: drawStart >= 0 ? t - drawStart : 0, canRetreat: (m.noRoomUntil ?? -1) <= t, hp: m.hp, melee: damage, st: (m.bowSt ??= {}) });
      if (VERBOSE && process.env.TRACE) log.push(`${t}: bow d ${dist3D(me, m).toFixed(1)} ${JSON.stringify(bf)} busy ${motor.busy} me ${me.x.toFixed(1)},${me.z.toFixed(1)} mob ${m.x.toFixed(1)},${m.z.toFixed(1)}`);
      if (!bf.melee) {
        blocking = false;
        if (bf.draw) { if (drawStart < 0) drawStart = t; } else drawStart = -1;
        releaseEarly = !!bf.release;
        if (bf.stop) stopWalking();
        if (bf.away && !motor.busy) {
          const path = awayPath(findPath, classify, me, m, bf.away);
          if (path) { routeSeq++; motor.followPath(smoothPath(classify, path), { seamless: true, walk: true }); }
          else m.noRoomUntil = t + 40;
        } else if (bf.goal && (t >= nextRoute || !motor.busy)) { nextRoute = t + 6; route(bf.goal, bf.tolerance, false, 1500); }
        return;
      }
      drawStart = -1;
    }
    // Tall melee mobs coming at a dead end: a kill slot (a block at our feet across the way in).
    if (SLOT && !slot && m.type !== 'creeper' && blocks >= 2 && !wallQueue.length) {
      const near = mobs.filter((o) => o.hp > 0).map((o) => ({ type: o.type, dist: dist3D(me, o) }));
      const ks = killSlotWorth({ threats: near, health: hp }) && killSlotCells(me, m, at);
      if (ks) {
        slot = ks; slots++; for (const c of ks.cells) wallQueue.push(c);
        if (VERBOSE) log.push(`${t}: kill slot across the way in (${ks.cells.length} blocks)`);
      }
    }
    // Behind the slot: stand at the back of the cell, hit whatever's at the gap.
    const beyond = slot && ((m.x - slot.stand.x) * slot.dir.x + (m.z - slot.stand.z) * slot.dir.z) > 1;
    const mvSlot = slot && beyond && m.type !== 'creeper' && (wallQueue.length || slotHolds())
      ? { swing: t >= nextSwing, stop: Math.hypot(me.x - slot.stand.x, me.z - slot.stand.z) <= 0.25 } : null;
    // (A step inside our own cell: straight there, no path search.)
    if (mvSlot && !mvSlot.stop && !motor.busy) { routeSeq++; motor.followPath([{ ...me }, slot.stand], { walk: true }); }
    // Up our pillar: stand still and hit what's at its foot.
    const onTower = towerHolds() && m.type !== 'creeper';
    let mv = onTower ? { swing: t >= nextSwing, stop: true } : mvSlot ? mvSlot : m.type === 'creeper' ? creeperFight({ me, mob: m, t, st: (m.st ??= {}), shield, canSwing: cw(m).ready, canRetreat: m.room !== false, lit: m.fuse >= 0, reach: cw(m).reach, minReach: cw(m).minReach, canWall: WALLS && blocks >= (GUARD ? 1 : 2), kbPoor, walls: !GUARD, company: mobs.some((o) => o !== m && o.hp > 0 && dist3D(me, o) <= 16) })
      : fightMove({ me, mob: m, melee: MOBS[m.type].kind === 'melee', t, shield, canSwing: t >= nextSwing, type: m.type });
    if (OLD && mv.goal) { const d0 = dist3D(me, m); mv.goal = d0 > 3.3 ? standOffOld(me, m) : { x: m.x, y: m.y, z: m.z }; mv.tolerance = 0.5; }
    blocking = mv.block;
    if (t < dodgeUntil) mv = { ...mv, stop: false, away: 0, goal: null }; // (mid-dodge: the feet are the dodge's)
    if (VERBOSE && process.env.TRACE) log.push(`${t}: me ${me.x.toFixed(1)},${me.y.toFixed(1)} mob ${m.x.toFixed(1)} d ${dist3D(me, m).toFixed(1)} goal ${mv.goal ? `${mv.goal.x.toFixed(1)},${mv.goal.z.toFixed(1)}` : "-"} away ${mv.away ?? 0} now ${!!mv.now} stop ${!!mv.stop} swing ${!!mv.swing} room ${m.room} lit ${m.fuse >= 0} busy ${motor.busy}`);
    if (mv.wall) {
      // Wall it off: its way in and its sight of us, one block at a time (3 ticks each).
      const cells = blockOffCells(me, m, at);
      for (const c of cells) wallQueue.push(c);
      walls++;
      if (VERBOSE) log.push(`${t}: walling off the creeper (${cells.length} blocks, knockback room ${knockbackRoom(me, m, at)}, d ${dist3D(me, m).toFixed(1)})`);
    }
    if (mv.guard) {
      // One block at our feet toward it, then on with the fight.
      const c = guardCell(me, m, at);
      if (c) { wallQueue.push(c); walls++; }
      if (VERBOSE) log.push(`${t}: a block against the blast ${c ? `at ${c.x},${c.y},${c.z}` : '(nowhere to put it)'}, d ${dist3D(me, m).toFixed(1)}`);
    }
    if (mv.stop) stopWalking();
    if (mv.away && (mv.now || !motor.busy)) {
      // Backing off a creeper: the nearest spot that far from it, found and walked on the spot.
      const path = awayPath(findPath, classify, me, m, mv.away);
      if (path) { routeSeq++; motor.followPath(smoothPath(classify, path), { seamless: true, urgent: mv.urgent, walk: mv.walk }); }
    } else if (mv.goal && (t >= nextRoute || !motor.busy || mv.now)) {
      nextRoute = t + 6;
      route(mv.goal, mv.tolerance, mv.urgent, 1500, mv.sync, mv.walk);
    }
    const pw = m.type === 'creeper' ? cw(m) : prof(m), spear = pw.reach > 3.5;
    // Out of reach: measured in the game (feet to feet) if calibrated, else eye to the mob's box.
    const eyeReach = spear ? 4.125 : 3, tooNear = spear && dist3D(me, m) < 2;
    const calReach = CAL.reachFeet?.[spear ? 'spear' : 'sword'];
    const outOfReach = calReach ? dist3D(me, m) > calReach + 0.05 : reachTo(m) > eyeReach;
    if (mv.swing && facingMob(m) && !canSee(m)) { /* nothing to swing at: a wall's in the way */ }
    else if (mv.swing && facingMob(m) && (outOfReach || tooNear)) { nextSwing = t + pw.cooldown; misses++; if (VERBOSE) log.push(`${t}: swing at ${m.type} misses (${reachTo(m).toFixed(2)} from the eye)`); }
    else if (mv.swing && facingMob(m) && m.iframe <= t) {
      const raw = pw.damage > 1 ? pw.damage : 1;
      m.hp -= t < fx.weakUntil ? Math.max(0, raw - 4) : raw; m.iframe = t + 10; nextSwing = t + 10;
      m.hitAt = t; m.hitD = dist3D(me, m); m.kbMoved = undefined;
      if (spear) spearNext = t + pw.cooldown;
      if (VERBOSE) log.push(`${t}: hit ${m.type} at ${dist3D(me, m).toFixed(1)} (hp ${m.hp})`);
      // Knockback: pushed a block away from us (if there's room).
      const dx = m.x - me.x, dz = m.z - me.z, l = Math.hypot(dx, dz) || 1;
      // (Knockback has an upward kick: it can carry a mob up one step, as up the quarry stairs.)
      let rose = false;
      for (let k = 0; k < Math.round(knockbackFor(spear) / 0.1); k++) {
        const nx = m.x + dx / l * 0.1, nz = m.z + dz / l * 0.1;
        const open = (y) => classify(Math.floor(nx), y, Math.floor(nz)) === Cell.AIR && classify(Math.floor(nx), y + 1, Math.floor(nz)) === Cell.AIR;
        if (open(Math.floor(m.y))) { m.x = nx; m.z = nz; }
        else if (!rose && open(Math.floor(m.y) + 1)) { m.x = nx; m.z = nz; m.y = Math.floor(m.y) + 1; rose = true; }
        else break;
      }
      // Landed: down to the ground under it.
      while (classify(Math.floor(m.x), Math.floor(m.y) - 1, Math.floor(m.z)) === Cell.AIR && m.y > -60) m.y = Math.floor(m.y) - 1;
      if (m.hp <= 0) { kills++; if (VERBOSE) log.push(`${t}: killed ${m.type}`); stale.reset(); }
    }
    if (m.hp > 0 && !OLD && stale.update(m.id, t, tm.dist, MOBS[m.type].hp - m.hp)) {
      giveUp.set(m.id, t + 1200); gaveUp++; stale.reset();
      if (VERBOSE) log.push(`${t}: giving up on ${m.id} (no progress)`);
    }
  }
  let jabs = 0, dodges = 0, arrowsShot = 0, arrowHits = 0, dodgeUntil = -1, blastHp = 0;
  const arrows = []; // { pos, vel, from, age }
  const potions = []; // a witch's: { pos, vel, kind, from, age }
  let vel = { x: 0, z: 0 };
  let t = 0, fightRef = null, explosions = 0, coast = 0, coastDir = { x: 0, z: 0 };
  const tNow = () => t;
  for (; t < ticks && hp > 0; t++) {
    const alive = mobs.filter((m) => m.hp > 0);
    const me = body.pos;
    // ---- the bot: see, decide (every 4 ticks, like survive()) ----
    if (t % 4 === 0) {
      const seen = alive.map((m) => {
        const d = dist3D(me, m);
        const visible = clear(classify, eye(), { x: m.x, y: m.y + 1.6, z: m.z });
        const c = reachCache.get(m.id);
        let canReach = c && t - c.t < 40 ? c.ok : null;
        if (canReach === null) {
          canReach = runPath(classify, m, me, 2, 600).complete;
          reachCache.set(m.id, { ok: canReach, t });
        }
        if ((giveUp.get(m.id) ?? 0) > t) canReach = false;
        if (OLD && MOBS[m.type].kind === 'ranged') canReach = undefined;
        if (visible) m.seenAt = t;
        return { id: m.id, type: m.type, hp: m.hp, lit: m.type === 'creeper' && m.fuse >= 0, dist: d, visible, targetingMe: m.aware !== false && d <= 16, attackedMe: t - m.lastHitMe < 200, recent: visible || t - (m.seenAt ?? -1e9) < 100, dy: m.y - me.y, canReach, pos: { x: m.x, y: m.y, z: m.z }, inWater: false, ref: m };
      });
      const d = decide({ health: hp, damage, isNight: night, prevMode: mode, mobs: seen, shield, slot: slotHolds() });
      if (d.mode === 'flee' && corneredUntil > t && d.reason !== 'creeper' && d.reason !== 'cover') {
        const target = d.threats.find((m) => m.type !== 'creeper' && m.dist <= 8);
        if (target) { d.mode = 'fight'; d.target = target.id; }
      }
      if (tower?.done) {
        if (!towerSafe(d.threats)) tower = null; // something that shoots, climbs or blows up: off it, the usual way
        else if (towerHolds()) {
          const tgt = d.threats.filter((m) => m.type !== 'creeper' && m.dist <= 5).sort((a, b) => a.dist - b.dist)[0];
          if (tgt) { d.mode = 'fight'; d.target = tgt.id; } else if (d.mode !== 'none') d.mode = 'none';
        }
      }
      if (d.mode !== mode && VERBOSE) log.push(`${t}: ${mode} -> ${d.mode} (${d.reason})`);
      mode = d.mode;
      foughtAtDeath = mode === 'fight';
      blocking = false;
      if (mode === 'fight') {
        const tm = seen.find((m) => m.id === d.target);
        fightRef = tm?.ref ?? null;
        if (tm) act(tm, seen);
      } else if (mode === 'flee') {
        motor.setFocus(null);
        const creeper = d.threats.find((m) => m.type === 'creeper');
        if (creeper && creeperMove({ me, creeper: creeper.pos, shield, lit: creeper.lit }) === 'block') {
          blocking = true; stopWalking(); motor.setFocus({ x: creeper.pos.x, y: creeper.pos.y + 1, z: creeper.pos.z });
        } else if ((tower && !tower.done) || climbRoute) {
          // (building it, or on the way up a ledge)
        } else if (t >= nextRoute || !motor.busy) {
          nextRoute = t + 20;
          const cands = [];
          const f = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
          const cls = AVOID && !OLD ? avoidCreepers(classify, d.threats.filter((m) => m.type === 'creeper').map((m) => m.pos), Number(process.env.AV_R ?? 3.5), me) : classify;
          findPath(cls, me, me, { maxNodes: 1500, ...(CLIMB && !OLD ? { actions: FLEE_ACTIONS() } : {}), goalTest: (x, y, z, w) => { if (w.standable(x, y, z)) cands.push({ x: x + 0.5, y, z: z + 0.5, cost: Math.hypot(x - f.x, z - f.z) }); return false; } });
          const sees = (p, m) => clear(classify, { x: m.pos.x, y: m.pos.y + 1.6, z: m.pos.z }, { x: p.x, y: p.y + 1.2, z: p.z });
          const spot = pickRefuge(me, d.threats, cands, sees);
          // Nowhere much better: wall off here, or get into the dead end nearby (a single way in)
          // and wall off there; only if neither, stand and fight.
          const deeper = spot ? null : pickRefuge(me, d.threats, cands, sees, 0.5);
          const towerOk = () => TOWER && !tower && !OLD && t >= noTowerUntil && towerWorth({ threats: d.threats, health: hp, blocks, headroom: [1, 2, 3, 4, 5].every((k) => classify(Math.floor(me.x), Math.floor(me.y) + k, Math.floor(me.z)) === Cell.AIR) });
          if (!spot && !trySlot(d.threats) && !tryWall(d.threats)) {
            // Nowhere to run and no way in to block: up a pillar out of their reach (zombies only).
            if (towerOk()) {
              tower = { x: Math.floor(me.x), z: Math.floor(me.z), top: Math.floor(me.y) + TOWER_H, left: TOWER_H, base: null, done: false };
              towers++; stopWalking();
              if (VERBOSE) log.push(`${t}: cornered: up a pillar out of their reach`);
            } else if (deeper) { route(deeper, 0.5, true, 1500, false, false, cls, CLIMB && !OLD); nextRoute = t + 8; }
            else corneredUntil = t + 200;
          } else if (spot) route(spot, 1, true, 3000, false, false, cls, CLIMB && !OLD);
        }
      } else motor.setFocus(null);
      // Standing still while something's after us and nothing's happening: the staring contest.
      const hunted = seen.some((m) => m.visible && m.dist <= 16);
      if (hunted && !motor.busy && mode !== 'fight' && mode !== 'flee' && !blocking) idleWhileHunted += 4;
      // (Standing off a creeper at spear's length, waiting on it, isn't idling.)
      else if (hunted && mode === 'fight' && !motor.busy && !seen.some((m) => m.dist <= REACH_HIT + 0.5 || (m.type === 'creeper' && m.dist <= 6))) idleWhileHunted += 4;
      else idleWhileHunted = 0;
      worstIdle = Math.max(worstIdle, idleWhileHunted);
    }
    // An arrow coming at us: a step aside (it's aimed where we are). Seen a tick after it's loosed.
    if (DODGE && !HITSCAN && (mode === 'fight' || mode === 'flee') && (arrows.length || potions.length)) {
      const seenArrows = [...arrows.filter((a) => a.age >= 1 && !(blocking && facingMob(a.from))), ...potions.filter((a) => a.age >= 1).map((a) => ({ ...a, grow: 1.2 }))];
      const dg = seenArrows.length ? dodgeArrow({ me, arrows: seenArrows, at }) : null;
      if (dg && t >= dodgeUntil) {
        dodges++;
        routeSeq++;
        motor.strafe(dg.dir, Math.min(8, dg.eta + 2));
        drawStart = -1; // (a dodge lets the bow down)
        dodgeUntil = t + dg.eta + 2; nextRoute = dodgeUntil;
        if (VERBOSE) log.push(`${t}: arrow in ${dg.eta} ticks: stepping aside`);
      }
    }
    // Loosing the arrow: fully drawn (or early, if it's nearly on us), facing it, a clear shot.
    if (drawStart >= 0 && (mode !== 'fight' || !fightRef || fightRef.hp <= 0)) drawStart = -1;
    if (drawStart >= 0 && arrowsLeft > 0) {
      const drawn = t - drawStart, m = fightRef;
      if ((drawn >= BOW_FULL || (releaseEarly && drawn >= 10)) && facingMob(m) && canSee(m)) {
        const speed = 3 * bowPower(drawn), dir = aimBow(eye(), m, m.v ?? { x: 0, z: 0 }, speed);
        // A player's shot: spread 0.0075 a component.
        const g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rng(); return (u - 3) * 0.0075; };
        arrows.push({ pos: eye(), vel: { x: (dir.x + g()) * speed, y: (dir.y + g()) * speed, z: (dir.z + g()) * speed }, from: null, mine: true, full: drawn >= BOW_FULL, age: 0 });
        arrowsLeft--; bowShots++; drawStart = -1;
        if (VERBOSE) log.push(`${t}: loosed at ${m.type} ${dist3D(me, m).toFixed(1)} away (drawn ${drawn})`);
      }
    }
    // Running from something catching up: turn and jab it (the spear from out of its reach), run on.
    if (mode === 'flee' && FLEEJAB) {
      const hasSpear = weaponReach(creeperId).reach > 3.5;
      const chasers = mobs.filter((m) => m.hp > 0 && (MOBS[m.type].kind === 'melee' || (CJAB && !OLD && m.type === 'creeper'))).map((m) => ({ m, type: m.type, d: dist3D(me, m) }));
      let c = null, how = null;
      for (const o of fleeJabOrder(chasers)) {
        how = fleeJab({ me, mob: o.m, t, st: (o.m.fj ??= {}), melee: true, hasSpear, spearReady: t >= spearNext && t >= nextSwing, swordReady: t >= nextSwing, creeper: o.type === 'creeper' });
        c = o;
        if (how) break;
      }
      if (c) {
        if (how && c.type === 'creeper') creeperJabs++;
        if (how) {
          motor.setFocus({ x: c.m.x, y: c.m.y + 1, z: c.m.z });
          if (facingMob(c.m) && c.m.iframe <= t && canSee(c.m)) {
            const pw = weaponReach(how === 'spear' ? creeperId : mainId);
            c.m.hp -= pw.damage; c.m.iframe = t + 10; nextSwing = t + 10; jabs++;
            if (how === 'spear') spearNext = t + pw.cooldown;
            const dx = c.m.x - me.x, dz = c.m.z - me.z, l = Math.hypot(dx, dz) || 1;
            for (let k = 0; k < Math.round(knockbackFor(how === 'spear') / 0.1); k++) {
              const nx = c.m.x + dx / l * 0.1, nz = c.m.z + dz / l * 0.1;
              if (classify(Math.floor(nx), Math.floor(c.m.y), Math.floor(nz)) !== Cell.AIR) break;
              c.m.x = nx; c.m.z = nz;
            }
            if (VERBOSE) log.push(`${t}: running, jabbed the ${c.m.type} with the ${how} at ${c.d.toFixed(1)}`);
            if (c.m.hp <= 0) kills++;
            motor.setFocus(null);
          }
        } else if (motor.focus && mode === 'flee') motor.setFocus(null);
      }
    }
    // A creeper fight is timed in ticks (a 0.7-block window between our reach and its fuse): every
    // tick, like the game's creeper step.
    if (t % 4 !== 0 && mode === 'fight' && fightRef?.type === 'creeper' && fightRef.hp > 0 && !OLD) {
      const m = fightRef;
      act({ ref: m, id: m.id, type: m.type, dist: dist3D(me, m), pos: { x: m.x, y: m.y, z: m.z } }, []);
    }
    // Blocks going down one at a time (a mob standing in the cell: it can't go there).
    if (tower && !tower.done) {
      const fy = Math.floor(body.pos.y);
      if (motor.busy) motor.stop();
      if (tower.left <= 0) { if (body.onGround) { if (tower.step) tower = null; else tower.done = true; } }
      else if (body.onGround && classify(tower.x, fy + 2, tower.z) !== Cell.AIR) { tower = null; noTowerUntil = t + 200; } // a ceiling: no room
      else if (body.onGround) { tower.base = fy; body.jump(); }
      else if (tower.base != null && body.pos.y >= tower.base + 1.02 && classify(tower.x, tower.base, tower.z) === Cell.AIR && blocks > 0) {
        placed.add(`${tower.x},${tower.base},${tower.z}`); blocks--; tower.left--; tower.base = null;
      }
    }
    if (climbRoute && !tower) {
      const p = climbRoute.path, i = climbRoute.i;
      if (i >= p.length || t - climbRoute.at > 200) climbRoute = null;
      else if (p[i].move?.type === 'pillar') { tower = { x: Math.floor(body.pos.x), z: Math.floor(body.pos.z), top: Math.floor(body.pos.y) + 1, left: 1, base: null, done: false, step: true }; climbRoute.i++; }
      else if (!motor.busy) {
        let j = i; while (j < p.length && p[j].move?.type !== 'pillar') j++;
        motor.followPath(smoothPath(classify, p.slice(i - 1, j)), { seamless: true, urgent: true });
        climbRoute.i = j;
      }
    }
    for (const m of mobs) if (m.type === 'creeper' && m.hp > 0 && dist3D(body.pos, m) <= 3) creeperClose++;
    if (wallQueue.length && t >= wallNext) {
      const c = wallQueue.shift();
      const inIt = mobs.some((m) => m.hp > 0 && Math.floor(m.x) === c.x && Math.floor(m.z) === c.z && Math.floor(m.y) <= c.y && Math.floor(m.y) + 1 >= c.y);
      if (!inIt && at(c.x, c.y, c.z) === 'open' && blocks > 0) { placed.add(`${c.x},${c.y},${c.z}`); blocks--; if (VERBOSE) log.push(`${t}: placed ${c.x},${c.y},${c.z}`); }
      wallNext = t + 3;
    }
    for (let k = inFlight.length - 1; k >= 0; k--) {
      if (inFlight[k].at > t) continue;
      const f = inFlight.splice(k, 1)[0];
      if (!STALE_OK && f.seq !== routeSeq) continue; // stopped since it was asked for
      f.go();
    }
    const before = { x: body.pos.x, z: body.pos.z };
    // (A dodge in progress keeps the fight from re-routing us back onto the arrow's line.)
    if (t < dodgeUntil) nextRoute = Math.max(nextRoute, dodgeUntil);
    motor.tick();
    // No command this tick: the body coasts on what it had (0.546 a tick on the ground).
    let coasting = false;
    if (ACCEL) {
      const base = body.sprint ? 0.28 : 0.216;
      const want = body.cmd ? { x: body.cmd.dx * base * body.cmd.s, z: body.cmd.dz * base * body.cmd.s } : { x: 0, z: 0 };
      vel = { x: vel.x * 0.546 + want.x * 0.454, z: vel.z * 0.546 + want.z * 0.454 };
      const sp = Math.hypot(vel.x, vel.z);
      const cmd0 = body.cmd, sprint0 = body.sprint;
      body.cmd = sp > 0.005 ? { dx: vel.x / sp, dz: vel.z / sp, s: sp / 0.216 } : null; body.sprint = false;
      const b0 = { x: body.pos.x, z: body.pos.z };
      body.step();
      body.cmd = cmd0; body.sprint = sprint0;
      // Blocked by a wall: that part of the speed is gone.
      vel = { x: body.pos.x - b0.x, z: body.pos.z - b0.z };
    } else if (!body.cmd && coast > 0.01) { body.cmd = { dx: coastDir.x, dz: coastDir.z, s: coast / 0.216 }; body.sprint = false; coasting = true; }
    if (ACCEL) { /* stepped above */ } else body.step();
    if (ACCEL) { /* no coast bookkeeping */ } else if (coasting) { body.cmd = null; coast *= 0.546; }
    else {
      const moved = Math.hypot(body.pos.x - before.x, body.pos.z - before.z);
      coast = body.cmd && moved > 0.01 ? moved : 0;
      if (coast) coastDir = { x: (body.pos.x - before.x) / moved, z: (body.pos.z - before.z) / moved };
    }
    // ---- the mobs ----
    for (const m of alive) {
      const d = dist3D(me, m);
      m.v = m.px === undefined ? { x: 0, z: 0 } : { x: m.x - m.px, z: m.z - m.pz }; m.px = m.x; m.pz = m.z;
      const info = MOBS[m.type];
      if (m.type === 'witch') {
        const sight = clear(classify, { x: m.x, y: m.y + 1.5, z: m.z }, { x: me.x, y: me.y + 1.0, z: me.z });
        // Drinking (32 ticks, nothing else): a healing potion when it's hurt, 5% a tick (Minecraft's witch).
        if ((m.drinkUntil ?? -1) > t) { if (t === m.drinkUntil - 1) m.hp = Math.min(MOBS.witch.hp, m.hp + 4); continue; }
        if (m.hp < MOBS.witch.hp && rng() < 0.05) { m.drinkUntil = t + 32; if (VERBOSE) log.push(`${t}: witch drinks (hp ${m.hp})`); continue; }
        if (t >= m.cool && d <= 10 && sight) {
          m.cool = t + 60;
          const kind = d >= 8 && t >= fx.slowUntil ? 'slowness' : hp >= 8 && t >= fx.poisonUntil ? 'poison' : d <= 3 && t >= fx.weakUntil && rng() < 0.25 ? 'weakness' : 'harming';
          // Where we'll be next tick, at our body, arced up 0.2 a block, 0.75 a tick, spread 8.
          const from = { x: m.x, y: m.y + 1.5, z: m.z };
          const lx = me.x + vel.x - m.x, lz = me.z + vel.z - m.z, h = Math.hypot(lx, lz);
          const dy = me.y + 1.62 - 1.1 - m.y + h * 0.2;
          const l = Math.hypot(lx, dy, lz) || 1;
          const g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rng(); return (u - 3) * 0.0075 * 8; };
          potions.push({ pos: from, vel: { x: (lx / l + g()) * 0.75, y: (dy / l + g()) * 0.75, z: (lz / l + g()) * 0.75 }, kind, from: m, age: 0 });
          potionsThrown++;
          if (VERBOSE) log.push(`${t}: witch throws ${kind} from ${d.toFixed(1)}`);
        }
        // Closes in to within 9 with a clear throw, then stands.
        if (!(d <= 9 && sight)) {
          if (t % 10 === 0) { const r = runPath(classify, m, me, 1, 500); m.path = r.path.length >= 2 ? r.path : null; m.pi = 1; }
          if (m.path && m.pi < m.path.length) {
            const w = m.path[m.pi], tx = w.x + 0.5, tz = w.z + 0.5, dx = tx - m.x, dz = tz - m.z, l = Math.hypot(dx, dz);
            if (l < 0.17) { m.x = tx; m.z = tz; m.y = w.y; m.pi++; } else { m.x += dx / l * 0.17; m.z += dz / l * 0.17; if (Math.abs(w.y - m.y) >= 1 && l < 0.6) m.y = w.y; }
          }
        }
        continue;
      }
      if (info.kind === 'ranged') {
        // Stands its ground and shoots every 2 s when it can see us (arrow line: its eye to our chest).
        // An arrow hits the first thing in its way: a zombie between us takes it.
        const inWay = alive.some((o) => o !== m && o.hp > 0 && (() => {
          const ax = me.x - m.x, az = me.z - m.z, l2 = ax * ax + az * az || 1;
          const u = ((o.x - m.x) * ax + (o.z - m.z) * az) / l2;
          return u > 0.05 && u < 0.95 && Math.hypot(m.x + ax * u - o.x, m.z + az * u - o.z) < 0.5 && Math.abs(o.y - me.y) < 2;
        })());
        if (t >= m.cool && d <= 16 && inWay && HITSCAN) { m.cool = t + 40; }
        else if (t >= m.cool && d <= 16 && clear(classify, { x: m.x, y: m.y + 1.5, z: m.z }, { x: me.x, y: me.y + 1.0, z: me.z })) {
          m.cool = t + 40; if (VERBOSE) log.push(`${t}: arrow from ${m.x.toFixed(2)},${m.y} to ${me.x.toFixed(2)},${me.y.toFixed(2)}`);
          if (HITSCAN) hurt(3, m, 'arrow');
          else {
            // Minecraft's skeleton: at our body a third of the way up, raised by 0.2 a block of
            // distance for the drop, 1.6 a tick, spread 0.0075 x 6 (normal difficulty) a component.
            const from = { x: m.x, y: m.y + 1.5, z: m.z };
            const dx = me.x - from.x, dz = me.z - from.z, h = Math.hypot(dx, dz);
            const dy = me.y + 0.6 - from.y + h * 0.2;
            const l = Math.hypot(dx, dy, dz) || 1;
            const g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rng(); return (u - 3) * 0.0075 * 6; };
            arrows.push({ pos: from, vel: { x: (dx / l + g()) * 1.6, y: (dy / l + g()) * 1.6, z: (dz / l + g()) * 1.6 }, from: m, age: 0 });
            arrowsShot++;
          }
        } else if (t >= m.cool && d <= 16) { m.cool = t + 40; m.missed = (m.missed ?? 0) + 1; }
        continue;
      }
      // Walkers: follow a path to us, re-planned every 10 ticks.
      if (t % 10 === 0) {
        const r = runPath(classify, m, me, 1, 500);
        m.path = r.path.length >= 2 ? r.path : null; m.pi = 1;
      }
      // Walking speeds from the calibrated creeper (attribute 0.2 walks 0.135 a tick): a zombie (0.23)
      // ~0.155, a spider (0.3) ~0.2. The bot walks 0.216 and sprints 0.28.
      const speed = m.type === 'creeper' ? CSPEED : m.type === 'spider' || m.type === 'cave_spider' ? 0.2 : 0.155;
      if (m.path && m.pi < m.path.length && d > 1.3 && !(m.type === 'creeper' && m.fuse >= 0)) { // a hissing creeper stands still
        const w = m.path[m.pi], tx = w.x + 0.5, tz = w.z + 0.5;
        const dx = tx - m.x, dz = tz - m.z, l = Math.hypot(dx, dz);
        if (l < speed) { m.x = tx; m.z = tz; m.y = w.y; m.pi++; } else { m.x += dx / l * speed; m.z += dz / l * speed; if (Math.abs(w.y - m.y) >= 1 && l < 0.6) m.y = w.y; }
      }
      if (m.type === 'creeper') {
        const sight = clear(classify, { x: m.x, y: m.y + 1.5, z: m.z }, { x: me.x, y: me.y + 1.2, z: me.z });
        // Bedrock's creeper: the fuse starts inside 2.5 blocks of us with us in sight, and stops
        // beyond 6 or once it loses sight of us (its target_nearby_sensor).
        if (m.fuse < 0 && d <= FUSE_START && sight) { m.fuse = t + 30; if (VERBOSE) log.push(`${t}: creeper hisses at ${d.toFixed(1)}`); }
        if (m.fuse >= 0 && (d > FUSE_STOP || !sight)) { m.fuse = -1; if (VERBOSE) log.push(`${t}: creeper calms down at ${d.toFixed(1)}`); }
        if (m.fuse >= 0 && t >= m.fuse) {
          // Minecraft's blast: how much of us its rays reach from its feet (OLDBLAST=1: the old guess).
          const dmg = process.env.OLDBLAST === '1' ? Math.max(0, 25 * (1 - d / 6)) * (sight ? 1 : 0.3)
            : blastDamage({ x: m.x, y: m.y + 0.05, z: m.z }, me, (a, b) => clear(classify, a, b));
          blastHp += blocking && facingMob(m) ? 0 : dmg;
          if (VERBOSE) log.push(`${t}: creeper goes off at ${d.toFixed(1)} blocks (${dmg.toFixed(1)} damage)`);
          hurt(dmg, m, 'creeper');
          explosions++;
          // The crater (stone resists: a small one, ragged).
          const r = 1.4 + rng() * 1.0;
          for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) {
            if (Math.hypot(dx, dy, dz) > r * (0.75 + rng() * 0.35)) continue;
            const bx = Math.floor(m.x) + dx, by = Math.floor(m.y) + dy, bz = Math.floor(m.z) + dz;
            if (classify(bx, by, bz) === Cell.SOLID) { blown.add(`${bx},${by},${bz}`); crater++; }
          }
          m.hp = 0;
        }
        continue;
      }
      if (d <= 1.6) closeTicks++; // (inside its reach: where a player doesn't let a zombie be)
      if (d <= 1.6 && t >= m.cool) { m.cool = t + 20; hurt(info.dps, m, m.type); }
    }
    // ---- a witch's potions: they burst on whatever they hit, and splash everything within 4 ----
    for (let k = potions.length - 1; k >= 0; k--) {
      const a = potions[k];
      let at = null;
      for (let i = 1; i <= 4 && !at; i++) {
        const x = a.pos.x + a.vel.x * i / 4, y = a.pos.y + a.vel.y * i / 4, z = a.pos.z + a.vel.z * i / 4;
        const c = classify(Math.floor(x), Math.floor(y), Math.floor(z));
        const inBox = (o, hw, ht) => Math.abs(x - o.x) <= hw + 0.125 && Math.abs(z - o.z) <= hw + 0.125 && y >= o.y - 0.125 && y <= o.y + ht + 0.125;
        if (c === Cell.SOLID || c === Cell.STEP || c === Cell.SLAB || inBox(body.pos, 0.3, 1.8) || (a.age > 2 && mobs.some((o) => o !== a.from && o.hp > 0 && inBox(o, 0.3, 1.9)))) at = { x, y, z, direct: inBox(body.pos, 0.3, 1.8) };
      }
      if (at || a.age++ > 80) {
        potions.splice(k, 1);
        if (!at) continue;
        const dd = Math.hypot(at.x - body.pos.x, at.y - (body.pos.y + 0.9), at.z - body.pos.z);
        const i = at.direct ? 1 : Math.max(0, 1 - dd / 4);
        if (i > 0) {
          potionHits++;
          if (a.kind === 'harming') { hp -= 6 * i; potionHp += 6 * i; hitsTaken++; }
          else if (a.kind === 'poison') fx.poisonUntil = Math.max(fx.poisonUntil, t + Math.round(900 * i));
          else if (a.kind === 'slowness') fx.slowUntil = Math.max(fx.slowUntil, t + Math.round(1800 * i));
          else if (a.kind === 'weakness') fx.weakUntil = Math.max(fx.weakUntil, t + Math.round(1800 * i));
          if (VERBOSE) log.push(`${t}: ${a.kind} splashes us (${(i * 100).toFixed(0)}%)`);
        }
        continue;
      }
      a.pos = { x: a.pos.x + a.vel.x, y: a.pos.y + a.vel.y, z: a.pos.z + a.vel.z };
      a.vel = { x: a.vel.x * 0.99, y: a.vel.y * 0.99 - 0.05, z: a.vel.z * 0.99 };
    }
    if (t < fx.poisonUntil && t % 25 === 0 && hp > 1) { hp -= 1; potionHp += 1; }
    // ---- arrows in flight: into rock, a mob in the way, or us (the shield, if it's up at them) ----
    for (let k = arrows.length - 1; k >= 0; k--) {
      const a = arrows[k];
      let gone = a.age++ > 60;
      for (let i = 1; i <= 4 && !gone; i++) {
        const x = a.pos.x + a.vel.x * i / 4, y = a.pos.y + a.vel.y * i / 4, z = a.pos.z + a.vel.z * i / 4;
        const c = classify(Math.floor(x), Math.floor(y), Math.floor(z));
        if (c === Cell.SOLID || c === Cell.STEP || c === Cell.SLAB) { gone = true; break; }
        const inBox = (o, hw, ht) => Math.abs(x - o.x) <= hw + 0.25 && Math.abs(z - o.z) <= hw + 0.25 && y >= o.y - 0.25 && y <= o.y + ht + 0.25;
        if (a.mine) {
          const o = mobs.find((q) => q.hp > 0 && inBox(q, 0.3, 1.9));
          if (!o) continue;
          gone = true;
          if (o.iframe > t) break;
          const sp = Math.hypot(a.vel.x, a.vel.y, a.vel.z), base = Math.ceil(sp * 2);
          const dmg = base + (a.full ? Math.floor(rng() * (base / 2 + 2)) : 0);
          o.hp -= dmg; o.iframe = t + 10; bowHits++; o.lastHitByUs = t;
          // Knocked back a little along the arrow's line (0.5), walls permitting.
          const hl = Math.hypot(a.vel.x, a.vel.z) || 1;
          for (let q = 0; q < 5; q++) { const nx = o.x + a.vel.x / hl * 0.1, nz = o.z + a.vel.z / hl * 0.1; if (classify(Math.floor(nx), Math.floor(o.y), Math.floor(nz)) !== Cell.AIR) break; o.x = nx; o.z = nz; }
          if (VERBOSE) log.push(`${t}: arrow hit ${o.type} for ${dmg} (hp ${o.hp})`);
          if (o.hp <= 0) { kills++; stale.reset(); }
          break;
        }
        if (inBox(body.pos, 0.3, 1.8)) { const b0 = blocked; hurt(3, a.from, 'arrow'); if (blocked === b0) arrowHits++; gone = true; break; }
        if (a.age > 2 && mobs.some((o) => o !== a.from && o.hp > 0 && inBox(o, 0.3, 1.9))) { gone = true; break; }
      }
      if (gone) { arrows.splice(k, 1); continue; }
      a.pos = { x: a.pos.x + a.vel.x, y: a.pos.y + a.vel.y, z: a.pos.z + a.vel.z };
      a.vel = { x: a.vel.x * 0.99, y: a.vel.y * 0.99 - 0.05, z: a.vel.z * 0.99 };
    }
    if (!mobs.some((m) => m.hp > 0)) break;
  }
  return { climbs, killer: hp <= 0 ? lastHurt : null, towers, creeperClose, creeperJabs, closeTicks, potionsThrown, potionHits, potionHp, blastHp, bowShots, bowHits, arrowsLeft, dodges, arrowsShot, arrowHits, slots, jabs, crater, misses, explosions, walls, foughtAtDeath, hp: Math.max(0, hp), kills, total: mobs.length, ticks: t, worstIdle, hitsTaken, blocked, gaveUp, log };
}

const standOffOld = (me, mob, r = 2.8) => { const dx = me.x - mob.x, dz = me.z - mob.z, l = Math.hypot(dx, dz) || 1; return { x: mob.x + dx / l * r, y: mob.y, z: mob.z + dz / l * r }; };

// ---------- terrains ----------
const flat = (y = 64) => (x, yy) => (yy < y ? Cell.SOLID : Cell.AIR);
function forest() {
  // Uneven ground (bumps of 1-2) and trunks every few blocks with leaves over them.
  const h = (x, z) => 64 + Math.floor(1.5 * Math.sin(x / 3.1) + 1.2 * Math.cos(z / 2.7));
  const trunk = (x, z) => ((x * 7 + z * 13) % 11 + 11) % 11 === 0;
  return (x, y, z) => {
    const g = h(x, z);
    if (y < g) return Cell.SOLID;
    if (trunk(x, z) && y < g + 5) return Cell.SOLID;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (trunk(x + dx, z + dz) && y >= h(x + dx, z + dz) + 3 && y <= h(x + dx, z + dz) + 5) return Cell.DANGER; // leaves
    return Cell.AIR;
  };
}
/** The quarry: surface at 64 for x <= 0; stairs down +x, a step each block, 3 high, to x = 10 (y 54). */
function quarry() {
  return (x, y, z) => {
    if (x <= 0) return y < 64 ? Cell.SOLID : Cell.AIR;
    if (z !== 0 || x > 12) return Cell.SOLID;
    const feet = 64 - Math.min(x, 10);
    return y >= feet && y < feet + 3 ? Cell.AIR : Cell.SOLID;
  };
}
/** A 1-wide, 2-high tunnel along +x from x = 0 to 20 at y 40, closed at x = 0 (a dead end behind us). */
/**
 * The bot's own mine: 12 steps of 1-wide stairs down from the surface (Y 64) to Y 52, the tunnel on
 * along +x from the bottom (2 high, to x 30), and a side branch off it at x 22 (along +z, to z 8).
 */
function mine() {
  return (x, y, z) => {
    if (y >= 64 && x <= 0) return Cell.AIR; // the surface
    if (x <= 0) return Cell.SOLID;
    if (z === 0 && x >= 1 && x <= 12) { const f = 64 - x; return y >= f && y < f + 3 ? Cell.AIR : y >= 64 ? Cell.AIR : Cell.SOLID; }
    if (z === 0 && x > 12 && x <= 30) return y === 52 || y === 53 ? Cell.AIR : y >= 64 ? Cell.AIR : Cell.SOLID;
    if (x === 22 && z > 0 && z <= 8) return y === 52 || y === 53 ? Cell.AIR : y >= 64 ? Cell.AIR : Cell.SOLID;
    return y >= 64 ? Cell.AIR : Cell.SOLID;
  };
}

/**
 * Jagged steps coming down to where the bot's cornered (no way on behind it): seed-random risers of
 * 1 or 2, runs of 1 or 2, the ceiling 3 over each step (a hit can't lift the creeper much). kind:
 * 'deadend' 1 wide, a dead end at the bottom; 'wide' 3 wide, a wall behind the bottom; 'low' 1
 * wide, the ceiling 2.5 over each step. Returns { classify, bot, top }.
 */
function jagged(r, kind = 'deadend') {
  const floors = new Map(); // x -> floor y (feet)
  let x = 3, y = 40;
  for (let k = 0; k <= 2; k++) floors.set(k, 40);
  while (x < 16) { const run = r() < 0.5 ? 1 : 2, rise = r() < 0.6 ? 1 : 2; y += rise; for (let k = 0; k < run; k++) floors.set(x++, y); }
  const width = kind === 'wide' ? 1 : 0, head = kind === 'low' ? 2 : 3;
  const classify = (bx, by, bz) => {
    if (bx < 0 || bx >= x || Math.abs(bz) > width) return Cell.SOLID;
    const f = floors.get(bx);
    // The ceiling: 3 over each step, and never lower than the next step's head room (a step you
    // walk up needs its own 3).
    const top = Math.max(f + head, (floors.get(bx + 1) ?? f) + 2); // (room to step down off the one above)
    return by >= f && by < top ? Cell.AIR : Cell.SOLID;
  };
  return { classify, bot: { x: 0.5, y: 40, z: 0.5 }, top: { x: x - 0.5, y: floors.get(x - 1), z: 0.5 } };
}

/** Rough, tall ground: terraces with 1-3 block steps between them (walls a zombie takes the long way round). */
function cliffs(seed = 1) {
  const r = makeRng(seed), a = r() * 6, b = r() * 6, c = r() * 6;
  const h = (x, z) => 64 + Math.max(0, Math.round(2.2 * Math.sin(x / 4.3 + a) + 2.0 * Math.cos(z / 3.7 + b) + 1.2 * Math.sin((x - z) / 2.9 + c)));
  return (x, y, z) => (y < h(x, z) ? Cell.SOLID : Cell.AIR);
}
/** A trench 3 wide and 2 deep along x, open ground either side (the way out is up its sides). */
function trench() { return (x, y, z) => (y < (Math.abs(z) <= 1 ? 62 : 64) ? Cell.SOLID : Cell.AIR); }
function tunnel() {
  return (x, y, z) => (z === 0 && x >= 1 && x <= 20 && (y === 40 || y === 41) ? Cell.AIR : Cell.SOLID);
}

const SCENARIOS = {
  'cornered at a dead end, creeper down jagged steps, no shield': () => { const J = jagged(makeRng(5), 'deadend'); return { classify: J.classify, weapon: ['stone_sword', 'stone_spear'], bot: J.bot, mobs: [{ type: 'creeper', ...J.top }], minHp: 20 }; },
  'creeper drops in two steps up the quarry stairs, already inside its fuse range': () => ({ classify: mine(), weapon: ['stone_sword', 'stone_spear'], bot: { x: 12.5, y: 52, z: 0.5 }, mobs: [{ type: 'creeper', x: 10.5, y: 54, z: 0.5 }], minHp: 15 }),
  'creeper coming down the quarry steps, spear': () => ({ classify: quarry(), weapon: ['stone_sword', 'stone_spear'], bot: { x: 10.5, y: 54, z: 0.5 }, mobs: [{ type: 'creeper', aware: false, x: -1.5, y: 64, z: 0.5 }], minHp: 20 }),
  'creeper coming down the quarry steps, stone sword': () => ({ classify: quarry(), bot: { x: 10.5, y: 54, z: 0.5 }, mobs: [{ type: 'creeper', aware: false, x: -1.5, y: 64, z: 0.5 }], minHp: 20 }),
  'down a mine tunnel: skeleton then a zombie, iron sword + shield, hurt': () => ({ classify: tunnel(), bot: { x: 2.5, y: 40, z: 0.5 }, weapon: 'iron_sword', shield: true, health: 14, mobs: [{ type: 'skeleton', x: 8.5, y: 40, z: 0.5 }, { type: 'zombie', x: 11.5, y: 40, z: 0.5 }], minHp: 6 }),
  'down a mine tunnel: skeleton behind two zombies, stone sword': () => ({ classify: tunnel(), bot: { x: 3.5, y: 40, z: 0.5 }, mobs: [{ type: 'skeleton', x: 9.5, y: 40, z: 0.5 }, { type: 'zombie', x: 12.5, y: 40, z: 0.5 }, { type: 'zombie', x: 15.5, y: 40, z: 0.5 }], minHp: 1 }),
  'zombie, open field, bow': () => ({ classify: flat(), weapon: ['bow', 'stone_sword'], bot: { x: 0.5, y: 64, z: 0.5 }, mobs: [{ type: 'zombie', x: 12.5, y: 64, z: 0.5 }] }),
  'witch and a zombie, open field, stone sword': () => ({ classify: flat(), bot: { x: 0.5, y: 64, z: 0.5 }, mobs: [{ type: 'witch', x: 11.5, y: 64, z: 0.5 }, { type: 'zombie', x: 9.5, y: 64, z: 6.5 }], ticks: 1500 }),
  'witch, open field, stone sword': () => ({ classify: flat(), bot: { x: 0.5, y: 64, z: 0.5 }, mobs: [{ type: 'witch', x: 11.5, y: 64, z: 0.5 }], ticks: 1500 }),
  'creeper walking in, bow': () => ({ classify: flat(), weapon: ['bow', 'stone_sword'], bot: { x: 0.5, y: 64, z: 0.5 }, mobs: [{ type: 'creeper', x: 14.5, y: 64, z: 0.5 }] }),
  'skeleton in the open, bow': () => ({ classify: flat(), weapon: ['bow', 'stone_sword'], bot: { x: 0.5, y: 64, z: 0.5 }, mobs: [{ type: 'skeleton', x: 14.5, y: 64, z: 0.5 }] }),
  'zombie, open field, stone sword': () => ({ classify: flat(), bot: { x: 0.5, y: 64, z: 0.5 }, mobs: [{ type: 'zombie', x: 10.5, y: 64, z: 0.5 }] }),
  'two zombies, iron sword + shield': () => ({ classify: flat(), bot: { x: 0.5, y: 64, z: 0.5 }, weapon: 'iron_sword', shield: true, mobs: [{ type: 'zombie', x: 9.5, y: 64, z: 2.5 }, { type: 'zombie', x: 10.5, y: 64, z: -3.5 }] }),
  'skeleton in the open, stone sword': () => ({ classify: flat(), bot: { x: 0.5, y: 64, z: 0.5 }, mobs: [{ type: 'skeleton', x: 12.5, y: 64, z: 0.5 }] }),
  'skeleton in the open, with a shield': () => ({ classify: flat(), bot: { x: 0.5, y: 64, z: 0.5 }, shield: true, mobs: [{ type: 'skeleton', x: 12.5, y: 64, z: 0.5 }] }),
  // The reported one: it can see the skeleton up the stairs, the skeleton's arrows hit the rock.
  'skeleton at the quarry mouth, bot at the bottom': () => ({ classify: quarry(), bot: { x: 10.5, y: 54, z: 0.5, yaw: 90 }, mobs: [{ type: 'skeleton', x: 0.5, y: 64, z: 0.5 }], ticks: 800 }),
  // Exactly as seen: a step back from the lip, the arrows land in the first block of the stairs.
  'skeleton behind the quarry lip, arrows hit the rock': () => ({ classify: quarry(), bot: { x: 10.5, y: 54, z: 0.5, yaw: 90 }, mobs: [{ type: 'skeleton', x: -0.7, y: 64, z: 0.5 }], ticks: 800 }),
  'skeleton at the quarry mouth, shield': () => ({ classify: quarry(), bot: { x: 10.5, y: 54, z: 0.5, yaw: 90 }, shield: true, mobs: [{ type: 'skeleton', x: 0.5, y: 64, z: 0.5 }], ticks: 800 }),
  'skeleton up on a ledge it can\'t be reached on': () => ({
    classify: (x, y, z) => (x >= 8 && x <= 10 && Math.abs(z) <= 1 && y < 70 ? Cell.SOLID : y < 64 ? Cell.SOLID : Cell.AIR),
    bot: { x: 0.5, y: 64, z: 0.5 }, mobs: [{ type: 'skeleton', x: 9.5, y: 70, z: 0.5 }], ticks: 800,
  }),
  'creeper walking in, no shield': () => ({ classify: flat(), minHp: 15, bot: { x: 0.5, y: 64, z: 0.5 }, mobs: [{ type: 'creeper', x: 6.5, y: 64, z: 0.5 }], ticks: 600 }),
  'creeper walking in, shield': () => ({ classify: flat(), minHp: 15, bot: { x: 0.5, y: 64, z: 0.5 }, shield: true, mobs: [{ type: 'creeper', x: 6.5, y: 64, z: 0.5 }], ticks: 600 }),
  'creeper down a dead-end tunnel, shield': () => ({ classify: tunnel(), bot: { x: 1.5, y: 40, z: 0.5 }, shield: true, minHp: 15, mobs: [{ type: 'creeper', x: 12.5, y: 40, z: 0.5 }], ticks: 600 }),
  'creeper down a dead-end tunnel, no shield': () => ({ classify: tunnel(), bot: { x: 1.5, y: 40, z: 0.5 }, mobs: [{ type: 'creeper', x: 12.5, y: 40, z: 0.5 }], ticks: 600 }),
  'zombie + skeleton at night, iron sword': () => ({ classify: flat(), bot: { x: 0.5, y: 64, z: 0.5 }, weapon: 'iron_sword', mobs: [{ type: 'zombie', x: 8.5, y: 64, z: 4.5 }, { type: 'skeleton', x: 14.5, y: 64, z: -3.5 }] }),
  'three zombies, stone sword (too many: run)': () => ({ classify: flat(), bot: { x: 0.5, y: 64, z: 0.5 }, mobs: [{ type: 'zombie', x: 8.5, y: 64, z: 0.5 }, { type: 'zombie', x: 9.5, y: 64, z: 3.5 }, { type: 'zombie', x: 9.5, y: 64, z: -3.5 }], ticks: 900 }),
  'zombie at 8 hp, stone sword': () => ({ classify: flat(), health: 8, bot: { x: 0.5, y: 64, z: 0.5 }, mobs: [{ type: 'zombie', x: 8.5, y: 64, z: 0.5 }], ticks: 900 }),
  'skeleton and a creeper, iron sword + shield': () => ({ classify: flat(), weapon: 'iron_sword', shield: true, bot: { x: 0.5, y: 64, z: 0.5 }, mobs: [{ type: 'skeleton', x: 13.5, y: 64, z: 2.5 }, { type: 'creeper', x: 7.5, y: 64, z: -4.5 }], ticks: 1200 }),
  'zombies coming down the quarry stairs': () => ({ classify: quarry(), bot: { x: 10.5, y: 54, z: 0.5, yaw: 90 }, mobs: [{ type: 'zombie', x: -2.5, y: 64, z: 0.5 }, { type: 'zombie', x: -4.5, y: 64, z: 0.5 }], ticks: 1200 }),
  'boxed in a tunnel, zombies both sides, iron sword': () => ({ classify: (x, y, z) => (z === 0 && x >= -20 && x <= 20 && (y === 40 || y === 41) ? Cell.AIR : Cell.SOLID), weapon: 'iron_sword', bot: { x: 0.5, y: 40, z: 0.5 }, mobs: [{ type: 'zombie', x: 8.5, y: 40, z: 0.5 }, { type: 'zombie', x: -8.5, y: 40, z: 0.5 }], ticks: 1200 }),
  // A kill slot (a block at the feet across the way in, the gap at eye level): nothing gets to us.
  'three zombies at the end of a 3-high tunnel, stone sword, 10 hp': () => ({ classify: (x, y, z) => (z === 0 && x >= 1 && x <= 20 && y >= 40 && y <= 42 ? Cell.AIR : Cell.SOLID), bot: { x: 1.5, y: 40, z: 0.5 }, health: 10, minHp: 10, mobs: [{ type: 'zombie', x: 8.5, y: 40, z: 0.5 }, { type: 'zombie', x: 11.5, y: 40, z: 0.5 }, { type: 'husk', x: 14.5, y: 40, z: 0.5 }], ticks: 1200 }),
  'two zombies down a dead-end tunnel, stone axe': () => ({ classify: tunnel(), weapon: 'stone_axe', bot: { x: 3.5, y: 40, z: 0.5 }, mobs: [{ type: 'zombie', x: 9.5, y: 40, z: 0.5 }, { type: 'zombie', x: 12.5, y: 40, z: 0.5 }], ticks: 900 }),
  'zombies in a rough forest, stone sword': () => ({ classify: forest(), bot: { x: 3.5, y: 70, z: 3.5 }, mobs: [{ type: 'zombie', x: 14.5, y: 70, z: 9.5 }, { type: 'zombie', x: -6.5, y: 70, z: 12.5 }], ticks: 1600 }),
};

// Settle bots and mobs onto the ground (scenario coordinates are rough for the forest).
function ground(classify, p) {
  let y = Math.floor(p.y) + 6;
  while (y > -60 && !(classify(Math.floor(p.x), y - 1, Math.floor(p.z)) === Cell.SOLID && classify(Math.floor(p.x), y, Math.floor(p.z)) === Cell.AIR && classify(Math.floor(p.x), y + 1, Math.floor(p.z)) === Cell.AIR)) y--;
  return { ...p, y };
}

// --fuzz N: random fights (terrain, mobs, gear, health) to find bad calls: dying in a fight it
// chose to start, or standing about while hunted.
const FUZZ = process.argv.includes('--fuzz') ? Number(process.argv[process.argv.indexOf('--fuzz') + 1] || 100) : 0;
if (FUZZ) {
  const rng = makeRng(99);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const stats = { runs: 0, died: 0, diedFighting: 0, stared: 0, lived: 0 };
  const bad = [];
  for (let i = 0; i < FUZZ; i++) {
    const terrain = pick(['flat', 'forest', 'quarry', 'tunnel']);
    const classify = terrain === 'flat' ? flat() : terrain === 'forest' ? forest() : terrain === 'quarry' ? quarry() : tunnel();
    const bot = terrain === 'quarry' ? { x: 10.5, y: 54, z: 0.5 } : terrain === 'tunnel' ? { x: 1.5 + Math.floor(rng() * 5), y: 40, z: 0.5 } : { x: 0.5, y: 70, z: 0.5 };
    const n = 1 + Math.floor(rng() * 3);
    const mobs = [];
    for (let k = 0; k < n; k++) {
      const type = pick(['zombie', 'zombie', 'skeleton', 'creeper']);
      const a = rng() * Math.PI * 2, r = 6 + rng() * 8;
      mobs.push(terrain === 'quarry' ? { type, x: -1.5 - k * 2, y: 64, z: 0.5 } : terrain === 'tunnel' ? { type, x: bot.x + 6 + k * 3, y: 40, z: 0.5 } : { type, x: 0.5 + Math.cos(a) * r, y: 70, z: 0.5 + Math.sin(a) * r });
    }
    const sc = { classify, bot: ground(classify, bot), mobs: mobs.map((m) => ground(classify, m)), weapon: pick(['wooden_sword', 'stone_sword', 'stone_sword', 'iron_sword', 'stone_axe']), shield: rng() < 0.5, health: pick([20, 20, 14, 10]), ticks: 900 };
    const desc = `${terrain}, ${mobs.map((m) => m.type).join('+')}, ${sc.weapon}${sc.shield ? '+shield' : ''}, ${sc.health} hp`;
    const r = arena(sc);
    stats.runs++;
    if (r.hp <= 0) { stats.died++; if (r.foughtAtDeath) { stats.diedFighting++; bad.push(`died fighting: ${desc}`); } else bad.push(`died running: ${desc}`); }
    else stats.lived++;
    if (r.worstIdle >= 160) { stats.stared++; bad.push(`idle ${(r.worstIdle / 20).toFixed(0)} s while hunted: ${desc}`); }
  }
  console.log(JSON.stringify(stats));
  for (const b of bad.slice(0, 25)) console.log(`  - ${b}`);
  process.exit(stats.diedFighting + stats.stared ? 1 : 0);
}

// --zombies N: one or two zombies (a husk now and then) on flat ground, in a forest, down a tunnel,
// each weapon: hits taken, and how long a zombie was inside its own reach (1.6) of the bot.
const ZOMBIES = process.argv.includes('--zombies') ? Number(process.argv[process.argv.indexOf('--zombies') + 1] || 200) : 0;
if (ZOMBIES) {
  const rng = makeRng(7);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  let hits = 0, close = 0, died = 0, kills = 0, total = 0, secs = 0;
  for (let i = 0; i < ZOMBIES; i++) {
    const terrain = pick(['flat', 'forest', 'tunnel']);
    const classify = terrain === 'flat' ? flat() : terrain === 'forest' ? forest() : tunnel();
    const bot = terrain === 'tunnel' ? { x: 1.5, y: 40, z: 0.5 } : { x: 0.5, y: 70, z: 0.5 };
    const n = 1 + (rng() < 0.4 ? 1 : 0);
    const mobs = [];
    for (let k = 0; k < n; k++) {
      const a = rng() * Math.PI * 2, r = 5 + rng() * 8;
      mobs.push(terrain === 'tunnel' ? { type: 'zombie', x: bot.x + 6 + k * 3, y: 40, z: 0.5 } : { type: 'zombie', x: 0.5 + Math.cos(a) * r, y: 70, z: 0.5 + Math.sin(a) * r });
    }
    const r = arena({ classify, bot: ground(classify, bot), mobs: mobs.map((m) => ground(classify, m)), weapon: pick(['stone_sword', 'iron_sword', 'stone_axe', 'wooden_sword']), shield: false, health: 20, ticks: 900 });
    hits += r.hitsTaken; close += r.closeTicks; kills += r.kills; total += r.total; secs += r.ticks / 20; if (r.hp <= 0) died++;
  }
  console.log(`${ZOMBIES} zombie fights: ${(hits / ZOMBIES).toFixed(2)} hits taken a fight, a zombie inside its reach ${(close / ZOMBIES / 20).toFixed(2)} s a fight, killed ${kills}/${total}, ${(secs / ZOMBIES).toFixed(1)} s a fight, died ${died}`);
  process.exit(0);
}

// --creepers N: creeper encounters: from any side, behind trees or round a corner, not always known
// to be after us, sometimes with company; any gear (fists too). Counts how many never went off.
const CREEPERS = process.argv.includes('--creepers') ? Number(process.argv[process.argv.indexOf('--creepers') + 1] || 200) : 0;
if (CREEPERS) {
  const rng = makeRng(4242);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const stats = { runs: 0, exploded: 0, died: 0 };
  const bad = [], byKind = {};
  for (let i = 0; i < CREEPERS; i++) {
    const terrain = pick(['flat', 'forest', 'forest', 'quarry', 'tunnel']);
    const classify = terrain === 'flat' ? flat() : terrain === 'forest' ? forest() : terrain === 'quarry' ? quarry() : tunnel();
    const bot = terrain === 'quarry' ? { x: 10.5, y: 54, z: 0.5 } : terrain === 'tunnel' ? { x: 1.5 + Math.floor(rng() * 5), y: 40, z: 0.5 } : { x: 0.5, y: 70, z: 0.5 };
    const company = rng() < 0.25 ? [pick(['zombie', 'skeleton', 'creeper'])] : [];
    const mobs = [];
    for (const [k, type] of ['creeper', ...company].entries()) {
      const a = rng() * Math.PI * 2, r = 5 + rng() * 9;
      mobs.push({ type, aware: rng() < 0.5, ...(terrain === 'quarry' ? { x: -1.5 - k * 2, y: 64, z: 0.5 } : terrain === 'tunnel' ? { x: bot.x + 5 + k * 3 + Math.floor(rng() * 6), y: 40, z: 0.5 } : { x: 0.5 + Math.cos(a) * r, y: 70, z: 0.5 + Math.sin(a) * r }) });
    }
    const weapon = pick([null, 'wooden_sword', 'stone_sword', 'stone_sword', 'iron_sword', 'stone_axe']);
    // SPEAR=1: a stone spear carried too (what the bot makes for creepers).
    const sc = { classify, bot: ground(classify, bot), mobs: mobs.map((m) => ground(classify, m)), weapon: SPEAR ? [weapon, 'stone_spear'] : weapon, shield: rng() < 0.4, health: pick([20, 20, 14, 8]), ticks: 900 };
    const desc = `${terrain}, ${mobs.map((m) => m.type + (m.aware ? '' : '(unaware)')).join('+')}, ${weapon ?? 'fists'}${SPEAR ? '+spear' : ''}${sc.shield ? '+shield' : ''}, ${sc.health} hp`;
    const r = arena(sc);
    stats.runs++;
    const key = `${terrain}${company.length ? '+company' : ''}`;
    byKind[key] ??= [0, 0]; byKind[key][0]++;
    if (r.explosions) { stats.exploded++; byKind[key][1]++; bad.push(`${r.hp <= 0 ? 'DIED' : `${r.hp.toFixed(0)} hp`}: ${desc}`); }
    if (r.hp <= 0) { stats.died++; if (process.env.DUMPDIED) console.log(`  died: ${desc}${r.walls ? ' (block/wall used)' : ''}, blast ${r.blastHp.toFixed(1)}`); }
  }
  console.log(`${stats.runs - stats.exploded}/${stats.runs} without an explosion (${(100 * (1 - stats.exploded / stats.runs)).toFixed(1)}%), ${stats.died} died`);
  for (const [k, [n, e]] of Object.entries(byKind)) console.log(`  ${k.padEnd(16)} ${n - e}/${n}`);
  for (const b of bad.slice(0, VERBOSE ? 60 : 12)) console.log(`  - ${b}`);
  process.exit(0);
}

// --ambush N: creepers catching the bot in its own quarry and mine. Kinds:
//   stairs    the bot working in the tunnel, a creeper coming down the stairs behind it
//   dropped   a creeper suddenly on the stairs a few steps above the bot (fell in)
//   dark      one appears in the tunnel between the bot and the way out, the bot at the dead end
//   side      one comes out of the side branch close by
//   climbing  the bot half way up the stairs, one coming down at it
// The bot's kit: a stone sword and the stone spear it makes (SPEAR=0: sword only), shield sometimes.
// --cornered N: the bot cornered at the bottom of jagged steps with a creeper coming down, no shield
// (knockback hits the steps behind it and barely moves it). Weapons: stone sword (+ spear).
const CORNERED = process.argv.includes('--cornered') ? Number(process.argv[process.argv.indexOf('--cornered') + 1] || 200) : 0;
if (CORNERED) {
  const rng = makeRng(31337);
  const kinds = { deadend: [0, 0, 0], wide: [0, 0, 0], low: [0, 0, 0] };
  const bad = [];
  let walls = 0, killed = 0, lost = 0, blast = 0;
  for (let i = 0; i < CORNERED; i++) {
    const kind = Object.keys(kinds)[i % 3];
    const J = jagged(rng, kind);
    const weapon = process.env.SPEAR === '0' ? 'stone_sword' : ['stone_sword', 'stone_spear'];
    const sc = { classify: J.classify, bot: J.bot, mobs: [{ type: 'creeper', ...J.top }], weapon, shield: false, health: 20, ticks: 900, blocks: Number(process.env.BLOCKS ?? 16) };
    const r = arena(sc);
    kinds[kind][0]++;
    walls += r.walls ? 1 : 0;
    killed += r.kills; lost += 20 - Math.max(0, r.hp); blast += r.blastHp;
    if (r.explosions) { kinds[kind][1]++; bad.push(`${kind} #${i}: ${r.hp <= 0 ? 'DIED' : `${r.hp.toFixed(0)} hp`}${r.walls ? ' (walled)' : ''}`); }
    if (r.hp <= 0) kinds[kind][2]++;
  }
  const tot = Object.values(kinds).reduce((a, k) => [a[0] + k[0], a[1] + k[1], a[2] + k[2]], [0, 0, 0]);
  console.log(`${tot[0] - tot[1]}/${tot[0]} cornered at the foot of jagged steps without an explosion (${(100 * (1 - tot[1] / tot[0])).toFixed(1)}%), ${tot[2]} died, ${GUARD ? 'a block against the blast' : 'walled off'} in ${walls}; creeper killed ${killed}/${tot[0]}, ${(lost / tot[0]).toFixed(1)} hp lost a fight (${(blast / tot[0]).toFixed(1)} of it blast)`);
  for (const [k, [n, e, d]] of Object.entries(kinds)) console.log(`  ${k.padEnd(8)} ${n - e}/${n}${d ? ` (${d} died)` : ''}`);
  for (const b of bad.slice(0, VERBOSE ? 30 : 6)) console.log(`  - ${b}`);
  process.exit(0);
}

// --chase N: running (hurt) from melee mobs close behind that can catch up: spiders (faster than
// our walk), zombies where the ground slows us (forest, up the quarry stairs). Sword and spear.
const CHASE = process.argv.includes('--chase') ? Number(process.argv[process.argv.indexOf('--chase') + 1] || 200) : 0;
if (CHASE) {
  const rng = makeRng(2718);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  let hits = 0, died = 0, runs = 0, jabs = 0, hpLeft = 0;
  const byKind = {};
  for (let i = 0; i < CHASE; i++) {
    const terrain = pick(['flat', 'forest', 'mine']);
    const classify = terrain === 'flat' ? flat() : terrain === 'forest' ? forest() : mine();
    const bot = terrain === 'mine' ? { x: 24.5, y: 52, z: 0.5 } : { x: 1.5, y: 70, z: 0.5 }; // (0,0 is a trunk in the forest)
    const n = 1 + Math.floor(rng() * 2);
    const mobs = [];
    for (let k = 0; k < n; k++) {
      const type = pick(['zombie', 'zombie', 'spider']);
      if (terrain === 'mine') mobs.push({ type, x: 28.5 + k, y: 52, z: 0.5 }); // 4-5 behind us, from the tunnel's end: we run for the stairs
      else { const a = rng() * Math.PI * 2, r = 3 + rng() * 3; mobs.push({ type, x: 0.5 + Math.cos(a) * r, y: 70, z: 0.5 + Math.sin(a) * r }); }
    }
    const sc = { classify, bot: ground(classify, bot), mobs: mobs.map((m) => ground(classify, m)), weapon: ['stone_sword', 'stone_spear'], shield: false, health: 5, ticks: 600, night: true };
    const r = arena(sc);
    runs++; hits += r.hitsTaken; jabs += r.jabs; hpLeft += Math.max(0, r.hp);
    if (r.hp <= 0) died++;
    const key = `${terrain} ${mobs.map((m) => m.type).join('+')}`;
    byKind[terrain] ??= [0, 0, 0]; byKind[terrain][0]++; byKind[terrain][1] += r.hitsTaken; if (r.hp <= 0) byKind[terrain][2]++;
    void key;
  }
  console.log(`${runs} chases (5 hp, running): ${died} died, ${(hits / runs).toFixed(2)} hits taken each, ${(jabs / runs).toFixed(1)} jabs each, ${(hpLeft / runs).toFixed(1)} hp left on average`);
  for (const [k, [n, h, d]] of Object.entries(byKind)) console.log(`  ${k.padEnd(7)} ${n} runs, ${(h / n).toFixed(2)} hits each, ${d} died`);
  process.exit(0);
}

// --pursuit N: running from a group (2-4: zombies, a spider, a creeper among them) on flat ground,
// in a forest, on rough tall ground; hurt (running) or not. Hits taken, deaths, explosions, how long
// a creeper was within 3 of the bot, creepers jabbed away, pillars climbed.
const PURSUIT = process.argv.includes('--pursuit') ? Number(process.argv[process.argv.indexOf('--pursuit') + 1] || 200) : 0;
if (PURSUIT) {
  const rng = makeRng(31337);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const tot = { runs: 0, died: 0, hits: 0, blasts: 0, close: 0, cjabs: 0, towers: 0 };
  const byT = {};
  for (let i = 0; i < PURSUIT; i++) {
    const terrain0 = pick(['flat', 'forest', 'cliffs', 'cliffs', 'trench']), terrain = process.env.TERRAIN ?? terrain0;
    const classify = terrain === 'flat' ? flat() : terrain === 'forest' ? forest() : terrain === 'trench' ? trench() : cliffs(i);
    const bot = { x: 1.5, y: 70, z: 0.5 };
    const n = 2 + Math.floor(rng() * 3);
    const mobs = [];
    for (let k = 0; k < n; k++) {
      const type = k === 0 && rng() < 0.6 ? 'creeper' : pick(['zombie', 'zombie', 'zombie', 'spider']);
      const ang = rng() * Math.PI * 2, rr = 4 + rng() * 6;
      // (In the trench: coming along it from both ends.)
      mobs.push(terrain === 'trench' ? { type, x: 1.5 + (k % 2 ? -1 : 1) * (4 + rng() * 4), y: 70, z: 0.5 } : { type, x: 1.5 + Math.cos(ang) * rr, y: 70, z: 0.5 + Math.sin(ang) * rr });
    }
    const r = arena({ classify, bot: ground(classify, bot), mobs: mobs.map((m) => ground(classify, m)), weapon: pick([['stone_sword', 'stone_spear'], ['iron_sword', 'stone_spear'], 'stone_sword']), shield: false, health: pick([20, 10, 6]), ticks: 900, blocks: 16 });
    if (r.killer) tot.killers = { ...(tot.killers ?? {}), [r.killer]: (tot.killers?.[r.killer] ?? 0) + 1 };
    tot.climbs = (tot.climbs ?? 0) + r.climbs;
    tot.runs++; tot.hits += r.hitsTaken; tot.blasts += r.explosions; tot.close += r.creeperClose; tot.cjabs += r.creeperJabs; tot.towers += r.towers; if (r.hp <= 0) tot.died++;
    const b = (byT[terrain] ??= { runs: 0, died: 0, hits: 0, blasts: 0 }); b.runs++; b.hits += r.hitsTaken; b.blasts += r.explosions; if (r.hp <= 0) b.died++;
  }
  console.log(`${tot.runs} pursuits: ${tot.died} died, ${(tot.hits / tot.runs).toFixed(2)} hits taken each, ${tot.blasts} explosions, a creeper within 3 for ${(tot.close / tot.runs / 20).toFixed(2)} s a run, ${(tot.cjabs / tot.runs).toFixed(2)} creeper jabs a run, ${(tot.towers / tot.runs).toFixed(2)} pillars a run, ${(tot.climbs / tot.runs).toFixed(2)} ledges climbed a run`);
  console.log(`  killed by: ${JSON.stringify(tot.killers ?? {})}`);
  for (const [k, b] of Object.entries(byT)) console.log(`  ${k.padEnd(7)} ${b.runs} runs, ${b.died} died, ${(b.hits / b.runs).toFixed(2)} hits each, ${b.blasts} explosions`);
  process.exit(0);
}

// --archers N: 1-2 skeletons at 8-15 blocks on flat ground, in a forest, at the quarry mouth;
// random weapon and health, a shield some of the time. DODGE=0: no stepping out of the way.
const ARCHERS = process.argv.includes('--archers') ? Number(process.argv[process.argv.indexOf('--archers') + 1] || 200) : 0;
if (ARCHERS) {
  const rng = makeRng(4242);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  let shot = 0, hit = 0, died = 0, dodges = 0, won = 0, blockedN = 0;
  const by = {};
  for (let i = 0; i < ARCHERS; i++) {
    const terrain = pick(['flat', 'forest', 'quarry']);
    const classify = terrain === 'flat' ? flat() : terrain === 'forest' ? forest() : quarry();
    const shield = rng() < 0.3;
    const n = 1 + (rng() < 0.4 ? 1 : 0);
    let bot, mobs = [];
    if (terrain === 'quarry') { bot = { x: 10.5, y: 54, z: 0.5 }; for (let k = 0; k < n; k++) mobs.push({ type: 'skeleton', x: 0.5 - k * 2, y: 64, z: 0.5 + k }); }
    else { bot = { x: 1.5, y: 70, z: 0.5 }; /* (0,0 is a trunk in the forest) */ for (let k = 0; k < n; k++) { const a = rng() * Math.PI * 2, r = 8 + rng() * 7; mobs.push({ type: 'skeleton', x: 0.5 + Math.cos(a) * r, y: 70, z: 0.5 + Math.sin(a) * r }); } }
    const r = arena({ classify, bot: ground(classify, bot), mobs: mobs.map((m) => ground(classify, m)), weapon: pick(['wooden_sword', 'stone_sword', 'iron_sword']), shield, health: pick([20, 20, 14, 8]), ticks: 1200 });
    if (process.env.DUMP && i < Number(process.env.DUMP)) { console.log(`#${i} ${terrain} shield ${shield} bot ${JSON.stringify(ground(classify, bot))} mobs ${JSON.stringify(mobs.map((m) => ground(classify, m)))} -> hp ${r.hp} shot ${r.arrowsShot} hit ${r.arrowHits} dodges ${r.dodges} kills ${r.kills}/${r.total} ticks ${r.ticks}`); if (VERBOSE) console.log(r.log.slice(0, 60).join('\n')); }
    shot += r.arrowsShot; hit += r.arrowHits; dodges += r.dodges; blockedN += r.blocked;
    if (r.hp <= 0) died++; if (r.kills === r.total) won++;
    const k = `${terrain}${shield ? '+shield' : ''}`;
    by[k] ??= [0, 0, 0, 0]; by[k][0]++; by[k][1] += r.arrowsShot; by[k][2] += r.arrowHits; if (r.hp <= 0) by[k][3]++;
  }
  console.log(`${ARCHERS} archer fights: ${died} died, won ${won}, ${shot} arrows loosed, ${hit} hit (${(100 * hit / Math.max(1, shot)).toFixed(0)}%), ${blockedN} on the shield, ${dodges} dodges`);
  for (const [k, [n, sh, h, d]] of Object.entries(by)) console.log(`  ${k.padEnd(14)} ${n} fights, ${(h / Math.max(1, sh) * 100).toFixed(0)}% of arrows hit, ${(h / n).toFixed(2)} hits a fight, ${d} died`);
  process.exit(0);
}

// --weapons N: the same N fights (terrain, mobs, health) with each loadout, side by side: the
// swords, an axe, sword + spear, and a bow (64 arrows) backed by a sword.
const WEAPONS = process.argv.includes('--weapons') ? Number(process.argv[process.argv.indexOf('--weapons') + 1] || 200) : 0;
if (WEAPONS) {
  const loadouts = [['wooden_sword'], ['stone_sword'], ['stone_axe'], ['iron_sword'], ['stone_sword', 'stone_spear'], ['bow', 'wooden_sword'], ['bow', 'stone_sword'], ['bow', 'iron_sword']];
  const sets = [['zombie'], ['zombie', 'zombie'], ['skeleton'], ['skeleton', 'zombie'], ['creeper'], ['spider'], ['zombie', 'skeleton', 'creeper']];
  const make = (i) => {
    const rng = makeRng(9000 + i);
    const pick = (a) => a[Math.floor(rng() * a.length)];
    const terrain = pick(['flat', 'flat', 'forest', 'tunnel', 'quarry']);
    const set = pick(sets), health = pick([20, 20, 14]);
    const classify = terrain === 'flat' ? flat() : terrain === 'forest' ? forest() : terrain === 'tunnel' ? tunnel() : quarry();
    let bot, mobs;
    if (terrain === 'tunnel') { bot = { x: 3.5, y: 40, z: 0.5 }; mobs = set.map((type, k) => ({ type, x: 11.5 + k * 3, y: 40, z: 0.5 })); }
    else if (terrain === 'quarry') { bot = { x: 10.5, y: 54, z: 0.5 }; mobs = set.map((type, k) => ({ type, x: 0.5 - k, y: 64, z: 0.5 })); }
    else { bot = { x: 1.5, y: 70, z: 0.5 }; mobs = set.map((type) => { const a = rng() * Math.PI * 2, r = 10 + rng() * 5; return { type, x: 1.5 + Math.cos(a) * r, y: 70, z: 0.5 + Math.sin(a) * r }; }); }
    return { terrain, set, health, classify, bot: ground(classify, bot), mobs: mobs.map((m) => ground(classify, m)) };
  };
  const key = (w) => w.join('+');
  const res = {}, bySet = {};
  for (let i = 0; i < WEAPONS; i++) {
    for (const w of loadouts) {
      const f = make(i);
      const r = arena({ classify: f.classify, bot: f.bot, mobs: f.mobs, weapon: w, health: f.health, ticks: 1500 });
      const o = (res[key(w)] ??= { n: 0, died: 0, hp: 0, lost: 0, kills: 0, total: 0, ticks: 0, shots: 0, bowHits: 0, explosions: 0 });
      o.n++; o.died += r.hp <= 0 ? 1 : 0; o.hp += Math.max(0, r.hp); o.lost += f.health - Math.max(0, r.hp); o.kills += r.kills; o.total += r.total; o.ticks += r.ticks; o.shots += r.bowShots; o.bowHits += r.bowHits; o.explosions += r.explosions;
      const sk = f.set.join('+');
      ((bySet[sk] ??= {})[key(w)] ??= [0, 0, 0]);
      bySet[sk][key(w)][0]++; bySet[sk][key(w)][1] += f.health - Math.max(0, r.hp); if (r.hp <= 0) bySet[sk][key(w)][2]++;
      if (process.env.KILLS) { bySet[sk][key(w)][3] = (bySet[sk][key(w)][3] ?? 0) + r.kills; bySet[sk][key(w)][4] = (bySet[sk][key(w)][4] ?? 0) + r.total; bySet[sk][key(w)][5] = (bySet[sk][key(w)][5] ?? 0) + r.bowShots; }
    }
  }
  console.log(`${WEAPONS} fights with each loadout (flat, forest, a mine tunnel, the quarry; 1-3 mobs; 14-20 hp):`);
  console.log(`  ${'loadout'.padEnd(26)} died  hp lost  killed      explosions  time    arrows (hit)`);
  for (const [k, o] of Object.entries(res)) console.log(`  ${k.padEnd(26)} ${String(o.died).padStart(4)}  ${(o.lost / o.n).toFixed(1).padStart(7)}  ${`${o.kills}/${o.total}`.padStart(9)}  ${String(o.explosions).padStart(10)}  ${(o.ticks / o.n / 20).toFixed(1).padStart(4)} s  ${o.shots ? `${(o.shots / o.n).toFixed(1)} (${(100 * o.bowHits / o.shots).toFixed(0)}%)` : '-'}`);
  console.log('  hp lost a fight (deaths), by what it faced:');
  const cols = ['stone_sword', 'iron_sword', 'stone_sword+stone_spear', 'bow+stone_sword', 'bow+iron_sword'];
  console.log(`  ${''.padEnd(26)} ${cols.map((c) => c.replace('stone_', 's.').replace('iron_', 'i.').replace('+s.spear', '+spear').padStart(14)).join('')}`);
  for (const [sk, row] of Object.entries(bySet)) console.log(`  ${sk.padEnd(26)} ${cols.map((c) => { const [n, l, d] = row[c] ?? [0, 0, 0]; return (n ? `${(l / n).toFixed(1)} (${d})${process.env.KILLS ? ` ${row[c][3]}/${row[c][4]} a${row[c][5]}` : ''}` : '-').padStart(process.env.KILLS ? 24 : 14); }).join('')}`);
  process.exit(0);
}

// --witch N: a witch (sometimes with a zombie) on flat ground, in a forest, at the quarry mouth;
// random weapon, health, a shield some of the time. WITCHFLEE=1: run from witches (as before).
const WITCH = process.argv.includes('--witch') ? Number(process.argv[process.argv.indexOf('--witch') + 1] || 200) : 0;
if (WITCH) {
  const rng = makeRng(8888);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  let died = 0, lost = 0, killed = 0, total = 0, thrown = 0, hitBy = 0, potHp = 0, secs = 0;
  const by = {};
  for (let i = 0; i < WITCH; i++) {
    const terrain = pick(['flat', 'forest', 'quarry']);
    const classify = terrain === 'flat' ? flat() : terrain === 'forest' ? forest() : quarry();
    const company = rng() < 0.3;
    let bot, mobs = [];
    if (terrain === 'quarry') { bot = { x: 10.5, y: 54, z: 0.5 }; mobs.push({ type: 'witch', x: 0.5, y: 64, z: 0.5 }); if (company) mobs.push({ type: 'zombie', x: -1.5, y: 64, z: 1.5 }); }
    else { bot = { x: 1.5, y: 70, z: 0.5 }; const a = rng() * Math.PI * 2, r = 9 + rng() * 5; mobs.push({ type: 'witch', x: 1.5 + Math.cos(a) * r, y: 70, z: 0.5 + Math.sin(a) * r }); if (company) mobs.push({ type: 'zombie', x: 1.5 + Math.cos(a + 1) * r, y: 70, z: 0.5 + Math.sin(a + 1) * r }); }
    const health = pick([20, 20, 14]);
    const r = arena({ classify, bot: ground(classify, bot), mobs: mobs.map((m) => ground(classify, m)), weapon: pick(['stone_sword', 'stone_sword', 'iron_sword']), shield: rng() < 0.3, health, ticks: 1500 });
    if (r.hp <= 0) died++;
    lost += health - Math.max(0, r.hp); killed += r.kills; total += r.total; thrown += r.potionsThrown; hitBy += r.potionHits; potHp += r.potionHp; secs += r.ticks / 20;
    const k = `${terrain}${company ? '+zombie' : ''}`;
    by[k] ??= [0, 0, 0, 0]; by[k][0]++; by[k][1] += health - Math.max(0, r.hp); if (r.hp <= 0) by[k][2]++; by[k][3] += r.kills === r.total ? 1 : 0;
  }
  console.log(`${WITCH} witch encounters${process.env.WITCHFLEE === '1' ? ' (running from witches)' : ''}: ${died} died, ${(lost / WITCH).toFixed(1)} hp lost each, killed ${killed}/${total}, ${thrown} potions thrown, ${hitBy} splashed us (${(potHp / WITCH).toFixed(1)} hp each), ${(secs / WITCH).toFixed(0)} s each`);
  for (const [k, [n, l, d, w]] of Object.entries(by)) console.log(`  ${k.padEnd(14)} ${n} runs, ${(l / n).toFixed(1)} hp lost, ${d} died, won ${w}`);
  process.exit(0);
}

// --deadend N: caught at the end of a mine tunnel (1 wide, 2 or 3 high) by 2-3 zombies, random
// health and weapon: the way out is through them. SLOT=0: without the kill slot.
const DEADEND = process.argv.includes('--deadend') ? Number(process.argv[process.argv.indexOf('--deadend') + 1] || 200) : 0;
if (DEADEND) {
  const rng = makeRng(1618);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  let hits = 0, died = 0, slots = 0, hpLeft = 0, killed = 0, total = 0;
  for (let i = 0; i < DEADEND; i++) {
    const high = rng() < 0.5 ? 2 : 3;
    const classify = (x, y, z) => (z === 0 && x >= 1 && x <= 24 && y >= 40 && y < 40 + high ? Cell.AIR : Cell.SOLID);
    const n = 2 + Math.floor(rng() * 2);
    const bx = 1 + Math.floor(rng() * 3);
    const mobs = [];
    for (let k = 0; k < n; k++) mobs.push({ type: pick(['zombie', 'zombie', 'husk']), x: bx + 6 + k * 2 + Math.floor(rng() * 3) + 0.5, y: 40, z: 0.5 });
    const r = arena({ classify, bot: { x: bx + 0.5, y: 40, z: 0.5 }, mobs, weapon: pick(['wooden_sword', 'stone_sword', 'stone_axe', 'iron_sword']), health: 6 + Math.floor(rng() * 15), ticks: 1500 });
    if (process.env.DUMP && i < Number(process.env.DUMP)) console.log(`#${i} high ${high} bot ${bx} mobs ${mobs.map((m) => m.x).join(',')} -> hp ${r.hp.toFixed(0)} slot ${r.slots} hits ${r.hitsTaken} kills ${r.kills}/${r.total} walls ${r.walls} ticks ${r.ticks}`);
    hits += r.hitsTaken; slots += r.slots ? 1 : 0; hpLeft += Math.max(0, r.hp); killed += r.kills; total += r.total;
    if (r.hp <= 0) died++;
  }
  console.log(`${DEADEND} dead ends, 2-3 zombies: ${died} died, ${(hits / DEADEND).toFixed(2)} hits taken each, ${(hpLeft / DEADEND).toFixed(1)} hp left on average, killed ${killed}/${total}, kill slot in ${slots}`);
  process.exit(0);
}

const AMBUSH = process.argv.includes('--ambush') ? Number(process.argv[process.argv.indexOf('--ambush') + 1] || 200) : 0;
if (AMBUSH) {
  const rng = makeRng(777);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const kinds = { stairs: [0, 0, 0], dropped: [0, 0, 0], dark: [0, 0, 0], side: [0, 0, 0], climbing: [0, 0, 0] }; // runs, exploded, died
  let crater = 0;
  const bad = [];
  const stepAt = (x) => ({ x: x + 0.5, y: 64 - x, z: 0.5 });
  for (let i = 0; i < AMBUSH; i++) {
    const kind = pick(Object.keys(kinds));
    let bot, cr;
    if (kind === 'stairs') { bot = { x: 14 + Math.floor(rng() * 12) + 0.5, y: 52, z: 0.5 }; cr = stepAt(1 + Math.floor(rng() * 5)); }
    else if (kind === 'dropped') { bot = { x: 12.5 + Math.floor(rng() * 3), y: 52, z: 0.5 }; const k = 8 + Math.floor(rng() * 3); cr = stepAt(k); }
    else if (kind === 'dark') { bot = { x: 29.5, y: 52, z: 0.5 }; cr = { x: 29.5 - (3.5 + rng() * 4), y: 52, z: 0.5 }; cr.x = Math.floor(cr.x) + 0.5; }
    else if (kind === 'side') { bot = { x: 20.5 + Math.floor(rng() * 4), y: 52, z: 0.5 }; cr = { x: 22.5, y: 52, z: 3.5 + Math.floor(rng() * 4) }; }
    else { const k = 4 + Math.floor(rng() * 4); bot = stepAt(k); cr = stepAt(k - 4 - Math.floor(rng() * 3)); }
    const weapon = process.env.SPEAR === '0' ? 'stone_sword' : ['stone_sword', 'stone_spear'];
    const sc = { classify: mine(), bot, mobs: [{ type: 'creeper', aware: rng() < 0.6, ...cr }], weapon, shield: rng() < 0.5, health: pick([20, 20, 14]), ticks: 900 };
    const r = arena(sc);
    kinds[kind][0]++;
    if (r.explosions) { kinds[kind][1]++; crater += r.crater; bad.push(`${kind}: bot ${bot.x},${bot.y}, creeper ${cr.x.toFixed(1)},${cr.y},${cr.z.toFixed(1)}${sc.shield ? ', shield' : ''} -> ${r.hp <= 0 ? 'DIED' : `${r.hp.toFixed(0)} hp`}`); }
    if (r.hp <= 0) kinds[kind][2]++;
  }
  const tot = Object.values(kinds).reduce((a, k) => [a[0] + k[0], a[1] + k[1], a[2] + k[2]], [0, 0, 0]);
  console.log(`${tot[0] - tot[1]}/${tot[0]} ambushes in the quarry without an explosion (${(100 * (1 - tot[1] / tot[0])).toFixed(1)}%), ${tot[2]} died${tot[1] ? `, ${(crater / tot[1]).toFixed(0)} blocks blown out per blast` : ''}`);
  for (const [k, [n, e, d]] of Object.entries(kinds)) console.log(`  ${k.padEnd(9)} ${n - e}/${n}${d ? ` (${d} died)` : ''}`);
  for (const b of bad.slice(0, VERBOSE ? 40 : 8)) console.log(`  - ${b}`);
  process.exit(0);
}

let failed = 0;
for (const [name, make] of Object.entries(SCENARIOS)) {
  if (ONLY && !name.includes(ONLY)) continue;
  const sc = make();
  sc.bot = ground(sc.classify, sc.bot);
  sc.mobs = sc.mobs.map((m) => ground(sc.classify, m));
  const r = arena(sc);
  const lived = r.hp > 0;
  const stared = r.worstIdle >= 160; // 8 s of doing nothing while hunted
  const ok = lived && !stared && r.hp >= (sc.minHp ?? 1);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${lived ? `lived (${r.hp.toFixed(0)} hp)` : 'DIED'}, killed ${r.kills}/${r.total}, hits taken ${r.hitsTaken}, blocked ${r.blocked}, gave up ${r.gaveUp}, longest idle while hunted ${(r.worstIdle / 20).toFixed(1)} s, ${(r.ticks / 20).toFixed(0)} s`);
  if (VERBOSE) for (const l of r.log) console.log(`    ${l}`);
}
process.exitCode = failed ? 1 : 0;
