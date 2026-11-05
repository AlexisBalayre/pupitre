# 0024. Custom adapter escape hatch = `sh -c` commands with a JSON stdout contract (2026-07-24)

- Status: accepted

24. **Custom adapter escape hatch = `sh -c` commands with a JSON stdout contract
    (2026-07-24).** `.pupitre/adapter.yml` maps `build`/`test`/`lint` (exit-code gated)
    and `depGraph`/`deadCode`/`duplication`/`complexity`/`coverage` (capability JSON on
    stdout; `complexity` gets the file list as JSON on stdin) to shell commands, plus an
    optional `id`. Strict on config: unknown keys and non-string values throw at load —
    a typo'd key silently dropping a stage is worse than a crash. Strict on output too:
    a failing or non-JSON capability command throws a named error rather than skipping;
    only `coverage` uses its existing "unavailable" channel. The config is read from the
    trusted main checkout, but commands execute in whichever checkout is being measured.
    Unlike package.json (which sessions legitimately edit, accepted exposure), the
    escape hatch is pure gate-defining config a session has no reason to author — so
    `.pupitre/**` joins `.claude/**` in the protected-path globs and any session diff
    touching it hard-fails the scope audit. Humans own the file; a human omitting a
    stage is a visible choice (the gate reports it skipped "not measured" every run).
    When present, the custom adapter outranks the built-ins in the registry, since
    overriding them is its purpose.
