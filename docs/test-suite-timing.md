# Test suite timing

Profile of `vitest run` for the pup gate's test stage. Nothing in the suite, config or gate was changed to take it.

## How it was measured

- One run of all 119 test files vitest's `include` matches (`src/**` and `test/**`), through `pup session test --reporter=json`, on an 8-core Mac. 4,875 tests, 4,874 passed, 0 failed (one skipped or todo).
- Wall time of the run: **408 s**. The summed per-file durations are 1,561 s, so the 4 workers (`maxWorkers` = half of 8 cores) were busy about 3.8x in parallel. The run is throughput-bound on worker time, not on one long file.
- A file's duration is its vitest `endTime - startTime`. It is within 0.1% of the sum of its tests' durations, so setup in `beforeEach` is counted. Durations are measured under the contention of 4 workers plus whatever else the machine ran, so they are higher than a file run alone.
- The 12 `tools/**` test files are not matched by the vitest `include` and did not run.
- "What dominates" below comes from reading each file's setup and counting spawn, git, tmux and timer calls. It is **not** a per-phase measurement: the JSON report has no split between git, subprocess and timer time. Step 1 of the speedups is to take that split before acting on any estimate.

## 15 slowest test files

| # | File | Seconds | Tests | s/test |
|---|------|--------:|------:|-------:|
| 1 | `src/core/land.test.ts` | 204.5 | 112 | 1.83 |
| 2 | `src/core/merge-gate.test.ts` | 174.8 | 178 | 0.98 |
| 3 | `src/core/merge-gate-open-pr.test.ts` | 152.5 | 102 | 1.50 |
| 4 | `src/core/merge-gate-regate.test.ts` | 98.0 | 61 | 1.61 |
| 5 | `src/core/merge-gate-checkout.test.ts` | 97.0 | 74 | 1.31 |
| 6 | `src/core/git-diff-client.test.ts` | 65.3 | 194 | 0.34 |
| 7 | `src/core/fix-round.test.ts` | 63.1 | 20 | 3.15 |
| 8 | `src/core/profile-compiler.test.ts` | 41.9 | 100 | 0.42 |
| 9 | `src/core/land-squash.test.ts` | 40.6 | 34 | 1.20 |
| 10 | `src/cli/index.test.ts` | 38.5 | 224 | 0.17 |
| 11 | `src/core/land-refusals.test.ts` | 38.1 | 26 | 1.47 |
| 12 | `src/core/session-lifecycle.test.ts` | 37.6 | 167 | 0.23 |
| 13 | `src/core/fix-round-kickoff.test.ts` | 37.2 | 40 | 0.93 |
| 14 | `src/core/merge-gate-shared-config.test.ts` | 31.5 | 23 | 1.37 |
| 15 | `src/core/profile-compiler-hooks.test.ts` | 30.7 | 15 | 2.05 |

These 15 files are 1,151 s of the 1,561 s of worker time (74%). The top 5 alone are 727 s (47%). `src/cli/index-3.test.ts` (28.5 s) is 16th.

## What dominates each (from reading the files)

- **`land`, `land-squash`, `land-refusals`**: a `beforeEach` that builds a real git repo, a real bare origin, pushes `main`, adds a real worktree, commits and pushes the branch, plus an in-memory SQLite store (`land.test.ts:118-155`). About ten git subprocesses per test, and then the land itself runs real fetches, merges and gate children. A fake `gh` is on `PATH`. At 1.2-1.8 s per test, the per-test fixture is the main suspect.
- **`merge-gate`, `-open-pr`, `-regate`, `-checkout`, `-shared-config`**: the same pattern: per-test temp repos, worktrees and bare origins (`merge-gate.test.ts` has ~25 temp-dir/repo setups and ~50 git calls), then a real `runMergeGate` that spawns real git and sandboxed gate children. Some also wait on real deadlines (`-open-pr` has 8 timer or sleep uses, `-regate` 4). `merge-gate-shared-config` includes a 6.2 s test that kills a git child blocked on a fifo.
- **`git-diff-client`**: 194 tests over ~34 temp repos, ~130 git calls. Cheap per test (0.34 s), large in total. Spawn-bound.
- **`fix-round`**: only 20 tests at 3.15 s each. Real time budgets: one test is 4.4 s waiting for "a GitHub that does not answer" to hit its time budget. Real timers.
- **`profile-compiler`, `profile-compiler-hooks`**: real subprocesses and real deadlines. `profile-compiler-recap` has the single slowest test in the suite (10.6 s, "kills a pup that never answers at its deadline"), `profile-compiler` has a 6.9 s test and `-hooks` a 4.6 s one, all waiting on real timeouts and kills.
- **`cli/index`, `index-3`**: 150-200 temp dirs and 50 git calls each, with tmux referenced in 10-23 places (tmux was not confirmed to be spawned for real; a stub is likely). Cheap per test (0.17 s); the cost is the count.
- **`session-lifecycle`**: 167 tests at 0.23 s, tmux-shaped but no temp repos, so it is dominated by per-test store and tmux-stub work.

