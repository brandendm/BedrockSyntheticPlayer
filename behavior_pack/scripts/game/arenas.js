// The arenas themselves (the engine is game/arena.js). Each one is a plain description:
//   dims()    the box it needs         build(s, B)  its blocks (B queues the commands)
//   layout(s) where each lane starts   kit(s, p)    what each side is given
//   go(s)     at GO (mobs...)          tick(s)      every 4 ticks while it runs
//   bot(s, p, gen)  the bot's routine  value/text   the score, and how it reads
//   better    'high' or 'low' wins     verdict(s, bot)  PASS/FAIL for `!bot test <name>`
import { system, world, ItemStack, EquipmentSlot } from '@minecraft/server';
import { forestPlan, treeFills, oreLayout, ORE_POINTS, parkourPlan, boatPlan, boatDrive, clock, ARENA_INFO, ARENA_NAMES } from '../core/arena.js';
import { runSession, stopArena, recoverPlayer, kit, countOf, tell, Builder } from './arena.js';
import { CONFIG } from '../config.js';

const wait = (n) => system.waitTicks(n);
const isLogId = /_log$/;

/** Gates open at GO: each is a command (the cage around a start comes down). */
function cage(s, B, cx, cz, { r = 2, h = 4, y0 = s.G, base = 'grass_block' } = {}) {
  B.fill(cx - r, y0, cz - r, cx + r, y0 + h, cz + r, 'glass', 'hollow');
  s.gates.push(`fill ${cx - r} ${y0 + 1} ${cz - r} ${cx + r} ${y0 + h} ${cz + r} air`);
  s.gates.push(`fill ${cx - r} ${y0} ${cz - r} ${cx + r} ${y0} ${cz + r} ${base}`);
}

const SWORD_KIT = [[0, 'iron_sword'], [1, 'iron_spear'], [2, 'cobblestone', 64], [3, 'cobblestone', 64]];

// ---------- the forest: most logs in two minutes ----------
const FOREST = {
  name: 'forest', title: 'Log Race', secs: 120, better: 'high',
  rules: 'Most logs in your pack when the time runs out. Same forest, same iron axe.',
  dims: () => ({ w: 38, d: 38, h: 26 }),
  build(s, B) {
    const { O, G } = s, size = 36;
    const plan = s.x.plan = forestPlan({ size, seed: s.opts.seed ?? 11 });
    B.fill(O.x, O.y, O.z, O.x + 37, G - 1, O.z + 37, 'dirt');
    B.fill(O.x + 1, G, O.z + 1, O.x + 36, G, O.z + 36, 'grass_block');
    B.fill(O.x, G, O.z, O.x + 37, G + 14, O.z, 'stone_bricks');
    B.fill(O.x, G, O.z + 37, O.x + 37, G + 14, O.z + 37, 'stone_bricks');
    B.fill(O.x, G, O.z, O.x, G + 14, O.z + 37, 'stone_bricks');
    B.fill(O.x + 37, G, O.z, O.x + 37, G + 14, O.z + 37, 'stone_bricks');
    const ox = O.x + 1, oz = O.z + 1;
    for (const t of plan.trees) {
      for (const f of treeFills(t, G)) {
        const [a, b, c, d, e, g] = f.box;
        B.fill(ox + a, b, oz + c, ox + d, e, oz + g, f.kind === 'log' ? 'oak_log' : 'oak_leaves', f.kind === 'log' ? '' : 'replace air');
      }
    }
    for (const st of plan.starts) cage(s, B, ox + st.x, oz + st.z);
  },
  layout(s) {
    const ox = s.O.x + 1, oz = s.O.z + 1;
    return { starts: s.x.plan.starts.map((st) => ({ x: ox + st.x + 0.5, y: s.G + 1, z: oz + st.z + 0.5, fx: st.x < 18 ? 1 : -1, fz: st.z < 18 ? 1 : -1 })) };
  },
  kit: () => kit([[0, 'iron_axe']]),
  bot: async (s, p, gen) => { await s.agent.skills.gatherLogs(gen, 99999, 0, { replant: false }); },
  value: (s, p) => countOf(p.ent, isLogId),
  text: (s, p) => `${countOf(p.ent, isLogId)} logs`,
  verdict: (s, bot) => {
    const n = countOf(bot.ent, isLogId);
    return { pass: n >= 10, detail: `${n} logs in ${(s.elapsed / 20).toFixed(0)} s${bot.deaths ? `, died ${bot.deaths}x` : ''}` };
  },
};

