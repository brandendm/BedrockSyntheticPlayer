import { readdirSync } from 'node:fs';
// Holds core/recipes.js to Mojang's recipes (bedrock-samples): output count, ingredient count and 2x2-vs-3x3 for each of ours.
//   node tools/check_vanilla.mjs <bedrock-samples dir>
import { readJ } from './lenient_json.mjs';
const dir = `${process.argv[2]}/behavior_pack/recipes`;
const by = {};
for (const f of readdirSync(dir)) {
  let j; try { j = readJ(`${dir}/${f}`); } catch { continue; }
  const sh = j['minecraft:recipe_shaped'], sl = j['minecraft:recipe_shapeless'];
  const r = sh ?? sl; if (!r) continue;
  const res = Array.isArray(r.result) ? r.result[0] : r.result; const item = (res.item ?? res).toString().replace('minecraft:', ''); const count = res.count ?? 1;
  let total = 0, w = 0, h = 0, kinds = {};
  if (sh) { h = sh.pattern.length; w = Math.max(...sh.pattern.map((x) => x.length)); for (const ch of sh.pattern.join('')) if (ch !== ' ' && ch !== '#' || (ch === '#' && sh.key['#'])) { const k = sh.key[ch]; if (!k) continue; total++; const n = (k.item ?? k.tag ?? '').replace('minecraft:', ''); kinds[n] = (kinds[n] ?? 0) + 1; } }
  else { for (const ing of sl.ingredients) { const c = ing.count ?? 1; total += c; const n = (ing.item ?? ing.tag ?? '').replace('minecraft:', ''); kinds[n] = (kinds[n] ?? 0) + c; } }
  (by[item] ??= []).push({ id: r.description.identifier, count, total, table: sh ? (w > 2 || h > 2) : total > 4, kinds });
}
const { RECIPES } = await import('../behavior_pack/scripts/core/recipes.js');
for (const [k, r] of Object.entries(RECIPES)) {
  const outs = by[k] ?? by[k.replace(/^planks$/, 'oak_planks')] ?? [];
  const ours = r.inputs.reduce((a, i) => a + i.n, 0);
  if (!outs.length) { console.log(`${k.padEnd(18)} NOT IN VANILLA recipes (ours: out ${r.out}, ${ours} items)`); continue; }
  const ok = outs.some((o) => o.count === r.out && o.total === ours && o.table === r.table);
  if (!ok) console.log(`${k.padEnd(18)} DIFFERS ours out ${r.out} in ${ours} table ${r.table} | vanilla ${outs.slice(0, 3).map((o) => `${o.id}: out ${o.count} in ${o.total} table ${o.table} ${JSON.stringify(o.kinds)}`).join(' ; ')}`);
}
console.log('checked', Object.keys(RECIPES).length, 'recipes');
