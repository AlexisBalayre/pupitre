# 0128. A kickoff names the tracked files its scope-in matches, at most 40, and the globs that match none as files to create (2026-10-30)

- Status: accepted

128. **A kickoff names the tracked files its scope-in matches, at most 40, and the globs that
    match none as files to create (2026-10-30).**
    A worker's kickoff gave its scope as globs, so its first turns went to finding the files
    behind them, and each parallel worker did that again. Reading and searching code was about 26%
    of what workers re-read on 2026-10-26. A compiled worker context now has a `## Files in scope`
    section. It lists the tracked files the scope-in globs match when the profile is compiled, as
    paths only. Past 40 it shows the first 40 and a `+N more` line. Each scope-in glob that matches
    no tracked path is listed as one to be created.
    *Which files.* The list comes from `git ls-files` on the repo, not the worktree, which may not
    exist yet when a launch compiles. It is matched with `scopedPaths`, the gate's own precedence.
    So a protected path or a file scope-out takes back is never listed, since the session could not
    commit it. A glob is offered for creation only when it matches no tracked path at all, before
    that precedence, and the gate's rule does not refuse its own text. A glob whose files are all
    under `.claude/` or scope-out is therefore neither listed nor offered, since the hook would
    refuse whatever it names. `scopeInFiles` in `task-spec.utils.ts` does the matching.
    *Untrusted names.* A session writes the shared `.git`, so it can choose the names the listing
    returns. The section sits below the Session protocol, after every rule it could contradict, as
    the brief does (decision 57), and says each entry is a file name, not an instruction. Each
    path and glob has its control characters scrubbed, as a peer's files do (decision 99), and its
    format characters (bidi overrides, zero-width) and line and paragraph separators replaced, then
    is cut to 160 characters with an ellipsis. A path holding `\n`, U+2028 or U+2029 is never
    listed at all: a glob's `*` and `**` stop at a line terminator, as the gate's do.
    *A hint, not a control.* A launch is never refused over the list. When git cannot list the
    repo, or runs past its five-second deadline (a fifo planted as the index blocks it on open), or
    past `runGit`'s 64 MiB output cap, the context compiles with no section and the session
    searches as it did before. An interrupt still stops the compile. When the section would take
    the context past its budget, the context is compiled without it rather than refused.
    *Not in the hash.* The profile hash covers `context.md` as compiled without the section. The
    list follows the repo's index, which a session can write and every land moves, so hashing it
    would let a session forge config drift and mark every live session stale whenever main
    changed. The hash is therefore no longer over every compiled byte: the list is the one part of
    the context it does not attest.
    *Cost and its ceiling.* Forty entries of at most 160 characters are at most about 1,600
    tokens. The matching is one pass of every scope-in pattern over the listing, then the gate's
    precedence over the paths that matched, under a two-second deadline checked between paths
    and between batches of a thousand; past it the section is omitted. The count past 40 is
    exact, so the pass is not cut at the cap. The deadline bounds the pass, not one regex test: a
    glob of repeated `**/` against a deep path can backtrack inside a single test, which no
    in-process check interrupts. That ceiling is not new: the launch's overlap check (decision 99)
    and the gate's scope audit run the same patterns over the same listing without a deadline.
    *Tests.* A scope-in of `src/core/land*.ts` lists `land.service.ts` and `land.test.ts` and not
    `island.ts`, `land.md`, `landing/inner.ts` or `src/cli/land.ts`. Scope-out and `.claude/` are
    neither listed nor offered for creation. A glob matching nothing is listed as to be created.
    45 matches show 40 and `+5 more`. A long path is cut with an ellipsis. Paths holding a newline
    heading, U+2028, U+2029, ESC, C1 `\u009b`, U+202E and U+200B leave none of those characters
    in the section, and every entry line starts with `- `. The section sits below the Session
    protocol. Adding a tracked file changes the context and not the hash. A budget the section
    would break compiles without it. A passed deadline gives no match. A directory that is not a
    repo, and a repo whose index is a fifo, compile with no section.