// ---------- the duels: a golem or an enderman, a pen each, fastest kill wins ----------
// Same pen, same mob, same kit; each side fights its own. The mob is made angry at its own fighter at GO
// (a hit from them: a golem or an enderman leaves you alone otherwise).
function duel({ name, title, mob, secs, rules, spawnAt = 13.5, low = false, force = false }) {
  const pen = (s, lane) => { const x1 = s.O.x + 1 + lane * 18, z1 = s.O.z + 1; return { x1, x2: x1 + 16, z1, z2: z1 + 16, y1: s.G + 1, y2: s.G + 8, cx: x1 + 8.5, cz: z1 + 8.5 }; };
  const mobHp = (p) => { try { return p.x.mob?.isValid ? p.x.mob.getComponent('minecraft:health').currentValue : 0; } catch { return 0; } };
  const frac = (p) => Math.max(0, Math.min(1, (p.x.mob?.isValid ? mobHp(p) : (p.x.lastMobHp ?? 0)) / (p.x.mobMax || 1)));
  const spawnMob = (s, p, hp) => {
    const b = p.x.pen = pen(s, p.lane);
    const m = s.dim.spawnEntity(`minecraft:${mob}`, { x: b.x1 + spawnAt, y: s.G + 1, z: b.cz });
    p.x.mob = m; p.x.gone = 0;
    const h = m.getComponent('minecraft:health');
    p.x.mobMax = h?.effectiveMax ?? 1;
    if (hp && h) { try { h.setCurrentValue(Math.max(1, hp)); } catch {} }
    if (p.x.minHp === undefined) p.x.minHp = 20;
    try { m.applyDamage(hp ? 0.1 : 1, { cause: 'entityAttack', damagingEntity: p.ent }); } catch (e) { console.warn(`[arena] provoke: ${e}`); }
  };
  return {
    name, title, secs, better: 'low', mobTypes: [mob], rules, low,
    dims: () => ({ w: 37, d: 19, h: 16 }),
    build(s, B) {
      const { O, G } = s;
      B.fill(O.x, O.y, O.z, O.x + 36, G - 1, O.z + 18, 'dirt');
      B.fill(O.x, G, O.z, O.x + 36, G + 9, O.z + 18, 'stone_bricks');
      B.fill(O.x + 1, G + 1, O.z + 1, O.x + 17, G + 8, O.z + 17, 'air');
      B.fill(O.x + 19, G + 1, O.z + 1, O.x + 35, G + 8, O.z + 17, 'air');
      B.fill(O.x + 1, G, O.z + 1, O.x + 17, G, O.z + 17, 'grass_block');
      B.fill(O.x + 19, G, O.z + 1, O.x + 35, G, O.z + 17, 'grass_block');
      B.fill(O.x + 1, G + 9, O.z + 1, O.x + 17, G + 9, O.z + 17, 'glass');
      B.fill(O.x + 19, G + 9, O.z + 1, O.x + 35, G + 9, O.z + 17, 'glass');
    },
    layout(s) {
      return { starts: [0, 1].map((lane) => { const b = pen(s, lane); return { x: b.x1 + 2.5, y: s.G + 1, z: b.cz, fx: 1, fz: 0 }; }) };
    },
    kit: () => kit(SWORD_KIT),
    go(s) { for (const p of s.parts) spawnMob(s, p); },
    tick(s) {
      for (const p of s.parts) {
        const hp = (() => { try { return p.ent.getComponent('minecraft:health').currentValue; } catch { return 20; } })();
        p.x.minHp = Math.min(p.x.minHp ?? 20, hp);
        const m = p.x.mob, b = p.x.pen;
        if (CONFIG.debug && system.currentTick % 20 < 4) { try { console.warn(`[arena] dbg ${mob} valid ${m?.isValid} hp ${m?.isValid ? m.getComponent('minecraft:health').currentValue : '-'} at ${m?.isValid ? `${m.location.x.toFixed(1)},${m.location.y.toFixed(1)},${m.location.z.toFixed(1)}` : '-'} me ${p.ent.location.x.toFixed(1)},${p.ent.location.y.toFixed(1)},${p.ent.location.z.toFixed(1)} hp ${hp}`); } catch (e) { console.warn(`[arena] dbg ${e}`); } }
        if (m?.isValid && b) {
          p.x.gone = 0;
          try { p.x.lastMobHp = m.getComponent('minecraft:health').currentValue; } catch {}
          // It must keep coming for ITS fighter (an enderman forgets, a golem is only ever angry at who hit it).
          if (system.currentTick - (p.x.provokedAt ?? 0) >= 40 && !p.done) {
            let tgt = null; try { tgt = m.target?.id; } catch {}
            if (CONFIG.debug) { let tt = "-"; try { tt = m.target?.typeId; } catch {} console.warn(`[arena] dbg ${mob} target ${tgt ?? "none"} (${tt}) me ${p.ent.id}`); }
            if (tgt !== p.ent.id) { p.x.provokedAt = system.currentTick; try { m.applyDamage(0.1, { cause: 'entityAttack', damagingEntity: p.ent }); } catch {} }
          }
          const l = m.location;
          if (l.x < b.x1 - 0.5 || l.x > b.x2 + 1.5 || l.z < b.z1 - 0.5 || l.z > b.z2 + 1.5 || l.y < s.G - 1 || l.y > s.G + 9) {
            try { m.teleport({ x: b.cx, y: s.G + 1, z: b.cz }); } catch {}
          }
        } else if (!p.done && p.x.mob) {
          // Gone without dying (an enderman that blinked far off is removed by the game): a new one, with what health it had left.
          if (++p.x.gone >= 3) { p.x.gone = 0; p.x.lost = (p.x.lost ?? 0) + 1; console.warn(`[arena] ${mob} for ${p.name} was lost (${p.x.lost}); replacing it`); spawnMob(s, p, p.x.lastMobHp); }
        }
      }
    },
    mobDied(s, e) {
      const p = s.parts.find((x) => x.x.mob && x.x.mob.id === e.id);
      if (p && !p.done) { p.done = true; p.x.killed = true; p.doneAt = system.currentTick; }
    },
    died(s, p) {
      if (p.done) return;
      p.done = true; p.x.dead = true; p.doneAt = system.currentTick;
      p.x.left = frac(p);
      try { p.x.mob?.remove(); } catch {}
    },
    keepsGoing: () => false,
    over: (s) => s.parts.some((p) => p.x.killed) || s.parts.every((p) => p.done),
    finish(s) { for (const p of s.parts) { p.x.left = frac(p); } },
    value(s, p) {
      if (p.x.killed) return p.doneAt - s.tick0;
      return 1e6 + Math.round((p.x.left ?? frac(p)) * 1000) + (p.x.dead ? 500 : 0); // (not killed: ranked by how much it had left)
    },
    text(s, p) {
      if (p.x.killed) return `killed it in ${clock(p.doneAt - s.tick0)} (lowest hp ${Math.round(p.x.minHp)}/20)`;
      const left = Math.round((p.x.left ?? frac(p)) * 100);
      return `${p.x.dead ? 'died' : 'not dead yet'}, ${mob.replace('_', ' ')} at ${left}%${p.x.minHp !== undefined ? ` (lowest hp ${Math.round(p.x.minHp)}/20)` : ''}`;
    },
    verdict(s, bot) {
      const k = !!bot.x.killed;
      return { pass: k, detail: k ? `killed the ${mob.replace('_', ' ')} in ${clock(bot.doneAt - s.tick0)}, lowest hp ${Math.round(bot.x.minHp)}` : `${bot.x.dead ? 'died' : 'ran out of time'} with the ${mob.replace('_', ' ')} at ${Math.round((bot.x.left ?? 1) * 100)}%` };
    },
    bot: async (s, p, gen) => { while (s.phase === 'run' && gen === s.agent.taskGen) await wait(10); },
    fightTarget: (s, p) => ((force || s.opts.force) && p.x.mob?.isValid ? p.x.mob.id : null),
  };
}

