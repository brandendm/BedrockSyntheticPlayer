// Breaking a fall with the water bucket (core/fall.js), against Minecraft's fall physics: drops of
// 4-120 blocks, walking off an edge or jumping off, the bot seeing where it is a tick late (the
// script reads last tick's position), for a few reaches. Counts falls where the water went down in
// reach before we hit the ground, and the damage it saved.
//
//   node tools/sim_fall.mjs
import { mlgNow, fallDamage } from '../behavior_pack/scripts/core/fall.js';

function drop(h, { jump = false, reach = 5, late = 1, lead = 0 } = {}) {
  const groundY = 0;
  let y = h, vy = jump ? 0.42 : 0, fallFrom = h, placedAt = null, seen = [];
  for (let t = 0; t < 400; t++) {
    seen.push({ y, vy });
    // What the script sees this tick: `late` ticks ago.
    const s = seen[Math.max(0, seen.length - 1 - late)];
    fallFrom = Math.max(fallFrom, s.y);
    if (placedAt === null && s.vy < -0.3) {
      const m = mlgNow({ fallFrom, y: s.y, vy: s.vy, groundY, health: 20, reach, lead });
      // The water goes on the block's top face; the hand can only get there within reach of where
      // we really are now.
      if (m.place) placedAt = { t, d: y - groundY, ok: y - groundY >= 0 && y - groundY + 1.62 <= reach + 0.5 };
    }
    const ny = y + vy;
    vy = (vy - 0.08) * 0.98;
    if (ny <= groundY) {
      const damage = fallDamage(fallFrom - groundY);
      const saved = placedAt?.ok ? damage : 0;
      return { damage, saved, placed: !!placedAt, ok: !!placedAt?.ok, d: placedAt?.d };
    }
    y = ny;
  }
  return null;
}

const heights = [4, 5, 6, 8, 10, 15, 20, 30, 45, 60, 90, 120];
const reach = 5;
for (const lead of [0, 1]) {
  for (const late of [0, 1]) {
    let ok = 0, damage = 0, saved = 0, tried = 0, farthest = 0;
    const misses = [];
    for (const h of heights) for (const jump of [false, true]) for (let off = 0; off < 1; off += 0.1) {
      const r = drop(h + off, { jump, reach, late, lead });
      if (!r) continue;
      damage += r.damage; saved += r.saved;
      if (r.damage >= 3) { tried++; if (r.ok) { ok++; farthest = Math.max(farthest, r.d + 1.62); } else misses.push(`${(h + off).toFixed(1)}${jump ? 'j' : ''}`); }
    }
    console.log(`projecting ${lead} tick${lead === 1 ? '' : 's'} ahead, the reading really ${late} tick${late === 1 ? '' : 's'} late: ${ok}/${tried} falls broken (${(100 * ok / tried).toFixed(0)}%), ${saved}/${damage} damage saved, placed from up to ${farthest.toFixed(1)} away${misses.length ? `; missed ${misses.slice(0, 6).join(' ')}${misses.length > 6 ? ' ...' : ''}` : ''}`);
  }
}
