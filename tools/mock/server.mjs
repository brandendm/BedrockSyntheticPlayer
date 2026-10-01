// A stand-in for @minecraft/server, enough to run game/ code (homestead's furnace jobs, the world
// memory, the inventory helpers) outside the game: tools/sim_furnace.mjs. Loaded in place of the
// real module by tools/mock/hooks.mjs.
const props = new Map();
const timeouts = [];
export const system = {
  currentTick: 0,
  runTimeout(fn, ticks = 1) { timeouts.push({ at: this.currentTick + ticks, fn }); return timeouts.length; },
  run(fn) { return this.runTimeout(fn, 1); },
  runInterval() { return 0; },
  clearRun() {},
  /** The sim's clock: n ticks on, running what fell due. */
  advance(n = 1) {
    for (let i = 0; i < n; i++) {
      this.currentTick++;
      for (let k = timeouts.length - 1; k >= 0; k--) if (timeouts[k].at <= this.currentTick) { const t = timeouts.splice(k, 1)[0]; t.fn(); }
      for (const f of tickers) f(this.currentTick);
    }
  },
  /** A server restart: the tick count starts again from 0. */
  restart() { this.currentTick = 0; timeouts.length = 0; },
};
const tickers = [];
export const onTick = (f) => tickers.push(f);
export const world = {
  getDynamicProperty: (k) => props.get(k),
  setDynamicProperty: (k, v) => props.set(k, v),
  getTimeOfDay: () => 6000,
  afterEvents: {}, beforeEvents: {},
};
export class ItemStack {
  constructor(typeId, amount = 1) { this.typeId = typeId.startsWith('minecraft:') ? typeId : `minecraft:${typeId}`; this.amount = amount; this.maxAmount = 64; }
  getComponent() { return undefined; }
  clone() { return new ItemStack(this.typeId, this.amount); }
}
export class Container {
  constructor(size) { this.size = size; this.slots = new Array(size).fill(undefined); }
  getItem(i) { const it = this.slots[i]; return it ? it.clone() : undefined; } // (a copy, like the game)
  setItem(i, it) { this.slots[i] = it ? it.clone() : undefined; }
  addItem(it) {
    let left = it.amount;
    for (let i = 0; i < this.size && left > 0; i++) {
      const s = this.slots[i];
      if (s && s.typeId === it.typeId && s.amount < 64) { const k = Math.min(64 - s.amount, left); s.amount += k; left -= k; }
    }
    for (let i = 0; i < this.size && left > 0; i++) if (!this.slots[i]) { const k = Math.min(64, left); this.slots[i] = new ItemStack(it.typeId, k); left -= k; }
    return left > 0 ? new ItemStack(it.typeId, left) : undefined;
  }
  /** Move slot i's stack into `other`; what didn't fit is returned (and stays here). */
  transferItem(i, other) {
    const it = this.slots[i];
    if (!it) return undefined;
    const left = other.addItem(it.clone());
    this.slots[i] = left ?? undefined;
    return left;
  }
}
export const Direction = { Up: 'Up', Down: 'Down', North: 'North', South: 'South', East: 'East', West: 'West' };
export const EntityComponentTypes = { Inventory: 'minecraft:inventory', Equippable: 'minecraft:equippable' };
export const EquipmentSlot = { Head: 'Head', Chest: 'Chest', Legs: 'Legs', Feet: 'Feet', Offhand: 'Offhand', Mainhand: 'Mainhand' };
export const EnchantmentTypes = { get: () => undefined };
export const BlockPermutation = { resolve: (id) => ({ type: { id } }) };
export const BlockTypes = { get: (id) => ({ id }) };
export const ItemTypes = { get: (id) => ({ id }) };
export class BlockVolume { constructor(from, to) { this.from = from; this.to = to; } }
