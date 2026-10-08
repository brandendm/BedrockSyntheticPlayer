# sim — one offline engine for the whole bot

`server.mjs` stands in for `@minecraft/server` (+ the GameTest SimulatedPlayer) so the bot's real `game/` code runs in Node on a virtual clock. World = `world.js`, motion = `physics.js`, constants = `params.js` (`calibration.json` overrides them).

- `node sim/run_tow.mjs leadstep` — a tow course with the real bot code. Anything the game code asks for that is not built is listed ("not built yet"), never silently wrong.
- `node sim/probes_run.mjs [probe]` — the physics probes (core/probes.js) on the sim.
- `node sim/calibrate.mjs [--real brain/logs/probes.jsonl] [--fit]` — compare with / fit to the real traces; `--selftest` proves the fitter on fabricated data.

Calibration loop: run the probes in the game (`brain/inbox/run.json` with `test probewalk,...`), then `calibrate.mjs --fit`; check held-out tow courses with `run_tow.mjs` against the real results in `brain/logs/tests.jsonl`.

## What the real game turned out to do (measured by the probes, 10 Oct 2026, builds u262–u266)
- The walker: the sim's walk/jump/move match the game to under 1 cm. `sim.move(x, z, speed)` ignores `speed` (always full speed); `moveToLocation` honours it.
- A leashed boat is not on a spring: it goes toward the holder at a speed proportional to how far past ~4.3–4.7 blocks the lead is, reaching it over a few ticks, and stops there (no overshoot). Trailing a walker at full speed it lags 6.3 behind.
- Against a wall the lead keeps pulling: the boat creeps up the wall face (vertical pull stronger than the horizontal), and when it clears the lip it shoots off at up to 1.06 blocks/tick. That is the sling.
- A boat spawns 0.2 off in x and z; `applyImpulse` moves a boat only about an eighth to a third as far as a free body; reading a removed entity throws.
- Fit: 0.12 blocks rms over all probes (walker 0.001–0.09; flat lead 0.08–0.25; lift 0.4). The tow courses in the sim: leadstep 9 s (game 13), leadstair 13 s (17), leadturn 12.5 s (14), leadgate 14 s (15–18). leadledge (bridging over a pit) still fails in the sim: the sling step walks off the end of the runway; needs a place-and-walk probe.

## Robustness runs
`node sim/ensemble.mjs [course] --n 10 --spread 0.08` runs each tow course on the fitted physics jittered by +-8% (boat and lead only). A course that passes on the fitted numbers and fails on a jittered one is a knife edge in the bot, not in the sim: u267's two leadledge fixes came from this (5/10 -> 10/10). `node sim/compare_run.mjs leadledge` puts the sim's bot path beside the bot's real run second by second.

## Random courses (u269)
`node sim/gen_run.mjs 1 20` plays the bot's real code on generated lanes (`sim/gencourse.mjs`: steps of 1, gates on either side, low walls; seeds >= 1000 are held out). First run: 13/20 pass, mean 24 s. It also caught a u268 regression the five fixed courses missed when the bot has no learned memory (the jam clock reset whenever the walker came within range). Open: low "wall" bumps the walker hops over and drops off (repeated "up onto the step" at one spot, boat left jammed behind).

u270: on the random courses (seeds 1-20: 13 -> 14 of 20; held-out 1000-1011: 8 -> 10 of 12) the walker past a low wall with the boat jammed at its foot now slings from the ground (taut lead, 8+) before it tries climbing the wall, which only walked it back off.

