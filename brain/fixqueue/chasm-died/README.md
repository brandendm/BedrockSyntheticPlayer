# chasm: died

Rank 7, seen 2 times. Pass rate over the logged runs of `chasm`: 1/4.

## Start here
- behavior_pack/scripts/core/terrain.js (the course)
- behavior_pack/scripts/game/scenarios.js (case 'thicket'... the test)
- behavior_pack/scripts/core/threat.js, core/tactics.js (fight or flee)

## To reproduce
`!bot test chasm` in game, or queue it: `{"tests":["chasm"],"reload":true,"workers":1}` in brain/inbox/run.json (Auto runs on).

## Then
Fix, add a unit test, bump the build, ship, and run the test 3+ times (a single pass proves little).
