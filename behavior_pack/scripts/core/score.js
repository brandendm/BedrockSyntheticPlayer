// A test run as a number between 0 and 1, not only pass/fail (u301). Pass/fail needs dozens of runs to tell two policies apart; a score that also says how fast, how
// hurt, and how far a failure got needs a handful. Read from what every test already says in its detail text ("... in 22s; ... lowest health 9 ... x 43/45").
// Passes score 0.60 to 1.00 (faster and healthier is higher); failures 0.00 to 0.45 (the further it got, the higher).
const num = (re, s) => { const m = re.exec(s); return m ? Number(m[1]) : null; };

/** @param {{pass: boolean, detail?: string, cap?: number}} r */
export function runScore({ pass, detail = '', cap = 120 }) {
  const secs = num(/\b(?:in|after) (\d+(?:\.\d+)?) ?s\b/, detail);
  const hp = num(/lowest health (\d+(?:\.\d+)?)/, detail);
  if (pass) {
    const speed = secs === null ? 0.5 : 1 - Math.min(1, secs / Math.max(10, cap));
    const health = hp === null ? 0.5 : Math.min(1, Math.max(0, hp / 20));
    return round(0.6 + 0.25 * speed + 0.15 * health);
  }
  let progress = 0.05;
  const x = /x (-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/.exec(detail);
  const below = num(/still (\d+(?:\.\d+)?) below/, detail);
  const short = num(/(\d+(?:\.\d+)?) blocks short/, detail);
  if (x && Number(x[2]) > 0) progress = Math.max(0, Math.min(1, Number(x[1]) / Number(x[2])));
  else if (below !== null) progress = Math.max(0, 1 - below / 20);
  else if (short !== null) progress = Math.max(0, 1 - short / 40);
  else if (secs !== null && /died|dead/.test(detail)) progress = Math.min(0.5, secs / Math.max(10, cap)); // (lasted this long)
  const died = /died|DIED|dead/.test(detail);
  return round(Math.min(0.45, (died ? 0.3 : 0.4) * progress + 0.05));
}
const round = (v) => Math.round(v * 1000) / 1000;
