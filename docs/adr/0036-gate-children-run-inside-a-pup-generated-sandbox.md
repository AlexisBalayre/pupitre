# 0036. Gate children run inside a pup-generated `sandbox-exec` profile, and `PUP_GATE_ENV` is replaced by `--gate-env` (2026-08-02)

- Status: accepted
- Amended by: [0078](0078-off-macos-the-gate-refuses-unless-the-operator.md)

36. **Gate children run inside a pup-generated `sandbox-exec` profile, and `PUP_GATE_ENV` is
    replaced by `--gate-env` (2026-08-02).** Closes the containment decision 28 deferred, and the
    ambient-injection door its 2026-07-27 refinement described. Decision 28 removed the
    operator's secrets from the child's *environment* and said plainly that this was not
    containment: `HOME` stayed, so a gate child could still read `~/.aws/credentials`,
    `~/.config/gh/hosts.yml` or `~/.ssh`, and write `~/.zshenv` for the operator's next login.
    Every call site that built a `gateChildEnv()` — gate stages, the TypeScript and Python
    capabilities, the custom adapter's `sh -c` (decision 24), and `pup init`/`pup audit`'s
    baseline stages — now goes through one seam, `runGateChild` (`sandbox.utils.ts`), which pairs
    the env allowlist with a filesystem policy. One seam is the point: "what can a gate child
    touch" has a single answer, and a new call site cannot forget the sandbox without also
    forgetting the environment it has to ask for anyway.
    **The policy.** Reads default-allow; writes default-**deny**, allowed back only for the paths
    a gate needs — the checkout being measured, the trusted checkout, the run's scratch dir, the
    toolchain cache, and `/dev` — and then `~/.pupitre`, the generated profile and each granted
    checkout's `.git` denied *last*, so they stay unwritable whatever a caller passes as writable.
    Order is load-bearing: SBPL's last matching rule wins, and the worktree being measured normally
    lives under `HOME`, so a blanket deny has to land before the allow.
    Denying only `HOME` was the first attempt and it was not enough. `/opt/homebrew/bin` is
    group-writable on a standard install, so a gate child could overwrite the `gh`, `git` or `tmux`
    binary pup itself runs *afterwards* — unsandboxed, with the operator's full environment. The
    writable set is enumerated at every call site anyway, so inverting the default costs nothing
    and closes every path nobody thought to name. A checkout's `.git` is denied for the same class
    of reason: `core.fsmonitor`, `core.sshCommand`, `core.pager` and aliases in `.git/config` are
    executed by pup's own later git calls, and `core.hooksPath=/dev/null` does not close that
    (verified against Apple Git-154). Denying the directory whole covers `config.worktree`, that
    checkout's own `.git` pointer file, `hooks/`, `info/` and refs — measurement must not mutate
    the repository it measures, which is the rule the Python adapter's `uv --no-sync` already
    follows. The `.git` denies are derived inside the seam rather than passed per call site: a
    call site that forgets to protect the checkout it just made writable reopens the hole.
    **The trusted checkout is not writable during a merge**, and getting that wrong cost two
    rounds. It was granted for one stated reason — a worktree shares its git object store, so a
    stage running git needs the index lock — and denying `.git` outright nullified that reason
    while the grant survived it. What the grant still bought an attacker was everything: the deny
    reaches `<repo>/.git`, but a *sibling* worktree's pointer file at
    `<repo>/.worktrees/<other>/.git` is a level below it, and rewriting that to a `gitdir:` whose
    `commondir` supplies a `core.fsmonitor` executes under the next `pup merge`'s unsandboxed git
    (reproduced; the simpler gitdir-only redirect does not work, since git resolves config through
    `commondir`). Worse and quieter, `<repo>/package.json` was rewritable, so a build stage could
    drop `@vitest/coverage-v8` from the manifest the coverage capability reads and turn the
    coverage stage into a skip — measurement forgery aimed straight at decision 29, invisible to
    both the worktree cleanliness check and the branch-diff scope audit, and persistent, since the
    same file chooses the *next* run's `gateCommands`. So `repoPath` now only keys the toolchain
    cache. `pup init`/`pup audit` are unaffected: they pass the same path as `cwd`, where the
    write grant is legitimate.
    `file-read*` is denied for a fixed constant (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`,
    `~/.npmrc`, `~/.gnupg`, `~/.kube`, `~/.docker/config.json`, `~/Library/Keychains`,
    `~/.pupitre`) with **no extension mechanism**: a per-repo or per-operator list is a channel a
    session can write, which is the hole decision 31 had to close for `python_files`. Read cannot
    be default-deny — the node binary a gate child executes lives under `HOME` on any nvm/asdf
    install, so denying reads there executes nothing at all.
    **Cache redirect, and why it is not per-run.** Denied `HOME` writes break toolchains that
    default their cache to `~/.npm` or `~/Library/Caches`, so `XDG_CACHE_HOME`,
    `npm_config_cache`, `COREPACK_HOME`, `PIP_CACHE_DIR` and `UV_CACHE_DIR` are pointed at a
    pup-owned cache directory and `TMPDIR` at the run's own scratch. The cache directory is
    deliberately *stable across runs* where the scratch is not: pointed at a directory that starts
    empty every time, corepack re-downloads the repo's package manager on every `pup merge`, which
    turns a local gate into a network-dependent one — worse than not redirecting at all. It is
    equally deliberately scoped **per repo**, keyed by `projectId`: these caches carry executable
    code (corepack runs the package-manager tarballs in its home, uv hardlinks cached wheels into
    the venv), so one shared directory would let a gate child in repo A supply the `pnpm` that
    measures repo B. The directory is checked before reuse — a real directory, owned by this user,
    not group- or world-writable — because its name is guessable and `TMPDIR` is a variable, so a
    `TMPDIR` aimed at a shared `/tmp` must refuse rather than silently share.
    **Both fail modes.** On darwin a sandbox that cannot be set up throws instead of running the
    child, so the stage fails and the merge refuses, exactly as decision 31's parse errors do. The
    invariant is about gate *children* and only them: no child pup spawns to measure a session's
    code runs unconfined on a platform pup claims to confine. It says nothing about the session
    process, which runs with permissions bypassed by design (decision 5) and is not sandboxed at
    all — the hooks and the gate are its enforcement layer, not this. Everywhere else children run
    unsandboxed and the gate report, `pup init` and `pup audit` each print `sandbox: none
    (unsupported platform)` — decision 29's honesty rule applied to the platform gap, since a
    silent absence reads exactly like the guarantee. *Amended by decision 78:* off darwin pup now
    refuses unless the operator declares the machine itself the sandbox with `PUP_SANDBOX=vm`.
    **A third mode, found by dogfooding.** macOS refuses a nested `sandbox_apply` unless the inner
    profile is identical to the outer one, and pupitre's own gate is precisely that case: `pnpm
    test` runs as a sandboxed stage and the suite spawns gate children of its own, which failed 52
    tests with `sandbox_apply: Operation not permitted`. Pup probes once per process and reports
    `sandbox: inherited (pup is itself sandboxed)` when it cannot layer its own profile on top.
    That is not a hole — a child cannot escape the sandbox its parent runs under, so it stays
    confined by whatever confines pup — but it is a different guarantee, so it gets a different
    word in the report. Only the nesting refusal degrades this way; any other `sandbox-exec`
    failure still refuses the merge.
    **That probe is security-critical, and its first version was forgeable.** It ran a
    PATH-resolved `true` and matched the refusal against the child's own stderr buffer, so a
    planted `true` printing `sandbox_apply: Operation not permitted` forced `inherited` — every
    gate child then ran unwrapped while the report claimed containment. It now runs `/usr/bin/true`
    by absolute path, a SIP-protected binary that writes nothing, with an empty environment, and
    matches the refusal anchored to `sandbox-exec:` at the start of a line. The rule the fix
    encodes: the probe must observe nothing the child can write.
    **`PUP_GATE_ENV` is gone**, replaced by `--gate-env <NAME,...>` on `merge`, `init` and
    `audit`. The variable is no longer honoured at all, which is the whole point: direnv's
    `.envrc`, a CI job, a Makefile or any wrapper process supplies an environment variable without
    anyone editing the command the operator typed, while a flag is reachable only by rewriting
    that command.
    Verified against this repo's own gate, which is the acceptance decision 28 used: build, lint,
    test and the instrumented coverage run all pass under the sandbox (82.7% over 71 files).
    **Ceilings, stated rather than implied.** Network stays open, so a gate child can still
    exfiltrate anything it can read — and it can read everything the deny list misses, which means
    a secret in `~/Documents/keys.txt` is not protected; the list closes the credential stores an
    attacker reaches for first, not the general case. The sandbox matches resolved paths, so a
    `~/.npmrc` symlinked out to a dotfiles repo is read through its target. `/dev` is write-granted,
    so a child can reach `/dev/tty` and the terminal behind it — unchanged from the default-allow
    policy this replaced, but worth naming now that everything else is enumerated. A repo's own
    cache stays poisonable by that repo's gate children — the cross-repo path is closed, the
    same-repo one is not, and it buys an attacker nothing there, since a gate child already runs
    that repo's code. The session process itself is unconfined by design (decision 5), so this
    bounds what the *gate* executes, not what a session does inside its worktree. Whoever launches
    pup still chooses the child's policy in the `inherited` case. And Linux gets nothing here: the
    same seam wants a `bwrap` implementation, deferred rather than faked, because a report that
    says `none` is honest where a half-policy would not be.
