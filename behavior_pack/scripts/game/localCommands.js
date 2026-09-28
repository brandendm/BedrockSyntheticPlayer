// Minimal command parser used only when the brain is down, so the bot stays usable
// offline. The full grammar lives in brain/command_parser.py.
export function parseLocal(text, sender) {
  const t = text.trim().toLowerCase().split(/\s+/);
  const n = (s) => Number(s);
  switch (t[0]) {
    case 'come':
    case 'here':
      return [{ type: 'come', player: sender }];
    case 'follow':
      return [{ type: 'follow', player: t[1] || sender }];
    case 'stop':
      return [{ type: 'stop' }];
    case 'dig':
      return [{ type: 'dig' }];
    case 'surface':
    case 'up':
      return [{ type: 'surface' }];
    case 'memory':
    case 'where':
      return [{ type: 'memory' }];
    case 'auto':
    case 'resume':
      return [{ type: 'auto', on: t[1] !== 'off' }];
    case 'beds':
    case 'sleep':
      return [{ type: 'beds', on: t[1] !== 'off' }];
    case 'goto':
      if (t.length >= 4 && [t[1], t[2], t[3]].every((s) => Number.isFinite(n(s)))) {
        return [{ type: 'goto', x: n(t[1]), y: n(t[2]), z: n(t[3]) }];
      }
      if (t.length === 3 && Number.isFinite(n(t[1])) && Number.isFinite(n(t[2]))) {
        return [{ type: 'goto', x: n(t[1]), z: n(t[2]) }];
      }
      return [{ type: 'say', text: 'usage: goto <x> <y> <z>' }];
    default:
      return [{ type: 'say', text: `Brain offline; I only know come, follow, stop, goto, auto, dig right now.` }];
  }
}
