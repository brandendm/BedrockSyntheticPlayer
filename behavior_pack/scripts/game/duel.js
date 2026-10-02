// `!bot test duel`: you and the bot fight with the same weapon and a shield, a few rounds (stone sword, iron axe, iron sword).
// A round ends at 11 hp left or after 45 s; both are healed between rounds. Hits and damage are counted per side, and both of you
// are recorded (the bot as `bot`, you as `human`) so how you moved and swung can be set against how the bot did.
import { system, world, ItemStack, EquipmentSlot } from '@minecraft/server';
import { TestRecorder } from './testrun.js';
import { container } from './inventory.js';

/** @type {Array<[string, number]>} */
const ROUNDS = [['stone_sword', 12], ['iron_axe', 20], ['iron_sword', 12]];
const ROUND_S = 45, END_HP = 11;

const hpOf = (e) => { try { return e.getComponent('minecraft:health')?.currentValue ?? 0; } catch { return 0; } };
const heal = (e) => { try { e.getComponent('minecraft:health')?.resetToMaxValue(); } catch { /* */ } };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * @returns {Promise<{ pass: boolean, detail: string }>}
 */
export async function runDuel(agent, player, { cmd, x, gy, z, extraRuns, secs }) {
  const sim = agent.sim, dim = agent.dim;
  agent.testHold = true;
  const pk = container(player), simPk = container(sim);
  const eqP = player.getComponent('minecraft:equippable'), eqS = sim.getComponent('minecraft:equippable');
  const oldOff = (() => { try { return eqP?.getEquipment(EquipmentSlot.Offhand); } catch { return undefined; } })();
  const oldSlot = player.selectedSlotIndex;
  /** @type {Array<() => void>} */
  const undo = [];
  const tally = { bot: { hits: 0, dmg: 0, blocked: 0 }, human: { hits: 0, dmg: 0, blocked: 0 } };
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
  try {
    // An arena: a stone floor, open air.
    cmd(`fill ${x - 6} ${gy} ${z - 7} ${x + 12} ${gy} ${z + 7} stone`);
    cmd(`fill ${x - 6} ${gy + 1} ${z - 7} ${x + 12} ${gy + 6} ${z + 7} air`);
    agent.say('Duel: you and the bot, same weapon and shield each round. A round ends at 5 hearts left or 45 s. `!bot test skip` to stop. Raise your shield with right-click held.');
    recBot.start(); recHuman.start();
    for (const [weapon, every] of ROUNDS) {
      if (agent.testSkipped) break;
      const give = (pack, ent) => { try { pack?.addItem(new ItemStack(`minecraft:${weapon}`, 1)); } catch { /* */ } };
      give(pk, player); give(simPk, sim);
      try { eqP?.setEquipment(EquipmentSlot.Offhand, new ItemStack('minecraft:shield', 1)); } catch { /* */ }
      try { eqS?.setEquipment(EquipmentSlot.Offhand, new ItemStack('minecraft:shield', 1)); agent.shield = true; } catch { /* */ }
      const slotOf = (pack) => { for (let i = 0; pack && i < 9; i++) if (pack.getItem(i)?.typeId === `minecraft:${weapon}`) return i; return -1; };
      try { const i = slotOf(pk); if (i >= 0) player.selectedSlotIndex = i; } catch { /* */ }
      try { const i = slotOf(simPk); if (i >= 0) sim.selectedSlotIndex = i; } catch { /* */ }
      heal(player); heal(sim);
      player.teleport({ x: x + 9.5, y: gy + 1, z: z + 0.5 }, { facingLocation: { x, y: gy + 2, z: z + 0.5 } });
      sim.teleport({ x: x + 1.5, y: gy + 1, z: z + 0.5 });
      agent.say(`Round: ${weapon.replace('_', ' ')}. Fight in 3...`);
      await system.waitTicks(60);
      const before = { bot: { ...tally.bot }, human: { ...tally.human } };
      let lastHit = -99, strafe = 1, nextStrafe = 0;
      const t0 = system.currentTick;
      let ended = '';
      while (!ended) {
        await system.waitTicks(2);
        const t = system.currentTick;
        if (agent.testSkipped) { ended = 'skipped'; break; }
        if ((t - t0) / 20 > ROUND_S) { ended = 'time'; break; }
        const hb = hpOf(sim), hh = hpOf(player);
        if (hb <= END_HP) { ended = 'you won'; break; }
        if (hh <= END_HP) { ended = 'the bot won'; break; }
        let me, you;
        try { me = sim.location; you = player.location; } catch { ended = 'gone'; break; }
        const d = dist(me, you);
        try { sim.lookAtEntity(player); } catch { /* */ }
        if (t >= nextStrafe) { strafe = -strafe; nextStrafe = t + 20 + Math.floor(Math.random() * 20); }
        // Close in, hold at sword range and circle; shield up between swings, down just before the next.
        const dx = (you.x - me.x) / (d || 1), dz = (you.z - me.z) / (d || 1);
        if (d > 3.2) agent.body.move(dx, dz, 1);
        else if (d < 1.8) agent.body.move(-dx, -dz, 1);
        else agent.body.move(-dz * strafe, dx * strafe, 0.8);
        const ready = t - lastHit >= every;
        agent.setBlocking(!ready && d < 5);
        if (ready && d <= 3.1) { try { sim.attackEntity(player); } catch { /* */ } lastHit = t; }
      }
      agent.setBlocking(false);
      agent.body.stop?.();
      const r = {
        weapon, ended,
        botHits: tally.bot.hits - before.bot.hits, botDmg: Math.round(tally.bot.dmg - before.bot.dmg),
        youHits: tally.human.hits - before.human.hits, youDmg: Math.round(tally.human.dmg - before.human.dmg),
      };
      rounds.push(r);
      agent.say(`${weapon.replace('_', ' ')}: ${r.ended}. You hit ${r.youHits} times (${r.youDmg} dmg), the bot ${r.botHits} (${r.botDmg} dmg).`);
      // The weapon back out of both packs.
      for (const [pack] of [[pk], [simPk]]) for (let i = 0; pack && i < pack.size; i++) { const it = pack.getItem(i); if (it?.typeId === `minecraft:${weapon}`) { pack.setItem(i, undefined); break; } }
      if (ended === 'skipped') break;
    }
  } finally {
    heal(player); heal(sim);
    try { eqP?.setEquipment(EquipmentSlot.Offhand, oldOff); } catch { /* */ }
    try { eqS?.setEquipment(EquipmentSlot.Offhand, undefined); agent.shield = false; } catch { /* */ }
    try { player.selectedSlotIndex = oldSlot; } catch { /* */ }
    agent.setBlocking(false);
    const sb = recBot.stop(), sh = recHuman.stop();
    for (const u of undo) { try { u(); } catch { /* */ } }
    const botWon = rounds.filter((r) => r.botDmg > r.youDmg).length, youWon = rounds.filter((r) => r.youDmg > r.botDmg).length;
    extraRuns.push({ who: 'human', summary: sh, trace: recHuman.trace(), pass: youWon >= botWon && rounds.length > 0 });
    extraRuns.push({ who: 'bot', summary: sb, trace: recBot.trace(), pass: botWon >= youWon && rounds.length > 0 });
  }
  const botWon = rounds.filter((r) => r.botDmg > r.youDmg).length, youWon = rounds.filter((r) => r.youDmg > r.botDmg).length;
  const engaged = rounds.length > 0 && rounds.every((r) => r.botHits > 0);
  return {
    pass: engaged,
    detail: `${rounds.length} rounds in ${secs()}s: you won ${youWon}, the bot ${botWon}; bot landed ${tally.bot.hits} hits (${Math.round(tally.bot.dmg)} dmg), you ${tally.human.hits} (${Math.round(tally.human.dmg)} dmg)${engaged ? '' : '; the bot did not land a hit in every round'}`,
  };
}
