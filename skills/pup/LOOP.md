# The per-task loop, in full

## 1. Worker finishes

`pup status` shows the task `awaiting-review`. Its branch is `pup/<task>`, its worktree
`.worktrees/<task>` under the project repo. Read the commits with
`git -C .worktrees/<task> log --oneline main..HEAD`.

## 2. Review before the gate

Review the diff `main...HEAD` in the worktree yourself, or with a security-minded subagent when
the change touches hook generation, profile compilation, the gate, or anything that shells out.
Ask for file:line evidence and a must-fix versus nice-to-have split. Mutation probes (plant a
regression in a backup COPY of the file, run the test, restore from the copy, never
`git checkout --`) are the most reliable check that a new test guards anything.

Steer must-fix items with ONE `pup steer <task> "<message>"`. Name only files inside the task's
scope: a new file outside `scopeIn` fails the scope audit, so say so in the steer. Then wait for
the fix commit and the next `awaiting-review`.

## 3. Gate

From the project's main checkout:

```
pup merge <task> --pr
```

Always with `--pr`: a plain `pup merge` fast-forwards local main on pass, which skips the
human's review of the pull request. Run the `--pr` command without the debt flags first. If stages flag (diff size, complexity, dead exports, duplication, coverage),
re-run with `--accept-debt "<reason>" --review-by "<condition>"`. One reason is stamped on every
flagged stage, so write one that fits all of them. On pass the branch is pushed and a PR opened;
`pup status` then says `merged`, which means the PR exists, not that GitHub merged it.

Never validate a change to the gate with the gate on its own branch.

## 4. CI review

When the conductor runs, this loop is its job, not the console's: it waits on every PR it gates,
runs the fix rounds and reports each PR ready for your merge click. Leave the waiting to it.
Without a conductor, run the same steps yourself:

```
pup ci wait <task>          # blocks until the review of the PR's head finished; one digest line
pup fix <task>              # when the digest names it: the threads go back to the task's worker
pup merge <task> --pr       # re-gate the round once the worker is done and reviewed
```

Run `pup ci wait` in the foreground with a Bash `timeout` of 600000 ms; its default timeout is 9
minutes and it exits non-zero when it ran out, so run it again. Never wait any other way: no
`gh pr checks --watch`, no sleep loop, no background job. The digest names the head, the outcome,
the open and important threads, and the next step after `→`:

- `pup fix <task>`: open threads. The worker answers each one in its `pup session done`
  summary. Review its commits, then re-gate with `pup merge <task> --pr`, then `pup ci wait`
  again. The re-gate pins the pushed head, the only sha the PR vouches for and `pup land`
  accepts.
- `ready for the operator's merge click`: read the PR, then merge it on GitHub yourself.
- Anything else (read the PR, comment `@claude review`, `pup land`) is yours to act on as it
  says.

Once a round is gated, pup replies on each thread it named: `Addressed in <sha>` with the
worker's reason, and resolves it; a declined thread gets the reason and stays open for you. One
summary comment per round. Never reply or resolve by hand on top of that. Minor issues in the
review body never take a round alone. A thread that opens a design decision reaches your
needs-you inbox through the worker's `pup session ask`: answer it there.

## 5. After the human merges

```
git pull --ff-only
pnpm worktree:remove --merged   # or the project's equivalent
pup audit                # re-stamps the baseline; run from main, it measures main
pup debt close <n>       # for ledger entries whose review-by names the merged task
```

Then the next task: `pup launch <task>`, or hand the order to the conductor.

## Gotchas that are not repo-specific

- A session left idle at `❯` reading STALLED after an API outage needs one
  `pup steer <id> "network is back, pick up where you left off"`. Nothing else wakes it.
- `core.bare=true` can appear on a main checkout after worktree add/remove cycles. Check
  `git rev-parse --is-bare-repository`; fix with `git config core.bare false`.
- Under the gate sandbox the default TMPDIR is write-denied. A generated hook must `mktemp`
  beside its own files.
- Every string read from `~/.pupitre` is session-writable and must be scrubbed before it prints.
  Multi-line details are scrubbed line by line: a single scrub over the whole block folds it
  onto one line and cuts it at 300 characters.
- A `[` in a git revision turns `git diff a...b` into a pathspec glob that exits 0 on unknown
  refs. Mock the git client in CLI tests rather than trusting a passing call.
- A pre-commit that runs the full suite can hang one test for minutes under load. Run the
  suite directly, then commit.
