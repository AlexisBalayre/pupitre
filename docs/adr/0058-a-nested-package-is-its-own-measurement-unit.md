# 0058. A nested package is its own measurement unit (2026-09-21)

- Status: accepted

58. **A nested package is its own measurement unit (2026-09-21).** #95 added `tools/review`, a
    package with its own `package.json`, lockfile, vitest config and tests, and the TypeScript
    adapter measured it as part of the root. Its eight source files joined the root coverage
    report through decision 30's `--coverage.include` glob, instrumented and never run by the
    root's `src/**/*.test.ts`, and its exports, consumed by its own scripts rather than by any
    root module, read as dead. `pup audit` on 2026-09-18 recorded coverage **92.3% → 84%** and
    dead exports **14 → 19**, and the gate flagged five `tools/review` exports as new dead code
    on PR #99. None of it was debt anyone could act on from the root.
    The rule is decision 32's: exclude only what the runner cannot be expected to cover, and say
    why. A directory below the measured root that commits its own `package.json` has its own
    runner, so the root runner is not expected to cover it, and it is skipped the way
    `.worktrees/` is skipped as another checkout. `nestedPackageDirs` answers it in
    `git-tree.client.ts`, once per capability call. The source walk stops there, which
    takes the directory out of the dependency graph, dead exports and duplication together.
    `coverableFiles` does not expect coverage for a file inside one, and `rootCoverageReport`
    drops the same files from the report with the same predicate, so report and expectation
    cannot drift (decision 32's reason for sharing `isCoverageExcluded`). Filtered in pup after
    the run, as decision 32 did, so the worktree's vitest config has no say. There is no
    path-specific rule for `tools/review`; any workspace member gets the same treatment.
    *The marker must be committed in both checkouts.* A `package.json` is one file a session
    can write anywhere, so the check is decision 31's AND over `measurePath` and `configPath`:
    a nested package a session creates is counted at the root in its own merge and leaves the
    metrics after it has landed. **The first cut read both sides from the filesystem, and the
    operator's security review found that the AND bought nothing:** an untracked
    `src/core/package.json` dropped into the main checkout from a session shell is diffed by
    nothing and hashed by nothing, and the gate checks only the worktree for dirt, so that file
    plus the same file committed on the branch exempted `src/core/` from dead code,
    duplication and coverage in the session's own gate with nothing merged. Markers now come
    from `git ls-tree -r HEAD` in each checkout, run with `GIT_SAFE_CONFIG`, `scrubbedGitEnv`
    and a timeout as `readOriginUrl` does. The review proposed `git ls-files`; that reads the
    index, and the main checkout's index is also the session's to `git add` an untracked file
    into, with nothing checking it, so only `HEAD`'s tree counts. Reading a tree also makes the
    symlink, directory and empty-file questions moot: a marker is whatever git committed at
    that path, and there is no filesystem type left to check. A checkout git cannot list
    contributes no markers, so nothing is exempt, the safe direction.
    Each direction is asserted, and each test was proven by mutation, each restored from a
    backup copy: making the set always empty fails the three tests that name a nested package;
    taking the union of the checkouts' markers instead of the intersection fails exactly the two
    that commit the marker in the worktree alone (weakening `every` to `some`, the first cut's
    mutation, is an equivalent mutant over two checkouts and was replaced by the union);
    reading the index (`ls-files`) fails the staged-marker test; reading untracked files too
    fails the three untracked- and staged-marker tests; dropping the coverage filter from
    `rootCoverageReport` fails its own test, which the first cut lacked, leaving the suite
    green with that line removed; and matching a nested directory as a string prefix fails the
    two tests that hold a sibling (`pkgs/` beside `pkg/`). A directory without its own
    `package.json` is still walked, with a test.
    *Ceilings, stated plainly.* **Closed by decision 59:** the gate now runs a touched nested
    package's own `test` and `typecheck`, the three debt stages name what they left out,
    `DUPLICATION_RULE_ID` is bumped, and the review workflow runs the merge base's
    `tools/review`, not the PR head's. As stated at the time: **`tools/review` is now measured
    by no stage except scope-audit and complexity.** Nothing invokes its own runner: the root `tsc` includes `src` only, the
    root vitest includes `src/**/*.test.ts` only, biome ignores `tools/review`, and the review
    workflow installs it and runs its scripts but never `pnpm --dir tools/review test`. That
    workflow executes the PR head's `tools/review` code with a write token, so this is the
    least-measured code in the repo with the most privilege. This decision takes it out of
    metrics it was only distorting; it does not measure it. The follow-up makes the gate run a
    touched nested package's own `test` and `typecheck` scripts, and makes dead-code,
    duplication and coverage print "N changed file(s) in a nested package not measured here"
    rather than pass silently (decision 29: a capability says what it did not measure).
    The trusted side is trusted one merge deep, so a PR that commits `src/core/package.json`
    and merges exempts `src/core/` from then on; that is decision 31's accepted residual, and
    it is a visible line in a PR diff. The root's runner is not consulted: a nested package
    whose tests the root vitest config *does* collect is still dropped, so its files leave the
    root's metrics although the root could measure them. That too needs the marker merged
    first, and is the price of not parsing runner config. Complexity is unaffected; it is
    measured per changed file and does not depend on which unit the file belongs to. vitest
    still instruments the nested package's files before pup discards them, decision 32's same
    bounded waste.
    *Python does not apply the rule.* The observed cost came from two things the TypeScript
    adapter owns and the Python adapter does not: a source walk of its own, and an include glob
    that reports unloaded files as 0%. Python's dead code and coverage are delegated to vulture
    and pytest-cov under the repo's own config, which decides their scope, and with no
    include-equivalent (decision 30) an unimported nested module is absent from the report
    rather than dragging the ratio down. What would carry over is `coverableFiles` flagging a
    changed file in a nested Python project as unreported, and the marker there
    (`pyproject.toml`, `setup.py`, `setup.cfg`) is a different question with no Python repo here
    to dogfood it against, so it is deferred rather than guessed at.
    *Observed cost, and the re-stamp.* The 84% and 19 baselines stamped on 2026-09-18 were
    counted under the old rule. As decision 39 learned, a gate change cannot be validated by the
    gate: `pup merge` runs the main checkout's adapter, so this change was judged by the rule it
    replaces, and nothing was run against itself to prove it. The operator re-runs `pup audit`
    on main after it lands to re-stamp the baseline. Measured directly on this tree before
    landing, dead exports are 15 with none under `tools/`; the one above the pre-#95 14 is a
    genuine dead export added since, not this rule. Until that audit the three metrics differ:
    - *Coverage* carries no rule id, so a baseline counted the old way (84%) sits below what
      the new rule measures (about 92%), and a merge can drop coverage by up to that gap
      unflagged.
    - *Dead exports* have no window. They are compared as sets of file and export name, so the
      stale `tools/review` keys in the stored baseline are simply entries nothing can reach
      again, and a new dead export is still new.
    - *Duplication* keeps `DUPLICATION_RULE_ID` unchanged, so it compares a new-rule number
      against an old-rule baseline until the follow-up bumps the id or `pup audit` re-stamps.
      Today the gap is zero, because `tools/review` holds no counted duplicate block, but it is
      the check decision 39 built the id for, and it is not being made here.
    The re-stamp has a cost of its own: it *raises* the bar a PR's patch coverage is held to from 84% to about 92%, so
    an unrelated later PR landing at 85–90% patch coverage will be flagged for a move it did
    not cause. That is the honest number arriving, not a regression, and the operator should
    expect it rather than reach for `--accept-debt`.
