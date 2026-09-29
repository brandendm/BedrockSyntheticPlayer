// Maps real blocks to the pathfinder's cell categories.
import { Cell } from '../core/pathfinder.js';

// Never enter or stand on.
const DANGER = new Set([
  'minecraft:lava', 'minecraft:flowing_lava', 'minecraft:fire', 'minecraft:soul_fire',
  'minecraft:magma', 'minecraft:cactus', 'minecraft:sweet_berry_bush', 'minecraft:powder_snow',
  'minecraft:campfire', 'minecraft:soul_campfire', 'minecraft:wither_rose',
  'minecraft:pointed_dripstone', 'minecraft:cobweb',
]);

// Taller than one block (fences, walls) or needs interaction (doors, gates). Until there are
// move types for these, treating them as "never enter" stops the bot trying to hop a fence.
const IMPASSABLE = /(_fence|_wall|fence_gate|_door|iron_bars|glass_pane)$/;

// Things you walk straight through.
const PASSABLE = new Set([
  'minecraft:short_grass', 'minecraft:tall_grass', 'minecraft:fern', 'minecraft:large_fern',
  'minecraft:deadbush', 'minecraft:snow_layer', 'minecraft:torch',
  'minecraft:soul_torch', 'minecraft:redstone_torch', 'minecraft:lever',
  'minecraft:redstone_wire', 'minecraft:rail', 'minecraft:seagrass', 'minecraft:sugar_cane',
  'minecraft:wheat', 'minecraft:carrots', 'minecraft:potatoes', 'minecraft:beetroot',
]);
const PASSABLE_RE = /(flower|tulip|sapling|_button|pressure_plate|carpet|_sign|banner|dandelion|poppy|orchid|allium|bluet|daisy|cornflower|lily_of_the_valley|_rail|crimson_roots|warped_roots|_sprouts|propagule|mushroom|leaf_litter|wildflowers|pink_petals|dry_grass|^minecraft:bush|firefly_bush|glow_lichen|sculk_vein|hanging_roots|spore_blossom|small_dripleaf_block|cave_vines_plant|nether_sprouts|seagrass|kelp)$/;

const MANGROVE_ROOTS = /^minecraft:(muddy_)?mangrove_roots$/;

export const OPENABLE = /^minecraft:(?!iron_)(\w*_door|\w*fence_gate)$/;

// You can climb these (hold forward into the wall, or just go up them).
export const CLIMBABLE = /^minecraft:(ladder|vine|weeping_vines|twisting_vines|cave_vines|cave_vines_body_with_berries|cave_vines_head_with_berries)$/;

// Blocks that are really water as far as a swimmer is concerned (you're submerged in them).
const WATER_PLANTS = /^minecraft:(kelp|kelp_plant|seagrass|tall_seagrass|bubble_column|sea_pickle)$/;

/** True if a body in this block is in water (plain water, water plants, waterlogged non-solids). */
export function isWatery(b) {
  if (!b) return false;
  if (b.isLiquid) return !b.typeId.includes('lava');
  if (WATER_PLANTS.test(b.typeId)) return true;
  try { return b.isWaterlogged && !b.isSolid; } catch { return false; }
}

/** Falling water (a waterfall column): liquid_depth 8+ in Bedrock. */
function isFalling(b) {
  try {
    return (b.permutation.getState('liquid_depth') ?? 0) >= 8;
  } catch {
    return false;
  }
}

/** Flowing water (not a source block, not falling): liquid_depth 1-7 in Bedrock. Its current pushes. */
export function isFlowing(b) {
  try {
    if (!b.isLiquid) return false;
    const d = b.permutation.getState('liquid_depth') ?? 0;
    return d >= 1 && d < 8;
  } catch {
    return false;
  }
}

export function makeClassifier(dimension) {
  return (x, y, z) => {
    let b;
    try {
      b = dimension.getBlock({ x, y, z });
    } catch {
      return Cell.UNKNOWN; // out of world bounds
    }
    if (!b) return Cell.UNKNOWN; // chunk not loaded
    if (b.isAir) return Cell.AIR;
    const id = b.typeId;
    if (DANGER.has(id)) return Cell.DANGER;
    // Mangrove roots are solid (you stand on them, they block you), even waterlogged in a swamp.
    if (MANGROVE_ROOTS.test(id)) return Cell.SOLID;
    if (isWatery(b)) return isFalling(b) ? Cell.DANGER : isFlowing(b) ? Cell.FLOW : Cell.LIQUID; // waterfalls drop you into ravines
    // Leaves: never walk on or through a canopy (you end up on top of a forest, or stuck in it).
    if (id.endsWith('leaves')) return Cell.DANGER;
    // Wooden doors and fence gates are ways through: the bot opens them as it walks up (agent.js
    // doorTick) and shuts them behind it. Iron doors need redstone: those stay walls.
    if (OPENABLE.test(id)) return Cell.AIR;
    if (IMPASSABLE.test(id)) return Cell.DANGER;
    if (CLIMBABLE.test(id)) return Cell.CLIMB;
    if (PASSABLE.has(id) || PASSABLE_RE.test(id)) return Cell.AIR;
    // Stairs the right way up and bottom slabs are walked up onto, no jump (the pathfinder's STEP
    // and SLAB); upside-down stairs, top and double slabs are ordinary solid blocks.
    if (STAIRS.test(id)) return halfState(b, 'upside_down_bit') ? Cell.SOLID : Cell.STEP;
    if (SLAB.test(id) && !/double/.test(id)) return slabOnTop(b) ? Cell.SOLID : Cell.SLAB;
    return Cell.SOLID;
  };
}

