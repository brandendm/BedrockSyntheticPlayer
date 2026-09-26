// Debug: `scriptevent agent:cmd probe` - which door orientation opens across the way we walk.
import { system, Direction } from '@minecraft/server';

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
