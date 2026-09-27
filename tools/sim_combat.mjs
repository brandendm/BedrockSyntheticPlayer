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
import { fightMove, creeperMove, creeperFight, Stalemate, pickRefuge, barricadeCells } from '../behavior_pack/scripts/core/tactics.js';
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
const KNOCKBACK_STEPS = Number(process.env.KB ?? 4);

// ---------- the arena ----------
function arena({ classify: base, bot, mobs, weapon = 'stone_sword', shield = false, ticks = 1200, night = true, health = 20, blocks = 16 }) {
  // Blocks the bot puts down (a barricade) are solid to everyone from then on.
  const placed = new Set();
  const classify = (x, y, z) => (placed.has(`${x},${y},${z}`) ? Cell.SOLID : base(x, y, z));
  let walls = 0;
  const rng = makeRng(7);
  const body = new SimBody({ classify }, { ...bot }, bot.yaw ?? 0, { hw: 0.3 });
  const motor = new MotorController(body, {}, rng);
  let hp = health, mode = 'none', foughtAtDeath = false, nextRoute = 0, nextSwing = 0, corneredUntil = 0, blocking = false;
  const log = [];
  const stale = new Stalemate(120);
  const giveUp = new Map(); // mob id -> tick we stop counting it as reachable until
  const reachCache = new Map();
  let kills = 0, idleWhileHunted = 0, worstIdle = 0, hitsTaken = 0, blocked = 0, gaveUp = 0;
  const damage = weaponDamage(weapon);
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
  function tryWall(threats) {
    const near = threats.filter((m) => m.dist <= 12).sort((a, b) => a.dist - b.dist)[0];
    if (!near || blocks < 2) return false;
    const cells = barricadeCells(body.pos, near.pos, at);
    if (!cells || cells.length > blocks) return false;
    if (mobs.some((m) => m.hp > 0 && cells.some((c) => Math.floor(m.x) === c.x && Math.floor(m.z) === c.z && Math.abs(Math.floor(m.y) - c.y) <= 1))) return false;
    for (const c of cells) if (at(c.x, c.y, c.z) === 'open') { placed.add(`${c.x},${c.y},${c.z}`); blocks--; }
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
      m.room = findPath(classify, me, me, { maxNodes: 400, goalTest: (x, y, z, w) => w.standable(x, y, z) && Math.hypot(x + 0.5 - m.x, z + 0.5 - m.z) >= need && Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z) < Math.hypot(x + 0.5 - m.x, z + 0.5 - m.z) - 2 }).complete;
    }
    const walledNow = m.type === 'creeper' && m.room === false && !shield && tryWall(seen);
    const mv = walledNow ? { goal: null, stop: true, swing: false, block: false }
      : m.type === 'creeper' ? creeperFight({ me, mob: m, t, st: (m.st ??= {}), shield, canSwing: t >= nextSwing, canRetreat: m.room !== false, lit: m.fuse >= 0 })
      : fightMove({ me, mob: m, melee: MOBS[m.type].kind === 'melee', t, shield, canSwing: t >= nextSwing });
    if (OLD && mv.goal) { const d0 = dist3D(me, m); mv.goal = d0 > 3.3 ? standOffOld(me, m) : { x: m.x, y: m.y, z: m.z }; mv.tolerance = 0.5; }
    blocking = mv.block;
    if (VERBOSE && process.env.TRACE) log.push(`${t}: me ${me.x.toFixed(1)},${me.y.toFixed(1)} mob ${m.x.toFixed(1)} d ${dist3D(me, m).toFixed(1)} goal ${mv.goal ? `${mv.goal.x.toFixed(1)},${mv.goal.z.toFixed(1)}` : '-'} busy ${motor.busy} st ${m.st?.phase}`);
    if (mv.stop && motor.busy) motor.stop();
    if (mv.goal && (t >= nextRoute || !motor.busy || mv.now)) {
      nextRoute = t + 6;
      const r = runPath(classify, me, mv.goal, mv.tolerance, 1500);
      if (r.path.length >= 2) motor.followPath(smoothPath(classify, r.path), { seamless: true, urgent: mv.urgent });
    }
    if (mv.swing && facingMob(m) && m.iframe <= t) {
      m.hp -= damage; m.iframe = t + 10; nextSwing = t + 10;
      if (VERBOSE) log.push(`${t}: hit ${m.type} at ${dist3D(me, m).toFixed(1)} (hp ${m.hp})`);
      // Knockback: pushed a block away from us (if there's room).
      const dx = m.x - me.x, dz = m.z - me.z, l = Math.hypot(dx, dz) || 1;
      // (Knockback has an upward kick: it can carry a mob up one step, as up the quarry stairs.)
      let rose = false;
      for (let k = 0; k < KNOCKBACK_STEPS; k++) {
        const nx = m.x + dx / l * 0.5, nz = m.z + dz / l * 0.5;
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
  let t = 0, fightRef = null, explosions = 0;
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
        return { id: m.id, type: m.type, hp: m.hp, lit: m.type === 'creeper' && m.fuse >= 0, dist: d, visible, targetingMe: m.aware !== false && d <= 16, attackedMe: t - m.lastHitMe < 200, recent: visible, dy: m.y - me.y, canReach, pos: { x: m.x, y: m.y, z: m.z }, inWater: false, ref: m };
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
          blocking = true; motor.stop(); motor.setFocus({ x: creeper.pos.x, y: creeper.pos.y + 1, z: creeper.pos.z });
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
            if (deeper) { const r = runPath(classify, me, deeper, 0.5, 1500); if (r.path.length >= 2) motor.followPath(smoothPath(classify, r.path), { urgent: true }); nextRoute = t + 8; }
            else corneredUntil = t + 200;
          } else if (spot) {
            const r = runPath(classify, me, spot, 1, 3000);
            if (r.path.length >= 2) motor.followPath(smoothPath(classify, r.path), { urgent: true });
          }
        }
      } else motor.setFocus(null);
      // Standing still while something's after us and nothing's happening: the staring contest.
      const hunted = seen.some((m) => m.visible && m.dist <= 16);
      if (hunted && !motor.busy && mode !== 'fight' && mode !== 'flee' && !blocking) idleWhileHunted += 4;
      else if (hunted && mode === 'fight' && !motor.busy && !seen.some((m) => m.dist <= REACH_HIT + 0.5)) idleWhileHunted += 4;
      else idleWhileHunted = 0;
      worstIdle = Math.max(worstIdle, idleWhileHunted);
    }
    // A creeper fight is timed in ticks (a 0.7-block window between our reach and its fuse): every
    // tick, like the game's creeper step.
    if (t % 4 !== 0 && mode === 'fight' && fightRef?.type === 'creeper' && fightRef.hp > 0 && !OLD) {
      const m = fightRef;
      act({ ref: m, id: m.id, type: m.type, dist: dist3D(me, m), pos: { x: m.x, y: m.y, z: m.z } }, []);
    }
    motor.tick();
    body.step();
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
      const speed = m.type === 'creeper' ? 0.1 : 0.115;
      if (m.path && m.pi < m.path.length && d > 1.3 && !(m.type === 'creeper' && m.fuse >= 0)) { // a hissing creeper stands still
        const w = m.path[m.pi], tx = w.x + 0.5, tz = w.z + 0.5;
        const dx = tx - m.x, dz = tz - m.z, l = Math.hypot(dx, dz);
        if (l < speed) { m.x = tx; m.z = tz; m.y = w.y; m.pi++; } else { m.x += dx / l * speed; m.z += dz / l * speed; if (Math.abs(w.y - m.y) >= 1 && l < 0.6) m.y = w.y; }
      }
      if (m.type === 'creeper') {
        const sight = clear(classify, { x: m.x, y: m.y + 1.5, z: m.z }, { x: me.x, y: me.y + 1.2, z: me.z });
        // Bedrock's creeper: the fuse starts inside 2.5 blocks of us with us in sight, and stops
        // beyond 6 or once it loses sight of us (its target_nearby_sensor).
        if (m.fuse < 0 && d <= 2.5 && sight) { m.fuse = t + 30; if (VERBOSE) log.push(`${t}: creeper hisses at ${d.toFixed(1)}`); }
        if (m.fuse >= 0 && (d > 6 || !sight)) { m.fuse = -1; if (VERBOSE) log.push(`${t}: creeper calms down at ${d.toFixed(1)}`); }
        if (m.fuse >= 0 && t >= m.fuse) {
          const dmg = Math.max(0, 25 * (1 - d / 6)) * (sight ? 1 : 0.3);
          if (VERBOSE) log.push(`${t}: creeper goes off at ${d.toFixed(1)} blocks`);
          hurt(dmg, m, 'creeper');
          explosions++;
          m.hp = 0;
        }
        continue;
      }
      if (d <= 1.6 && t >= m.cool) { m.cool = t + 20; hurt(info.dps, m, m.type); }
    }
    if (!mobs.some((m) => m.hp > 0)) break;
  }
  return { explosions, walls, foughtAtDeath, hp: Math.max(0, hp), kills, total: mobs.length, ticks: t, worstIdle, hitsTaken, blocked, gaveUp, log };
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
function tunnel() {
  return (x, y, z) => (z === 0 && x >= 1 && x <= 20 && (y === 40 || y === 41) ? Cell.AIR : Cell.SOLID);
}

const SCENARIOS = {
  'creeper coming down the quarry steps, stone sword': () => ({ classify: quarry(), bot: { x: 10.5, y: 54, z: 0.5 }, mobs: [{ type: 'creeper', x: -1.5, y: 64, z: 0.5 }], minHp: 20 }),
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
    const sc = { classify, bot: ground(classify, bot), mobs: mobs.map((m) => ground(classify, m)), weapon, shield: rng() < 0.4, health: pick([20, 20, 14, 8]), ticks: 900 };
    const desc = `${terrain}, ${mobs.map((m) => m.type + (m.aware ? '' : '(unaware)')).join('+')}, ${weapon ?? 'fists'}${sc.shield ? '+shield' : ''}, ${sc.health} hp`;
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
