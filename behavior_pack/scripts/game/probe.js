// Debug: `scriptevent agent:cmd probe` - which door orientation opens across the way we walk.
import { system, Direction, ItemStack } from '@minecraft/server';
import { sendEvent, trace } from './bridge.js';
import { CONFIG } from '../config.js';

const log = (m) => console.warn(`[probe] ${m}`);

export async function probe(agent) {
  const sim = agent.sim, dim = sim.dimension;
  const f = { x: Math.floor(sim.location.x), y: Math.floor(sim.location.y), z: Math.floor(sim.location.z) };
  const cmd = (c) => { try { dim.runCommand(c); } catch (e) { log(`${c}: ${e}`); } };
  cmd(`fill ${f.x - 6} ${f.y - 1} ${f.z - 6} ${f.x + 6} ${f.y - 1} ${f.z + 6} stone`);
  cmd(`fill ${f.x - 6} ${f.y} ${f.z - 6} ${f.x + 6} ${f.y + 3} ${f.z + 6} air`);
  const walk = { south: [0, 1], east: [1, 0] };
  for (const [wname, [dx, dz]] of Object.entries(walk)) {
    for (const card of ['north', 'south', 'east', 'west']) {
      const door = { x: f.x + dx * 2, y: f.y, z: f.z + dz * 2 };
      const px = dz !== 0 ? 1 : 0, pz = dx !== 0 ? 1 : 0;
      cmd(`fill ${door.x - px * 2} ${f.y} ${door.z - pz * 2} ${door.x + px * 2} ${f.y + 2} ${door.z + pz * 2} planks`);
      cmd(`setblock ${door.x} ${door.y + 1} ${door.z} air`); cmd(`setblock ${door.x} ${door.y} ${door.z} air`);
      cmd(`setblock ${door.x} ${door.y} ${door.z} wooden_door ["minecraft:cardinal_direction"="${card}"]`);
      const go = async () => {
        sim.teleport({ x: f.x + 0.5, y: f.y, z: f.z + 0.5 }); await system.waitTicks(5);
        const r = await agent.motor.followPath([{ x: f.x + 0.5, y: f.y, z: f.z + 0.5 }, { x: door.x + 0.5, y: f.y, z: door.z + 0.5 }, { x: f.x + dx * 4 + 0.5, y: f.y, z: f.z + dz * 4 + 0.5 }]);
        return r.status;
      };
      const closed = await go();
      sim.teleport({ x: f.x + 0.5, y: f.y, z: f.z + 0.5 }); await system.waitTicks(3);
      sim.interactWithBlock(door, Direction.Up); await system.waitTicks(4);
      const open = await go();
      log(`walk ${wname}, door ${card}: closed -> ${closed}, open -> ${open}`);
      cmd(`fill ${door.x - px * 2} ${f.y} ${door.z - pz * 2} ${door.x + px * 2} ${f.y + 2} ${door.z + pz * 2} air`);
    }
  }
  log('done');
}

/**
 * `!bot probe api`: try each game call the bot leans on, once, on a flat cleared patch, and write down what the game
 * answered (to the chat, the trace and brain/logs/events.jsonl as `probe`). Facts instead of guesses: whether a
 * component exists, what an item use returns, what a lead's limits are, whether a simulated player can ride.
 * Everything it spawns or places is removed again.
 */
