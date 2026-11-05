# 0022. Python adapter ships the v1 gate surface only (2026-07-24)

- Status: accepted
- Amended by: [0072](0072-one-debt-module-for-pup-init-pup-audit.md)

22. **Python adapter ships the v1 gate surface only (2026-07-24).** Detect (any of
    pyproject.toml / setup.py / setup.cfg / requirements.txt) plus build/test/lint
    commands: byte-compile via `compileall` as the build check, pytest and ruff only
    when the repo's own config declares them, all run through `uv run` / `poetry run`
    when the matching lockfile exists. Config probing is raw-text on pyproject — the
    stack has no TOML parser and docs/08 gates new dependencies. depGraph and the
    debt capabilities are deferred; the code map and debt-delta stages degrade to
    "not measured" per docs/06. Adapter selection moves to `adapter.registry.ts`:
    detection order is priority order, TypeScript first, and single-adapter flows
    (merge, map) use the first hit. *Amended by decision 72:* the merge gate's
    debt stages measure every detected adapter; only its hard stages and the
    nested-package check still use the first hit.
