// The colosseum's line to the brain's lab (brain/lab.py): which bout to play next, and how it went. The brain keeps every record and the report.
import { http, HttpRequest, HttpRequestMethod, HttpHeader } from '@minecraft/server-net';
import { CONFIG } from '../config.js';
import { table, norm, realPolicy } from '../core/doctrine.js';

async function call(path, body) {
  try {
    const req = new HttpRequest(`${CONFIG.brainUrl}${path}`);
    req.method = body === undefined ? HttpRequestMethod.Get : HttpRequestMethod.Post;
    if (body !== undefined) { req.body = JSON.stringify(body); req.headers = [new HttpHeader('Content-Type', 'application/json')]; }
    req.timeout = 30;
    const res = await http.request(req);
    return JSON.parse(res.body);
  } catch (e) { return { ok: false, say: `the brain did not answer (${e})` }; }
}

/** The loop's end of a lab run: `next()` -> a bout ({ id, mob, count, gear, doctrine, limit }) or null when done; `done(rec)` sends the record. */
export function makeLab(bouts, say) {
  let left = bouts, last = null, played = 0;
  return {
    async next() {
      if (left <= 0) return null;
      const r = await call('/lab/next', { table: table() });
      if (!r?.ok) { say(`§cLab: ${r?.say ?? 'no answer'}`); return null; }
      left--; last = r.bout;
      return r.bout;
    },
    async done(rec) {
      if (!last) return;
      const r = await call('/lab/result', { id: last.id, rec });
      played++;
      if (!r?.ok) { say(`§cLab: ${r?.say ?? 'the record was not taken'}`); return; }
      const ev = r.event;
      const who = last.role === 'cand' ? 'candidate' : 'champion';
      say(`Bout ${played} (${last.env === 'water' ? 'underwater, ' : ''}${last.mob} x${last.count}, ${who}): ${rec.outcome}, score ${r.score >= 0 ? '+' : ''}${r.score}.`);
      if (ev?.type === 'promoted') say(`§aNew ${ev.env === 'water' ? 'underwater ' : ''}champion! ${Object.entries(ev.note.changed).map(([k, [a, b]]) => `${k} ${+a.toFixed(2)} -> ${+b.toFixed(2)}`).join(', ')} (+${ev.note.mean} over ${ev.note.pairs} paired bouts). ${ev.note.why.slice(0, 2).join('; ')}`);
      else if (ev?.type === 'dropped') say(`Candidate dropped (${ev.changed.join(', ')}: ${ev.mean >= 0 ? '+' : ''}${ev.mean}).`);
    },
  };
}

/** `lab report | apply | reset`. Returns the lines to say. */
export async function labAdmin(sub, agent, applyPolicy, diffFromDefaults) {
  if (sub === 'reset') { const r = await call('/api/lab', { action: 'reset' }); return [r?.error ? `lab: ${r.error}` : 'The lab is cleared (champion, bouts and report).']; }
  const r = await call('/api/lab');
  if (!r || r.error || r.say) return [`lab: ${r?.error ?? r?.say ?? 'no answer'}`];
  if (sub === 'apply') {
    if (!r.champion) return ['The lab has no champion yet (`!bot colosseum lab`).'];
    const pol = realPolicy(norm(r.champion));
    if (!Object.keys(pol).length) return ['The champion does not differ from the defaults in anything the real fight uses yet.'];
    agent.memory.data.policy = { ...(agent.memory.data.policy ?? {}), ...pol };
    const applied = applyPolicy(agent.memory.data.policy);
    agent.memory.save();
    return [`Real fight constants set from the champion: ${JSON.stringify(pol)}. In force now: ${JSON.stringify(diffFromDefaults(applied))}. (The arena-only knobs - strafing, bow, horse - have no real-fight counterpart yet.)`];
  }
  const c = r.cand;
  return [`Lab: ${r.bouts} bouts, ${r.promotions} promotions, ${r.dropped} dropped. ${c ? `Testing a candidate that changes ${c.changed.join(', ')} (${c.pairs.length} pairs in).` : ''} The full report is in the dashboard's Lab panel.`];
}
