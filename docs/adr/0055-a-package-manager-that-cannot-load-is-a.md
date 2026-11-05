# 0055. A package manager that cannot load is a broken cache, not a baseline (2026-09-17)

- Status: accepted

55. **A package manager that cannot load is a broken cache, not a baseline (2026-09-17).**
    Twice (2026-08-31, 2026-09-05) a half-extracted corepack download left
    `pup-toolchain-cache/<projectId>/corepack/v1/pnpm/<version>/bin/` empty. It sticks, and
    corepack is the reason: the directory has no `.corepack` marker, so corepack downloads
    again, the rename into place fails because the directory exists, corepack reads that as
    "another instance installed it" and runs the empty one. Every sandboxed stage then died on
    `MODULE_NOT_FOUND` for `pnpm.cjs`, and `pup audit` stored build/test/lint FAIL, plus a
    `baseline_history` row, as the bar the next merge gated against.
    *Repaired before the first child.* `toolchainCacheDir` moves aside every
    `v1/<manager>/<version>` whose `bin/` is empty, renamed `<version>.corrupt-<ms>`, so the
    next stage downloads it again. It runs when a process first resolves a repo's cache, the
    same place the cache is created, so an install that breaks during a run is repaired by the
    next run, not mid-gate. An empty `bin/` is never a download still in progress, because
    corepack extracts into `v1/corepack-<pid>-<hex>` and renames the finished directory into
    place; those temp directories are skipped all the same, since another process may be
    filling one. Moved rather than deleted, so whoever wants to know how it broke still can.
    The trigger is the shape that was observed and nothing wider: a cache the rule
    misreads would cost a working package manager.
    *Recognised when it is not repaired.* `brokenPackageManagerInstall` reads a stage's output
    for Node's missing-entrypoint banner: `Cannot find module '<path>'`, `MODULE_NOT_FOUND`
    and an empty `requireStack`, with the path inside a corepack install tree. The empty
    require stack is the discriminator. A missing module the project's own code required has
    a stack, and that failure is the checkout's to answer.
    *Refused, not stored.* `initProject` runs that check on every failed stage and throws
    `BrokenToolchainError`, naming the install directory, before it writes the
    `baseline_history` row or `projects.baseline`. The check lives in `initProject` rather
    than `auditProject`, so `pup init` is covered as well as `pup audit`: both would otherwise
    store the crash as the bar. It runs straight after the stages, before the debt
    capabilities, because those call the same package manager and would only spend minutes
    failing the same way. Neither command catches it yet, so it surfaces as a crash: the
    message on the first line, then a stack. That is loud and stores nothing. Routing it
    through the guard that reports a repo with no adapter, as one line and exit 1, is a CLI
    change outside this task's scope. The project row itself may
    exist, because `ensureProject` runs before any stage. That row carries no baseline, so it
    is not a bar.