const GOLEM = duel({ name: 'golem', title: 'Iron Golem Duel', mob: 'iron_golem', secs: 90, rules: 'Kill your iron golem first. Sword, spear and blocks. It has 100 hp and hits hard.' });
const ENDER = duel({ name: 'ender', title: 'Enderman Duel', mob: 'enderman', secs: 90, low: true, force: true, rules: 'Kill your enderman first. Sword, spear and blocks. It blinks about and hits for 7.' });

// ---------- underwater mining: a flooded tank each, ore in the floor, drowned about ----------
const DIVE_KIT = kit([[0, 'iron_pickaxe'], [1, 'iron_sword']], { Head: ['iron_helmet', [['aqua_affinity', 1]]] });
const TANK = 14;
function diveTank(s, lane) { const x1 = s.O.x + 1 + lane * 16, z1 = s.O.z + 1; return { x1, z1, x2: x1 + TANK - 1, z2: z1 + TANK - 1 }; }
const DIVE = {
  name: 'dive', title: 'Deep Dive Mining', secs: 100, better: 'high', floor: 3, swims: true,
  rules: 'Most ore points from the tank floor (coal 1, iron 2, gold and lapis 3, diamond 5). Iron pickaxe, aqua affinity, a sword for the drowned. You start on the ledge.',
  dims: () => ({ w: 31, d: 16, h: 18 }),
  build(s, B) {
    const { O, G } = s;
    const ores = s.x.ores = oreLayout({ size: TANK, seed: s.opts.seed ?? 5, keepOut: [0, 1, 2].flatMap((x) => [0, 1, 2].map((z) => ({ x, z }))) });
    B.fill(O.x, O.y, O.z, O.x + 30, G - 2, O.z + 15, 'stone');
    B.fill(O.x, G - 1, O.z, O.x + 30, G + 12, O.z + 15, 'stone_bricks');
    for (const lane of [0, 1]) {
      const t = diveTank(s, lane);
      B.fill(t.x1, G - 1, t.z1, t.x2, G, t.z2, 'stone');
      B.fill(t.x1, G + 1, t.z1, t.x2, G + 12, t.z2, 'air');
      B.fill(t.x1, G + 1, t.z1, t.x2, G + 8, t.z2, 'water');
      B.fill(t.x1, G + 1, t.z1, t.x1 + 2, G + 8, t.z1 + 2, 'stone'); // the ledge, flush with the water
      for (const o of ores) B.set(t.x1 + o.x, o.layer === 0 ? G : G - 1, t.z1 + o.z, o.kind);
      cage(s, B, t.x1 + 1, t.z1 + 1, { r: 1, h: 4, y0: G + 8, base: 'stone' });
    }
  },
  layout(s) { return { starts: [0, 1].map((lane) => { const t = diveTank(s, lane); return { x: t.x1 + 1.5, y: s.G + 9, z: t.z1 + 1.5, fx: 1, fz: 1 }; }) }; },
  kit: () => DIVE_KIT,
  mobTypes: ['drowned'],
  go(s) {
    for (const p of s.parts) {
      const t = diveTank(s, p.lane);
      p.x.cells = s.x.ores.map((o) => ({ x: t.x1 + o.x, y: o.layer === 0 ? s.G : s.G - 1, z: t.z1 + o.z, kind: o.kind, pts: ORE_POINTS[o.kind] ?? 1, got: false, layer: o.layer }));
      p.x.ores = 0;
      for (const [dx, dy, dz] of [[8, 3, 8], [10, 5, 4], [5, 2, 10]]) {
        try { s.dim.spawnEntity('minecraft:drowned', { x: t.x1 + dx + 0.5, y: s.G + dy, z: t.z1 + dz + 0.5 }); } catch (e) { console.warn(`[arena] drowned: ${e}`); }
      }
    }
  },
  tick(s) {
    for (const p of s.parts) {
      for (const c of p.x.cells ?? []) {
        if (c.got) continue;
        let id; try { id = s.dim.getBlock(c)?.typeId; } catch { continue; }
        if (id && id !== `minecraft:${c.kind}`) { c.got = true; p.score += c.pts; p.x.ores++; }
      }
    }
  },
  keepsGoing: () => true,
  value: (s, p) => p.score,
  text: (s, p) => `${p.score} points (${p.x.ores ?? 0} ores)${p.deaths ? `, died ${p.deaths}x` : ''}`,
  verdict: (s, bot) => ({ pass: bot.score >= 8, detail: `${bot.score} points, ${bot.x.ores ?? 0} ores${bot.deaths ? `, died ${bot.deaths}x` : ''}` }),
  // The nearest drowned within a few blocks is fought, wherever it is (the bot's usual "run to shore" is no use in a tank).
  fightTarget(s, p) {
    const f = p.ent?.location;
    if (!f) return null;
    let best = null, bd = 6;
    for (const m of s.dim.getEntities({ type: 'minecraft:drowned', location: f, maxDistance: 6 })) {
      const d = Math.hypot(m.location.x - f.x, m.location.y - f.y, m.location.z - f.z);
      if (d < bd) { bd = d; best = m; }
    }
    return best?.id ?? null;
  },
  // The bot: a diver of its own, since the usual swimming assumes the surface is never far above. Swim
  // along the top to above the ore, sink down on to it, mine it from above; up for air on a budget
  // (what the climb back needs, with a margin), then breathe out the rest before the next dive.
  bot: async (s, p, gen) => {
    const A = s.agent, S = A.skills, B = A.body;
    const t = diveTank(s, p.lane);
    const surfaceY = s.G + 9; // (the water's top face)
    const bad = new Map();
    const wet = (pt) => { try { return /water/.test(s.dim.getBlock({ x: Math.floor(pt.x), y: Math.floor(pt.y), z: Math.floor(pt.z) })?.typeId ?? ''); } catch { return false; } };
    const headWet = () => wet(A.sim.getHeadLocation());
    // Air needed to get from feet height y up to the surface, as a share of a full breath (about 2 blocks a second up).
    const needAir = (y) => (Math.max(0, surfaceY - y) / 2 * 20 + 50) / 300;
    const inLedge = (x, z) => x > t.x1 - 0.5 && x < t.x1 + 3.5 && z > t.z1 - 0.5 && z < t.z1 + 3.5;
    const crossesLedge = (a, b) => { for (let k = 0; k <= 10; k++) if (inLedge(a.x + (b.x - a.x) * k / 10, a.z + (b.z - a.z) * k / 10)) return true; return false; };
    // One leg, steered by hand: sideways with the move keys, up and down with pushes. 'arrived' | 'air' | 'slow'.
    const swimTo = async (to, { tol = 0.5, ticks = 300, airCheck = true } = {}) => {
      for (let i = 0; i < ticks; i++) {
        S.check(gen);
        if (s.phase !== 'run') return 'slow';
        const f = A.body.getPos();
        const dx = to.x - f.x, dz = to.z - f.z, dy = to.y - f.y, h = Math.hypot(dx, dz);
        if (h < tol && Math.abs(dy) < 0.45) { B.stop(); return 'arrived'; }
        if (airCheck && B.headUnderwater() && B.airRatio() < needAir(f.y)) { B.stop(); return 'air'; }
        if (h >= tol) B.move(dx / h, dz / h, Math.min(1, h / 1.5 + 0.3)); else B.stop();
        if (dy < -0.4) B.swimDown(); else if (dy > 0.4) B.swimUp();
        A.motor.setFocus({ x: to.x, y: to.y + 0.5, z: to.z });
        await S.wait(gen, 1);
      }
      B.stop();
      return 'slow';
    };
    // Up, and breathe: float with the head out until the breath is full again.
    const breathe = async () => {
      for (let i = 0; i < 160 && s.phase === 'run'; i++) {
        S.check(gen);
        if (headWet()) B.swimUp();
        else if (B.airRatio() >= 0.97) break;
        A.motor.setFocus(null);
        await S.wait(gen, 1);
      }
    };
    while (s.phase === 'run') {
      S.check(gen);
      const now = system.currentTick;
      const f = A.body.getPos();
      if (B.headUnderwater() && B.airRatio() < needAir(f.y)) { await breathe(); continue; }
      const cand = (p.x.cells ?? []).filter((c) => !c.got && (bad.get(`${c.x},${c.y},${c.z}`) ?? 0) < now && (S.blockAt(c) ?? '').replace('minecraft:', '') === c.kind &&
        (c.layer === 0 || !/stone|ore|brick/.test(S.blockAt({ x: c.x, y: c.y + 1, z: c.z }) ?? 'stone')));
      const score = (c) => c.pts / (Math.hypot(c.x - f.x, c.z - f.z) + Math.abs(c.y - f.y) * 0.5 + 3);
      cand.sort((a, b) => score(b) - score(a));
      const c = cand[0];
      if (!c) { await S.wait(gen, 10); continue; }
      const key = `${c.x},${c.y},${c.z}`;
      // Enough breath for the swim down, the dig and the climb back? If not, fill up first.
      if (B.airRatio() < needAir(c.y + 1) + 0.22 && B.airRatio() < 0.97) { await breathe(); continue; }
      const col = { x: c.x + 0.5, z: c.z + 0.5 };
      const hover = { ...col, y: c.y + 1.6 };
      // Along the top first if the ledge is in the way; then to above the ore; then down on to it.
      if (crossesLedge(f, col)) {
        const r = await swimTo({ ...col, y: surfaceY - 0.6 }, { tol: 0.6 });
        if (r === 'air') { await breathe(); continue; }
      }
      let r = await swimTo(hover, { tol: 0.5 });
      if (r === 'air') { await breathe(); continue; }
      r = await swimTo({ ...col, y: c.y + 1 }, { tol: 0.35 });
      if (r === 'air') { await breathe(); continue; }
      B.stop();
      A.motor.setFocus(null);
      const ok = await S.mine(gen, c, { collect: false, allowBelow: true });
      if (CONFIG.debug) console.warn(`[arena] dbg dive ore ${c.kind} at ${c.x} ${c.y} ${c.z}: ${ok ? 'mined' : 'failed'} (swim ${r}, air ${Math.round(B.airRatio() * 100)}%)`);
      if (!ok) bad.set(key, now + 400);
    }
  },
};

