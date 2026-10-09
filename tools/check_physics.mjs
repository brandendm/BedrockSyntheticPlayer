// Compare sim/params.js (player) with PrismarineJS prismarine-physics' vanilla Java constants.
//   MCDATA_DIR=<folder with node_modules/prismarine-physics and minecraft-data> node tools/check_physics.mjs
// A difference is a question, not an error: Bedrock is not Java, and sim/calibrate.mjs fits some of ours to the real game. Constants marked fit in params.js may move; the rest should match
// unless measured otherwise.
import { createRequire } from 'node:module';
import { PARAMS } from '../sim/params.js';
const req = createRequire((process.env.MCDATA_DIR ?? process.cwd()) + '/');
let src; try { const m = req('prismarine-physics'); src = typeof m === 'function' ? m : m.Physics ?? m.default; } catch { console.error('prismarine-physics not found: npm i --no-save prismarine-physics minecraft-data'); process.exit(2); }
const mc = req('minecraft-data')('1.20.4'); // (java data; prismarine-physics needs its attributes)
const phys = src(mc, {});
const P = PARAMS.player;
const rows = [
  ['gravity', P.gravity, phys.gravity], ['air drag (vertical)', P.drag, phys.airdrag], ['step height', P.step, phys.stepHeight], ['half width', P.halfWidth, phys.playerHalfWidth], ['height', P.height, phys.playerHeight],
  ['water drag', P.waterDrag, phys.waterInertia], ['water gravity', P.waterGravity, phys.waterGravity],
];
for (const [name, ours, theirs] of rows) console.log(`${Math.abs(ours - theirs) < 1e-3 ? 'ok ' : '?? '} ${name}: ours ${ours}, prismarine ${Number(theirs).toFixed(4)}`);
