// A run, read at a glance: the bot and boat second by second, and the tow's own trace lines (what it decided and why).
export function timelineText(r, { every = 1, maxTrace = 40 } = {}) {
  const out = [`${r.name}: ${r.pass ? 'PASS' : 'FAIL'} in ${r.secs}s${r.m?.why ? `  why: ${r.m.why}` : ''}`, 'sec  bot x,y,z          boat x,y,z          apart'];
  for (const t of r.timeline) if (t.s % every === 0) out.push(`${String(t.s).padStart(3)}  ${t.bot.join(',').padEnd(18)}  ${(t.boat ?? ['gone']).join(',').padEnd(18)}  ${t.d ?? '-'}`);
  out.push('trace:'); for (const t of r.traces.slice(0, maxTrace)) out.push(`  ${(t.tick / 20).toFixed(1)}s ${String(t.msg).slice(0, 240)}`);
  if (r.traces.length > maxTrace) out.push(`  ... ${r.traces.length - maxTrace} more`);
  return out.join('\n');
}
