// Physics probes: small, scripted experiments whose every tick is recorded, run the SAME way in the real game (game/scenarios.js, `test probewalk,...`) and in the
// simulator (sim/probes_run.mjs). The sim is fitted to the game by making the two traces agree (sim/calibrate.mjs): a probe is a question to both, with the answer
// as numbers. A probe uses only what both can do: the SimulatedPlayer's moveToLocation / stopMoving / jump / teleport, entities' location / applyImpulse, blocks by command.
//
// ctx: { sim (the bot's body), dim, x, gy, z (the site: the floor is y gy, you stand at gy + 1), cmd(text), wait(ticks), spawn(type, loc), leash(entity) -> bool,
//        give(id, n), mark(label), watch(entity) (sampled every tick from now on) }. A probe's run(ctx) is async; its result is the rows the runner sampled.

/** The flat floor and the air over it that every probe stands on: `fill` lines for a site of this extent, relative to (x, gy, z). */
const floor = (w, e, r) => (x, gy, z) => [
  `fill ${x - w} ${gy} ${z - r} ${x + e} ${gy} ${z + r} grass_block`,
  `fill ${x - w} ${gy + 1} ${z - r} ${x + e} ${gy + 9} ${z + r} air`,
];
const at = (ctx, dx, dy, dz) => ({ x: ctx.x + dx + 0.5, y: ctx.gy + 1 + dy, z: ctx.z + dz + 0.5 });
const go = (ctx, dx, dz, speed = 1) => ctx.sim.moveToLocation({ x: ctx.x + dx + 0.5, y: ctx.gy + 1, z: ctx.z + dz + 0.5 }, { speed });