## Debugging tools (u271)
- `npm run gate` (`gate:quick`): unit tests + the five fixed courses (no memory, and with a player's learned memory) + random seeds 1-20 and held-out 1000-1011, against `sim/baseline.json`. Fails on any course that fails or is >25% slower, or a seed that passed before and fails now. `node sim/gate.mjs --update` after a change you meant. About 80 s.
- `node sim/minimize.mjs <seed> [--timeline]`: shrinks a failing random course to the smallest one that still fails (drops parts, then shortens them). `--parts '<json>'` re-runs a minimal one.
- `node sim/replay_capsule.mjs brain/inbox/capsules.json [i]`: a real-game repro capsule rebuilt in the sim (its blocks, where the bot and boat were, the tow goal) and played with the bot's real code. `LEARNED='{...}'` adds a learned memory.
- `sim/report.mjs`: second-by-second bot/boat table + the tow's trace lines, returned by `runTow` (`timeline`, `traces`).
- `node tools/ship.mjs [--bump] [--commit "msg"] [--tests a,b] [--wait 150]` (on the PC): sync the pack to the server, check it, queue the real-game run, wait for THAT build's result, print the summary, commit.
Finding (u272, real game, probewall): a boat at the foot of a wall 1-2 high cannot be slung from the ground at any stretch up to 9.5 (6 tries, it never passed the face, peaked 1.2-1.5; the sim matched to 0.08 blocks). So u270's ground sling does nothing for walls (kept as ONE try in u273 because it makes the stair 4 s quicker), and the generator's walls are now 6-9 deep (a top to stand on and stretch the lead); with that, the bot passes 20/20 and 12/12 held-out. Next: harder courses (pits, 2-high steps with a block kit, corners).

## Loops (u274)
- `node sim/tune.mjs [--evals 120] [--apply]`: coordinate search over the tow's constants (`core/towtune.js`; the bot reads overrides from `memory.data.leadTune`) on a train set (5 fixed + random level 1 and 2, seeds 2001+), checked on held-out seeds; writes `sim/tuned.json` only if it wins there too (the first try did not: train 32.1 -> 29.3, held-out 38.9 -> 39.2, nothing written). Workers: `sim/pool.mjs`.
- Random courses have levels: `node sim/gen_run.mjs 1 12 --level 2` = 3-6 parts with pits and a 32-dirt kit. First run 7/12; the failures are "the lead broke" while bridging/slinging near a pit (the boat falls into the pit, then a sling at rise 6.5).
- `node tools/nightly.mjs [--tune]` (on the PC; `tools/install_nightly.bat` registers it for 05:30 daily): gate + fresh seeds from the date + every failure minimized with its timeline -> `brain/reports/nightly-DATE.md`. Changes nothing in the bot.
- `node tools/regress.mjs --start --set tow|probes|core|all` / `--continue` / `--update`: every scenario in the real game against `brain/regress_baseline.json`, REGRESSION / SLOWER / FASTER per scenario -> `brain/reports/regress-BUILD.md`.
- `node tools/new_probe.mjs probefoo "what"` scaffolds a probe; `node tools/probe_cycle.mjs probefoo --bump` ships it, runs it in the game and prints sim-vs-real.

u275: `villagerferry` scenario (game/scenarios.js; you: `!bot test villagerferry me`, the bot: `!bot test villagerferry`): villagerhaul's course with two zombies from the west end (fire-proof), a sheep, a pig and a chicken about the boat, difficulty Hard (a zombie that kills a villager turns it), the slab's glass rim keeping everybody in. Pass = both still villagers within 4 of the gold block. The result says who was killed or turned and who sat in the boat. The bot lifts non-villagers out of the boat by command (like putting villagers in). Real-game only: the sim has no mob AI.

u275 horse versions: every tow course and both villager tests have a `...horse` twin (`leadstephorse` ... `leadgatehorse`, `villagerhaulhorse`, `villagerferryhorse`): same course, a tamed saddled horse by the start (`readyHorse`), the lead held from the saddle (`tow.run(..., { mount })`). Your horse runs are not fed to the tow learning. Horse versions of the courses a horse cannot climb (3-high steps, the ledge and pit) may be impossible; that is what the first run is for. Real-game only.

## u276 — admin panel
`http://<brain>/admin` (link in the dashboard header): doctor (build/pack/game/autorun/rate-limit/locks checks), reload/spawn/STOP, run any scenario as bot or you, build an auto-run batch (writes `inbox/run.json`), log tail with grep and follow, last result + autorun history, nightly/regress reports, command box, copyable sim/tool commands. Logic in `brain/admin.py`, tests in `brain/tests/test_admin.py`. Restart the brain to get it.

## u277 — pass-rate analytics
Dashboard "Pass rates & progress": tiles (bot pass rate, last 20 vs the 20 before, your rate, efficiency score), rolling pass-rate line with build markers, per-build bars, per-test you-vs-bot bars with speed against you, last-10 pips and ▲▼ trend. `brain/analytics.py` (`/api/analytics`) reads `tests.jsonl`; efficiency = mean of (bot recent pass rate x min(1.5, your median secs / bot median secs)) over tests you both ran, 100 = you. The game now sends `build` with each `test_run`, so by-build bars fill from u277 on (older rows group as "?").

## u278 — retire / needs-attention verdicts
`brain/analytics.py` `verdict()`: RETIRE? = 8+ bot runs, last 5 all passed, 90%+ lifetime, and (if you have a time) efficiency >= 90%. NEEDS ATTENTION = 3+ bot runs and recent pass rate <= 40%, or efficiency < 50% of yours, or falling while under 60%. Thresholds are constants at the top of the file. Shown as tiles, badges on each test row (hover for why) and a summary line.

## u279 — ferry/horse fixes from the first real runs
villagerferry (bot): the bot's own fight mode replaced the test task ("interrupted: task replaced, mode fight"): now `testHold` for the run. Horse variants: "tame after 2 tries but not saddled" — the bot had no saddle in the pack: now given one before mounting.

## u280 — horse saddle, zombies leave the spectator alone
readyHorse: the saddle slot only exists on a TAME horse, and `tame(who)` was handed a string in some paths; now triggers the horse's own tamed event, tames, waits, then tries `replaceitem @s`, the tagged command, and the inventory container in turn, and logs the result. villagerferry bot runs put you in creative (zombies ignore creative players) and restore your old mode in cleanup.

## u281 — the lift formula, probejumps, villager creep
- `core/liftmodel.js`: holder h above the boat, d out: top-of-jump lead length s = hypot(d, h + jump); excess e = s - pull; jumps = ceil((need0 + needPerH*h)/e), Infinity when e <= 0 (one up, two out: nothing; going down: shorter lead, nothing). `minLength`, `liftPlan` (fewest jumps that fit the guard; `extra` = runway to build). The tow's sling at a step now takes its distance and number of jumps from it (a player's taught stretch still wins), one more jump per failure; `sling()` jumps up to N times.
- Real calibration: `!bot test probejumps` (3 heights x 7 distances x up to 4 jumps), then `node sim/fit_lift.mjs --apply` fits pull/jump/need0/needPerH and rewrites LIFT. `--sim` runs the pipeline on the simulator (which has no multi-jump regime: its lead pulls steadily, so it shows 1 jump from 7 out).
- sweepVillagers: when the boat has stopped short of the villager with the lead taut, the holder walks on half a block at a time (up to 3.5) instead of standing.
- Horse variants: if the game still does not saddle the horse, a saddle goes in the rider's pack and the failure is traced. villagerferry bot gets resistance + regeneration (its fight mode is off, the zombies killed it).

## u282 — from the u281 sweep (real game)
- villagerhaul (bot): on the 1-high rise the bot climbed onto the step, stood 1.4 from the boat with a slack lead, and the route took it off down the far side: the boat never came (stuck #1-6, 25 s). Now, up on the step with the boat leashed and below, the lift (formula, runway if the top is too short) is done at once (`liftFrom`).
- Horses: `readyHorse` traced "tamed false, saddled false": the game's tame() / events do not tame. The bot now tames it by riding (as a player does), gets off, then the horse is saddled (command, then container). Still: a saddle in the rider's pack as the last resort.
- villagerferry: human run crashed (InvalidEntityError on a villager killed that tick) - guarded; the eviction no longer teleports the player out of the boat; the bot swings at a zombie within 3.2.
- Horse ferry (bot): stood still 40 s at 12 from its boat while zombies hit it, then the lead broke at the tow's start - not yet understood (the fix above may cure it: the horse was never really tame).
- Not yet run in the real game: probejumps (it was not in the sweep).
