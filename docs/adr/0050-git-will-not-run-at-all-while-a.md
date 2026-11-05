# 0050. Git will not run at all while a filter or merge driver is armed (2026-09-13)

- Status: accepted

50. **Git will not run at all while a filter or merge driver is armed (2026-09-13).**
    Decision 41 stated this as a ceiling and said what its honest fix was: "a smudge filter
    armed through the untracked `info/attributes` runs on `git worktree add` and on the gate's
    rebase, and has no `-c` disarm because its driver name is chosen by whoever wrote it."
    Verified reachable then, reproduced again here against Apple Git 2.39.5 before anything was
    written: `$GIT_COMMON_DIR/info/attributes` holding `* filter=pwn merge=pwn`, plus
    `filter.pwn.smudge` and `merge.pwn.driver` in the shared config — all three writable from a
    worktree with a plain `git config` and a redirect, none of them in any diff — and the
    script runs once per checked-out file under `launchTask`'s `worktree add`, and again on the
    gate's `git rebase`, with the operator's environment and ahead of the sandbox that is
    supposed to confine the session.
    *There is nothing to disarm, so the answer is to stop.* Every other key in this class went
    into `GIT_SAFE_CONFIG` as `-c key=`, because the key is fixed and pup can name it first.
    Here the key is `filter.<anything>.smudge`, and the `<anything>` is chosen by whoever armed
    it, so there is no command line that outranks it. That leaves decision 6's shape:
    `assertNoArmedGitDrivers` reads the two surfaces before each call and refuses loudly,
    naming the path and what is armed, because "clear it and retry" is only actionable if the
    operator knows which key and which file.
    *Armed means a key that names a command, not a namespace.* `filter.<name>.clean|smudge|process`
    and `merge.<name>.driver` execute; `merge.conflictstyle`, `merge.ff` and
    `filter.<name>.required` do not. Refusing on `^(filter|merge)\.` whole would refuse a repo
    whose operator set an ordinary preference, which is a defence nobody keeps switched on.
    `info/attributes` counts on its own, with no driver named anywhere: the file is inert until
    one is, but nothing else in a pup repo writes it, and a `-diff` pattern there already
    forges the diff the coverage stage reads (decision 41). The pair cannot be assembled
    without tripping one half.
    *`--list --show-scope`, not `--local --get-regexp`.* The obvious read misses a scope and
    cannot be fixed by adding `--worktree` beside it: with `extensions.worktreeConfig` off,
    `git config --worktree --get-regexp` silently answers out of the local file, so the two
    scopes cannot be asked for separately. They have to be, because `extensions.worktreeConfig`
    itself lives in the shared config — a session turns it on, writes `filter.pwn.smudge` into
    its own worktree's `config.worktree`, and a `--local` read from the main checkout sees
    nothing while the rebase, which runs *in that worktree*, runs the filter. Reproduced
    against the shipped gate, and it is why the gate asks at both paths: the rebase runs in the
    worktree, the ff-only merge in the main checkout. `global` and `system` are excluded on
    purpose — they are the operator's own, and a developer with git-lfs installed globally
    would otherwise never launch anything.
    *Read where git will run, which is the inverse of decision 30's rule and safe here.* That
    rule says measure from the trusted checkout so a session cannot aim the question at its own
    index. This reads at the path the command will use, including a session's worktree, because
    this measurement only ever *adds* findings: the config and the attributes file are shared,
    so a worktree reports everything the main checkout does plus its own scope, and there is no
    quieter answer for a session to point it at.
    *`pup new` asks before it writes,* the same reordering decision 41 made for the overlap
    check and for the same reason: a refusal inside `launchTask` alone would leave the spec the
    operator just abandoned sitting in the backlog, unclaimed and attributed to them.
    *The functional cost, stated.* A repo that legitimately configures git-lfs (or any clean/
    smudge pair) in its *local* config can no longer be launched or merged until that moves to
    the operator's global config or goes. That is the same trade as clearing the sign flags in
    decision 41 — loud, and the right direction, because the alternative is a documented and
    inert defence.
    *Ceilings.* This is check-then-run, not a lock: a driver armed in the window between the
    check and the command still runs, which narrows the exposure from always to milliseconds
    and does not close it. A tracked `.gitattributes` on the session's own branch is honoured
    by the rebase before the scope audit ever sees it, but it cannot execute without a driver
    in the config, which is refused — the attributes half alone is inert. Decision 41's other
    two open ceilings are untouched here and still open: the session-controlled push target
    (`url.<base>.insteadOf` or a rewritten `remote.origin.url`; the rewrite half closed by
    decision 54), and `gitDiffNumstat` forgeable
    by the same `* -diff` line (closed by decision 53). And the boundary remains the OS user
    (decisions 44, 45, 47):
    a session that can write the shared git dir can write a great deal else, and what is closed
    here is the specific path from that write to code running with the operator's environment
    on pup's own git calls.
