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
