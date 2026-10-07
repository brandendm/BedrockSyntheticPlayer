# sim — one offline engine for the whole bot

`server.mjs` stands in for `@minecraft/server` (+ the GameTest SimulatedPlayer) so the bot's real `game/` code runs in Node on a virtual clock. World = `world.js`, motion = `physics.js`, constants = `params.js` (`calibration.json` overrides them).

- `node sim/run_tow.mjs leadstep` — a tow course with the real bot code. Anything the game code asks for that is not built is listed ("not built yet"), never silently wrong.
- `node sim/probes_run.mjs [probe]` — the physics probes (core/probes.js) on the sim.
- `node sim/calibrate.mjs [--real brain/logs/probes.jsonl] [--fit]` — compare with / fit to the real traces; `--selftest` proves the fitter on fabricated data.

Calibration loop: run the probes in the game (`brain/inbox/run.json` with `test probewalk,...`), then `calibrate.mjs --fit`; check held-out tow courses with `run_tow.mjs` against the real results in `brain/logs/tests.jsonl`.
