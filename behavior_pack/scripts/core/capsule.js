// (u250) The repro capsule: what is saved when something goes wrong, so the situation can be looked at, and replayed, without running
// the whole test again. Pure: game/capsule.js fills it from the world.
//
//   a ring of samples (the bot and what it watches, a few times a second) and trace lines, the last seconds only;
//   a slice of the world around the bot (blocks run-length coded down each column, entities listed);
//   why it was taken, and the bot's own state.
//
// `slice` = { box:{x1,y1,z1,x2,y2,z2}, palette:[id...], cols:["<idx>x<n>,<idx>x<n>..." per column, x-major then z] }; air is palette 0.

/** Keeps the records of the last `maxTicks` ticks. */
export class Ring {
  constructor(maxTicks = 400) { this.maxTicks = maxTicks; /** @type {{tick:number}[]} */ this.items = []; }
  push(rec) {
    this.items.push(rec);
    const lim = rec.tick - this.maxTicks;
    let k = 0;
    while (k < this.items.length && this.items[k].tick < lim) k++;
    if (k) this.items.splice(0, k);
  }
  /** The records from `tick` on. */
  since(tick) { return this.items.filter((r) => r.tick >= tick); }
  get length() { return this.items.length; }
}

/** Blocks of box `box` through `get(x,y,z) -> id|null` as a slice (null counts as air). */
export function encodeSlice(box, get) {
  const palette = ['air'], index = new Map([['air', 0]]);
  const cols = [];
  for (let x = box.x1; x <= box.x2; x++) for (let z = box.z1; z <= box.z2; z++) {
    const runs = [];
    let last = -1, n = 0;
    for (let y = box.y1; y <= box.y2; y++) {
      const id = get(x, y, z) ?? 'air';
      let i = index.get(id);
      if (i === undefined) { i = palette.length; palette.push(id); index.set(id, i); }
      if (i === last) n++; else { if (n) runs.push(`${last}x${n}`); last = i; n = 1; }
    }
    if (n) runs.push(`${last}x${n}`);
    cols.push(runs.join(','));
  }
  return { box: { ...box }, palette, cols };
}

/** A slice back as get(x,y,z) -> id (outside the box: null). */
export function decodeSlice(slice) {
  const { box, palette, cols } = slice;
  const h = box.y2 - box.y1 + 1, w = box.z2 - box.z1 + 1;
  const grid = cols.map((c) => {
    const col = [];
    for (const r of c.split(',')) { if (!r) continue; const [i, n] = r.split('x').map(Number); for (let k = 0; k < n; k++) col.push(palette[i]); }
    while (col.length < h) col.push('air');
    return col;
  });
  return (x, y, z) => {
    if (x < box.x1 || x > box.x2 || y < box.y1 || y > box.y2 || z < box.z1 || z > box.z2) return null;
    return grid[(x - box.x1) * w + (z - box.z1)][y - box.y1];
  };
}

const GLYPH = (id) => {
  if (!id || id === 'air' || id === 'cave_air') return '.';
  if (/water/.test(id)) return '~';
  if (/lava/.test(id)) return '!';
  if (/gold_block/.test(id)) return 'G';
  if (/dirt|grass/.test(id)) return 'd';
  if (/stone|cobble|deepslate|andesite|diorite|granite/.test(id)) return '#';
  if (/planks|log|wood/.test(id)) return 'p';
  if (/glass/.test(id)) return 'g';
  return 'o';
};

/**
 * The layers of a slice around `at` ({x,y,z}) drawn as text: `rows` layers from `y0` up, `r` blocks each way,
 * with marks `{x,z,y,ch}` drawn over (the bot '@', the boat 'B').
 */