Slowest single tests, all waiting on real deadlines: 10.6 s (`profile-compiler-recap`), 8.7 s (`merge-gate-fresh-base`, 30 merges), 6.9 s, 6.2 s, 6.0 s (`sandbox-utils`, a child that ignores SIGTERM), 5.7 s, 5.1 s, 4.6 s, 4.4 s, 4.4 s. The top 10 total about 63 s, 4% of worker time.

## Ranked speedups

"Guarantee" means what the gate's test stage promises: every test runs against real git and real subprocesses, on every file, on every merge.

1. **Measure the split first (no change to the gate).** Run the 5 slowest files with `--reporter=verbose` and a wall-clock probe in `beforeEach` versus the test body, to learn what share of the 727 s is fixture setup. Every estimate below depends on it. Nothing here is measured yet.
2. **Build the git fixture once per file and copy it per test.** In `land*` and `merge-gate*`, init the repo, bare origin and first commits in `beforeAll`, then `cp -R` it (or `git clone --local`) in `beforeEach`. This cuts roughly 8 of ~10 git spawns per test across about 500 tests in the top files. **Does not change the guarantee**: tests still run real git on a real repo. Care is needed: the copy must keep absolute paths inside `.git` (worktree links, remote URL) valid. Largest expected win; size unknown until step 1.
3. **Trim per-spawn git overhead in test repos.** Set `core.fsync=false`, `gc.auto=0`, `core.fsmonitor=false`, `GIT_CONFIG_NOSYSTEM=1` and `init.defaultBranch` in the shared test helper so each of the thousands of spawns does less disk and config work. **Does not change the guarantee**, as long as no test is about fsync or system config. Gain unmeasured; likely small per spawn and large over thousands.
4. **Inject the deadlines instead of waiting them out.** The ~15 tests that wait 4-10 s for a real timeout (kill at deadline, GitHub not answering, listing outliving its deadline) take about 63 s in total. Pass a short deadline (for example 200 ms) or use fake timers where the test is about the decision and not the kill itself. **Partly changes the guarantee**: tests that check that a real process is really killed (the SIGTERM-ignoring child, the fifo-blocked git) must keep their real wait, or at least a real process with a short deadline. Estimated saving about 40 s of worker time, so about 10 s of wall.
5. **Raise `maxWorkers` from 4 to 6 on 8 cores.** At 3.8x effective parallelism, wall would fall toward 270 s if the work scaled. **Does not change what the tests check**, but the config comment records that more workers time out the spawn-heavy tests, and the gate may run several suites at once. Try only after 2 and 3 reduce the spawn load, and watch for flakes.
6. **Split the 5 largest files.** Not worth doing alone. With 4 workers and 1,561 s of work the ideal wall is 390 s against a measured 408 s, so scheduling is already near balanced. It matters only if `maxWorkers` is raised (a 205 s file is then the floor of the critical path).
7. **Affected-tests-only gate.** Run only the tests that import changed files. This is by far the largest saving (most sessions touch a few modules), but it **does change the guarantee**: the gate would no longer prove the whole suite passes on the merge result, and cross-module regressions through shared helpers (`test/helpers/*`, `land.mock`) could merge. It needs an ADR, and a full run on a schedule or on shared-helper changes to backstop it.

Items 2, 3 and 5 keep the gate's guarantee unchanged. Item 4 keeps it if the real-kill tests stay real. Item 7 does not.
