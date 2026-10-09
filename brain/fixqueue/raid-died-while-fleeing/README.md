# raid: died while fleeing

Rank 3, seen 5 times. Pass rate over the logged runs of `raid`: 2/9.

## Start here
- behavior_pack/scripts/core/terrain.js (the course)
- behavior_pack/scripts/game/scenarios.js (case 'thicket'... the test)
- behavior_pack/scripts/core/threat.js, core/tactics.js (fight or flee)

## To reproduce
`!bot test raid` in game, or queue it: `{"tests":["raid"],"reload":true,"workers":1}` in brain/inbox/run.json (Auto runs on).

## Then
Fix, add a unit test, bump the build, ship, and run the test 3+ times (a single pass proves little).
