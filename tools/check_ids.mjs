// Check the id strings in our tables against PrismarineJS minecraft-data (Bedrock): an id that is not real never matches anything, and nothing says so.
//   MCDATA_DIR=<folder with node_modules/minecraft-data> node tools/check_ids.mjs [bedrock_1.21.60]
// Checked: MOBS, SLOT_SAFE (entities); WEAPON_DAMAGE, RECIPES, TOOL_STONE, STONE_TARGETS, SHOVEL_BLOCKS (items/blocks); every id-looking quoted string in costs.js's patterns that names a block exactly.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { MOBS, WEAPON_DAMAGE, SLOT_SAFE } from '../behavior_pack/scripts/core/threat.js';
import { RECIPES, TOOL_STONE, STONE_TARGETS, SHOVEL_BLOCKS } from '../behavior_pack/scripts/core/recipes.js';
const req = createRequire((process.env.MCDATA_DIR ?? process.cwd()) + '/');
let mc; try { mc = req('minecraft-data'); } catch { console.error('minecraft-data not found: npm i --no-save minecraft-data (or set MCDATA_DIR)'); process.exit(2); }
const d = mc(process.argv[2] ?? 'bedrock_1.21.60');
const blocks = new Set(d.blocksArray.map((b) => b.name)), items = new Set(d.itemsArray.map((i) => i.name)), ents = new Set(d.entitiesArray.map((e) => e.name));
const any = (n) => blocks.has(n) || items.has(n);
let bad = 0;
const report = (what, names, ok) => { const miss = [...names].filter((n) => !ok(n)); bad += miss.length; console.log(`${miss.length ? '!!' : 'ok'} ${what}: ${names.size ?? names.length} ids${miss.length ? `; not in the data: ${miss.join(', ')}` : ''}`); };
report('MOBS', new Set(Object.keys(MOBS)), (n) => ents.has(n));
report('SLOT_SAFE', SLOT_SAFE, (n) => ents.has(n));
report('WEAPON_DAMAGE', new Set(Object.keys(WEAPON_DAMAGE)), any);
report('RECIPES outputs', new Set(Object.keys(RECIPES).filter((n) => !['planks'].includes(n))), any);
report('TOOL_STONE', TOOL_STONE, any);
report('STONE_TARGETS', STONE_TARGETS, any);
report('SHOVEL_BLOCKS', SHOVEL_BLOCKS, any);
// the exact names inside costs.js's alternations (^(a|b|c)$): each must be a real block
const src = fs.readFileSync(new URL('../behavior_pack/scripts/core/costs.js', import.meta.url), 'utf8');
const names = new Set();
for (const m of src.matchAll(/\/\^\(([a-z_|]+)\)\$\//g)) for (const n of m[1].split('|')) names.add(n);
report('costs.js exact block names', names, (n) => blocks.has(n));
console.log(`\n${bad} id(s) to look at`);
