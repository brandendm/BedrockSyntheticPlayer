// The pathfinding log (game/pathlog.js): who asked is read off the stack, searches and walks are counted, and the totals say
// how many were partial, slow or stuck.  node tools/sim_pathlog.mjs
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const { PathLog, callerOf } = await import('../behavior_pack/scripts/game/pathlog.js');
const checks = [];
const ok = (n, c, d = '') => checks.push([n, !!c, d]);

ok('QuickJS style frames (no class names)', callerOf('Error\n    at plan (agent.js:1)\n    at goNear (skills.js:2)\n    at mine (skills.js:3)') === 'goNear < mine');
ok('plan wrappers skipped', callerOf('Error\n    at Agent.plan (agent.js:1)\n    at async Skills.goNear (skills.js:2)\n    at async Skills.mine (skills.js:3)') === 'S.goNear < S.mine');
ok('nothing to read', callerOf('') === '?');

const log = new PathLog();
const stack = 'Error\n    at Agent.plan (a.js:1)\n    at async Skills.sweep (s.js:1)';
log.plan({ from: { x: 0, y: 64, z: 0 }, to: { x: 10, y: 64, z: 0 }, tolerance: 1, maxNodes: 8000, goalTest: null, actions: false, r: { expanded: 120, complete: true, path: [1, 2, 3] }, ticks: 2, stack });
log.plan({ from: { x: 0, y: 64, z: 0 }, to: { x: 90, y: 64, z: 0 }, tolerance: 1, maxNodes: 25000, goalTest: null, actions: false, r: { expanded: 25000, complete: false, path: [1] }, ticks: 63, stack });
log.walk({ wps: [{ x: 0, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }, { x: 8, y: 64, z: 0, leap: 2 }], result: { status: 'arrived' }, ticks: 40, from: { x: 0, y: 64, z: 0 }, end: { x: 8, y: 64, z: 0 } });
log.walk({ wps: [{ x: 0, y: 64, z: 0 }, { x: 20, y: 64, z: 0 }], result: { status: 'stuck' }, ticks: 100, from: { x: 0, y: 64, z: 0 }, end: { x: 11, y: 64, z: 0 } });
const s = log.summary();
ok('totals', s.plans === 2 && s.partialPct === 50 && s.slow === 1 && s.walks === 2 && s.stuckPct === 50 && s.blocksWalked === 28, JSON.stringify(s));
ok('rows kept with who, leaps and how far it ended from the target', log.rows[0].who === 'S.sweep' && log.rows[2].leaps === 1 && log.rows[3].short === 9 && log.rows[3].status === 'stuck', JSON.stringify(log.rows[3]));
for (const [n, c, d] of checks) console.log(`${c ? 'PASS' : 'FAIL'} ${n}${!c && d ? ` (${d})` : ''}`);
process.exit(checks.every((c) => c[1]) ? 0 : 1);
