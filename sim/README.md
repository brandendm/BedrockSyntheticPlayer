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
Open: seed 20 minimizes to one 1-high 3-deep wall 2 blocks in; the sim bot stretches to 8.5 and jumps every second and the boat never comes (is the sim's ground-level lift too weak, or the real thing the same? needs a probe: boat at a wall's foot, walker on the ground beyond).
