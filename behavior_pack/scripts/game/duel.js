// `!bot test duel`: you and the bot in an arena with terrain (a hill, walls to hide behind, pillars, a pit), each with every kind of weapon
// in the game and a shield, in iron armour, three rounds. Nobody is told what to use: you pick what you like and so does the bot (the best
// of what it carries by damage and pace, the bow when you are far off and in the open, a melee weapon when you are near). A round ends at
// 3 hearts left or after 60 s; both are healed between rounds. Hits and damage are counted per side, and both of you are recorded
// (the bot as `bot`, you as `human`) so how you moved, aimed and swung can be set against how the bot did.
import { system, world, ItemStack, EquipmentSlot } from '@minecraft/server';
import { TestRecorder } from './testrun.js';
import { container, hold, invCounts, take } from './inventory.js';
import { weaponReach } from '../core/tactics.js';
import { bestWeapon } from '../core/tactics.js';
import { solvePitch } from '../core/ballistics.js';

/** @type {Array<[string, number]>} */
const ARSENAL = [
  ['diamond_sword', 1], ['diamond_axe', 1], ['diamond_spear', 1], ['mace', 1], ['trident', 1], ['bow', 1], ['crossbow', 1], ['arrow', 64], ['golden_apple', 3],
];
const MELEE = ['diamond_sword', 'diamond_axe', 'diamond_spear', 'mace', 'trident'];
const ARMOUR = [[EquipmentSlot.Head, 'iron_helmet'], [EquipmentSlot.Chest, 'iron_chestplate'], [EquipmentSlot.Legs, 'iron_leggings'], [EquipmentSlot.Feet, 'iron_boots']];
const ROUNDS = 3, ROUND_S = 60, END_HP = 6;

const hpOf = (e) => { try { return e.getComponent('minecraft:health')?.currentValue ?? 0; } catch { return 0; } };
const heal = (e) => { try { e.getComponent('minecraft:health')?.resetToMaxValue(); } catch { /* */ } };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** The arena, on the sky slab (x - 14 .. x + 18, z - 12 .. z + 12): cover, a hill, pillars, a pit. */
function buildArena(cmd, x, gy, z) {
  cmd(`fill ${x - 12} ${gy + 1} ${z - 10} ${x + 16} ${gy + 8} ${z + 10} air`);
  // walls to hide behind
  cmd(`fill ${x - 3} ${gy + 1} ${z - 6} ${x - 3} ${gy + 2} ${z - 2} stone_bricks`);
  cmd(`fill ${x + 1} ${gy + 1} ${z + 2} ${x + 1} ${gy + 2} ${z + 6} stone_bricks`);
  cmd(`fill ${x + 9} ${gy + 1} ${z - 6} ${x + 9} ${gy + 2} ${z - 2} stone_bricks`);
  cmd(`fill ${x + 5} ${gy + 1} ${z + 3} ${x + 5} ${gy + 2} ${z + 7} stone_bricks`);
  // a hill in the middle, stepped
  cmd(`fill ${x + 2} ${gy + 1} ${z - 3} ${x + 6} ${gy + 1} ${z + 1} stone`);
  cmd(`fill ${x + 3} ${gy + 2} ${z - 2} ${x + 5} ${gy + 2} ${z} stone`);
  cmd(`fill ${x + 4} ${gy + 3} ${z - 1} ${x + 4} ${gy + 3} ${z - 1} stone`);
  // pillars
  for (const [px, pz] of [[x - 6, z + 5], [x - 6, z - 5], [x + 12, z + 5], [x + 12, z - 5]]) cmd(`fill ${px} ${gy + 1} ${pz} ${px} ${gy + 3} ${pz} cobblestone`);
  // pits (two deep) near each end
  cmd(`fill ${x - 9} ${gy - 1} ${z + 2} ${x - 8} ${gy} ${z + 3} air`);
  cmd(`fill ${x + 13} ${gy - 1} ${z - 3} ${x + 14} ${gy} ${z - 2} air`);
  // a ramp up to a ledge at the player's end
  cmd(`fill ${x + 14} ${gy + 1} ${z + 1} ${x + 16} ${gy + 1} ${z + 3} stone`);
  cmd(`fill ${x + 15} ${gy + 2} ${z + 1} ${x + 16} ${gy + 2} ${z + 3} stone`);
}

/**
 * @returns {Promise<{ pass: boolean, detail: string }>}
 */
