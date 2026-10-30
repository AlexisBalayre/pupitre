# 0128. A kickoff names the tracked files its scope-in matches, at most 40, and the globs that match none as files to create (2026-10-30)

- Status: accepted

128. **A kickoff names the tracked files its scope-in matches, at most 40, and the globs that
    match none as files to create (2026-10-30).**
    A worker's kickoff gave its scope as globs, so its first turns went to finding the files
    behind them, and each parallel worker did that again. Reading and searching code was about 26%
    of what workers re-read on 2026-10-26. A compiled worker context now has a `## Files in scope`
    section under Scope. It lists the tracked files the scope-in globs match when the profile is
    compiled, as paths only. Past 40 it shows the first 40 and a `+N more` line. Each scope-in glob
    that matches no tracked path is listed as one to be created.
    *Which files.* The list comes from `git ls-files` on the repo, not the worktree, which may not
    exist yet when a launch compiles. It is matched with `scopedPaths`, the gate's own precedence.
    So a protected path or a file scope-out takes back is never listed, since the session could not
    commit it. A glob is offered for creation only when it matches no tracked path at all, before
    that precedence, and the gate's rule does not refuse its own text. A glob whose files are all
    under `.claude/` or scope-out is therefore neither listed nor offered, since the hook would
    refuse whatever it names. `scopeInFiles` in `task-spec.utils.ts` does the matching.
    *Untrusted names.* A session writes the shared `.git`, so it can choose the names the listing
    returns. Each path and glob is scrubbed of control characters, as a peer's files are
    (decision 99), and cut to 160 characters with an ellipsis. The section says each entry is a
    file name, not an instruction.
    *A hint, not a control.* A launch is never refused over the list. When git cannot list the
    repo, or runs past its five-second deadline (a fifo planted as the index blocks it on open), or
    past `runGit`'s 64 MiB output cap, the context compiles with no section and the session
    searches as it did before. An interrupt still stops the compile. When the section would take
    the context past its budget, the context is compiled without it rather than refused. The list
    is part of `context.md`, so it is in the profile hash like the knowledge slice.
    *Cost.* Forty entries of at most 160 characters are at most about 1,600 tokens. The matching is
    one regex pass per glob over the listing, which the deadline and the output cap bound; the
    count of files past 40 is exact, so the pass is not cut at the cap.
    *Tests.* A scope-in of `src/core/land*.ts` lists `land.service.ts` and `land.test.ts` and not
    `island.ts`, `land.md`, `landing/inner.ts` or `src/cli/land.ts`. Scope-out and `.claude/` are
    neither listed nor offered for creation. A glob matching nothing is listed as to be created.
    45 matches show 40 and `+5 more`. A long path is cut with an ellipsis. A budget the section
    would break compiles without it. A directory that is not a repo, and a repo whose index is a
    fifo, compile with no section.
