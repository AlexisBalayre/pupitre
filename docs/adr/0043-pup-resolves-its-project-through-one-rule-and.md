# 0043. `pup` resolves its project through one rule, and the store decides only when it cannot be wrong (2026-09-05)

- Status: accepted

43. **`pup` resolves its project through one rule, and the store decides only when it cannot be
    wrong (2026-09-05).** Every command opened with `resolveProject()`, which shelled out to
    `git rev-parse --git-common-dir` from cwd and, outside any repo, died with the raw
    `execFileSync` stack (exit 128) — `pup status` from `$HOME` was a crash, and the
    `--project <id>` docs/02 had promised since the beginning had no implementation. The rule,
    the operator's: inside a git repo the repo wins, unchanged. `--project <id>` wins over that,
    from anywhere, including inside a different repo, and an unknown id refuses in one line that
    names the registered ids. Outside any repo the store under `~/.pupitre` — one directory per
    project id, each with its own `state.db` and `projects` row — is consulted, and only
    projects whose repo still exists on disk count: exactly one live project is used silently,
    even with stale ones beside it; several live ones are printed as `id  repo_path`, one per
    line with the stale ones marked `(missing)`, and refused with one line asking for
    `--project <id>`, because a guess would run a command against a repo the operator did not
    name; none live refuses with one line — naming the stale ids as missing when there are any,
    pointing at `pup init` either way.
    *One seam, not per-command branches.* `resolveProject(cwd, projectId?)` is still the only
    function that turns a place into a project; `--project` is a global option on the program
    that a single closure in `buildProgram` hands to it, so the twenty call sites changed one
    name and gained no branch. `pup profile`, which reached `repoRoot()` directly for its
    profiles dir, goes through the same closure now, so `--project` reaches it too. The
    refusals are a `ProjectResolutionError` the entry point maps to its message and exit 1 —
    the operator's to resolve, not a bug — while anything else that escapes `parse` still
    crashes with its stack. Git's own "fatal: not a git repository" is captured instead of
    echoed, since outside a repo it is the expected answer and pup speaks for it.
    *A project whose repo is gone is reported, never used.* Projects are keyed by the hash of
    their `repo_path`, so a repo deleted or moved leaves a registered project with no repo
    behind it — three of the four in the first real store were temp dirs from smoke tests, and
    counting them made "exactly one" never match, so `pup status` from `$HOME` refused with a
    listing on the very store the rule was written for. A project with no repo could never
    have been the answer, so it does not count toward the choice; it is still shown in the
    listing marked `(missing)`, and an explicit `--project` on it refuses with the id and the
    path that is gone, because most commands shell into that path and would fail worse.
    *Reaching another project is operator-only.* Every operator-only guard (decisions 26, 40,
    42) asks `callingSession` of the store it was handed — the session's worktree and its
    `PUP_SESSION_ID` are rows there — and a session handed another project's store is unknown
    in it, so `pup --project <other> new|plan|launch|kill` from inside a session would have
    passed every guard at once; and the store's auto-select outside any repo is the same door
    without the flag, since a session that cd's out of every repo is handed the only live
    project's store just the same. The repo around cwd is therefore the one project the shared
    resolver hands over unguarded; every other path — `--project`, or the store choosing —
    refuses on `PUP_SESSION_ID` alone first, because outside every repo there is no own store
    to be found in and decision 42's ceiling must still need both the move and the unset, and
    then when the session's own store, the repo around cwd, reports a calling session; same
    detection, same ceiling as decision 27, and the target store is never opened for the check
    because it is exactly the store that cannot know.
    *The scan trusts nothing under `~/.pupitre`.* Every store there is read, including ones a
    session wrote through the shared base or a stray file dropped in: read-only, without the
    schema and migrations `openStore` runs, and a store that cannot be read is no project rather
    than every command's crash — said once on stderr, naming the store, because a project that
    vanishes from the listing when its store loses its permissions is otherwise a mystery; an
    empty `projects` table, which `pup status` in a never-initialised repo creates, is silent.
    When the store makes the choice it says so too, `Using project <id> at <path>` on stderr,
    since the command's output otherwise reads as if the operator had named the project, and
    the path is the store's to write. A row counts only when its id is the directory's name and the
    hash of its own `repo_path` — ids derive from paths, so a row that fails to derive is a
    store planted or renamed to answer for a repo it is not keyed to, and is skipped. The
    `repo_path` a store reports and the id argv passes are sanitized before they reach the
    terminal, the listing included, by decision 29's rule.
    *What this leaves open.* An explicit `--project` on a gone repo could still serve the
    read-only commands (`report`, `log`, `debt`) from history alone; it refuses today for the
    simpler rule, and reading history for a deleted repo is its own change if it is wanted. A
    store directory holding a `state.db` with no `projects` row — `pup status` in a repo that
    never ran `pup init` creates one — is not a project and is skipped. Nothing prunes stale
    projects; a `pup init --forget <id>` would be the place.
    *Addendum, 2026-09-21: `pup status` reads across stores, and `pup ui` will with its next
    task; nothing else may.*
    Outside any repo, `pup status` no longer picks the one live project or refuses with the
    listing: it prints the fleet view, one block per registered project, and `pup status --all`
    prints the same from anywhere (decision 60). Reading every store is a third door to
    another project's store beside `--project` and the auto-select, so it carries the same
    guard — refused on `PUP_SESSION_ID` or a calling conductor alone, then on the session's own
    store — and a project whose repo is gone is still reported, never used: listed as missing,
    its store never opened. The exemption is for the two readers only; `pup ui --all` is the
    next change and is recorded there. Every other command keeps this decision's rule
    unchanged — outside a repo with several live projects it lists them and asks for
    `--project <id>`, because a command that writes must be pointed at one project by name.