// ---------- parkour: hill, vine wall, stepped descent, dense trees, cave holes, lava, zombies ----------
const PARK_KIT = kit([[0, 'iron_sword'], [1, 'cobblestone', 64]]);
const PW = 9; // a lane's width
const parkX = (s, lane) => s.O.x + 1 + lane * (PW + 1);
const PARKOUR = {
  name: 'parkour', title: 'Parkour Run', secs: 150, better: 'low', floor: 8, mobTypes: ['zombie', 'husk'],
  rules: 'First to the gold wins: up the hill, climb the vines, down the far side, through the trees, past the cave holes, across the lava. Sword and blocks. Falling in lava sends you back to the start (the clock keeps running).',
  dims: () => ({ w: 2 * PW + 3, d: parkourPlan().L + 2, h: 34 }),
  build(s, B) {
    const { O, G } = s;
    const plan = s.x.plan = parkourPlan({ seed: s.opts.seed ?? 7 });
    const L = plan.L, z1 = O.z + 1, zEnd = O.z + L;
    B.fill(O.x, O.y, O.z, O.x + 2 * PW + 2, G - 1, O.z + L + 1, 'stone');
    for (const x of [O.x, O.x + PW + 1, O.x + 2 * PW + 2]) B.fill(x, G, O.z, x, G + 24, O.z + L + 1, 'stone_bricks');
    B.fill(O.x, G, O.z, O.x + 2 * PW + 2, G + 24, O.z, 'stone_bricks');
    B.fill(O.x, G, O.z + L + 1, O.x + 2 * PW + 2, G + 24, O.z + L + 1, 'stone_bricks');
    for (const lane of [0, 1]) {
      const x1 = parkX(s, lane), x2 = x1 + PW - 1;
      // The ground, row by row (runs of the same height in one go).
      for (let z = 0; z < L;) {
        let e = z; while (e + 1 < L && plan.h[e + 1] === plan.h[z]) e++;
        const h = plan.h[z];
        if (h > 0) B.fill(x1, G, z1 + z, x2, G + h - 1, z1 + e, plan.wall.z0 <= z && z <= plan.wall.z1 ? 'stone_bricks' : 'dirt');
        B.fill(x1, G + h, z1 + z, x2, G + h, z1 + e, plan.wall.z0 <= z && z <= plan.wall.z1 ? 'stone_bricks' : 'grass_block');
        z = e + 1;
      }
      // The vines up the wall.
      for (let y = plan.vines.y0; y <= plan.vines.y1; y++) for (const vx of plan.vines.xs) B.set(x1 + vx, G + y, z1 + plan.vines.z, `vine ["vine_direction_bits"=${plan.vines.bits}]`);
      // Trees.
      for (const t of plan.trees) {
        for (const f of treeFills(t, G)) {
          const [a, b, c, d, e, g] = f.box;
          B.fill(x1 + a, b, z1 + c, x1 + d, e, z1 + g, f.kind === 'log' ? 'oak_log' : 'oak_leaves', f.kind === 'log' ? '' : 'replace air');
        }
      }
      // Cave holes: a trench with a ramp out.
      for (const hl of plan.holes) {
        for (let i = 0; i < hl.depth.length; i++) {
          const d = hl.depth[i];
          if (d > 0) B.fill(x1 + hl.x0, G - d + 1, z1 + hl.z0 + i, x1 + hl.x1, G, z1 + hl.z0 + i, 'air');
        }
      }
      // Lava with islands in it, flush with the path.
      B.fill(x1, G - 2, z1 + plan.lava.z0, x2, G, z1 + plan.lava.z1, 'lava');
      for (const isl of plan.lava.islands) B.fill(x1 + isl.x0, G - 2, z1 + isl.z0, x1 + isl.x1, G, z1 + isl.z1, 'stone');
      // The gold.
      B.fill(x1, G, z1 + plan.finishZ, x2, G, zEnd, 'gold_block');
      cage(s, B, x1 + 4, z1 + 2, { r: 2, h: 4, y0: G, base: 'grass_block' });
    }
  },
  layout(s) { return { starts: [0, 1].map((lane) => ({ x: parkX(s, lane) + 4.5, y: s.G + 1, z: s.O.z + 3.5, fx: 0, fz: 1 })) }; },
  kit: () => PARK_KIT,
  go(s) {
    const plan = s.x.plan;
    for (const p of s.parts) {
      const x1 = parkX(s, p.lane);
      p.x.best = 0;
      for (const m of plan.mobs) {
        try {
          const e = s.dim.spawnEntity(`minecraft:${m.kind}`, { x: x1 + m.x + 0.5, y: s.G + m.h + 1, z: s.O.z + 1 + m.z + 0.5 });
          // (a zombie in the daylight burns: a helmet keeps the sun off)
          if (m.kind === 'zombie') { try { e.getComponent('minecraft:equippable').setEquipment(EquipmentSlot.Head, new ItemStack('minecraft:iron_helmet', 1)); } catch (err) { if (CONFIG.debug) console.warn(`[arena] dbg helmet: ${err}`); } }
        } catch (e) { console.warn(`[arena] ${m.kind}: ${e}`); }
      }
    }
  },
  tick(s, now) {
    const plan = s.x.plan;
    for (const p of s.parts) {
      if (p.done) continue;
      let l; try { l = p.ent.location; } catch { continue; }
      const x1 = parkX(s, p.lane), lz = l.z - (s.O.z + 1);
      if (l.x < x1 - 1 || l.x > x1 + PW + 1 || lz < 0) continue;
      if (lz > p.x.best) p.x.best = lz;
      if (lz >= plan.finishZ + 0.3 && l.y >= s.G + 0.5) { p.done = true; p.x.finished = true; p.doneAt = now; tell(`${p.name} is on the gold: ${clock(now - s.tick0)}!`); }
    }
  },
  over: (s) => s.parts.some((p) => p.x.finished),
  value(s, p) { return p.x.finished ? p.doneAt - s.tick0 : 1e6 + Math.round((s.x.plan.L - (p.x.best ?? 0)) * 1000) + (p.deaths ?? 0); },
  text(s, p) {
    const d = p.deaths ? `, fell/died ${p.deaths}x` : '';
    if (p.x.finished) return `on the gold in ${clock(p.doneAt - s.tick0)}${d}`;
    return `${Math.round(100 * Math.min(1, (p.x.best ?? 0) / s.x.plan.finishZ))}% of the way${d}`;
  },
  verdict: (s, bot) => ({ pass: !!bot.x.finished, detail: bot.x.finished ? `reached the gold in ${clock(bot.doneAt - s.tick0)}${bot.deaths ? `, died ${bot.deaths}x` : ''}` : `got ${Math.round(100 * (bot.x.best ?? 0) / s.x.plan.finishZ)}% of the way (row ${Math.round(bot.x.best ?? 0)}/${s.x.plan.finishZ})${bot.deaths ? `, died ${bot.deaths}x` : ''}` }),
  // The bot: checkpoint to checkpoint along the course; its own pathfinding does the climbing, jumping and fighting.
  bot: async (s, p, gen) => {
    const A = s.agent, S = A.skills, plan = s.x.plan;
    const x1 = parkX(s, p.lane), z1 = s.O.z + 1;
    const fails = new Map();
    while (s.phase === 'run' && !p.done) {
      S.check(gen);
      const lz = A.sim.location.z - z1;
      const i = plan.route.findIndex((c) => c.z > lz - 0.6);
      if (i < 0) { await S.goNear(gen, { x: x1 + 4.5, y: s.G + 1, z: z1 + plan.finishZ + 1.5 }, 1.5, 2); await S.wait(gen, 10); continue; }
      const c = plan.route[i];
      const ok = await S.goNear(gen, { x: x1 + c.x + 0.5, y: s.G + c.h + 1, z: z1 + c.z + 0.5 }, c.tol, 3);
      if (CONFIG.debug) console.warn(`[arena] dbg parkour checkpoint ${i} (row ${c.z}): ${ok ? 'there' : 'not yet'}`);
      if (!ok) { fails.set(i, (fails.get(i) ?? 0) + 1); await S.wait(gen, 20); }
    }
  },
};