export async function runDuel(agent, player, { cmd, x, gy, z, extraRuns, secs }) {
  const sim = agent.sim, dim = agent.dim;
  agent.testHold = true;
  const pk = container(player), simPk = container(sim);
  const eqP = player.getComponent('minecraft:equippable'), eqS = sim.getComponent('minecraft:equippable');
  const saved = (/** @type {any} */ eq) => { const o = {}; for (const [slot] of [...ARMOUR, [EquipmentSlot.Offhand]]) { try { o[slot] = eq?.getEquipment(slot); } catch { /* */ } } return o; };
  const oldP = saved(eqP), oldS = saved(eqS);
  const oldSlot = player.selectedSlotIndex;
  /** @type {Array<() => void>} */
  const undo = [];
  const tally = { bot: { hits: 0, dmg: 0 }, human: { hits: 0, dmg: 0 } };
  const wa = /** @type {any} */ (world.afterEvents);
  const sub = wa.entityHurt.subscribe((ev) => {
    try {
      const by = ev.damageSource?.damagingEntity?.id;
      const side = by === sim.id && ev.hurtEntity.id === player.id ? 'bot' : by === player.id && ev.hurtEntity.id === sim.id ? 'human' : null;
      if (!side) return;
      tally[side].hits++; tally[side].dmg += ev.damage;
    } catch { /* */ }
  });
  undo.push(() => wa.entityHurt.unsubscribe(sub));
  const recBot = new TestRecorder(sim), recHuman = new TestRecorder(player);
  const rounds = [];
  const used = { bot: {}, human: {} };
  try {
    buildArena(cmd, x, gy, z);
    agent.say(`Duel: an arena with a hill, walls, pillars and pits. You and the bot each have every weapon (diamond sword, axe and spear, mace, trident, bow, crossbow, 64 arrows), a shield and iron armour, and choose what to use. ${ROUNDS} rounds; one ends at 3 hearts left or after ${ROUND_S} s. \`!bot test skip\` stops.`);
    for (const [pack] of [[pk], [simPk]]) for (const [id, n] of ARSENAL) { try { pack?.addItem(new ItemStack(`minecraft:${id}`, n)); } catch { /* an id this version does not have */ } }
    for (const eq of [eqP, eqS]) {
      for (const [slot, id] of ARMOUR) { try { eq?.setEquipment(slot, new ItemStack(`minecraft:${id}`, 1)); } catch { /* */ } }
      try { eq?.setEquipment(EquipmentSlot.Offhand, new ItemStack('minecraft:shield', 1)); } catch { /* */ }
    }
    agent.shield = true;
    recBot.start(); recHuman.start();
    for (let rd = 1; rd <= ROUNDS; rd++) {
      if (agent.testSkipped) break;
      heal(player); heal(sim);
      player.teleport({ x: x + 14.5, y: gy + 1, z: z + 0.5 }, { facingLocation: { x: x - 8, y: gy + 2, z: z + 0.5 } });
      sim.teleport({ x: x - 9.5, y: gy + 1, z: z + 0.5 });
      agent.say(`Round ${rd}/${ROUNDS}: fight in 3...`);
      await system.waitTicks(60);
      const before = { bot: { ...tally.bot }, human: { ...tally.human } };
      let lastSwing = -99, strafe = 1, nextStrafe = 0, nextShot = 0, mode = 'melee', chosen = '';
      const t0 = system.currentTick;
      /** @returns {string} why the round is over, or '' */
      const over = () => {
        if (agent.testSkipped) return 'skipped';
        if ((system.currentTick - t0) / 20 > ROUND_S) return 'time';
        if (hpOf(sim) <= END_HP) return 'you won';
        if (hpOf(player) <= END_HP) return 'the bot won';
        return '';
      };
      let ended = '';
      while (!(ended = over())) {
        await system.waitTicks(2);
        const t = system.currentTick;
        let me, you, eyeY;
        try { me = sim.location; you = player.location; eyeY = player.getHeadLocation(); } catch { ended = 'gone'; break; }
        const d = dist(me, you);
        if (t >= nextStrafe) { strafe = -strafe; nextStrafe = t + 20 + Math.floor(Math.random() * 25); }
        const dx = (you.x - me.x) / (d || 1), dz = (you.z - me.z) / (d || 1);
        // What to use: the bow from a distance (and a shield between shots), a melee weapon when you are near.
        const arrows = invCounts(sim).arrow ?? 0;
        if (mode === 'melee' && d > 10 && arrows > 0) mode = 'bow';
        else if (mode === 'bow' && (d < 6 || arrows === 0)) mode = 'melee';
        if (mode === 'bow') {
          if (chosen !== 'bow') { hold(sim, 'bow'); chosen = 'bow'; used.bot.bow = (used.bot.bow ?? 0) + 1; }
          agent.setBlocking(false);
          agent.body.move(-dz * strafe, dx * strafe, 0.5);
          if (t >= nextShot) {
            // Aim where you will be when the arrow arrives, at the angle its drop needs, hold the view there, draw, release.
            try {
              const v = player.getVelocity(), flight = d / 2.8;
              const tgt = { x: eyeY.x + v.x * flight * 1, y: eyeY.y - 0.4 + v.y * flight * 0.3, z: eyeY.z + v.z * flight };
              const eye = sim.getHeadLocation();
              const ddx = tgt.x - eye.x, ddz = tgt.z - eye.z, dd = Math.hypot(ddx, ddz) || 1;
              const th = solvePitch(dd, tgt.y - eye.y);
              const pt = { x: eye.x + (ddx / dd) * 30 * Math.cos(th), y: eye.y + 30 * Math.sin(th), z: eye.z + (ddz / dd) * 30 * Math.cos(th) };
              /** @type {any} */ (sim).lookAtLocation(pt);
              agent.motor.setFocus(pt);
              await system.waitTicks(6);
              const item = simPk?.getItem(sim.selectedSlotIndex);
              try { /** @type {any} */ (sim).useItem(item); } catch { /* */ }
              for (let k = 0; k < 11 && !over(); k++) { agent.body.move(-dz * strafe, dx * strafe, 0.5); await system.waitTicks(2); }
              try { /** @type {any} */ (sim).stopUsingItem(); } catch { /* */ }
              await system.waitTicks(2);
            } finally { agent.motor.setFocus(null); }
            nextShot = system.currentTick + 10;
          }
          continue;
        }
        // Melee: the best of what it carries, closing to that weapon's reach, swinging when facing you, shield up between swings.
        const weapon = bestWeapon(MELEE.filter((id) => invCounts(sim)[id]).map((id) => ({ id }))) ?? 'diamond_sword';
        if (chosen !== weapon) { hold(sim, weapon); chosen = weapon; used.bot[weapon] = (used.bot[weapon] ?? 0) + 1; }
        const wr = weaponReach(weapon), every = Math.max(10, wr.cooldown);
        const far = Math.max(2.6, wr.reach - 0.25), near = Math.max(1.8, wr.minReach + 0.25);
        try { sim.lookAtEntity(player); } catch { /* */ }
        if (d > far) agent.body.move(dx, dz, 1);
        else if (d < near) agent.body.move(-dx, -dz, 1);
        else agent.body.move(-dz * strafe, dx * strafe, 0.8);
        const ready = t - lastSwing >= every;
        agent.setBlocking(!ready && d < 5);
        // Only when it is turned to you (the engine's own swing needs no aim, which is not how a player fights).
        if (ready && d <= wr.reach - 0.1 && d >= wr.minReach && agent.facing(you, 22)) { try { sim.attackEntity(player); } catch { /* */ } lastSwing = t; }
      }
      agent.setBlocking(false);
      agent.body.stop?.();
      const r = {
        ended, bot: chosen,
        botHits: tally.bot.hits - before.bot.hits, botDmg: Math.round(tally.bot.dmg - before.bot.dmg),
        youHits: tally.human.hits - before.human.hits, youDmg: Math.round(tally.human.dmg - before.human.dmg),
      };
      rounds.push(r);
      agent.say(`Round ${rd}: ${r.ended}. You hit ${r.youHits} times (${r.youDmg} dmg), the bot ${r.botHits} (${r.botDmg} dmg), the bot ended on ${r.bot.replace('_', ' ')}.`);
      for (const e of dim.getEntities({ type: 'minecraft:arrow', location: { x, y: gy, z }, maxDistance: 60 })) { try { e.remove(); } catch { /* */ } }
      if (ended === 'skipped') break;
    }
  } finally {
    heal(player); heal(sim);
    agent.motor.setFocus(null);
    // Everything handed out is taken back; the armour and shield they had before are put back.
    for (const ent of [player, sim]) for (const [id, n] of ARSENAL) { try { const have = invCounts(/** @type {any} */ (ent))[id] ?? 0; if (have > 0) take(/** @type {any} */ (ent), id, Math.min(have, n)); } catch { /* */ } }
    for (const [eq, old] of [[eqP, oldP], [eqS, oldS]]) for (const slot of Object.keys(old)) { try { eq?.setEquipment(slot, old[slot]); } catch { /* */ } }
    try { player.selectedSlotIndex = oldSlot; } catch { /* */ }
    agent.setBlocking(false);
    const sb = recBot.stop(), sh = recHuman.stop();
    for (const u of undo) { try { u(); } catch { /* */ } }
    const botWon = rounds.filter((r) => r.botDmg > r.youDmg).length, youWon = rounds.filter((r) => r.youDmg > r.botDmg).length;
    extraRuns.push({ who: 'human', summary: sh, trace: recHuman.trace(), pass: youWon >= botWon && rounds.length > 0 });
    extraRuns.push({ who: 'bot', summary: sb, trace: recBot.trace(), pass: botWon >= youWon && rounds.length > 0 });
  }
  const botWon = rounds.filter((r) => r.botDmg > r.youDmg).length, youWon = rounds.filter((r) => r.youDmg > r.botDmg).length;
  const engaged = rounds.length > 0 && rounds.every((r) => r.botHits > 0 || r.youHits > 0);
  return {
    pass: engaged,
    detail: `${rounds.length} rounds in ${secs()}s: you won ${youWon}, the bot ${botWon}; bot landed ${tally.bot.hits} hits (${Math.round(tally.bot.dmg)} dmg), you ${tally.human.hits} (${Math.round(tally.human.dmg)} dmg); the bot used ${Object.entries(used.bot).map(([k, v]) => `${k} x${v}`).join(', ') || 'nothing'}`,
  };
}
