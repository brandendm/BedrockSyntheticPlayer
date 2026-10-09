# bench stall: shelter / none @plan (after nothing)

Rank 1, seen 19 times. Pass rate over the logged runs of `bench stall`: n/a.

## Start here
- behavior_pack/scripts/game/agent.js (runAuto, planStep)
- behavior_pack/scripts/core/plan*.js
- behavior_pack/scripts/game/bench.js

## To reproduce
`!bot test bench stall` in game, or queue it: `{"tests":["bench stall"],"reload":true,"workers":1}` in brain/inbox/run.json (Auto runs on).

## Then
Fix, add a unit test, bump the build, ship, and run the test 3+ times (a single pass proves little).
