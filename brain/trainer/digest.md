# Training digest

Written 2026-10-09 05:32:24.  Cycles so far: 6  (accepted 0, rejected 2, no simulator gain 0, aborted 4).

## Champion (only the values that differ from the defaults)

```json
{}
```

## Last cycles

| when | group | outcome | what changed | why |
|---|---|---|---|---|
| 2026-10-09 05:32:24 | tow | aborted | {} | sim/train.mjs exited with code 13 and wrote no result:  |
| 2026-10-09 04:57:29 | play | aborted | {"attackerMemory": 220.338} | the batch ended: stopped |
| 2026-10-09 04:48:09 | play | rejected | {"attackerMemory": 235.491, "exploreCost": 59.223} | no gain in the real game (no difference the runs can show) |
| 2026-10-08 12:44:31 | combat | no simulator gain | {} | the search did not finish |
| 2026-10-08 12:21:12 | cave | rejected | {"caveTorchEvery": 5.7, "caveFleeLight": 2.491} | no gain in the real game (no difference the runs can show) |
| 2026-10-08 12:04:29 | tow | no simulator gain | {} | the search did not finish |

## Weakest tests (pass rate over every real run, any policy)

| test | passed | tried |
|---|---|---|
| raid | 0 | 4 |
| wild | 1 | 4 |
| ambush | 1 | 3 |
| siege | 3 | 4 |
| bow | 3 | 3 |
| hole | 3 | 3 |
| jungle | 3 | 3 |
| ladder | 3 | 3 |
