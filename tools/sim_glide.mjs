// The elytra planner (core/glide.js planGlide) flown against a model of the game: the owner's test (off a 22-high tower, 50 blocks from the
// landing spot), with the view lagging the command as the motor's spring does, and with the model's constants knocked off (more drag, a pitch
// that comes out a few degrees off the command, gravity). What it prints: seconds in the air, how far from the spot it touched down, the sink at
// the ground (6 b/s or more would hurt). No game involved.
//   node tools/sim_glide.mjs [--d 50] [--h 22] [--omega 11] [--log]
import { GLIDE, glideTick, planGlide, followPitch } from '../behavior_pack/scripts/core/glide.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };

/** The "game": the same step with its own constants. world: { dragX, dragY, g, pitchBias }. */
function plantTick(vx, vy, pitch, w) {
  const r = ((pitch + (w.pitchBias ?? 0)) * Math.PI) / 180, c2 = Math.cos(r) ** 2, g = w.g ?? GLIDE.g;
  let x = vx, y = vy + g * (-1 + c2 * 0.75);
  if (y < 0) { const d = y * -0.1 * c2; x += d; y += d; }
  if (r < 0) { const d = Math.abs(vx) * Math.sin(-r) * 0.04; x -= d; y += d * 3.2; }
  return [x * (w.dragX ?? GLIDE.dragX), y * (w.dragY ?? GLIDE.dragY)];
}

export function flight({ d = 50, h = 22, world = {}, start = { vx: 0.28, vy: -0.1 }, x0 = 1.5, plan = {}, omega = 11, lag = 3, aim = 1.5 } = {}) {
  let vx = start.vx, vy = start.vy, H = h, X = x0, t = 0, pitch = 0, rate = 0;
  const log = [];
  while (H > 0 && t < 600) {
    const r = planGlide({ h: H, d: d - X, vx, vy }, { aim, lag, ...plan });
    [pitch, rate] = followPitch(pitch, rate, r.pitch, omega);     // the view follows the command with a lag
    [vx, vy] = plantTick(vx, vy, pitch, world);
    H += vy; X += vx; t++;
    log.push(`${t} ${r.mode} cmd${r.pitch.toFixed(0)} view${pitch.toFixed(0)} x${X.toFixed(1)} h${H.toFixed(1)} vx${(vx * 20).toFixed(1)} vy${(vy * 20).toFixed(1)} pred${r.land.toFixed(1)}`);
  }
  const f = vy < 0 ? Math.max(0, Math.min(1, (H - vy) / -vy)) : 1;   // (the last step overshot the ground by H below it)
  return { ticks: t, x: X - vx * (1 - f), miss: X - vx * (1 - f) - d, vy: vy * 20, vx: vx * 20, log };
}

if (process.argv[1]?.endsWith('sim_glide.mjs')) {
  const d = opt('d', 50), h = opt('h', 22), omega = opt('omega', 11);
  const worlds = [['as modelled', {}], ['more drag (0.980)', { dragX: 0.980 }], ['less drag (0.989)', { dragX: 0.989 }], ['pitch 3 deg off (+)', { pitchBias: 3 }], ['pitch 3 deg off (-)', { pitchBias: -3 }],
    ['pitch 6 deg off (+)', { pitchBias: 6 }], ['gravity +4%', { g: 0.0832 }], ['gravity -4%', { g: 0.0768 }], ['sink drag 0.972', { dragY: 0.972 }]];
  for (const [name, world] of worlds) {
    const r = flight({ d, h, world, omega });
    console.log(`${name.padEnd(24)} ${(r.ticks / 20).toFixed(2)} s  touchdown ${r.miss >= 0 ? '+' : ''}${r.miss.toFixed(1)} from the spot  sink ${(-r.vy).toFixed(1)} b/s  at ${r.vx.toFixed(1)} b/s`);
  }
  if (args.includes('--log')) console.log(flight({ d, h, omega }).log.join('\n'));
}