export const PROBES = {
  // How the walker speeds up, runs and stops: full speed, then half and 0.4 (the speeds the tow uses), each from a standstill.
  probewalk: {
    ext: { w: 4, e: 44, r: 4 }, floor: floor(4, 44, 4), secs: 12,
    async run(ctx) {
      for (const [speed, ticks] of [[1, 60], [0.5, 50], [0.4, 40]]) {
        ctx.sim.teleport(at(ctx, -2, 0, 0)); await ctx.wait(10);
        ctx.mark(`walk ${speed}`); go(ctx, 38, 0, speed); await ctx.wait(ticks);
        ctx.mark('stop'); ctx.sim.stopMoving(); await ctx.wait(20);
      }
    },
  },
  // sim.move (the bot's fine steering): east at full, half, then 0.4; then a turn south from full speed; then diagonal; each stopped with stopMoving.
  probemove: {
    ext: { w: 4, e: 24, r: 8 }, floor: floor(4, 24, 8), secs: 14,
    async run(ctx) {
      ctx.sim.teleport(at(ctx, -2, 0, -4)); await ctx.wait(10);
      for (const speed of [1, 0.5, 0.4]) {
        ctx.mark(`move east ${speed}`); ctx.sim.move(1, 0, speed); await ctx.wait(40);
        ctx.mark('stop'); ctx.sim.stopMoving(); await ctx.wait(20);
        ctx.sim.teleport(at(ctx, -2, 0, -4)); await ctx.wait(5);
      }
      ctx.mark('east then south'); ctx.sim.move(1, 0, 1); await ctx.wait(25); ctx.sim.move(0, 1, 1); await ctx.wait(25);
      ctx.mark('stop'); ctx.sim.stopMoving(); await ctx.wait(20);
      ctx.sim.teleport(at(ctx, -2, 0, -6)); await ctx.wait(5);
      ctx.mark('diagonal'); ctx.sim.move(1, 1, 1); await ctx.wait(40);
      ctx.mark('stop'); ctx.sim.stopMoving(); await ctx.wait(20);
    },
  },
  // A jump on the spot, and a jump while walking.
  probejump: {
    ext: { w: 4, e: 24, r: 4 }, floor: floor(4, 24, 4), secs: 8,
    async run(ctx) {
      ctx.sim.teleport(at(ctx, 0, 0, 0)); await ctx.wait(10);
      ctx.mark('jump'); ctx.sim.jump(); await ctx.wait(30);
      ctx.mark('walk'); go(ctx, 20, 0); await ctx.wait(25);
      ctx.mark('jump walking'); ctx.sim.jump(); await ctx.wait(30);
      ctx.sim.stopMoving(); await ctx.wait(15);
    },
  },
  // Steps and walls: a half block (a slab) walked into, a full block walked into (it stops), then jumped onto, and a drop of 5 walked off.
  probestep: {
    ext: { w: 4, e: 28, r: 4 }, floor: floor(4, 28, 4), secs: 12,
    cmds: (x, gy, z) => [`setblock ${x + 6} ${gy + 1} ${z} stone_block_slab`, `fill ${x + 14} ${gy + 1} ${z - 1} ${x + 14} ${gy + 1} ${z + 1} stone`, `fill ${x + 20} ${gy} ${z - 3} ${x + 28} ${gy} ${z + 3} air`, `fill ${x + 20} ${gy - 6} ${z - 3} ${x + 28} ${gy - 6} ${z + 3} stone`],
    async run(ctx) {
      ctx.sim.teleport(at(ctx, 2, 0, 0)); await ctx.wait(10);
      ctx.mark('walk to the slab'); go(ctx, 11, 0); await ctx.wait(40);
      ctx.sim.stopMoving(); ctx.sim.teleport(at(ctx, 11, 0, 0)); await ctx.wait(5);
      ctx.mark('walk into the block'); go(ctx, 17, 0); await ctx.wait(30);
      ctx.mark('jump onto it'); ctx.sim.jump(); await ctx.wait(20);
      ctx.mark('walk off'); go(ctx, 25, 0); await ctx.wait(60);
      ctx.sim.stopMoving(); await ctx.wait(10);
    },
  },
  // A boat given a push and left to slide (the ground's friction on it), and one dropped from 3 up.
  probeslide: {
    ext: { w: 4, e: 24, r: 4 }, floor: floor(4, 24, 4), secs: 6,
    async run(ctx) {
      ctx.sim.teleport(at(ctx, -3, 0, 3)); await ctx.wait(5);
      const boat = ctx.spawn('minecraft:boat', at(ctx, 0, 0, 0)); ctx.watch(boat); await ctx.wait(15);
      ctx.mark('push'); boat.applyImpulse({ x: 0.5, y: 0, z: 0 }); await ctx.wait(50);
      ctx.mark('drop'); boat.teleport(at(ctx, 0, 3, -2)); await ctx.wait(30);
    },
  },
  // The lead as a spring: the boat held 5, 6, 7, 8, 9 away from a standing walker: how hard it is pulled at each length.
  probepull: {
    ext: { w: 4, e: 24, r: 4 }, floor: floor(4, 24, 4), secs: 14,
    async run(ctx) {
      ctx.sim.teleport(at(ctx, 14, 0, 0)); await ctx.wait(5);
      const boat = ctx.spawn('minecraft:boat', at(ctx, 8, 0, 0)); ctx.watch(boat); await ctx.wait(10);
      if (!ctx.leash(boat)) return;
      await ctx.wait(60);
      for (const d of [5, 6, 7, 8, 9]) { ctx.mark(`held at ${d}`); boat.teleport(at(ctx, 14 - d, 0, 0)); await ctx.wait(25); }
    },
  },
  // Walking with the boat on its lead: how far it trails at 1, 0.5, 0.4 speed, and how it catches up when the walker stops.
  probefollow: {
    ext: { w: 8, e: 52, r: 4 }, floor: floor(8, 52, 4), secs: 22,
    async run(ctx) {
      ctx.sim.teleport(at(ctx, -3, 0, 0)); await ctx.wait(5);
      const boat = ctx.spawn('minecraft:boat', at(ctx, -8, 0, 0)); ctx.watch(boat); await ctx.wait(10);
      if (!ctx.leash(boat)) return;
      ctx.mark('follow 1'); go(ctx, 45, 0, 1); await ctx.wait(140);
      ctx.mark('stop'); ctx.sim.stopMoving(); await ctx.wait(60);
      ctx.sim.teleport(at(ctx, -3, 0, 2)); boat.teleport(at(ctx, -8, 0, 2)); await ctx.wait(20);
      ctx.mark('follow 0.5'); go(ctx, 30, 2, 0.5); await ctx.wait(100);
      ctx.sim.stopMoving(); await ctx.wait(40);
    },
  },
  // A sling on the flat: the boat put 5.5, 7, 8.4, 9.5 away from a standing walker, left 30 ticks (does it pull without the walker moving?), then the walker jumps.
  probesling: {
    ext: { w: 4, e: 28, r: 4 }, floor: floor(4, 28, 4), secs: 24,
    async run(ctx) {
      for (const d of [5.5, 7, 8.4, 9.5]) {
        ctx.sim.teleport(at(ctx, 14, 0, 0)); await ctx.wait(5);
        const boat = ctx.spawn('minecraft:boat', at(ctx, 14 - d, 0, 0)); ctx.watch(boat); await ctx.wait(5);
        if (!ctx.leash(boat)) return;
        ctx.mark(`stretch ${d}`); boat.teleport(at(ctx, 14 - d, 0, 0)); await ctx.wait(30);
        ctx.mark('jump'); ctx.sim.jump(); await ctx.wait(40);
        try { boat.remove(); } catch { /* */ }
      }
    },
  },
  // The sling up a lip: a boat jammed at the foot of a platform 1, 2, 3 high, the walker on top at 6.5, 8, 9.5 from it; held 20 ticks, then the walker jumps (how high does the boat come, how fast).
  probelift: {
    ext: { w: 4, e: 28, r: 4 }, floor: floor(4, 28, 4), secs: 40,
    async run(ctx) {
      for (const rise of [1, 2, 3]) {
        ctx.cmd(`fill ${ctx.x} ${ctx.gy + 1} ${ctx.z - 2} ${ctx.x + 13} ${ctx.gy + rise} ${ctx.z + 2} stone`);
        for (const d of [6.5, 8, 9.5]) {
          ctx.sim.teleport({ x: ctx.x - 2.5, y: ctx.gy + 1, z: ctx.z + 0.5 }); await ctx.wait(5);
          const boat = ctx.spawn('minecraft:boat', { x: ctx.x - 0.9, y: ctx.gy + 1, z: ctx.z + 0.5 }); ctx.watch(boat); await ctx.wait(5);
          if (!ctx.leash(boat)) return;
          ctx.sim.teleport({ x: ctx.x - 0.9 + d, y: ctx.gy + 1 + rise, z: ctx.z + 0.5 }); ctx.mark(`rise ${rise} stretch ${d}`); await ctx.wait(20);
          ctx.mark('jump'); ctx.sim.jump(); await ctx.wait(35);
          try { boat.remove(); } catch { /* */ }
        }
        ctx.cmd(`fill ${ctx.x} ${ctx.gy + 1} ${ctx.z - 2} ${ctx.x + 13} ${ctx.gy + rise} ${ctx.z + 2} air`);
      }
    },
  },
  // A boat pulled into a block 1 high, and into one 3 high (the walker beyond, level): does it climb, how it sits against it; then the walker on top and a sling.
  probeblock: {
    ext: { w: 4, e: 28, r: 6 }, floor: floor(4, 28, 6),
    cmds: (x, gy, z) => [`fill ${x + 4} ${gy + 1} ${z - 6} ${x + 5} ${gy + 1} ${z - 1} stone`, `fill ${x + 4} ${gy + 1} ${z + 1} ${x + 5} ${gy + 3} ${z + 6} stone`, `fill ${x + 4} ${gy + 4} ${z + 1} ${x + 5} ${gy + 4} ${z + 6} air`], secs: 26,
    async run(ctx) {
      // 1 high, on the north half (z - 3): the walker well beyond it
      for (const [dz, rise] of [[-3, 1], [3, 3]]) {
        ctx.sim.teleport(at(ctx, 9, 0, dz)); await ctx.wait(5);
        const boat = ctx.spawn('minecraft:boat', at(ctx, 1, 0, dz)); ctx.watch(boat); await ctx.wait(5);
        if (!ctx.leash(boat)) return;
        ctx.mark(`level, wall ${rise}`); await ctx.wait(60);
        ctx.mark(`walker on top ${rise}`); ctx.sim.teleport(at(ctx, 6, rise, dz)); await ctx.wait(10);
        go(ctx, 11, dz, 0.5); await ctx.wait(40);
        ctx.sim.stopMoving(); ctx.mark('jump'); ctx.sim.jump(); await ctx.wait(40);
        ctx.mark('end'); boat.unleash?.(); try { boat.remove(); } catch { /* */ }
      }
    },
  },
  // The sling from the GROUND past a low wall (u272, from sim/minimize.mjs: one 1-high wall 3 deep and the bot jumping at 8.5, the boat never coming): a boat at the foot of a wall
  // 1 and 2 high and 3 deep, the walker on the ground beyond it at 7, 8.3, 9.5 from the boat; held 20 ticks, then the walker jumps. Does the boat come over, how high, how fast.
  probewall: {
    ext: { w: 4, e: 28, r: 4 }, floor: floor(4, 28, 4), secs: 50,
    async run(ctx) {
      for (const rise of [1, 2]) {
        ctx.cmd(`fill ${ctx.x} ${ctx.gy + 1} ${ctx.z - 2} ${ctx.x + 2} ${ctx.gy + rise} ${ctx.z + 2} stone`);
        for (const d of [7, 8.3, 9.5]) {
          ctx.sim.teleport({ x: ctx.x - 2.5, y: ctx.gy + 1, z: ctx.z + 0.5 }); await ctx.wait(5);
          const boat = ctx.spawn('minecraft:boat', { x: ctx.x - 0.9, y: ctx.gy + 1, z: ctx.z + 0.5 }); ctx.watch(boat); await ctx.wait(5);
          if (!ctx.leash(boat)) return;
          ctx.sim.teleport({ x: ctx.x - 0.9 + d, y: ctx.gy + 1, z: ctx.z + 0.5 }); ctx.mark(`wall ${rise} stretch ${d}`); await ctx.wait(20);
          ctx.mark('jump'); ctx.sim.jump(); await ctx.wait(30);
          try { boat.remove(); } catch { /* */ }
        }
        ctx.cmd(`fill ${ctx.x} ${ctx.gy + 1} ${ctx.z - 2} ${ctx.x + 2} ${ctx.gy + rise} ${ctx.z + 2} air`);
      }
    },
  },
  // (u281) The jump formula (core/liftmodel.js): a boat jammed at the foot of a platform 1, 2, 3 high, the walker on top 4.5 .. 8.5 out from it. Held 20 ticks, then up to four jumps 24 ticks
  // apart: how many does it take for the boat to come up (sim/fit_lift.mjs reads the marks "h <rise> d <out>" and "jump <n>")?
  probejumps: {
    ext: { w: 4, e: 28, r: 4 }, floor: floor(4, 28, 4), secs: 170,
    async run(ctx) {
      for (const rise of [1, 2, 3]) {
        ctx.cmd(`fill ${ctx.x} ${ctx.gy + 1} ${ctx.z - 2} ${ctx.x + 13} ${ctx.gy + rise} ${ctx.z + 2} stone`);
        for (const d of [4.5, 5.5, 6, 6.5, 7, 7.5, 8.5]) {
          ctx.sim.teleport({ x: ctx.x - 2.5, y: ctx.gy + 1, z: ctx.z + 0.5 }); await ctx.wait(5);
          const boat = ctx.spawn('minecraft:boat', { x: ctx.x - 0.9, y: ctx.gy + 1, z: ctx.z + 0.5 }); ctx.watch(boat); await ctx.wait(5);
          if (!ctx.leash(boat)) return;
          ctx.sim.teleport({ x: ctx.x - 0.9 + d, y: ctx.gy + 1 + rise, z: ctx.z + 0.5 }); ctx.mark(`h ${rise} d ${d}`); await ctx.wait(20);
          for (let j = 1; j <= 4; j++) { ctx.mark(`jump ${j}`); ctx.sim.jump(); await ctx.wait(24); }
          try { boat.remove(); } catch { /* */ }
        }
        ctx.cmd(`fill ${ctx.x} ${ctx.gy + 1} ${ctx.z - 2} ${ctx.x + 13} ${ctx.gy + rise} ${ctx.z + 2} air`);
      }
    },
  },
};
PROBES.probewater = {
  // Water physics (u305): dropped from 3 blocks into a 9-deep pool with no input, so the trace shows the splash, the slow sink to the bottom (its speed settles at
  // gravity * drag / (1 - drag): 0.08 a tick if water gravity is 0.02, 0.02 if it is 0.005 -- the one sim constant Java and ours disagree on), then jumping to rise.
  ext: { w: 5, e: 5, r: 5 }, floor: floor(5, 5, 5), secs: 12,
  cmds: (x, gy, z) => [`fill ${x - 4} ${gy - 10} ${z - 4} ${x + 4} ${gy} ${z + 4} stone`, `fill ${x - 3} ${gy - 9} ${z - 3} ${x + 3} ${gy} ${z + 3} water`],
  async run(ctx) {
    ctx.sim.teleport(at(ctx, 0, 3, 0)); await ctx.wait(5);
    ctx.mark('drop and sink'); await ctx.wait(90);
    ctx.mark('jumping up');
    for (let k = 0; k < 20; k++) { ctx.sim.jump(); await ctx.wait(2); }
    await ctx.wait(20);
  },
};
export const PROBE_NAMES = Object.keys(PROBES);
