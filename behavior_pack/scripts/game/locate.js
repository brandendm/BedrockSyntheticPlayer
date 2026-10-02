// Where the game itself says the nearest village (or other structure) or forest (or other biome) is: the brain types `/locate` into the server's
// console (brain/serverproc.py) and reads the answer, which a script's runCommand cannot. The game's own generator, so exact; nothing runs in the
// game's script engine but one HTTP request. null if the brain is not running the server (Start Agent.bat does) or the search found nothing:
// the callers fall back to the in-game biome search.
import { system } from '@minecraft/server';
import { http, HttpRequest, HttpRequestMethod, HttpHeader } from '@minecraft/server-net';
import { CONFIG } from '../config.js';
import { trace } from './bridge.js';

const cache = new Map();
let off = false;

/** kind: 'structure' | 'biome'; name e.g. 'village', 'forest'; from: { x, z }. Returns { x, z } or null. */
export async function locate(kind, name, from) {
  if (off) return null;
  const key = `${kind}:${name}:${Math.floor(from.x / 512)},${Math.floor(from.z / 512)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.pos ? 600000 : 120000)) return hit.pos;
  const t0 = Date.now();
  let pos = null, why = '';
  try {
    // The brain answers within a few seconds or says {pending}; asked again (the same question is the same job) for up to a minute.
    for (let i = 0; i < 20; i++) {
      const req = new HttpRequest(`${CONFIG.brainUrl}/locate`);
      req.method = HttpRequestMethod.Post;
      req.body = JSON.stringify({ kind, name, x: Math.floor(from.x), z: Math.floor(from.z) });
      req.headers = [new HttpHeader('Content-Type', 'application/json')];
      req.timeout = 8;
      const res = await http.request(req);
      const body = JSON.parse(res.body);
      if (body.pending) continue;
      if (Number.isFinite(body.x) && Number.isFinite(body.z)) pos = { x: body.x, z: body.z };
      else { why = String(body.error ?? 'no answer'); if (/not run by the brain/.test(why)) off = true; }
      break;
    }
    if (!pos && !why) why = 'still searching after a minute';
  } catch (e) { why = `${e}`; }
  trace(`locate ${kind} ${name}: ${pos ? `${pos.x} ${pos.z} (${Math.round(Math.hypot(pos.x - from.x, pos.z - from.z))} away)` : `none (${why})`} in ${Date.now() - t0} ms`);
  cache.set(key, { pos, at: Date.now() });
  return pos;
}
void system;