export async function probeApis(agent) {
  const sim = agent.sim, dim = sim.dimension;
  const out = [];
  const cleanup = [];
  const note = (k, v) => out.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const tryCall = (k, fn) => { try { note(k, fn()); } catch (e) { note(k, `THREW ${e}`); } };
  const f = { x: Math.floor(sim.location.x), y: Math.floor(sim.location.y), z: Math.floor(sim.location.z) };
  const cmd = (c) => { try { dim.runCommand(c); return true; } catch { return false; } };
  try {
    // The simulated player itself.
    for (const m of ['navigateToLocation', 'moveToLocation', 'stopMoving', 'useItemInSlotOnBlock', 'useItemOnBlock', 'interactWithBlock', 'interactWithEntity', 'attack', 'jump', 'lookAtBlock', 'lookAtEntity', 'respawn', 'disconnect']) note(`sim.${m}`, typeof sim[m]);
    tryCall('sim riding component', () => !!sim.getComponent('minecraft:riding'));
    tryCall('sim equippable component', () => !!sim.getComponent('minecraft:equippable'));
    tryCall('dimension.getSkyLightLevel', () => dim.getSkyLightLevel({ x: f.x, y: f.y + 1, z: f.z }));
    tryCall('dimension.calculateClosestBiomeFromSeed', () => typeof dim.calculateClosestBiomeFromSeed);
    // A flat patch to work on.
    cmd(`fill ${f.x - 4} ${f.y - 1} ${f.z - 4} ${f.x + 8} ${f.y - 1} ${f.z + 4} grass_block`);
    cmd(`fill ${f.x - 4} ${f.y} ${f.z - 4} ${f.x + 8} ${f.y + 4} ${f.z + 4} air`);
    // A horse: which components are there, the lead limits of a boat.
    const horse = dim.spawnEntity('minecraft:horse', { x: f.x + 4.5, y: f.y, z: f.z + 0.5 });
    cleanup.push(() => { try { horse.remove(); } catch {} });
    await system.waitTicks(10);
    for (const c of ['minecraft:is_tamed', 'minecraft:tamemount', 'minecraft:rideable', 'minecraft:inventory', 'minecraft:leashable', 'minecraft:health', 'minecraft:movement']) tryCall(`horse ${c}`, () => horse.hasComponent(c));
    tryCall('horse tamemount methods', () => { const t = horse.getComponent('minecraft:tamemount'); return t ? Object.getOwnPropertyNames(Object.getPrototypeOf(t)).filter((n) => n !== 'constructor') : null; });
    tryCall('horse rideable', () => { const r = horse.getComponent('minecraft:rideable'); return r ? { seats: r.seatCount, riders: r.getRiders().length, family: r.family?.length ?? 0, interact: r.crouchingSkipInteract } : null; });
    const boat = dim.spawnEntity('minecraft:boat', { x: f.x + 1.5, y: f.y, z: f.z + 3.5 });
    cleanup.push(() => { try { boat.remove(); } catch {} });
    await system.waitTicks(10);
    tryCall('boat leashable', () => { const l = boat.getComponent('minecraft:leashable'); return l ? { soft: l.softDistance, hard: l.hardDistance, max: l.maxDistance, leashed: l.isLeashed } : null; });
    // Items: what a use returns, with and without something to use on.
    const c = sim.getComponent('minecraft:inventory')?.container;
    if (c) {
      const slot = 8, before = c.getItem(slot);
      try { c.setItem(slot, new ItemStack('minecraft:flint_and_steel', 1)); sim.selectedSlotIndex = slot; } catch (e) { note('give flint', `THREW ${e}`); }
      cmd(`setblock ${f.x + 1} ${f.y} ${f.z} obsidian`);
      tryCall('flint and steel on obsidian top (useItemInSlotOnBlock)', () => String(sim.useItemInSlotOnBlock(slot, { x: f.x + 1, y: f.y, z: f.z }, Direction.Up, { x: 0.5, y: 1, z: 0.5 })));
      await system.waitTicks(12);
      note('block above the obsidian after', dim.getBlock({ x: f.x + 1, y: f.y + 1, z: f.z })?.typeId ?? '?');
      cmd(`setblock ${f.x + 1} ${f.y + 1} ${f.z} air`);
      cmd(`setblock ${f.x + 1} ${f.y} ${f.z} air`);
      try { c.setItem(slot, before); } catch { /* */ }
    }
    tryCall('ride command', () => { dim.runCommand('ride @e[type=horse,c=1] summon_rider'); return 'accepted'; });
  } catch (e) {
    note('probe stopped', `${e}`);
  } finally {
    for (const fn of cleanup) fn();
    cmd(`fill ${f.x - 4} ${f.y - 1} ${f.z - 4} ${f.x + 8} ${f.y + 4} ${f.z + 4} air`);
  }
  for (const l of out) { console.warn(`[probe] ${l}`); trace(`probe ${l}`); }
  sendEvent({ type: 'probe', build: CONFIG.build, results: out }).catch(() => {});
  return out;
}
