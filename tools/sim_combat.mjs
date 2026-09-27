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
import { fightMove, creeperMove, creeperFight, Stalemate, pickRefuge, barricadeCells, awayPath, weaponReach, creeperWeapon, bestWeapon, pickCreeperSwing, knockbackRoom, blockOffCells, fleeJab } from '../behavior_pack/scripts/core/tactics.js';
import { makeRng, dist3D } from '../behavior_pack/scripts/core/mathutil.js';
import { SimBody } from '../tests/helpers.js';

const VERBOSE = process.argv.includes('-v');
// --old: the fight logic as it was (aim at a point on the straight line to the mob; archers always
// count as reachable), to check the arena reproduces what went wrong in game.
const OLD = process.argv.includes('--old');
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
// FLEEJAB=0: running from something catching up, no turning to jab it.
const FLEEJAB = process.env.FLEEJAB !== '0';

// ---------- the arena ----------
function arena({ classify: base, bot, mobs, weapon = 'stone_sword', shield = false, ticks = 1200, night = true, health = 20, blocks = 16 }) {
  // Blocks the bot puts down (a barricade) are solid to everyone from then on.
  const placed = new Set();
  // Blocks the bot puts down, and blocks a blast took out.
  const blown = new Set();
  const classify = (x, y, z) => { const k = `${x},${y},${z}`; return placed.has(k) ? Cell.SOLID : blown.has(k) ? Cell.AIR : base(x, y, z); };
  let crater = 0;
  let walls = 0;
  const rng = makeRng(7);
  const body = new SimBody({ classify }, { ...bot }, bot.yaw ?? 0, { hw: 0.3 });
  const motor = new MotorController(body, {}, rng);
  let hp = health, mode = 'none', foughtAtDeath = false, nextRoute = 0, nextSwing = 0, corneredUntil = 0, blocking = false;
  // Paths in flight (the game's plan() is a job): { at, path, urgent, seq }. A stop bumps routeSeq;
  // a path planned before it is dropped when it lands (the game's routeTo does the same).
  const inFlight = [];
  let routeSeq = 0, misses = 0;
  const route = (goal, tolerance, urgent, maxNodes, now = false, walk = false) => {
    const r = runPath(classify, body.pos, goal, tolerance, maxNodes);
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
  const log = [];
  const stale = new Stalemate(120);
  const giveUp = new Map(); // mob id -> tick we stop counting it as reachable until
  const reachCache = new Map();
  let kills = 0, idleWhileHunted = 0, worstIdle = 0, hitsTaken = 0, blocked = 0, gaveUp = 0;
  // Weapons: the best for a fight, a spear if we carry one for creepers. `weapon` may be a list.
  const carried = (Array.isArray(weapon) ? weapon : [weapon]).filter(Boolean).map((id) => ({ id }));
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
  body.move = (dx, dz, s) => move0(dx, dz, blocking ? s * 0.3 : s);
  const eye = () => ({ x: body.pos.x, y: body.pos.y + EYE_HEIGHT, z: body.pos.z });
  const facingMob = (m) => {
    const yaw = Math.atan2(-(m.x - body.pos.x), m.z - body.pos.z) * 180 / Math.PI;
    return Math.abs(((yaw - body.yaw + 540) % 360) - 180) < 60;
  };
  const hurt = (n, m, what) => {
    if (blocking && facingMob(m)) { blocked++; return; }
    hp -= n; hitsTaken++; m.lastHitMe = t;
    if (VERBOSE) log.push(`${t}: hit by ${what} for ${n.toFixed(1)}, hp ${hp.toFixed(1)}`);
  };
  const at = (x, y, z) => { const c = classify(x, y, z); return c === Cell.AIR ? 'open' : c === Cell.SOLID || c === Cell.STEP || c === Cell.SLAB ? 'solid' : 'other'; };
  /** Cornered: wall off the way in, if it's a single 1-wide way and we have the blocks. */
  const wallQueue = [];
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
    const mv = m.type === 'creeper' ? creeperFight({ me, mob: m, t, st: (m.st ??= {}), shield, canSwing: cw(m).ready, canRetreat: m.room !== false, lit: m.fuse >= 0, reach: cw(m).reach, minReach: cw(m).minReach, canWall: WALLS && blocks >= 2, kbPoor })
      : fightMove({ me, mob: m, melee: MOBS[m.type].kind === 'melee', t, shield, canSwing: t >= nextSwing });
    if (OLD && mv.goal) { const d0 = dist3D(me, m); mv.goal = d0 > 3.3 ? standOffOld(me, m) : { x: m.x, y: m.y, z: m.z }; mv.tolerance = 0.5; }
    blocking = mv.block;
    if (VERBOSE && process.env.TRACE) log.push(`${t}: me ${me.x.toFixed(1)},${me.y.toFixed(1)} mob ${m.x.toFixed(1)} d ${dist3D(me, m).toFixed(1)} goal ${mv.goal ? `${mv.goal.x.toFixed(1)},${mv.goal.z.toFixed(1)}` : "-"} away ${mv.away ?? 0} now ${!!mv.now} stop ${!!mv.stop} swing ${!!mv.swing} room ${m.room} lit ${m.fuse >= 0} busy ${motor.busy}`);
    if (mv.wall) {
      // Wall it off: its way in and its sight of us, one block at a time (3 ticks each).
      const cells = blockOffCells(me, m, at);
      for (const c of cells) wallQueue.push(c);
      walls++;
      if (VERBOSE) log.push(`${t}: walling off the creeper (${cells.length} blocks, knockback room ${knockbackRoom(me, m, at)}, d ${dist3D(me, m).toFixed(1)})`);
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
    if (mv.swing && facingMob(m) && (outOfReach || tooNear)) { nextSwing = t + pw.cooldown; misses++; if (VERBOSE) log.push(`${t}: swing at ${m.type} misses (${reachTo(m).toFixed(2)} from the eye)`); }
    else if (mv.swing && facingMob(m) && m.iframe <= t) {
      m.hp -= pw.damage > 1 ? pw.damage : 1; m.iframe = t + 10; nextSwing = t + 10;
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
  let jabs = 0;
  let t = 0, fightRef = null, explosions = 0, coast = 0, coastDir = { x: 0, z: 0 };
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
      const d = decide({ health: hp, damage, isNight: night, prevMode: mode, mobs: seen, shield });
      if (d.mode === 'flee' && corneredUntil > t && d.reason !== 'creeper' && d.reason !== 'cover') {
        const target = d.threats.find((m) => m.type !== 'creeper' && m.dist <= 8);
        if (target) { d.mode = 'fight'; d.target = target.id; }
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
        } else if (t >= nextRoute || !motor.busy) {
          nextRoute = t + 20;
          const cands = [];
          const f = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
          findPath(classify, me, me, { maxNodes: 1500, goalTest: (x, y, z, w) => { if (w.standable(x, y, z)) cands.push({ x: x + 0.5, y, z: z + 0.5, cost: Math.hypot(x - f.x, z - f.z) }); return false; } });
          const sees = (p, m) => clear(classify, { x: m.pos.x, y: m.pos.y + 1.6, z: m.pos.z }, { x: p.x, y: p.y + 1.2, z: p.z });
          const spot = pickRefuge(me, d.threats, cands, sees);
          // Nowhere much better: wall off here, or get into the dead end nearby (a single way in)
          // and wall off there; only if neither, stand and fight.
          const deeper = spot ? null : pickRefuge(me, d.threats, cands, sees, 0.5);
          if (!spot && !tryWall(d.threats)) {
            if (deeper) { route(deeper, 0.5, true, 1500); nextRoute = t + 8; }
            else corneredUntil = t + 200;
          } else if (spot) route(spot, 1, true, 3000);
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
    // Running from something catching up: turn and jab it (the spear from out of its reach), run on.
    if (mode === 'flee' && FLEEJAB) {
      const hasSpear = weaponReach(creeperId).reach > 3.5;
      const chasers = mobs.filter((m) => m.hp > 0 && MOBS[m.type].kind === 'melee').map((m) => ({ m, d: dist3D(me, m) })).sort((a, b) => a.d - b.d);
      const c = chasers[0];
      if (c) {
        const how = fleeJab({ me, mob: c.m, t, st: (c.m.fj ??= {}), melee: true, hasSpear, spearReady: t >= spearNext && t >= nextSwing, swordReady: t >= nextSwing });
        if (how) {
          motor.setFocus({ x: c.m.x, y: c.m.y + 1, z: c.m.z });
          if (facingMob(c.m) && c.m.iframe <= t) {
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
    motor.tick();
    // No command this tick: the body coasts on what it had (0.546 a tick on the ground).
    let coasting = false;
    if (!body.cmd && coast > 0.01) { body.cmd = { dx: coastDir.x, dz: coastDir.z, s: coast / 0.216 }; body.sprint = false; coasting = true; }
    body.step();
    if (coasting) { body.cmd = null; coast *= 0.546; }
    else {
      const moved = Math.hypot(body.pos.x - before.x, body.pos.z - before.z);
      coast = body.cmd && moved > 0.01 ? moved : 0;
      if (coast) coastDir = { x: (body.pos.x - before.x) / moved, z: (body.pos.z - before.z) / moved };
    }
    // ---- the mobs ----
    for (const m of alive) {
      const d = dist3D(me, m);
      const info = MOBS[m.type];
      if (info.kind === 'ranged') {
        // Stands its ground and shoots every 2 s when it can see us (arrow line: its eye to our chest).
        // An arrow hits the first thing in its way: a zombie between us takes it.
        const inWay = alive.some((o) => o !== m && o.hp > 0 && (() => {
          const ax = me.x - m.x, az = me.z - m.z, l2 = ax * ax + az * az || 1;
          const u = ((o.x - m.x) * ax + (o.z - m.z) * az) / l2;
          return u > 0.05 && u < 0.95 && Math.hypot(m.x + ax * u - o.x, m.z + az * u - o.z) < 0.5 && Math.abs(o.y - me.y) < 2;
        })());
        if (t >= m.cool && d <= 16 && inWay) { m.cool = t + 40; }
        else if (t >= m.cool && d <= 16 && clear(classify, { x: m.x, y: m.y + 1.5, z: m.z }, { x: me.x, y: me.y + 1.0, z: me.z })) {
          m.cool = t + 40; if (VERBOSE) log.push(`${t}: arrow from ${m.x.toFixed(2)},${m.y} to ${me.x.toFixed(2)},${me.y.toFixed(2)}`); hurt(3, m, "arrow");
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
          const dmg = Math.max(0, 25 * (1 - d / 6)) * (sight ? 1 : 0.3);
          if (VERBOSE) log.push(`${t}: creeper goes off at ${d.toFixed(1)} blocks`);
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
      if (d <= 1.6 && t >= m.cool) { m.cool = t + 20; hurt(info.dps, m, m.type); }
    }
    if (!mobs.some((m) => m.hp > 0)) break;
  }
  return { jabs, crater, misses, explosions, walls, foughtAtDeath, hp: Math.max(0, hp), kills, total: mobs.length, ticks: t, worstIdle, hitsTaken, blocked, gaveUp, log };
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
    if (r.hp <= 0) stats.died++;
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
  let walls = 0;
  for (let i = 0; i < CORNERED; i++) {
    const kind = Object.keys(kinds)[i % 3];
    const J = jagged(rng, kind);
    const weapon = process.env.SPEAR === '0' ? 'stone_sword' : ['stone_sword', 'stone_spear'];
    const sc = { classify: J.classify, bot: J.bot, mobs: [{ type: 'creeper', ...J.top }], weapon, shield: false, health: 20, ticks: 900, blocks: Number(process.env.BLOCKS ?? 16) };
    const r = arena(sc);
    kinds[kind][0]++;
    walls += r.walls ? 1 : 0;
    if (r.explosions) { kinds[kind][1]++; bad.push(`${kind} #${i}: ${r.hp <= 0 ? 'DIED' : `${r.hp.toFixed(0)} hp`}${r.walls ? ' (walled)' : ''}`); }
    if (r.hp <= 0) kinds[kind][2]++;
  }
  const tot = Object.values(kinds).reduce((a, k) => [a[0] + k[0], a[1] + k[1], a[2] + k[2]], [0, 0, 0]);
  console.log(`${tot[0] - tot[1]}/${tot[0]} cornered at the foot of jagged steps without an explosion (${(100 * (1 - tot[1] / tot[0])).toFixed(1)}%), ${tot[2]} died, walled off in ${walls}`);
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
    const bot = terrain === 'mine' ? { x: 24.5, y: 52, z: 0.5 } : { x: 0.5, y: 70, z: 0.5 };
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
