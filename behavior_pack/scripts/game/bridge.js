// Event-driven link to the Python brain. The game only calls it when something
// happens (a command, a hostile shows up, a task finishes or gets stuck) - never on a timer.
import { system } from '@minecraft/server';
import { http, HttpRequest, HttpRequestMethod, HttpHeader } from '@minecraft/server-net';
import { CONFIG } from '../config.js';

let backoffUntil = 0;

// Decision traces ("logs: need 3, 0 in sight, best explore"): buffered here, shipped with the
// next dashboard poll, written by the brain to brain/logs/trace.jsonl. Costs nothing extra.
const traces = [];
const traceListeners = [];
/** Also hand every trace line to fn(tick, msg) (the flight recorder keeps them even with no brain running). */
export function onTrace(fn) { traceListeners.push(fn); }
let posFn = null;
/** Every trace line carries where the bot was when it was written (fn() -> {x, y, z}). */
export function tracePosition(fn) { posFn = fn; }
// A loop in the notes themselves: the same few lines over and over (an escape that plans, fails, relocates and plans again).
// Said once a minute with the cycle named, so "what is it doing" is one line instead of ninety.
const recentKeys = [];
let lastLoopSaid = -1e9;
function noteLoop(msg) {
  if (String(msg).startsWith('loop:')) return;
  recentKeys.push(String(msg).replace(/-?\d+(\.\d+)?/g, '#').slice(0, 70));
  if (recentKeys.length > 80) recentKeys.shift();
  const n = recentKeys.length;
  if (n < 20 || system.currentTick - lastLoopSaid < 1200) return;
  for (let p = 2; p <= 8; p++) {
    const reps = Math.floor(n / p);
    if (reps < 5) break;
    let ok = true;
    for (let i = n - 1; i >= n - p * 5; i--) if (recentKeys[i] !== recentKeys[i - p]) { ok = false; break; }
    if (!ok) continue;
    lastLoopSaid = system.currentTick;
    let times = 0;
    for (let i = n - 1; i - p >= 0 && recentKeys[i] === recentKeys[i - p]; i--) times++;
    const cycle = recentKeys.slice(n - p).join('  ->  ');
    trace(`loop: repeating ${p} notes about ${Math.round(times / p)}+ times: ${cycle}`);
    return;
  }
}

export function trace(msg) {
  const tick = system.currentTick;
  let p;
  try { const l = posFn?.(); if (l) p = [Math.round(l.x * 10) / 10, Math.round(l.y * 10) / 10, Math.round(l.z * 10) / 10]; } catch { /* between a death and the respawn */ }
  traces.push({ tick, msg: String(msg).slice(0, String(msg).includes('\n') ? 2500 : 300), p });
  try { noteLoop(msg); } catch { /* never breaks a trace */ }
  if (traces.length > 300) traces.splice(0, traces.length - 300);
  for (const f of traceListeners) { try { f(tick, msg); } catch { /* a listener never breaks a trace */ } }
}
let warned = false;

/** POST an event; returns {actions: [...]} or null if the brain is unreachable. */
export async function sendEvent(event) {
  if (system.currentTick < backoffUntil) return null;
  try {
    const req = new HttpRequest(`${CONFIG.brainUrl}/event`);
    req.method = HttpRequestMethod.Post;
    req.body = JSON.stringify(event);
    req.headers = [new HttpHeader('Content-Type', 'application/json')];
    req.timeout = CONFIG.brainTimeoutSec;
    const res = await http.request(req);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    warned = false;
    return JSON.parse(res.body);
  } catch (e) {
    backoffUntil = system.currentTick + CONFIG.brainBackoffTicks;
    if (!warned) {
      console.warn(`[agent] brain unreachable at ${CONFIG.brainUrl} (${e}); using local fallback`);
      warned = true;
    }
    return null;
  }
}

/** GET the learned profile (brain/learn.py) or null. */
export async function fetchProfile() {
  if (system.currentTick < backoffUntil) return null;
  try {
    const req = new HttpRequest(`${CONFIG.brainUrl}/profile`);
    req.method = HttpRequestMethod.Get;
    req.timeout = 2;
    const res = await http.request(req);
    return res.status === 200 ? JSON.parse(res.body) : null;
  } catch { return null; }
}

/** The settings kept on this computer by the brain (goal toggles, chat): { key: bool } or null if it isn't reachable. */
export async function fetchSettings() {
  if (system.currentTick < backoffUntil) return null;
  try {
    const req = new HttpRequest(`${CONFIG.brainUrl}/api/settings`);
    req.method = HttpRequestMethod.Get;
    req.timeout = 2;
    const res = await http.request(req);
    return res.status === 200 ? (JSON.parse(res.body).settings ?? null) : null;
  } catch { return null; }
}

/**
 * Dashboard link: send the bot's status, get back any commands typed on the dashboard
 * (brain/dashboard.html). Local HTTP once a second; nothing leaves the machine.
 */
export async function poll(status) {
  if (system.currentTick < backoffUntil) return [];
  try {
    const req = new HttpRequest(`${CONFIG.brainUrl}/poll`);
    req.method = HttpRequestMethod.Post;
    const batch = traces.splice(0, traces.length);
    req.body = JSON.stringify({ status, traces: batch });
    req.headers = [new HttpHeader('Content-Type', 'application/json')];
    req.timeout = 2;
    const res = await http.request(req);
    if (res.status !== 200) return [];
    return JSON.parse(res.body).commands ?? [];
  } catch {
    backoffUntil = system.currentTick + CONFIG.brainBackoffTicks;
    return [];
  }
}