const STAIRS = /_stairs$/;
const SLAB = /_slab\d?$/;

function halfState(b, name) {
  try { return !!b.permutation.getState(name); } catch { return false; }
}

/** A slab in the top half of its block (older versions: top_slot_bit). */
function slabOnTop(b) {
  try {
    const v = b.permutation.getState('minecraft:vertical_half');
    if (v !== undefined) return v === 'top';
  } catch {}
  return halfState(b, 'top_slot_bit');
}

/**
 * First block along a ray that stops it: a voxel walk (Amanatides & Woo) using getBlock.
 * Replaces dimension.getBlockFromRay, which on this server version (BDS 1.26) returns nothing
 * for any ray going diagonally across x and z (tested: (8,0,1) hits, (8,0,3) and (5,0,5) miss),
 * so every "can I see it" check was wrong off the axes. Air, plants, torches, rails, vines and
 * the like don't stop a ray; liquids only when asked. The cell we start in is skipped.
 * Returns { block, location, faceLocation (0..1 within the block) } or undefined.
 */
export function castRay(dimension, from, dir, maxDistance, { liquids = false, crosshair = false } = {}) {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
  let x = Math.floor(from.x), y = Math.floor(from.y), z = Math.floor(from.z);
  const sx = Math.sign(d.x), sy = Math.sign(d.y), sz = Math.sign(d.z);
  const next = (p, i, s, v) => (s === 0 ? Infinity : ((s > 0 ? i + 1 - p : p - i) / Math.abs(v)));
  let tx = next(from.x, x, sx, d.x), ty = next(from.y, y, sy, d.y), tz = next(from.z, z, sz, d.z);
  const dx = sx === 0 ? Infinity : 1 / Math.abs(d.x), dy = sy === 0 ? Infinity : 1 / Math.abs(d.y), dz = sz === 0 ? Infinity : 1 / Math.abs(d.z);
  for (let i = 0; i < 512; i++) {
    let t, face;
    if (tx <= ty && tx <= tz) { x += sx; t = tx; tx += dx; face = { x: -sx, y: 0, z: 0 }; }
    else if (ty <= tz) { y += sy; t = ty; ty += dy; face = { x: 0, y: -sy, z: 0 }; }
    else { z += sz; t = tz; tz += dz; face = { x: 0, y: 0, z: -sz }; }
    if (t > maxDistance) return undefined;
    let b;
    try { b = dimension.getBlock({ x, y, z }); } catch { return undefined; }
    if (!b) return undefined; // not loaded: can't see into it
    if (!(crosshair ? stopsCrosshair(b) : stopsRay(b, liquids))) continue;
    const hp = { x: from.x + d.x * t, y: from.y + d.y * t, z: from.z + d.z * t };
    // (face: the outward normal of the face the ray came in through)
    return { block: b, location: { x, y, z }, faceLocation: { x: hp.x - x, y: hp.y - y, z: hp.z - z }, face };
  }
  return undefined;
}

function stopsRay(b, liquids) {
  if (b.isAir) return false;
  if (b.isLiquid || WATER_PLANTS.test(b.typeId)) return liquids;
  const id = b.typeId;
  if (PASSABLE.has(id) || PASSABLE_RE.test(id) || CLIMBABLE.test(id)) return false;
  return true;
}

/**
 * What a player's crosshair stops on: anything with an outline, so vines, grass, flowers, torches,
 * fire, snow layers and leaves as much as stone. It passes through air and liquids only. (Seeing
 * is castRay's other mode: you see a log through a vine, but a click there hits the vine.)
 */
function stopsCrosshair(b) {
  if (b.isAir || b.isLiquid) return false;
  return !/^minecraft:(light_block.*|structure_void|bubble_column|water|flowing_water|lava|flowing_lava)$/.test(b.typeId);
}

/** True if nothing solid is between the eye and the target (fair-play perception). */
export function canSee(dimension, eye, target) {
  const dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.01) return true;
  try {
    return !castRay(dimension, eye, { x: dx, y: dy, z: dz }, dist - 0.3);
  } catch {
    return false;
  }
}

/**
 * Plants a punch breaks the moment it lands (no hardness): swiped through, not mined one by one.
 * (Never saplings, torches, crops or berry bushes: ours, or not ours to mow down.)
 */
export const ONE_TAP = /^(short_grass|tall_grass|fern|large_fern|dead_bush|deadbush|leaf_litter|wildflowers|pink_petals|tall_dry_grass|short_dry_grass|bush|firefly_bush|(?!chorus_)[a-z_]*_flower|dandelion|poppy|.*_tulip|azure_bluet|allium|blue_orchid|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony)$/;
