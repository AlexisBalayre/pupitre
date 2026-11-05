# 0025. Python debt capabilities ship as declared-tool shell-outs (2026-07-24)

- Status: accepted

25. **Python debt capabilities ship as declared-tool shell-outs (2026-07-24).** The Python
    adapter grows `deadCode` (vulture) and `coverage` (pytest-cov). Each runs only when the
    repo's own config declares the tool (the decision-22 raw-text probe, widened to
    pyproject/setup.cfg/requirements.txt), through the lockfile runner prefix, with the
    gate-command budget and the scrubbed git env. Vulture exit 3 is the findings report,
    not a failure; named findings map to `DeadExport` pairs and nameless unreachable-code
    findings are dropped, since the baseline keys on file+name. A `[tool.vulture]` section
    owns paths and excludes; without one the scan gets the compileall skip list.
    coverage.py's JSON report maps executed → covered, executed+missing → instrumented.
    To carry "declared but missing or crashed", `deadCode` adopts coverage's unavailable
    channel (`DeadExport[] | undefined`): the gate reports the stage skipped
    "not measured", and init stores no dead-export baseline rather than a false empty one.
    Trust: config is probed from the checkout being measured — the decision-24 package.json
    class of accepted exposure. A session editing its manifest can silence these stages,
    but only into a visible skipped "not measured". Hardened where cheap: capability
    `uv run` gets `--no-sync` so a worktree-planted lockfile cannot install packages,
    vulture findings are line-anchored and repo-contained before touching the baseline, and
    capability stdout gets an explicit 64 MiB buffer so an induced overflow cannot silently
    degrade a stage. Resolving capability config from the trusted main checkout (the
    `gateCommands` split) needs a two-path capability signature and is deferred.
    `duplication` (normalizeLines is `//`-comment-aware, and generalising at a second use
    contradicts the third-use rule) plus `complexity` and `depGraph` stay deferred.
