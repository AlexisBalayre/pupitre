# 0029. Capabilities take a two-path context and say why they measured nothing (2026-07-25)

- Status: accepted

29. **Capabilities take a two-path context and say why they measured nothing
    (2026-07-25).** Closes the two adapter-interface items decisions 25 and 26 deferred, in
    one migration rather than two passes over the same signature. Every capability now
    takes a `CapabilityContext { measurePath, configPath }` instead of a bare path. The
    split exists because the two checkouts are not equally trusted: measurement has to
    happen in the session's worktree, but *which tools are declared* now resolves from the
    main checkout the merge lock holds at the target branch. That closes the exposure
    decision 25 accepted — a session could drop `vulture` from its `requirements.txt`, or
    `@vitest/coverage-v8` from its `package.json`, and turn a debt stage into a skipped
    "not measured". TypeScript's dead-export entry points come from the trusted manifest
    for the same reason. Outside the gate (`pup init`, the code map) both paths are the
    same checkout, via `localContext()`.
    Second half: the `undefined` that meant "no measurement" becomes
    `{ unavailable: reason }`, and the gate prints the reason. "not measured — dead-code
    tooling unavailable or the run failed" told an operator nothing; "not measured —
    vulture failed: vulture: command not found" tells them what to fix. Failure text is
    collapsed to one line and capped, stderr preferred, so one broken tool cannot swamp
    the report. `undefined` on the *capability itself* still means the adapter has no such
    capability — one channel per question, rather than two nullish ones.
    Note the invariant this preserves: an empty array is a measurement, not an absence.
    `pup init` keys "did any adapter measure?" on the per-adapter result list, so an
    adapter that measured and found nothing still stores a real `[]` baseline instead of
    leaving the bar unset.
    **The split covers tool *declaration*, not tool *configuration*, and that distinction
    matters.** A capability still runs with the worktree as its working directory, because
    that is the code being measured, so per-tool config there still applies: vulture reads
    `[tool.vulture]` from its CWD, coverage reads `vitest.config.ts` / `[tool.coverage.run]`
    from the session's. Left alone, that is worse than what decision 25 accepted — a
    worktree `[tool.vulture]` aiming the scan at an empty path yields a PASS on a fake
    empty measurement and ratchets the baseline to nothing, where the old exposure only
    produced a visible skip. So vulture declines to measure at all when the worktree's
    section differs from the trusted one (text compare; fully honouring the trusted config
    needs a TOML parser, which docs/08 gates). The equivalent for coverage config is NOT
    closed: a session can still fail its instrumented run into a skip, or `coverage.exclude`
    its changed files into "no instrumentable changed lines", which the gate passes for
    free. Flagging changed-but-uninstrumented files is the fix and is deferred. Capability
    tool *binaries* also still resolve from the worktree (`.venv/bin`, `node_modules/.bin`,
    both normally gitignored, so neither the clean check nor the scope audit sees a planted
    one) — code execution there is already accepted by decisions 24 and 28, but it means
    measurement integrity rests on the worktree, and no claim here should suggest otherwise.
    Reasons are sanitized where they are consumed, not where they are produced: a custom
    adapter's reason is parsed JSON that never passed through `failureSummary`, and it
    reaches the operator's terminal and the fenced PR body. Control characters go (ANSI
    cursor moves could repaint a FLAGGED row as PASS on the screen the operator decides
    from), whitespace collapses so a closing fence cannot break out, and the cap counts
    code points. For the same reason `isUnavailable` is a shape check hardened against
    `null` and primitives rather than an `in` test, and custom-adapter JSON is shape-checked
    per capability — otherwise a script measuring session code could print
    `{"unavailable": …}` and convert its own measurement into a skipped stage.
    Behavioural note: TypeScript dead-export entry points now come from the trusted
    manifest, so a PR that legitimately adds a new `bin`/`exports` entry has that file's
    exports counted as dead in its own merge. `--accept-debt` covers it; the next `pup
    audit` after the merge clears it.
