// Inventory helpers for the SimulatedPlayer. Ids passed around without the "minecraft:" prefix.
import { ItemStack, EntityComponentTypes, EquipmentSlot, EnchantmentTypes } from '@minecraft/server';

const strip = (id) => id.replace('minecraft:', '');

export function container(sim) {
  return sim.getComponent(EntityComponentTypes.Inventory)?.container;
}

/** { itemId: count } */
export function invCounts(sim) {
  const c = container(sim);
  const out = {};
  if (!c) return out;
  for (let i = 0; i < c.size; i++) {
    const it = c.getItem(i);
    if (it) out[strip(it.typeId)] = (out[strip(it.typeId)] ?? 0) + it.amount;
  }
  return out;
}

export function findSlot(sim, id) {
  const c = container(sim);
  for (let i = 0; c && i < c.size; i++) {
    const it = c.getItem(i);
    if (it && strip(it.typeId) === id) return i;
  }
  return -1;
}

const isTool = (id) => /_(pickaxe|shovel|axe|sword|hoe|spear)$/.test(id);

/** Hold an item (moving it into the hotbar if needed), or null for a bare hand. Returns the slot. */
export function hold(sim, id) {
  const c = container(sim);
  if (!c) return -1;
  if (id) {
    let slot = findSlot(sim, id);
    if (slot < 0) return -1;
    if (slot >= 9) { c.swapItems(slot, 8, c); slot = 8; }
    sim.selectedSlotIndex = slot;
    return slot;
  }
  // Bare hand: an empty hotbar slot, else anything that isn't a tool.
  for (let i = 0; i < 9; i++) if (!c.getItem(i)) { sim.selectedSlotIndex = i; return i; }
  for (let i = 0; i < 9; i++) if (!isTool(strip(c.getItem(i).typeId))) { sim.selectedSlotIndex = i; return i; }
  return sim.selectedSlotIndex;
}

/** Remove n items with this exact id. */
export function take(sim, id, n) {
  const c = container(sim);
  for (let i = 0; c && i < c.size && n > 0; i++) {
    const it = c.getItem(i);
    if (!it || strip(it.typeId) !== id) continue;
    const k = Math.min(n, it.amount);
    n -= k;
    if (k === it.amount) c.setItem(i, undefined);
    else { it.amount -= k; c.setItem(i, it); }
  }
  if (n > 0) throw new Error(`inventory short of ${id}`);
}

export function give(sim, id, n) {
  const c = container(sim);
  // (u231 live: an ItemStack of more than a stack's worth is refused by the game (370 dirt at once): a stack at a time)
  let max = 64;
  try { max = new ItemStack(`minecraft:${id}`, 1).maxAmount || 64; } catch (e) { throw e; }
  for (let left = n; left > 0; left -= max) {
    const rest = c?.addItem(new ItemStack(`minecraft:${id}`, Math.min(max, left)));
    if (rest) sim.dimension.spawnItem(rest, sim.location); // full inventory: drop it, like the game does
  }
}

/** Uses left in all the tools matching `pred` we carry (their durability, minus the wear). */
export function usesLeft(sim, pred) {
  const c = container(sim);
  let n = 0;
  for (let i = 0; c && i < c.size; i++) {
    const it = c.getItem(i);
    if (!it || !pred(strip(it.typeId))) continue;
    try {
      const d = it.getComponent('minecraft:durability');
      n += d ? d.maxDurability - d.damage : 1;
    } catch { n += 1; }
  }
  return n;
}

// ---------- the kit, kept in the world ----------
// A simulated player leaves with the world (closing it, the server stopping) and comes back empty.
// What it carries and wears is written to the world's memory and put back when it's spawned again.

const WORN = ['Head', 'Chest', 'Legs', 'Feet', 'Offhand'];

/** One stack as plain data: id, count, wear, enchantments, name. */
function itemData(it) {
  const d = { id: it.typeId, n: it.amount };
  try { const dur = it.getComponent('minecraft:durability'); if (dur?.damage) d.dmg = dur.damage; } catch {}
  try {
    const en = it.getComponent('minecraft:enchantable')?.getEnchantments() ?? [];
    if (en.length) d.en = en.map((e) => [e.type.id, e.level]);
  } catch {}
  if (it.nameTag) d.name = it.nameTag;
  return d;
}

function itemFrom(d) {
  const it = new ItemStack(d.id, d.n);
  try { if (d.dmg) { const dur = it.getComponent('minecraft:durability'); if (dur) dur.damage = d.dmg; } } catch {}
  try {
    // (one at a time: a single enchantment the item will not take used to throw away the whole list)
    const ench = it.getComponent('minecraft:enchantable');
    for (const [id, level] of d.en ?? []) { try { const type = EnchantmentTypes.get(id); if (type) ench?.addEnchantment({ type, level }); } catch { /* not for this item */ } }
  } catch {}
  if (d.name) it.nameTag = d.name;
  return it;
}

/** { slots: [[slot, item], ...], worn: { Head: item, ... } } */
export function kitOf(sim) {
  const c = container(sim), slots = [], worn = {};
  for (let i = 0; c && i < c.size; i++) { const it = c.getItem(i); if (it) slots.push([i, itemData(it)]); }
  const eq = sim.getComponent('minecraft:equippable');
  for (const k of WORN) { try { const it = eq?.getEquipment(EquipmentSlot[k]); if (it) worn[k] = itemData(it); } catch {} }
  return { slots, worn };
}

/** Nothing in the pack and nothing worn: a fresh spawn. */
export function emptyHanded(sim) {
  const k = kitOf(sim);
  return !k.slots.length && !Object.keys(k.worn).length;
}

/** Put a saved kit back on. Returns how many stacks went back. */
export function restoreKit(sim, kit) {
  const c = container(sim), eq = sim.getComponent('minecraft:equippable');
  let n = 0;
  for (const [slot, d] of kit.slots ?? []) {
    try { const it = itemFrom(d); if (c && !c.getItem(slot)) c.setItem(slot, it); else c?.addItem(it); n++; } catch (e) { console.warn(`[agent] kit: ${d.id}: ${e}`); }
  }
  for (const [k, d] of Object.entries(kit.worn ?? {})) {
    try { eq?.setEquipment(EquipmentSlot[k], itemFrom(d)); n++; } catch (e) { console.warn(`[agent] kit: ${d.id} (${k}): ${e}`); }
  }
  return n;
}
