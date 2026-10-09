// The words of `!bot admin ...` (pure; the call itself is game/adminlink.js).

/** `!bot admin status | run <console command> | chain <name> | chains | backup [label]` (original case kept for the command and the chain name). */
export function parseAdmin(words) {
  const [verb, ...rest] = words;
  const arg = rest.join(' ').trim();
  if (verb === 'status' || !verb) return { action: 'status' };
  if (verb === 'run' || verb === 'console') return arg ? { action: 'console', command: arg } : { error: 'admin run <console command>' };
  if (verb === 'chain') return arg ? { action: 'chain', name: arg } : { error: 'admin chain <name>' };
  if (verb === 'chains') return { action: 'chains' };
  if (verb === 'backup') return { action: 'backup', label: arg };
  return { error: 'admin status | run <console command> | chain <name> | chains | backup [label]' };
}