// ---------- boats: a canal race, towing the villagers' boat on a lead ----------
// A canal each, side by side and identical. In each: a boat with its rider, behind it a second boat with two villagers
// on a lead held by the rider. The bot drives by pushing its boat along the racing line (a simulated player's movement
// does not steer a boat); you steer your own.
const BOAT_KIT = kit([[0, 'lead', 2]]);
const boatO = (s, lane) => ({ x: s.O.x + lane * (s.x.plan.w - 1), z: s.O.z });
const flatD = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const BOAT = {
  name: 'boat', title: 'Boat Race', secs: 240, better: 'low', floor: 2, swims: false,
  rules: 'Race your boat round the canal to the gold line, towing the villagers\' boat behind you on the lead. Both boats have to be on the gold, and keep the villagers in (20 s for each one lost, 5 s for a snapped lead). "race" instead of a time: no tow.',
  dims: () => { const p = boatPlan(); return { w: 2 * (p.w - 1) + 1, d: p.d, h: 12 }; },
  build(s, B) {
    const p = s.x.plan = boatPlan(); const { O, G } = s;
    const top = G + p.depth;
    B.fill(O.x, O.y, O.z, O.x + 2 * (p.w - 1), G, O.z + p.d - 1, 'stone');
    B.fill(O.x, G + 1, O.z, O.x + 2 * (p.w - 1), G + 7, O.z + p.d - 1, 'stone_bricks');
    for (const lane of [0, 1]) {
      const o = boatO(s, lane), X = (x) => o.x + x, Z = (z) => o.z + z;
      for (const r of p.rects) {
        B.fill(X(r.x0), G + 1, Z(r.z0), X(r.x1), top, Z(r.z1), 'water');
        B.fill(X(r.x0), top + 1, Z(r.z0), X(r.x1), G + 7, Z(r.z1), 'air');
      }
      for (const q of p.posts) { B.fill(X(q.x), G + 1, Z(q.z), X(q.x), top + 1, Z(q.z), 'stone_bricks'); B.set(X(q.x), top + 2, Z(q.z), 'sea_lantern'); }
      // The gold line on the floor and a lantern each side of it; the start gate (glass) comes down at GO.
      B.fill(X(p.finish.x0), G, Z(p.finish.z0), X(p.finish.x1), G, Z(p.finish.z0), 'gold_block');
      B.set(X(p.finish.x0 - 1), G + 7, Z(p.finish.z0), 'sea_lantern'); B.set(X(p.finish.x1 + 1), G + 7, Z(p.finish.z0), 'sea_lantern');
      const g = p.rects[0];
      B.fill(X(g.x0), G + 1, Z(p.gateZ), X(g.x1), G + 6, Z(p.gateZ), 'glass');
      s.gates.push(`fill ${X(g.x0)} ${G + 1} ${Z(p.gateZ)} ${X(g.x1)} ${top} ${Z(p.gateZ)} water`);
      s.gates.push(`fill ${X(g.x0)} ${top + 1} ${Z(p.gateZ)} ${X(g.x1)} ${G + 6} ${Z(p.gateZ)} air`);
    }
  },
  layout(s) {
    const p = s.x.plan, { G } = s;
    return { starts: [0, 1].map((lane) => { const o = boatO(s, lane); return { x: o.x + p.start.x + 0.5, y: G + p.depth + 1.4, z: o.z + p.start.z + 0.5, fx: 0, fz: 1 }; }) };
  },
  kit: (s, p) => (p.bot ? kit([]) : BOAT_KIT),
  mobTypes: [],
  async ready(s) {
    const p = s.x.plan, { G } = s;
    const sit = (ent, boat) => { const l = boat.location; try { ent.runCommand(`ride @s start_riding @e[type=boat,x=${l.x},y=${l.y},z=${l.z},c=1] teleport_rider`); return true; } catch (e) { console.warn(`[arena] sit: ${e}`); return false; } };
    s.x.sit = sit;
    for (const part of s.parts) {
      const o = boatO(s, part.lane);
      const at = (c) => ({ x: o.x + c.x + 0.5, y: G + p.depth + 1.15, z: o.z + c.z + 0.5 });
      const boat = part.x.boat = s.dim.spawnEntity('minecraft:boat', at(p.start));
      try { boat.setRotation({ x: 0, y: 0 }); } catch {}
      await wait(8);
      sit(part.ent, boat);
      part.x.tow = null; part.x.villagers = []; part.x.riders = 0; part.x.snaps = 0; part.x.lost = 0; part.x.best = 0;
      if (s.opts.tow === false) continue;
      const tow = part.x.tow = s.dim.spawnEntity('minecraft:boat', at(p.tow));
      try { tow.setRotation({ x: 0, y: 0 }); } catch {}
      await wait(8);
      for (let i = 0; i < 2; i++) {
        try {
          const v = s.dim.spawnEntity('minecraft:villager_v2', { x: tow.location.x, y: tow.location.y + 1, z: tow.location.z });
          part.x.villagers.push(v);
          await wait(2);
          sit(v, tow);
        } catch (e) { console.warn(`[arena] villager: ${e}`); }
      }
      part.x.riders = 2;
      try { tow.getComponent('minecraft:leashable').leashTo(part.ent); } catch (e) { console.warn(`[arena] lead: ${e}`); }
      try {
        const n = (b) => b.getComponent('minecraft:rideable').getRiders().length;
        console.warn(`[arena] boats (${part.name}): its own has ${n(boat)} aboard, the villagers' has ${n(tow)}; lead ${tow.getComponent('minecraft:leashable').isLeashed ? 'on' : 'OFF'}`);
      } catch (e) { console.warn(`[arena] boats check: ${e}`); }
    }
  },
  go(s) { for (const p of s.parts) { p.x.snaps = 0; p.x.lost = 0; p.x.best = 0; } },
  tick(s, now) {
    const plan = s.x.plan;
    const fin = plan.finish;
    for (const p of s.parts) {
      if (!p.ent?.isValid) continue;
      const o = boatO(s, p.lane);
      const inFin = (l) => l.x >= o.x + fin.x0 && l.x <= o.x + fin.x1 + 1 && l.z >= o.z + fin.z0 && l.z <= o.z + fin.z1 + 1;
      const where = (l) => { const lx = l.x - o.x; return lx < 8.5 ? l.z - o.z : lx < 16.5 ? 2 * 61 - (l.z - o.z) : 122 + (l.z - o.z); };
      const loc = p.ent.location;
      // A boat gone (broken, or got out and it drifted): a new one under a person.
      if (!p.bot && p.x.boat && !p.x.boat.isValid && !p.done) {
        try { const b = p.x.boat = s.dim.spawnEntity('minecraft:boat', { x: loc.x, y: loc.y + 0.3, z: loc.z }); b.setRotation({ x: 0, y: 0 }); tell('Your boat was lost: here is another one.'); } catch {}
      }
      const tow = p.x.tow;
      if (tow) {
        if (tow.isValid) {
          let riders = 0; try { riders = tow.getComponent('minecraft:rideable').getRiders().length; } catch {}
          if (riders < (p.x.riders ?? 2)) { tell(`§c${p.bot ? p.name + ': a' : 'A'} villager fell out of the boat!§r (${riders} left, +20 s each)`); p.x.riders = riders; }
          p.x.lost = 2 - riders;
          let leashed = true; try { leashed = tow.getComponent('minecraft:leashable').isLeashed; } catch {}
          if (!leashed && !p.done) {
            // Snapped (or the villagers' boat got wedged): tie it back on, and when it is far off or stuck put it behind the main boat first.
            const lead = tow.getComponent('minecraft:leashable');
            try {
              if (flatD(tow.location, loc) > 7) {
                const h = p.x.boat?.isValid ? p.x.boat.location : loc, fwd = p.x.heading ?? { x: 0, z: 1 };
                const water = (x, z) => { try { return s.dim.getBlock({ x: Math.floor(x), y: Math.floor(h.y - 0.6), z: Math.floor(z) })?.typeId === 'minecraft:water'; } catch { return false; } };
                const at = [4, 3, 2].map((k) => ({ x: h.x - fwd.x * k, z: h.z - fwd.z * k })).find((c) => water(c.x, c.z)) ?? { x: h.x, z: h.z };
                tow.teleport({ x: at.x, y: h.y, z: at.z }, { dimension: s.dim });
                try { tow.clearVelocity(); } catch {}
              }
              lead.leashTo(p.ent); p.x.snaps++;
              tell(`§e${p.bot ? p.name + ': the' : 'The'} lead snapped: tied it back on (+5 s).§r`);
            } catch (e) { if (!p.x.leashWarned) { p.x.leashWarned = true; console.warn(`[arena] re-leash failed: ${e}`); } }
          }
        } else p.x.lost = 2;
      }
      if (CONFIG.debug && now % 40 < 4) { try { console.warn(`[arena] dbg boat ${p.name} ${loc.x.toFixed(1)},${loc.y.toFixed(1)},${loc.z.toFixed(1)} riding ${p.ent.getComponent('minecraft:riding')?.entityRidingOn?.typeId ?? '-'} tow ${tow?.isValid ? `${tow.location.x.toFixed(1)},${tow.location.z.toFixed(1)} riders ${tow.getComponent('minecraft:rideable').getRiders().length} leashed ${tow.getComponent('minecraft:leashable').isLeashed}` : '-'}`); } catch {} }
      try { const bv = (p.x.boat?.isValid ? p.x.boat : p.ent).getVelocity(), sp = Math.hypot(bv.x, bv.z); if (sp > 0.12) p.x.heading = { x: bv.x / sp, z: bv.z / sp }; } catch {}
      const pr = where(loc);
      if (pr > p.x.best) p.x.best = pr;
      const towIn = !tow || !tow.isValid || inFin(tow.location);
      if (!p.done && inFin(loc) && towIn) { p.done = true; p.x.finished = true; p.doneAt = now; tell(`${p.name} is on the gold!`); }
    }
  },
  // Over when everyone is across, or 30 s after the first (the penalties can turn a race round).
  over(s, now) {
    const done = s.parts.filter((p) => p.x.finished);
    if (done.length === s.parts.length) return true;
    if (done.length) { s.x.firstDone ??= now; return now - s.x.firstDone > 600; }
    return false;
  },
  hudLine(s) {
    return s.parts.map((p) => {
      const leg = (() => { try { const lx = p.ent.location.x - boatO(s, p.lane).x; return lx < 8.5 ? 1 : lx < 16.5 ? 2 : 3; } catch { return 1; } })();
      return `${p.bot ? p.name : 'You'}: ${p.x.finished ? '§aon the gold§r' : `leg ${leg}/3`}${s.x.tow !== false && p.x.tow ? ` villagers ${2 - (p.x.lost ?? 0)}/2` : ''}`;
    }).join('  §7|§r  ');
  },
  value(s, p) {
    if (p.x.finished) return p.doneAt - s.tick0 + 100 * (p.x.snaps ?? 0) + 400 * (p.x.lost ?? 0);
    return 1e6 + Math.max(0, Math.round((183 - (p.x.best ?? 0)) * 100)) + 400 * (p.x.lost ?? 0);
  },
  text(s, p) {
    const notes = `${p.x.lost ? `, lost ${p.x.lost} villager${p.x.lost > 1 ? 's' : ''}` : ''}${p.x.snaps ? `, lead snapped ${p.x.snaps}x` : ''}`;
    if (p.x.finished) return `${clock(p.doneAt - s.tick0 + 100 * (p.x.snaps ?? 0) + 400 * (p.x.lost ?? 0))} (${clock(p.doneAt - s.tick0)} on the water)${notes}`;
    return `${Math.round(100 * Math.min(1, (p.x.best ?? 0) / 183))}% round the canal${notes}`;
  },
  verdict: (s, bot) => ({ pass: !!bot.x.finished && (bot.x.lost ?? 0) === 0, detail: bot.x.finished ? `across in ${clock(bot.doneAt - s.tick0)}${bot.x.lost ? `, lost ${bot.x.lost} villager(s)` : ', both villagers aboard'}${bot.x.snaps ? `, lead snapped ${bot.x.snaps}x` : ''}` : `${Math.round(100 * Math.min(1, (bot.x.best ?? 0) / 183))}% round the canal` }),
  // The bot: a boat's controls don't answer a simulated player, so it pushes the boat along the racing line, steering the boat's
  // velocity toward where it should be going (the same push for every bend), at about the speed a boat does under oars.
  // The villagers' boat gets the same kind of push toward the spot on the line 4.5 blocks behind the main one: a lead pulls the
  // boat straight at its holder, so round the end of an island it cuts the corner and sticks (tried: it never got round).
  // The lead stays on (and a snap still costs 5 s), but it is not what tows.
  bot: async (s, p, gen) => {
    const A = s.agent, S = A.skills, plan = s.x.plan;
    const boat = p.x.boat;
    if (!boat?.isValid) return;
    const o = boatO(s, p.lane);
    const line = boatDrive(plan).map((q) => ({ x: o.x + q.x, z: o.z + q.z, slow: !!q.slow }));
    const cum = [0]; for (let k = 1; k < line.length; k++) cum.push(cum[k - 1] + flatD(line[k], line[k - 1]));
    // Arc length of the nearest point on the line, and the point at a given arc length (before the start: straight back from it).
    const arc = (l) => {
      let best = 1e9, at = 0;
      for (let k = 1; k < line.length; k++) {
        const a = line[k - 1], b = line[k], vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz || 1;
        const t = Math.max(0, Math.min(1, ((l.x - a.x) * vx + (l.z - a.z) * vz) / L2));
        const d = Math.hypot(l.x - (a.x + vx * t), l.z - (a.z + vz * t));
        if (d < best) { best = d; at = cum[k - 1] + Math.sqrt(L2) * t; }
      }
      return at;
    };
    const pointAt = (sv) => {
      if (sv <= 0) { const a = line[0], b = line[1], L = flatD(a, b) || 1; return { x: a.x + (b.x - a.x) / L * sv, z: a.z + (b.z - a.z) / L * sv }; }
      let k = 1; while (k < line.length - 1 && cum[k] < sv) k++;
      const a = line[k - 1], b = line[k], t = Math.max(0, Math.min(1, (sv - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1)));
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    };
    // Push `ent` toward `want` blocks per tick along (ux,uz): at most 0.09 a tick (a boat shoved harder skips along the water).
    const push = (ent, ux, uz, want) => {
      const v = ent.getVelocity();
      let ix = ux * want - v.x, iz = uz * want - v.z;
      const m = Math.hypot(ix, iz), cap = 0.09;
      if (m > cap) { ix = ix / m * cap; iz = iz / m * cap; }
      try { ent.applyImpulse({ x: ix * 0.6, y: 0, z: iz * 0.6 }); } catch {}
      return v;
    };
    let i = 1, still = 0, last = { ...boat.location };
    const vmax = 7.2;
    while (s.phase === 'run' && !p.done) {
      S.check(gen);
      if (!boat.isValid) return;
      try { if (!A.sim.getComponent('minecraft:riding')?.entityRidingOn) s.x.sit?.(A.sim, boat); } catch {}
      const bl = boat.location;
      const tow = p.x.tow?.isValid ? p.x.tow : null;
      const sb = arc(bl), lag = tow ? sb - arc(tow.location) : 0;
      while (i < line.length - 1 && flatD(bl, line[i]) < 1.8) i++;
      const wp = line[i], dx = wp.x - bl.x, dz = wp.z - bl.z, d = Math.hypot(dx, dz) || 1;
      // Slower where the next stretch bends (the boat keeps its way): the speed it can carry into this waypoint and the one after.
      const next = line[Math.min(i + 1, line.length - 1)];
      const bend = wp.slow || next.slow ? 4.2 : vmax;
      let want = Math.min(bend, vmax, 2 + d * 1.6) / 20; // blocks per tick
      if (tow && lag > 9) want *= Math.max(0.05, (12 - lag) / 3); // the villagers are left far behind: wait for them
      const v = push(boat, dx / d, dz / d, want);
      try { boat.setRotation({ x: 0, y: Math.atan2(-dx, dz) * 180 / Math.PI }); } catch {}
      if (tow) {
        const tg = pointAt(sb - 4.5), tl = tow.location, tx = tg.x - tl.x, tz = tg.z - tl.z, td = Math.hypot(tx, tz) || 1;
        // Toward the spot behind us, at our speed plus a little for every block it is out (never faster than the main boat can go).
        const sp = Math.hypot(v.x, v.z) + Math.min(0.2, td * 0.04);
        push(tow, tx / td, tz / td, td < 0.35 ? 0 : Math.min(sp, vmax / 20));
        try { tow.setRotation({ x: 0, y: Math.atan2(-dx, dz) * 180 / Math.PI }); } catch {}
      }
      // Stuck against a wall or a post for 3 s: a push back toward the middle of the leg.
      still = want > 0.01 && flatD(bl, last) < 0.015 ? still + 1 : 0;
      if (still > 60) { try { boat.applyImpulse({ x: -dx / d * 0.25, y: 0.02, z: -dz / d * 0.25 }); } catch {} still = 0; p.x.nudges = (p.x.nudges ?? 0) + 1; }
      last = { ...bl };
      if (CONFIG.debug && system.currentTick % 20 === 0) console.warn(`[arena] dbg bot boat at ${bl.x.toFixed(1)},${bl.z.toFixed(1)} -> wp ${i}/${line.length - 1} (${wp.x.toFixed(1)},${wp.z.toFixed(1)}) speed ${(Math.hypot(v.x, v.z) * 20).toFixed(1)} b/s lag ${lag.toFixed(1)}`);
      await S.wait(gen, 1);
    }
  },
};

