# Training digest

Written 2026-10-09 06:53:45.  Cycles so far: 9  (accepted 0, rejected 3, no simulator gain 1, aborted 5).

## Champion (only the values that differ from the defaults)

```json
{}
```

## Last cycles

| when | group | outcome | what changed | why |
|---|---|---|---|---|
| 2026-10-09 06:53:45 | cave | rejected | {"quarryTorchLight": 3.693} | no gain in the real game (no difference the runs can show) |
| 2026-10-09 06:46:34 | tow | no simulator gain | {} | train 76.85->47.92, held 73.78->52.03 |
| 2026-10-09 06:10:10 | tow | aborted | {} | sim/train.mjs exited with code 1 and wrote no result:     at processTicksAndRejections (node:internal/process/task_queue |
| 2026-10-09 05:32:24 | tow | aborted | {} | sim/train.mjs exited with code 13 and wrote no result:  |
| 2026-10-09 04:57:29 | play | aborted | {"attackerMemory": 220.338} | the batch ended: stopped |
| 2026-10-09 04:48:09 | play | rejected | {"attackerMemory": 235.491, "exploreCost": 59.223} | no gain in the real game (no difference the runs can show) |
| 2026-10-08 12:44:31 | combat | no simulator gain | {} | the search did not finish |
| 2026-10-08 12:21:12 | cave | rejected | {"caveTorchEvery": 5.7, "caveFleeLight": 2.491} | no gain in the real game (no difference the runs can show) |
| 2026-10-08 12:04:29 | tow | no simulator gain | {} | the search did not finish |

## Weakest tests (pass rate over every real run, any policy)

| test | passed | tried |
|---|---|---|
| raid | 0 | 5 |
| chasm | 1 | 4 |
| wild | 1 | 4 |
| ambush | 1 | 3 |
| cavedeep | 3 | 4 |
| caveescape | 4 | 5 |
| siege | 4 | 5 |
| bow | 7 | 7 |
