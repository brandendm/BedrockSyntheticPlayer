import { readFileSync } from 'node:fs';
export function lenient(s) {
  let out = '', i = 0, str = false;
  while (i < s.length) {
    const c = s[i];
    if (str) { out += c; if (c === '\\') { out += s[++i]; } else if (c === '"') str = false; i++; continue; }
    if (c === '"') { str = true; out += c; i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
export const readJ = (f) => lenient(readFileSync(f, 'utf8'));