export const ARENAS = { forest: FOREST, golem: GOLEM, ender: ENDER, dive: DIVE, parkour: PARKOUR, boat: BOAT };

// ---------- commands ----------

/** `!bot arena ...` */
export function arenaCommand(agent, player, args) {
  const [name, arg] = args;
  const say = (m) => (player ? player.sendMessage(`§e[Arena]§r ${m}`) : tell(m));
  if (!name || name === 'list') {
    return say(`Arenas: ${Object.keys(ARENA_INFO).map((n) => `${n}${ARENAS[n] ? '' : ' (not built yet)'} - ${ARENA_INFO[n]}`).join(' | ')}. Run: !bot arena <name> [seconds]  (or "solo": the bot alone). !bot arena stop ends one; !bot arena leave gives your things back if one went wrong.`);
  }
  if (name === 'stop') return say(stopArena() ? 'Stopping the arena.' : 'No arena is running.');
  if (name === 'leave') {
    if (!player) return say('Run this as a player.');
    return say(recoverPlayer(player) ? 'Done.' : 'Nothing of yours is set aside.');
  }
  const def = ARENAS[name];
  if (!def) return say(`No arena called ${name}. ${ARENA_NAMES.join(', ')}.`);
  const solo = arg === 'solo' || !player;
  const secs = Number(arg) > 0 ? Number(arg) : undefined;
  runSession(agent, player, def, { solo, secs, tow: !(name === 'boat' && arg === 'race') }).catch((e) => console.warn(`[arena] ${e}\n${e.stack ?? ''}`));
}

/** `!bot test <arena>`: the bot alone, PASS/FAIL. */
export async function testArena(agent, name, arg) {
  const def = ARENAS[name];
  if (!def) return { pass: false, detail: 'not built yet' };
  return runSession(agent, null, def, { solo: true, secs: arg > 0 ? arg : undefined, linger: 0 });
}
