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

Run it plain first. If stages flag (diff size, complexity, dead exports, duplication, coverage),
re-run with `--accept-debt "<reason>" --review-by "<condition>"`. One reason is stamped on every
flagged stage, so write one that fits all of them. On pass the branch is pushed and a PR opened;
`pup status` then says `merged`, which means the PR exists, not that GitHub merged it.

Never validate a change to the gate with the gate on its own branch.

## 4. CI review

Wait with `until gh pr checks <n> | grep -v pending`. Address review threads in a hand-made
worktree (`git worktree add .worktrees/<task>-review pup/<task>`, install deps), reply and
resolve each thread, leave one PR comment for notes taken versus left as is, then
`git worktree remove` it. Before pushing a rename or a move, grep the decisions doc for the old
name. Never claim a fix in a reply before it is pushed.

## 5. After the human merges

```
git pull --ff-only
pnpm worktree:clean      # or the project's equivalent
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
  Multi-line details are scrubbed line by line; a whole-string scrub collapses them.
- A `[` in a git revision turns `git diff a...b` into a pathspec glob that exits 0 on unknown
  refs. Mock the git client in CLI tests rather than trusting a passing call.
- A pre-commit that runs the full suite can hang one test for minutes under load. Run the
  suite directly, then commit.
