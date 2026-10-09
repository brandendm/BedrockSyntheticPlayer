// Is a column a good world spawn? (u296) The new-world script used to leave the spawn point at (0, 0, 0): bedrock level, so a player started in a cave or at the
// bottom of an ocean. The game picks a land spawn itself when the point is unset (y 32767); this is the backstop that checks it and, if it is not good, finds one.
// Pure: given what the top two solid blocks of a column are, and the column's height.
const BAD_TOP = /(water|lava|ice|leaves|log|cactus|magma|fire|powder_snow|kelp|seagrass|bubble|vine|web)/;
const GOOD_GROUND = /(grass|dirt|sand|stone|gravel|podzol|mycelium|snow|terracotta|mud|clay|moss|rooted|deepslate|sandstone)/;

/** @param {string} topId block id of the highest non-air block  @param {number} y its y  @param {number} seaLevel */
export function goodSpawnColumn(topId, y, seaLevel = 62) {
  const id = String(topId ?? '').replace('minecraft:', '');
  if (!id || BAD_TOP.test(id)) return false;
  if (!GOOD_GROUND.test(id)) return false;
  return y >= seaLevel && y <= 150;
}

/** Candidate columns in a growing square spiral round (cx, cz): `step` apart, nearest first, `n` of them. */
export function spiral(cx, cz, step = 48, n = 80) {
  const out = [{ x: cx, z: cz }];
  for (let r = 1; out.length < n; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) out.push({ x: cx + dx * step, z: cz + dz * step });
  }
  return out.slice(0, n);
}
