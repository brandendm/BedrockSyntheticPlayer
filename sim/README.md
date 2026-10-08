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
