# What keeps going wrong

Ranked from the bot's own test results and benchmark runs (brain/miner.py). Fix the top of this list first.

| count | failure |
|---|---|
| 19 | bench stall: shelter / none @plan (after nothing) |
| 18 | bench stall: - / none (after nothing) |
| 16 | bench stall: - / none @plan (after nothing) |
| 15 | bench stall: shelter / none (after nothing) |
| 8 | bench stall: gather_logs / none @plan (after nothing) |
| 5 | raid: died while fleeing |
| 5 | wild: failed |
| 2 | ambush: died |
| 2 | raid: died |
| 2 | chasm: died |
| 1 | siege: died |
| 1 | siege: died while fleeing |
| 1 | bench: failed |
| 1 | caveescape: still below the surface |
| 1 | ravine: still below the surface |
| 1 | caveascent: still below the surface |
| 1 | bow: failed |
| 1 | cavedeep: stopped short of the goal |
| 1 | chasm: died while fleeing |

## Weakest tests

| test | passed |
|---|---|
| wild | 1/6 |
| raid | 2/9 |
| chasm | 1/4 |
| ambush | 4/6 |
| siege | 5/7 |
| cavedeep | 3/4 |
| caveascent | 5/6 |
| caveescape | 5/6 |
| bow | 10/11 |
| ravine | 10/11 |
