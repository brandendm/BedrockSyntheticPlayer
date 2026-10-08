// A real-game failure, replayed in the simulator.   node sim/replay_capsule.mjs <capsules.json> [index] [--timeline] [--secs N]
// Takes a repro capsule (brain/inbox/capsules.json: the blocks round the bot, where it and the boat were, where the tow was heading),
// builds that place in the sim, puts the bot and boat where they were at the START of the capsule, and runs the bot's real tow code on it.
// If the sim fails the same way, the failure is now a thing to fix offline (and to minimize by hand); if it does not, the difference between
// the two is the sim's error, which is worth knowing too. (The learned memory of that world is not in the capsule: run with LEARNED='{...}' to add one.)
import fs from 'node:fs';
import { runTow } from './run_tow.mjs';
import { decodeSlice } from '../behavior_pack/scripts/core/capsule.js';
import { timelineText } from './report.mjs';

export function capsuleCourse(c) {
  const get = decodeSlice(c.slice), { box } = c.slice, cmds = [];
  for (let x = box.x1; x <= box.x2; x++) for (let z = box.z1; z <= box.z2; z++) {
    let run = null;
    const flush = (y) => { if (run) cmds.push(`fill ${x} ${run.y} ${z} ${x} ${y - 1} ${z} ${run.id}`); run = null; };
    for (let y = box.y1; y <= box.y2 + 1; y++) {
      const id = y <= box.y2 ? (get(x, y, z) ?? 'air') : 'air';
      if (run && run.id === id) continue;
      flush(y); if (id !== 'air' && id !== 'cave_air') run = { y, id };
    }
  }
  const first = c.samples.find((s) => s.p && s.boat) ?? c.samples[0];
  const goal = c.watch?.goal;
  if (!first || !goal) throw new Error('the capsule has no bot/boat sample or no tow goal (it was not taken during a tow)');
  const boatE = c.entities.find((e) => /boat/.test(e.type));
  return {
    cmds, noSlab: true, ext: { w: 0, e: 0, r: 0 },
    start: { x: first.p[0], y: first.p[1], z: first.p[2] },
    boat: { x: first.boat[0], y: first.boat[1], z: first.boat[2] },
    goal: { x: goal[0], y: goal[1], z: goal[2] }, zone: 3.6, room: 2.5,
    desc: `capsule "${c.why}" (build ${c.build}, ${boatE ? 'boat seen' : 'no boat entity'})`,
  };
}
if ((process.argv[1] ?? '').endsWith('replay_capsule.mjs')) {
  const [file, idx] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const all = JSON.parse(fs.readFileSync(file, 'utf8')), c = Array.isArray(all) ? all[Number(idx ?? 0)] : all;
  const si = process.argv.indexOf('--secs');
  const C = capsuleCourse(c);
  console.log(C.desc);
  const r = await runTow('capsule', { course: () => C, maxS: si > 0 ? Number(process.argv[si + 1]) : 90 });
  console.log(timelineText(r, { every: 2 }));
}
