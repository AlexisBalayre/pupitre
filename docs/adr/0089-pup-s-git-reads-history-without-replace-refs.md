# 0089. Pup's git reads history without replace refs, grafts or the commit-graph, gh's git takes pup's pins, and the driver check refuses config includes, empty driver names and an `info/attributes` that is not a regular file (2026-11-05, amends 50 and 101)

- Status: accepted
- Amends: [0050](0050-git-will-not-run-at-all-while-a.md), [0101](0101-git-in-a-session-worktree-runs-pinned-to.md)

89. **Pup's git reads history without replace refs, grafts or the commit-graph, gh's git
    takes pup's pins, and the driver check refuses config includes, empty driver names and an
    `info/attributes` that is not a regular file (2026-11-05, amends 50 and 101).** The gate's
    reviews left these edges open, plus one from the security review of #176 (t-mvp24zsi, folded
    in because it touches the same files). Each one is a file in the shared `$GIT_COMMON_DIR` that a
    session can write and no diff shows.
    *History.* Three files change what a sha reads as for any git that consults them. A replace
    ref under `refs/replace/` was already disarmed by `core.useReplaceRefs=false` (decision
    99). `info/grafts` rewrites a commit's parents. Re-parenting the target's tip onto the
    branch's first commit moves the merge-base, and the three-dot diff the scope audit reads
    then hides every file that commit added. Neither `core.useReplaceRefs` nor
    `GIT_NO_REPLACE_OBJECTS` turns grafts off (verified on Git 2.54). Only `GIT_GRAFT_FILE`
    does. `objects/info/commit-graph` is where git takes a commit's parents and root tree
    from when the file exists. A graph that names the base's tree for the branch tip makes
    `git log --format=%T` and a two-dot diff from the merge-base read an empty change (a
    three-dot diff happens to load the tip from its object). `GIT_SAFE_CONFIG` now pins
    `core.commitGraph=false`. `runGit` lays a new `GIT_HISTORY_ENV` over every child it spawns:
    `GIT_GRAFT_FILE=/dev/null/no-grafts`, a path that cannot exist, which git reads as no
    grafts without a warning (`/dev/null` itself opens and prints the deprecation hint on
    every call), and `GIT_NO_REPLACE_OBJECTS=1`, which repeats the replace-ref pin for a git
    that takes no argv of pup's. Every git child the gate and `pup land` run goes through
    `runGit` (the single-entry-point test), so every one of them now has all three off.
    *gh.* Every `gh` pup runs uses the main checkout as its cwd. gh runs git there, and a
    session can write that checkout's config, so a `core.fsmonitor` armed there ran on gh's
    first index read. `gh` now runs under `pinnedGitEnv()`, which is `scrubbedGitEnv`,
    `GIT_HISTORY_ENV`, and `GIT_SAFE_CONFIG` turned into `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`.
    That is command-scope config, so it outranks the repo's config the way a `-c` does.
    `codegraphGitConfig` does the same conversion for its own list; it can adopt
    `pinnedGitEnv` once its extra keys have a place there.
    *Includes.* `git config --list` follows `include.path` and `includeIf.<condition>.path`,
    and the listing shows an included key under the including file's `local` scope, so a
    driver included now was already caught. Three things were not. The file can be filled
    after the check. It can be a fifo, which blocks the listing. Or it can sit under a condition
    (`onbranch:feature`, say) that is false where the check runs and true where the rebase
    does. The listing now passes `--no-includes`, and
    `ARMED_DRIVER_KEY` refuses an include key itself, whatever the file it names holds. This
    has a cost: a repo whose local config uses an include can no longer be launched or merged
    until the include moves to the operator's global config, the same trade decision 50 made
    for a local git-lfs.
    *Empty driver names.* `[filter ""]` is the key `filter..smudge`, and an attribute naming
    an empty driver selects it. The pattern required a non-empty subsection, so the key
    slipped past. Every subsection in `ARMED_DRIVER_KEY` may now be empty: `filter`, `merge`,
    `lfs.extension`, the url-scoped `standalonetransferagent` and `lfs.customtransfer`.
    *`info/attributes`, amending decision 50 and decision 101's non-blocking reads.*
    `attributePatterns` read the file with `existsSync` + `readFileSync`. Since #176 the
    open-PR merge re-runs the driver check after its branch compare-and-swap, under the merge
    lock. A fifo planted at `<common>/info/attributes` once the ref moved blocked node in
    `open()`, where withMergeLock's SIGINT and SIGTERM listeners never run. Only SIGKILL got it
    out, and SIGKILL skips the undo and strands the lock (reproduced in that review). The read
    now goes through `readRegularFile`, the open that `readPointer` used: `O_NOFOLLOW |
    O_NONBLOCK`, then `fstat`. Nothing there (`ENOENT`, or `ENOTDIR` under a non-directory
    `info`) reads as no patterns, as git reads it. A regular file of at most 1 MiB is read as
    before. Anything else is refused as armed: a symlink, a fifo, a directory, a bigger file,
    or one that cannot be opened. *Audit.* That was the only `existsSync` + `readFileSync`
    read of a session-writable file in `git-diff.client.ts`. `readPointer` already opened
    this way and now shares the helper. `worktreeGitEnv`'s `existsSync` stats the main
    checkout's `.git` and reads nothing. The `config.worktree` checks are `lstat`s.
    *Follow-up from the security review of this decision (t-mvb0lvqr).* *A deadline on every
    git child.* `--no-includes` stops a fifo an include names from blocking the listing.
    But git opens `<common>/config` itself before any command runs, and a session can swap
    that file for a fifo too. The `rev-parse`, `config --list` and `branch --show-current`
    the gate runs under the merge lock, after its last check of the file, then blocked in a
    spawn node waits on, where `withMergeLock`'s signal listeners never run (reproduced on
    Git 2.54: each blocks until it is killed). So did every other git child the gate runs
    under the lock: the reads after the stages, the fast-forward and the push.
    `spawnOptions` now gives every `runGit` and `runGitBytes` child a deadline,
    `GATE_COMMAND_TIMEOUT_MS`, unless the call names its own, much as decision 124 bounds
    every hook's git. At the deadline node kills the child with SIGTERM. The call throws
    `ETIMEDOUT`. A caller that lets that through, or whose catch passes it to
    `rethrowIfKilled`, which rethrows a killed git rather than read it as an answer, fails
    the run, and `withMergeLock` releases the lock. The push's lease read, which took any
    failure for a first push, now passes it through `rethrowIfKilled`. The same value, named explicitly in
    `assertNoSharedWorktreeKey`, `worktreeConfigState` and the gate's push, is now the
    default there. `pup land`, `pup init` and the nested-package listing still name it
    explicitly, in files outside this change. Twenty-five minutes is long for a one-line
    read, but it is the cap `MERGE_LOCK_WAIT_MS` is built from. A git that really runs past
    it, a fetch over a slow link say, now fails rather than waits. *Shallow file.*
    `GIT_HISTORY_ENV` now also pins `GIT_SHALLOW_FILE=/dev/null/no-shallow`, a path that
    cannot exist, which git reads as no shallow file. A `<common>/shallow` naming the branch
    tip made that tip a root commit. `log <target>..<tip>` then listed the tip alone, so the
    commit subjects the gate reads off the branch lost every commit under it: cutting
    history can shrink a read, not only fail a merge-base. gh's git takes the pin too,
    through `pinnedGitEnv`. *Cost:* a repo that really is a shallow clone now reads as
    whole, and any walk past its edge fails on the parent it lacks ("Failed to traverse
    parents", verified on Git 2.54). The gate and `pup land` therefore fail on a shallow
    main checkout until `git fetch --unshallow`. *Inherited variables.*
    `GIT_TEST_COMMIT_GRAPH=1` loads the commit-graph whatever `core.commitGraph` says.
    Verified on Git 2.54: under it, `-c core.commitGraph=false` read a forged graph's tree.
    `GIT_NAMESPACE` and `GIT_REPLACE_REF_BASE` change which refs and replace refs are read.
    Decision 181's allowlist already drops all three from the env that `runGit`,
    `runGitBytes` and gh start from. The tests below now guard the first and the third.
    *Refusal text.* `ArmedGitDriverError` had lost the space between its dash and the list
    of what is armed. It is back.
    *Lazy fetch and transports.* The shared config can make the repo a partial clone of a
    remote a session names: `extensions.partialClone`, `remote.<r>.promisor` and an
    `uploadpack` of the session's, with `protocol.file.allow=always`. Once the session
    deletes a loose object, any read that meets the gap fetches it, which runs that
    `uploadpack` with pup's environment, under the merge lock when the gate is the reader
    (verified on Git 2.54 with a plain `cat-file -p`). `GIT_HISTORY_ENV` now pins
    `GIT_NO_LAZY_FETCH=1`, and `runGit` and `runGitBytes` set `GIT_ALLOW_PROTOCOL=none`. Once
    that variable is set it is the whole allowlist, and git reads no `protocol.*.allow` key,
    so a planted key cannot re-open a transport. `none` names none. A list of
    `protocol.<t>.allow=never` keys was the first pin. It named `ext`, `fd`, `file`, `git`,
    `http`, `https` and `ssh`, but missed the `ftp` and `ftps` helpers git ships and any
    `git-remote-<x>` on PATH, reached through `<x>::` or `remote.<r>.vcs`. A transport with no
    key falls back to `protocol.allow`, then to git's default for an unknown transport, which
    allows it because pup's env never sets `GIT_PROTOCOL_FROM_USER`. Before Git 2.44,
    `GIT_NO_LAZY_FETCH` is ignored, so a promisor remote at `ftp://` was still fetched from,
    to a host the session chose (CI review on PR #333; verified on Git 2.54 against an
    explicit fetch). Either pin alone stops the fetch, and the transport pin also stops an
    explicit `git fetch <r>` and a git too old to know `GIT_NO_LAZY_FETCH`. gh's git takes
    both through `pinnedGitEnv`. pup hands gh `--head` and runs only `pr view`, `list`,
    `edit`, `create` and `comment`, which read GitHub's API, so its git never needs a
    transport. The two gits that reach a remote on purpose, the gate's push and `pup land`'s
    fetch, run in `withScratchGitDir`, whose runner passes `reachesRemote` and keeps the
    transports. Its scratch git dir reads no config a session can write. It borrows the
    repo's object store, though, whose `info/alternates` a session can write. For each
    alternate that is a repo, a fetch, and the `rev-list --alternate-refs` of its
    connectivity check, start `git --git-dir=<alternate's repo> for-each-ref`, first
    unsetting `GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_COUNT`. That git read the session's
    config with none of the `-c` pins and no transport pin. Before Git 2.44 a dangling ref
    there could lazily fetch from a promisor remote that config names (CI review on PR
    #333). Verified on Git 2.54: the child starts with both variables unset, and a dangling
    ref there fails the fetch. The lazy fetch was not reproduced, for Git 2.54 printed the
    ref without reading its object. The runner now passes `-c core.alternateRefsCommand=true`.
    The scratch git reads that key itself, and hands it to its `rev-list` as
    `GIT_CONFIG_PARAMETERS`, so each runs `true`, which prints no ref, in place of that git.
    Neither the scratch git nor any git it starts then reads a config a session can write,
    so it reaches only the URL it is handed. It still pins `ext` off and keeps the lazy-fetch
    pin. *Cost:* a main checkout that really is a partial clone fails on a missing object
    rather than fetching it. A fetch no longer offers an alternate's refs as haves, so for a
    clone made with `--reference` it may receive objects the alternate already holds.
    *Ceilings.* The session hooks' `safe_git` and codegraph's git get `core.commitGraph=false`
    through `GIT_SAFE_CONFIG` but neither `GIT_HISTORY_ENV` nor the transport pins, so grafts
    and a shallow file still bend what they read and a planted promisor remote can still be
    fetched from. Both are outside this decision's files. `dashboard.service.ts` names its own
    copy of the transport list and `GIT_NO_LAZY_FETCH`, now redundant under `runGit`; it is
    outside this change too. The security review's git in `profile-compiler.service.ts`
    names the same list without `runGit` under it, so `ftp`, `ftps` and PATH helpers stay
    open there. It is outside this decision's files.
    A catch that neither rethrows nor passes the error to `rethrowIfKilled` still reads a git
    the deadline killed as its failure answer. The gate then runs its next git, which a
    session can block the same way, so the lock is held for one deadline per such read, not
    one in all.
    `pinnedGitEnv` cannot disarm a `filter.<x>.clean` that `info/attributes` selects, for a
    filter has no `-c` disarm, so gh's index refresh would run it; only
    `assertNoArmedGitDrivers` guards against that.
    The check is still check-then-run (decision 50). The deadline bounds how long a blocked
    git holds the lock. It does not undo what the git did before the kill, nor reach a child
    it started (decision 124's ceilings). A git the kernel holds in an uninterruptible
    sleep, on a hung network filesystem say, ignores the kill until its call returns.
    *Tests.* In `git-diff-client.test.ts`, with a plain-git control for each: under a
    `git replace --graft` and under an `info/grafts` that re-parent main's tip,
    `gitDiffPaths` still lists both feature files. Under a commit-graph whose tip tree is
    swapped for the base's, `runGit`'s `log --format=%T` reads the real tree and its two-dot
    diff lists both files. A local `include.path`, an `includeIf.onbranch:` and
    `filter..smudge|clean|process` and `merge..driver` are each refused. A fifo at
    `info/attributes` is refused within 2 s, where a blocking read would wait for the test's
    3 s writer and come back empty. A symlink and a directory there are refused, and a
    regular file reads as before. In `github-client.test.ts`, a gh on PATH that runs `git
    status` in a checkout whose config arms `core.fsmonitor` does not fire it, and a plain
    `git status` there does. Each test except the replace-ref one fails with its fix removed;
    the replace ref was already pinned by decision 99, and its test guards the pin.
    The follow-up's tests. In `merge-gate-shared-config.test.ts`, a fifo is swapped in for
    `.git/config` under the lock, after the gate's last check of it. Once the shortened
    deadline passes, the merge throws `ETIMEDOUT`. Main stays where it was, the lock is
    released, and the next run merges. With no deadline, a writer the test starts 8 s after
    the swap unblocks git and the gate merges: the test fails rather than hangs. In
    `git-diff-client.test.ts`, under a planted `.git/shallow` naming the branch tip, plain
    git's `log main..feature` lists one commit, while `runGit` lists both and `gitDiffPaths`
    both files. Under an inherited `GIT_TEST_COMMIT_GRAPH=1`, plain git with
    `-c core.commitGraph=false` reads the forged graph's tree, while `runGit` reads the real
    one. A spawned git is handed `GIT_SHALLOW_FILE=/dev/null/no-shallow` and no inherited
    `GIT_REPLACE_REF_BASE`. The `include.path` refusal reads `— include.path.`. In a repo
    whose config names a promisor remote with a planted `uploadpack` and lets the `file`
    transport through, and which lacks a blob, plain git's `cat-file -p` of the blob runs
    the command. `runGit`'s read of it and its `fetch` of that remote run nothing, the fetch
    refused as "transport 'file' not allowed". gh's git under `pinnedGitEnv` runs nothing
    with either pin taken away, the lazy-fetch pin or the env config. In `merge-gate.test.ts`,
    under a planted `objects/info/alternates` naming a bare repo with a dangling ref, a plain
    `git fetch` in the repo fails, while `withScratchGitDir`'s fetch succeeds and its
    `GIT_TRACE` names no `for-each-ref`. Each fails with its fix removed.
