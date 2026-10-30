# 0126. A kickoff names the tracked files its scope-in matches, at most 40, and the globs that match none as files to create (2026-10-30)

- Status: accepted

126. **A kickoff names the tracked files its scope-in matches, at most 40, and the globs that
    match none as files to create (2026-10-30).**
    A worker's kickoff gave its scope as globs, so its first turns went to finding the files
    behind them, and each parallel worker did that again. Reading and searching code was about 26%
    of what workers re-read on 2026-10-26. A compiled worker context now has a `## Files in scope`
    section under Scope. It lists the tracked files the scope-in globs match when the profile is
    compiled, as paths only. Past 40 it shows the first 40 and a `+N more` line. Each scope-in glob
    that matches no file is listed as one to be created.
    *Which files.* The list comes from `git ls-files` on the repo, not the worktree, which may not
    exist yet when a launch compiles. It is matched with `scopedPaths`, the gate's own precedence.
    So a protected path or a file scope-out takes back is never listed, since the session could not
    commit it. `scopeInFiles` in `task-spec.utils.ts` does the matching. Paths and globs are
    scrubbed of control characters, as a peer's files are (decision 99).
    *A hint, not a control.* When git cannot list the repo, the context compiles with no section,
    and the session searches as it did before. A launch is not refused over a missing hint. The
    list is part of `context.md`, so it is in the profile hash like the knowledge slice.
    *Cost.* Forty paths are about 400 tokens, well inside the context budget.
    *Tests.* A scope-in of `src/core/land*.ts` lists `land.service.ts` and `land.test.ts` and not
    `island.ts`, `land.md`, `landing/inner.ts` or `src/cli/land.ts`. Scope-out and `.claude/` are
    left out. A glob matching nothing is listed as to be created. 45 matches show 40 and `+5 more`.
    A directory that is not a repo compiles with no section.
