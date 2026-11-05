# 0112. A worker reads a tracked file with the Read tool: a Bash call whose cat, sed, head, tail or nl reads one is refused (2026-10-27)

- Status: accepted

112. **A worker reads a tracked file with the Read tool: a Bash call whose cat, sed, head, tail
    or nl reads one is refused (2026-10-27).** In 14 worker sessions on 2026-10-26, 184
    `sed -n` reads made ~19% of re-read tokens: each dump stays in context and is re-read
    every later request, and ranges are re-dumped rather than revisited. A Bash read also
    fires no `.claude/rules` injection, which only a Read of a matching path does, so a
    worker that reads by shell never loads the conventions the rules carry.
    *The guard.* `hooks/read-guard.sh` runs on every worker Bash call, beside the bash and
    test guards. jq splits the command at `&&`, `||`, `;` and line breaks, keeps each
    pipeline's first command and drops its redirections, and prints the words a cat, sed,
    head, tail or nl there reads, past any `VAR=value` and the wrappers the test guard skips.
    A word naming a regular file git tracks in the worktree refuses the call with exit 2,
    telling the worker to use Read with offset and limit and that piping a command into tail
    or head stays allowed. Relative words resolve from the payload's `cwd`. The tracked check
    is `safe_git ls-files --error-unmatch` under the shared pins (decision 101) after
    `pinned_worktree`, so no session-written config runs. It runs from the worktree with
    the word's full path, which git normalizes, `..` and a symlinked prefix included; a path
    outside the worktree is outside the repository to git, so a file there goes through
    even when the worktree tracks one of the same name. Asked from the file's own directory
    with its bare name, git outside the work tree matched that name from the worktree root.
    *What goes through.* A filter of another command's output (`pnpm test 2>&1 | tail -40`,
    `git log | head`), since only a pipeline's first command is looked at. An untracked or
    ignored file, coverage output and scratch notes say. `sed -i`, which edits. A
    redirection's target, so `cat > notes.txt` writes as before.
    *Ceilings.* Best effort, like the bash guard (decision 6): it fails open. A quoted name
    holding a space, a glob, a read inside `$(...)` or `xargs`, an `awk` or `less`, and every
    call while the worktree's git pointers are not pup's go through. A here-doc's body is
    parsed as commands, so a body line reading a tracked file refuses the call. The
    conductor's hooks are unchanged: it reads main's checkout through the graph and the CLI,
    and has no `.claude/rules` of a task to miss.
    *Tests.* In `profile-compiler.test.ts`, over a real linked worktree: `sed -n 1,80p`, `cat`,
    `head -50`, `tail -n` of a quoted name, `nl`, `cat -n … | head`, reads after `&&`, `;`,
    `||` and a line break, behind `VAR=value` and through `/bin/cat` are refused, naming
    Read. Piped filters, a coverage report, an untracked file, a missing file, a directory,
    `sed -i`, `cat >` and `grep` go through. A relative name resolves from the call's `cwd`
    and an absolute one is refused. A `README.md` outside the worktree, by absolute path or
    as the main checkout's `../../README.md`, goes through, while `../../README.md` from
    `src/core` is refused. Every worker Bash entry runs the guard and the conductor's
    compiled files hold none.
