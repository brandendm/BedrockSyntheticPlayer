// Watching you play. `!bot learn on [name]` records one player (you): a sample every second (where,
// health, food, what's in hand, sprinting, sneaking) and, as they happen, what you break and place,
// what hurts you, what you hit and kill, what you eat, when you die. It goes to the brain in batches
// (brain/logs/demos/), which works your habits out of it (brain/learn.py). Nothing is sent anywhere
// else, and nothing is recorded unless you switch it on.
import { system, world, ItemStack } from '@minecraft/server';
import { sendEvent } from './bridge.js';
import { CONFIG } from '../config.js';
import { container, kitOf, restoreKit } from './inventory.js';
import { HOUSE_KIT, boxOf, buildPlan, describe, setPlan } from '../core/learnhouse.js';

const PLAN_KEY = 'agent:houseplan';

const FLUSH_EVERY = 200;   // ticks
const KEEP_ROWS = 3000;    // while the brain isn't reachable

const nm = (id) => String(id ?? '').replace(/^minecraft:/, '');

export class Demo {
  constructor(agent) {
    this.a = agent;
    this.name = null;
    this.session = null;
    this.buf = [];
    this.sent = 0;
    this.t0 = 0;
    this.mode = null;        // 'house': recording a house build (see startHouse)
    this.placed = new Map(); // house mode: "x,y,z" -> id, what the player has placed and not broken
    this.firstDoor = null;
    this.stash = null;       // house mode: the player's own stacks, exactly as they were (restored by stopHouse)
    this.finishing = false;
    try { const raw = world.getDynamicProperty(PLAN_KEY); if (typeof raw === 'string') setPlan(JSON.parse(raw)); } catch { /* none learned */ }
  }

  get on() { return !!this.name; }
  player() { return this.name ? world.getPlayers().find((p) => p.name === this.name) : null; }

  start(name, mode = null) {
    this.name = name;
    this.mode = mode;
    this.placed = new Map();
    this.firstDoor = null;
    this.session = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.t0 = system.currentTick;
    this.buf = [];
    this.sent = 0;
    this.row({ k: 'start', build: CONFIG.build });
    this.flush();
  }

  stop() {
    if (!this.name) return;
    this.row({ k: 'stop' });
    this.flush();
    const house = this.mode === 'house';
    const name = this.name;
    this.name = null;
    if (house) this.finishHouse(name).catch((e) => { this.a.say(`House learning failed: ${e}`); console.warn(`[agent] learn house: ${e}\n${e.stack}`); });
    this.mode = null;
  }

  // ---------- learning the house you build ----------

  /**
   * `!bot learn house`: your inventory is put aside (every stack exactly as it is, and written to the
   * world memory in case the server restarts), you're given what a house takes (core/learnhouse.js
   * HOUSE_KIT), and the recording starts. `learn off` reads the house you built, and puts your things back.
   * Returns a line for the chat.
   */
  startHouse(pl) {
    const mem = this.a.memory;
    if (mem.data.learnKit) return `Your things from last time are still put aside (${mem.data.learnKit.name}): \`!bot learn restore\` first.`;
    const c = container(pl);
    if (!c) return 'Can\'t reach your inventory.';
    const exact = [];
    for (let i = 0; i < c.size; i++) { const it = c.getItem(i); if (it) exact.push([i, it]); }
    mem.data.learnKit = { name: pl.name, slots: kitOf(pl).slots, at: Date.now() };
    mem.saveNow();
    this.stash = { name: pl.name, exact };
    for (let i = 0; i < c.size; i++) c.setItem(i, undefined);
    for (const [id, n] of HOUSE_KIT) { try { c.addItem(new ItemStack(`minecraft:${id}`, n)); } catch (e) { console.warn(`[agent] learn kit ${id}: ${e}`); } }
    this.start(pl.name, 'house');
    return `Watching you build a house. Your own things are put aside (they come back when you type \`!bot learn off\`) and you have everything a house takes: cobblestone, planks, a door, a bed, a crafting table, furnaces, chests, torches, glass, a few tools. Build it however you like, with a door, a bed, a table, a furnace and a chest inside, then \`!bot learn off\`.`;
  }

