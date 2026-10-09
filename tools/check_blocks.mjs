// Check core/costs.js (block hardness, which tool a block wants) against PrismarineJS minecraft-data (Bedrock blocks).
//   npm i --no-save minecraft-data   (or set MCDATA_DIR to a folder that has node_modules/minecraft-data)
//   node tools/check_blocks.mjs [bedrock_1.21.60]
// Prints every block whose table hardness differs from the data's, which tool the data says it wants where ours differs, and how many diggable blocks fall through
// to the default hardness of 1 (the ones we have never typed in; the list is the 25 most common-looking: no ores/stone-like words missing).
import { createRequire } from 'node:module';
import { hardness, toolKindFor } from '../behavior_pack/scripts/core/costs.js';
const req = createRequire((process.env.MCDATA_DIR ?? process.cwd()) + '/');
let mc;
try { mc = req('minecraft-data'); } catch { console.error('minecraft-data not found: npm i --no-save minecraft-data (or set MCDATA_DIR)'); process.exit(2); }
const ver = process.argv[2] ?? 'bedrock_1.21.60';
const d = mc(ver);
if (!d) { console.error(`no data for ${ver}`); process.exit(2); }
const kindOf = (b) => { const m = /mineable\/(\w+)/.exec(b.material ?? ''); return m ? m[1] : null; };
const bad = [], tool = [], dflt = [];
for (const b of d.blocksArray) {
  if (!b.diggable || b.hardness == null || b.hardness < 0) continue;
  const mine = hardness(b.name);
  const typed = mine !== 1 || b.hardness === 1;
  if (!typed) { dflt.push(`${b.name}(${b.hardness})`); continue; }
  if (Math.abs(mine - b.hardness) > 1e-6) bad.push(`${b.name}: table ${mine}, data ${b.hardness}`);
  const k = kindOf(b), ours = toolKindFor(b.name);
  if (k && ['pickaxe', 'axe', 'shovel'].includes(k) && ours && ours !== k) tool.push(`${b.name}: table ${ours}, data ${k}`);
}
console.log(`${ver}: ${d.blocksArray.length} blocks`);
console.log(`\nhardness differs (${bad.length}):\n  ${bad.join('\n  ') || 'none'}`);
console.log(`\ntool differs (${tool.length}):\n  ${tool.join('\n  ') || 'none'}`);
const wrongDefault = dflt.filter((s) => !/\(1\)$/.test(s));
console.log(`\nfall through to the default of 1 but are not 1 (${wrongDefault.length}):\n  ${wrongDefault.slice(0, 80).join(', ')}${wrongDefault.length > 80 ? ', ...' : ''}`);
