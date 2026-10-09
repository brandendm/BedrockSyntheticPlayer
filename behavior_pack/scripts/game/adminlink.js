// The bot's line to the Bedrock admin service (admin/service.py, a separate program that owns the server): one HTTP request to the brain's /admin,
// which adds the bot token and passes it on. The service decides what the bot may do (status, a safe list of console commands, backups, the chains
// marked "Bot may run"); the game never sees a token.
import { http, HttpRequest, HttpRequestMethod, HttpHeader } from '@minecraft/server-net';
import { CONFIG } from '../config.js';

/** body: { action: 'status' | 'console' | 'chain' | 'chains' | 'backup', command?, name?, label? } -> { ok, say } (never throws). */
export async function adminCall(body) {
  try {
    const req = new HttpRequest(`${CONFIG.brainUrl}/admin`);
    req.method = HttpRequestMethod.Post;
    req.body = JSON.stringify(body);
    req.headers = [new HttpHeader('Content-Type', 'application/json')];
    req.timeout = 120;
    const res = await http.request(req);
    const j = JSON.parse(res.body);
    return { ok: !!j.ok, say: String(j.say ?? j.error ?? 'no answer') };
  } catch (e) { return { ok: false, say: `the brain did not answer (${e})` }; }
}