  /** Put the player's own things back (after a house recording, or `!bot learn restore`). True if there was something to restore. */
  restoreFor(pl) {
    const mem = this.a.memory, saved = mem.data.learnKit;
    if (!saved || saved.name !== pl.name) return false;
    const c = container(pl);
    if (!c) return false;
    for (let i = 0; i < c.size; i++) c.setItem(i, undefined);
    if (this.stash?.name === pl.name) for (const [i, it] of this.stash.exact) { try { c.setItem(i, it); } catch (e) { console.warn(`[agent] restore slot ${i}: ${e}`); } }
    else restoreKit(pl, { slots: saved.slots, worn: {} });
    mem.data.learnKit = null;
    mem.saveNow();
    this.stash = null;
    return true;
  }

  /** The player came back (initial spawn): their things, if they were put aside and never returned. */
  restoreOnJoin(pl) {
    if (this.name === pl.name) return;
    if (this.restoreFor(pl)) pl.sendMessage?.('Your things from the house recording are back.');
  }

  /**
   * The house just built, read off the world (not replayed from clicks): a snapshot of the blocks round
   * what the player placed -> core/learnhouse.js buildPlan -> a plan, kept if it passes. Then their things back.
   */
  async finishHouse(name) {
    this.finishing = true;
    const say = (t) => { this.a.say(t); try { this.player()?.sendMessage?.(t); } catch { /* */ } };
    try {
      const placed = [...this.placed].map(([k, id]) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z, id }; });
      const box = boxOf(placed);
      const pl = world.getPlayers().find((p) => p.name === name);
      if (!box) say('Nothing was placed, so there is no house to learn.');
      else {
        const dim = pl?.dimension ?? this.a.dim;
        const snap = await this.snapshot(dim, box);
        const res = buildPlan(snap, { placed: new Set(this.placed.keys()), firstDoor: this.firstDoor, at: Date.now() });
        const ascii = res.ok ? describe(res.plan) : [];
        if (res.ok) {
          setPlan(res.plan);
          try { world.setDynamicProperty(PLAN_KEY, JSON.stringify(res.plan)); } catch (e) { console.warn(`[agent] save house plan: ${e}`); }
          const s = res.stats;
          say(`Learned your house: ${s.floor} cells of floor, ${s.stone} stone and ${s.planks} wood blocks of wall and roof, a bed, a table, ${res.plan.furnaces.length} furnace(s), ${res.plan.chests.length} chest(s). \`!bot house learned on\` builds the next house like it; the starter house stays until then.`);
          for (const n of res.notes) say(`Note: ${n}.`);
        } else {
          say(`Couldn't use that house: ${res.problems.join('; ')}. The starter house stays. (Fix it and \`!bot learn house\` again.)`);
        }
        sendEvent({ type: 'learned_house', ok: res.ok, problems: res.problems, notes: res.notes, stats: res.stats, ascii, plan: res.ok ? res.plan : null, player: name }).catch(() => {});
      }
    } finally {
      this.finishing = false;
      const pl = world.getPlayers().find((p) => p.name === name);
      if (pl && this.restoreFor(pl)) say('Your things are back.');
      else if (this.a.memory.data.learnKit) say('Your things are still put aside: they come back when you rejoin, or `!bot learn restore`.');
      this.placed = new Map();
    }
  }

  /** Read the box block by block, a few hundred a tick. { cells: Map, box, head: Set } for core/learnhouse.js. */
  snapshot(dim, box) {
    return new Promise((resolve, reject) => {
      const cells = new Map(), head = new Set();
      const job = function* () {
        let n = 0;
        for (let x = box.x0; x <= box.x1; x++) for (let y = box.y0; y <= box.y1; y++) for (let z = box.z0; z <= box.z1; z++) {
          let b;
          try { b = dim.getBlock({ x, y, z }); } catch (e) { reject(new Error('the house isn\'t loaded (stay near it)')); return; }
          if (!b) { reject(new Error('the house isn\'t loaded (stay near it)')); return; }
          const id = nm(b.typeId);
          if (id !== 'air') {
            cells.set(`${x},${y},${z}`, id);
            if (/(^|_)bed$/.test(id)) { try { if (b.permutation.getState('head_piece_bit')) head.add(`${x},${y},${z}`); } catch { /* */ } }
          }
          if (++n % 400 === 0) yield;
        }
        resolve({ cells, box, head });
      };
      system.runJob(job());
    });
  }

  status() {
    if (this.mode === 'house' && this.name) return `recording ${this.name} building a house: ${this.placed.size} blocks placed so far; \`!bot learn off\` when it's done`;
    return this.name ? `recording ${this.name}: ${this.sent + this.buf.length} rows, ${Math.round((system.currentTick - this.t0) / 1200)} min` : 'not recording';
  }

  row(r) {
    this.buf.push({ t: system.currentTick - this.t0, ...r });
    if (this.buf.length > KEEP_ROWS) this.buf.splice(0, this.buf.length - KEEP_ROWS);
  }

  /** Every tick (agent.tick). */
  tick(t) {
    if (!this.name) return;
    const p = this.player();
    if (!p || !p.isValid) { if (t % 100 === 0 && !p) this.stop(); return; }
    if (t % 20 === 0) this.sample(p);
    if (t % FLUSH_EVERY === 0) this.flush();
  }

  sample(p) {
    let hp = null, food = null, held = null;
    try { hp = Math.round((p.getComponent('minecraft:health')?.currentValue ?? 0) * 10) / 10; } catch {}
    try { food = p.getComponent('minecraft:player.hunger')?.currentValue ?? null; } catch {}
    try { held = nm(p.getComponent('minecraft:inventory')?.container?.getItem(p.selectedSlotIndex)?.typeId) || null; } catch {}
    const l = p.location;
    this.row({ k: 's', x: Math.round(l.x * 10) / 10, y: Math.round(l.y * 10) / 10, z: Math.round(l.z * 10) / 10, hp, food, h: held,
      sp: p.isSprinting ? 1 : 0, sn: p.isSneaking ? 1 : 0, g: p.isOnGround ? 1 : 0, d: nm(p.dimension?.id) });
  }

  // --- events (main.js hands them over) ---
  mine(ev) { return this.name && ev.player?.name === this.name; }
  onBreak(ev) {
    if (!this.mine(ev)) return;
    const l = ev.block.location;
    this.row({ k: 'b', id: nm(ev.brokenBlockPermutation?.type?.id), x: l.x, y: l.y, z: l.z, tool: nm(ev.itemStackBeforeBreak?.typeId) || null });
    if (this.mode === 'house') this.placed.delete(`${l.x},${l.y},${l.z}`);
  }
  onPlace(ev) {
    if (!this.mine(ev)) return;
    const l = ev.block.location;
    this.row({ k: 'p', id: nm(ev.block.typeId), x: l.x, y: l.y, z: l.z });
    if (this.mode === 'house') {
      const id = nm(ev.block.typeId), key = `${l.x},${l.y},${l.z}`;
      this.placed.set(key, id);
      if (/(^|_)door$/.test(id) && !this.firstDoor) this.firstDoor = key;
    }
  }
  onEat(ev) {
    if (!this.name || ev.source?.name !== this.name) return;
    this.row({ k: 'eat', item: nm(ev.itemStack?.typeId) });
  }
  onHurt(ev) {
    if (!this.name) return;
    const victim = ev.hurtEntity, by = ev.damageSource?.damagingEntity;
    if (victim?.name === this.name) this.row({ k: 'hurt', cause: ev.damageSource?.cause, amt: Math.round((ev.damage ?? 0) * 10) / 10, by: nm(by?.typeId) || null });
    else if (by?.name === this.name) this.row({ k: 'hit', target: nm(victim?.typeId), amt: Math.round((ev.damage ?? 0) * 10) / 10 });
  }
  onDie(ev) {
    if (!this.name) return;
    if (ev.deadEntity?.name === this.name) this.row({ k: 'die', cause: ev.damageSource?.cause });
    else if (ev.damageSource?.damagingEntity?.name === this.name) this.row({ k: 'kill', mob: nm(ev.deadEntity?.typeId) });
  }

  flush() {
    if (!this.buf.length || !this.name) { if (!this.buf.length) return; }
    const rows = this.buf.splice(0, this.buf.length);
    sendEvent({ type: 'demo', player: this.name ?? 'unknown', session: this.session, rows }).then((res) => {
      if (res === null) this.buf.unshift(...rows); // brain not reachable: keep them for the next try
      else this.sent += rows.length;
    }).catch(() => this.buf.unshift(...rows));
  }
}