export function renderSlice(slice, at, { y0 = Math.floor(at.y) - 1, rows = 4, r = 10, marks = [] } = {}) {
  const get = decodeSlice(slice), out = [];
  for (let y = y0 + rows - 1; y >= y0; y--) {
    out.push(`y ${y}${y === Math.floor(at.y) ? ' (feet)' : ''}   x ${Math.floor(at.x) - r}..${Math.floor(at.x) + r} across, z ${Math.floor(at.z) - r} (north) .. ${Math.floor(at.z) + r} down`);
    for (let z = Math.floor(at.z) - r; z <= Math.floor(at.z) + r; z++) {
      let line = '';
      for (let x = Math.floor(at.x) - r; x <= Math.floor(at.x) + r; x++) {
        const m = marks.find((k) => Math.floor(k.x) === x && Math.floor(k.z) === z && Math.floor(k.y) === y);
        line += m ? m.ch : GLYPH(get(x, y, z));
      }
      out.push(`  ${line}`);
    }
  }
  return out;
}

/** What is kept of one moment of the bot and what it watches. All numbers rounded to 0.1. */
export const r1 = (v) => Math.round(v * 10) / 10;
export const pt = (p) => (p ? [r1(p.x), r1(p.y), r1(p.z)] : null);

/**
 * The capsule: { v, why, build, tick, at, bot, samples, trace, slice, entities, watch }. `trace` and `samples` are cut to the last `secs` seconds.
 * @param {{why:string, build:string, tick:number, at:{x:number,y:number,z:number}, bot:object, ring:Ring, traces:{tick:number,msg:string}[], slice:object, entities:object[], watch?:object, secs?:number}} o
 */
export function makeCapsule(o) {
  const from = o.tick - (o.secs ?? 12) * 20;
  return {
    v: 1, why: String(o.why).slice(0, 300), build: o.build, tick: o.tick, at: pt(o.at), bot: o.bot,
    samples: o.ring.since(from), trace: o.traces.filter((t) => t.tick >= from - 200).map((t) => ({ tick: t.tick, msg: String(t.msg).slice(0, 240) })).slice(-60),
    slice: o.slice, entities: o.entities, watch: o.watch ?? null,
  };
}

/** The report's text for a capsule: why, what the bot was doing second by second, the trace lines, the drawing, and the whole thing as JSON. */
export function capsuleLines(c, { json = true } = {}) {
  const out = [`why: ${c.why}  (build ${c.build}, tick ${c.tick}, at ${c.at?.join(',')})`, `bot: ${JSON.stringify(c.bot)}`];
  if (c.watch) out.push(`watching: ${JSON.stringify(c.watch)}`);
  out.push(`entities: ${c.entities.map((e) => `${e.type}@${e.p?.join(',')}${e.leashed ? ' leashed' : ''}${e.v ? ` v${e.v}` : ''}`).join('; ') || 'none'}`);
  const sec = c.samples.filter((_, i) => i % 4 === 0);
  out.push(`the last ${Math.round(((c.samples.at(-1)?.tick ?? 0) - (c.samples[0]?.tick ?? 0)) / 20)} s (about one sample a second: ticks back from the end; bot x,y,z; held; boat x,y,z):`);
  for (const s of sec) out.push(`  -${((c.tick - s.tick) / 20).toFixed(1)}s ${s.p?.join(',')} ${s.held ?? '-'}${s.boat ? ` boat ${s.boat.join(',')}` : ''}${s.note ? ` ${s.note}` : ''}`);
  out.push('trace:'); for (const t of c.trace) out.push(`  -${((c.tick - t.tick) / 20).toFixed(1)}s ${t.msg}`);
  const marks = [{ ...(c.at ? { x: c.at[0], y: c.at[1], z: c.at[2] } : {}), ch: '@' }];
  for (const e of c.entities) if (e.p && /boat/.test(e.type)) marks.push({ x: e.p[0], y: e.p[1], z: e.p[2], ch: 'B' });
  if (c.at) out.push(...renderSlice(c.slice, { x: c.at[0], y: c.at[1], z: c.at[2] }, { marks }));
  if (json) out.push(`CAPSULE JSON: ${JSON.stringify(c)}`);
  return out;
}
