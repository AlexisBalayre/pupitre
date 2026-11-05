# 0028. Gate and capability children get an env allowlist, and pup's git calls stop running repo hooks (2026-07-25)

- Status: accepted

28. **Gate and capability children get an env allowlist, and pup's git calls stop running
    repo hooks (2026-07-25).** Gate stage commands and adapter debt capabilities run code
    a session wrote — `package.json` scripts, `[tool.vulture]` config, the test suite
    itself — and they were inheriting pup's whole environment, which for a developer
    running `pup merge` in their own terminal means API keys, `GH_TOKEN`, cloud
    credentials, and `SSH_AUTH_SOCK`. `gateChildEnv()` replaces `scrubbedGitEnv()` at
    every such call site — gate stages, the TypeScript and Python capabilities, the
    custom adapter's `sh -c` (decision 24), and `pup init`/`pup audit`'s baseline stages,
    since main is "trusted" only in the sense that the gate let it in one merge earlier —
    keeping a fixed list (HOME, PATH, SHELL, USER/LOGNAME, TMPDIR, TZ, the LANG/LC_* and
    XDG_*_HOME families) and dropping everything else, GIT_DIR family included, so it
    subsumes decision-22's scrub instead of layering on it. `NODE_OPTIONS` is excluded
    deliberately: it can `--require` a module into every node the stage runs. Verified
    against this repo's own gate: build, test, and lint all pass under the allowlist.
    Escape hatch: `PUP_GATE_ENV=DATABASE_URL,CI` adds those names.
    **Hooks are the other half.** Worktrees share `$GIT_COMMON_DIR/hooks` with the main
    checkout, hooks are untracked so the scope audit never sees one appear, and the
    gate's own `git rebase` runs before any stage — so a planted `pre-rebase` executed
    with pup's full environment ahead of the sandbox meant to confine it. Every git call
    in the gate and in session creation now passes `-c core.hooksPath=/dev/null`, which
    outranks a session-written `.git/config` (decision 41 adds `core.fsmonitor=` beside it,
    a second command git runs on index reads that `hooksPath` does not cover).
    **What this is not.** It removes env-borne secrets from the child; it is not
    containment. `HOME` stays (dropping it breaks every toolchain), so a gate child can
    still read `~/.config/gh/hosts.yml`, `~/.aws/credentials`, `~/.npmrc`, `~/.ssh`, and
    write `~/.zshenv` — including setting `PUP_GATE_ENV` there for the operator's next
    run. Real containment needs `sandbox-exec`/bwrap/a container, and making the
    passthrough an operator-supplied flag rather than an inherited variable; both
    deferred.
    **On that flag, refined (2026-07-27):** it is worth doing, but not for the reason
    stated above, and it does not close the hole it is listed against. The primitive is the
    `HOME` write, and a `~/.zshenv` that can export `PUP_GATE_ENV` can equally define a
    shell function or alias wrapping `pup` with the flag already set. What a flag does close
    is *ambient* injection, which is a wider door than the login shell: direnv's `.envrc`
    lives in the repo, and a CI job, a Makefile or any wrapper process supplies an
    environment variable without anyone editing a dotfile. A flag is reachable only by
    rewriting the operator's command. So the ordering is the reverse of the sentence above —
    containment is the fix, the flag is defence in depth against a different vector.
    Note also that the profile YAML is *not* an option for this, idiomatic though operator
    settings there otherwise are: it lives in the repo, so a session could write it, which is
    the same channel decision 31 had to close for `python_files`. Pupitre's own git and gh calls keep the full `scrubbedGitEnv()`: they run
    pup's code, and pushing needs the operator's credential helpers.
    **Process-group kill stays deferred, now with a reason.** Reaping a timed-out
    stage's grandchildren (vitest workers, pytest-xdist) needs the child in its own
    process group (`detached: true`), and that costs Ctrl-C: today the terminal's SIGINT
    reaches the whole group, so an operator can abort a ten-minute stage; detached, it
    would kill only pup and orphan the stage. Doing both needs a JS signal handler,
    which cannot run while `execFileSync` blocks the event loop — so it waits for an
    async gate pipeline, not for this PR.
