# 0101. Git in a session worktree runs pinned to the admin and common dirs pup trusts (2026-10-18)

- Status: accepted
- Amended by: [0124](0124-the-worktree-hooks-reads-run-under-a-deadline.md)

101. **Git in a session worktree runs pinned to the admin and common dirs pup trusts (2026-10-18).**
    Extends decision 50. A linked worktree finds its repo through two files: its `.git` gitfile
    (`gitdir: <common>/worktrees/<id>`) and that admin dir's `commondir`. On macOS the sandbox
    runtime write-protects neither. Reproduced on Apple Git 2.39.5: a session points either file
    at a repo of its own, whose config arms `filter.<x>.clean` with `* filter=<x>` in its
    `info/attributes`. The next index-reading git run at the worktree outside the sandbox then
    runs the filter with the operator's environment. That covers the compiled hooks' `git
    status` and the gate's status and rebase. Nothing in `GIT_SAFE_CONFIG` can stop it, since no
    `-c` names a driver someone else chose, and `assertNoArmedGitDrivers` read the repo the
    pointer named at the moment it looked, so a swap after the check went through.
    *Pinned, not followed.* Every git call pup or its hooks make in a worktree now runs with
    `GIT_DIR=<common>/worktrees/<id>`, `GIT_COMMON_DIR=<common>` and `GIT_WORK_TREE=<worktree>`.
    With all three set, git reads neither pointer. `<common>` is the realpath of the main
    checkout's `.git`, as `git worktree add` records it, and `<id>` is the worktree's basename,
    the name `worktree add` gives it. Both come from pup's own paths, never from the files.
    The hooks get them rendered at compile time, inside `safe_git`. The gate pins its
    worktree-clean status, its rebase and `--abort`, and its driver check, which now reads the
    config the rebase will use. The session window gets none of the three (*The window keeps
    its own git*, below).
    *Checked, so a rewrite is loud.* Pinned git would ignore a rewritten pointer. But the
    operator's shell and anything else that runs git there unpinned would follow it. So before
    the pinned calls, `verifiedWorktreeGitEnv` (and `pinned_worktree` in the hooks) checks with
    filesystem reads alone that `<worktree>/.git` is a regular file reading `gitdir: <admin
    dir>`, that the admin dir is its own realpath, and that its `commondir` resolves to
    `<common>`. Any mismatch is a refusal naming both paths. The hooks refuse after the call
    (the re-check) or refuse the conflict-resolution Edit, the gate throws before it rebases,
    and a launch or respawn opens no window. The TypeScript check opens each pointer with
    `O_NOFOLLOW | O_NONBLOCK`, so a symlink or a fifo is refused rather than followed or waited on.
    *`--ignore-submodules=all` on status and on the hook's diff.* A gitlink in the index over
    `<worktree>/<path>/.git` makes `status` and a worktree `diff` run a child git in that
    directory, with `GIT_DIR` set to the submodule's own repo, so the pins do not reach it and
    its armed filter runs. With the flag, git skips submodules entirely. The rebase was checked
    with the same plant and runs no child (`submodule.recurse=false`, decision 80). The window
    cannot take a flag, so it gets the same rule as command-scope config through tmux `-e`:
    `GIT_CONFIG_COUNT=2` with `diff.ignoreSubmodules=all` and `status.submoduleSummary=false`.
    The second is needed because a submodule summary runs child gits even with the first set.
    This narrows the exposure and does not close it (reproduced): a per-submodule `ignore =
    none` or `untracked` in `.gitmodules`, in the worktree or only in the index, outranks
    `diff.ignoreSubmodules` from any config, the environment's included. The plumbing
    `diff-files` and `diff-index` never read `diff.ignoreSubmodules` at all. Only a command-line
    `--ignore-submodules` beats the override. So pup's safety rests on its own calls, never on
    the window's config: every status and diff it or the hooks run over the worktree passes
    `--ignore-submodules=all`, none uses `diff-files` or `diff-index`, and the rebase, checked
    with the override planted, runs no child. pup's own git drops `GIT_CONFIG_COUNT`,
    `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n` and `GIT_CONFIG_PARAMETERS` with the GIT_DIR family,
    so the scope audit's diff, run from a shell that inherited the window's environment, still
    lists a gitlink change.
    *No worktree config.* With `extensions.worktreeConfig` on, git also reads
    `<admin dir>/config.worktree`, a file inside the admin dir the session can write, which
    would arm a driver under the pins. So the check refuses while that file exists, or while
    the extension is on in `<common>/config` or holds a value git cannot read as a boolean.
    git reads the extension from that file alone, never through an include. The fix assumes
    `<common>/config` is out of the session's reach. Where it is not, which is decision 41's
    exposure, a session arms a driver there directly and no pin holds.
    *Trust seeded for the checked repo.* `preseedTrust` marks the root of the checked common dir
    as trusted, not the repo `git rev-parse --git-common-dir` names from inside the worktree,
    so seeding trust runs no git that follows the pointers.
    *The window keeps its own git.* The window's environment carries none of `GIT_DIR`,
    `GIT_COMMON_DIR` and `GIT_WORK_TREE` (CI review, 2026-10-23). The first cut set all three
    through tmux `-e` to pin Claude Code's startup git. But every process the session runs
    inherits the window's environment (vitest, `pnpm install`, any build tool), and nothing the
    kickoff tells the agent reaches them. Under the three variables, a `git init` in a temp dir
    writes `core.worktree=<worktree>` into the shared `<common>/config` (reproduced), and then
    the operator's own git in the main checkout works against the session's worktree. A `git
    commit` from that temp dir lands on the session's branch, a `git clone` fails with "working
    tree already exists", and `git -C <other>` reads the session's repo. So the pins stay with
    pup's own git and the hooks', and the window gets only the submodule config. Claude Code's
    startup git follows the pointers, which the launch has just checked. The kickoff line that
    told the agent to clear the three for such commands is gone with them.
    *Absolute gitfiles.* Git 2.48's `worktree.useRelativePaths` has `worktree add` write
    `gitdir: ../../.git/worktrees/<id>`, which the exact checks refuse as a rewrite, after
    `startSession` has added the worktree and written its row (CI review). `GIT_SAFE_CONFIG` pins
    the key to `false`, so pup's `worktree add` (`startSession`, a fix round, the gate's checkout
    and the conductor's) writes the absolute gitfile whatever the operator's global config says. An older git ignores the key.
    The checks stay exact and do not resolve a relative gitfile, so a worktree added with
    relative paths outside pup is refused. The refusal's repair hint carries the same `-c`,
    because `worktree repair` also rewrites links to match the option.
    *Worktree config refused before anything is written.* The extension is on wherever `git
    sparse-checkout` or `clone --sparse` ever ran, the usual cause. git turns it on in the
    shared config, and `sparse-checkout disable` leaves it on, with `.git/config.worktree`
    (Apple Git 2.39.5). It is not the only cause: a session that can write the shared config
    (decision 41's exposure) can turn it on and arm a driver in `config.worktree`. The in-window check refused such a repo only after `startSession` had
    added the worktree and written its row. A relaunch then hit `TaskAlreadyClaimedError`, each
    retry after `pup kill` left another worktree and branch, and the message blamed a session
    that never ran (CI review, 2026-10-23). So `pup launch` and `pup new` call
    `assertNoWorktreeConfig` beside `assertNoArmedGitDrivers`, before anything is written. It
    refuses while the extension is on in `<repo>/.git/config`, or holds a value git cannot read
    as a boolean, or while `<repo>/.git/config.worktree` exists. It runs before the driver
    check, so it is what meets a driver a session armed there. Its message names sparse checkout
    as the usual cause and, where none ran, asks the operator to inspect `.git/config` and
    `.git/config.worktree` before removing anything and to treat a session that wrote them as
    compromised. Its unset runs `git -C / config --file <repo>/.git/config`, from outside the
    repo, because git will not open a repo whose value it cannot read, not even for `--file`
    (security review, 2026-10-23). The in-window check stays as
    it is, for an extension turned on after the launch. `pup fix` asks the same before its
    `worktree add` (t-mve8vgej), where it would otherwise fail late or read as a compromised
    worker.
    *Gitfile repos refused.* Every path pup trusts is built as `<repo>/.git/...`, the pins
    included. A repo whose `.git` is a gitfile (a linked worktree, a submodule, a
    `--separate-git-dir` clone) has none of them: the config read above misses, and the pointer
    check refuses only after the row and the worktree exist. `assertNoWorktreeConfig` refuses
    such a repo first, with a message asking for the main checkout. Resolving the gitfile was
    the alternative, but it would take the repo from a pointer file rather than from pup's own
    path.
    *The respawn, the code graph and the checkouts (security review, 2026-10-23).* Reproduced on
    Apple Git 2.39.5 with codegraph 1.6.0. A respawn indexed the worktree before any check, and
    the indexer's environment carried no `GIT_*`. codegraph runs `ls-files --recurse-submodules`
    and `status` over the tree, outside the sandbox, and again with the cwd in every nested repo
    it finds. So a repointed gitfile, or an untracked `<wt>/lib/x/.git` naming a repo the session
    built, had it run that repo's fsmonitor. Five changes. (1) `relaunchWindow` runs
    `assertMintedRow` before anything is killed, and `verifiedWorktreeGitEnv` after the kill and
    before the index; a rewrite refuses the respawn. (2) The indexer's git runs pinned:
    `prepareGraph` takes the pins as a thunk, evaluated inside its failure envelope once a binary
    is found, and `indexEnv` hands codegraph `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE`. With
    all three set, every git codegraph runs reads the trusted repo whatever its cwd, so a nested
    repo's `.git` is never followed. Nested repos are neither excluded nor refused, which
    codegraph's own `codegraph.json` could undo; the pins make their `.git` inert. (3) codegraph's
    argv is not pup's, so it gets `GIT_SAFE_CONFIG` as command-scope config through
    `GIT_CONFIG_COUNT`, with `diff.ignoreSubmodules=all`, `status.submoduleSummary=false` and
    `core.splitIndex=false`. A
    `.gitmodules` `ignore = none` still outranks that, and a submodule's child git clears the
    pins, so a tree whose index holds a gitlink is not indexed: the launch, respawn or fix round
    opens without a graph and says so. Without a gitlink, `.gitmodules` names nothing git would
    enter. The check and codegraph read one snapshot of the index. The admin dir's `index` is the
    session's to write (its own `git add` writes it), and checked in place, a gitlink added
    after the check, by a sibling session or a process that outlived the window, still reached
    codegraph's git (CI review of #173). So pup copies it into a `mkdtemp` directory of its own,
    as the gate's checkout is, without following a symlink or blocking on a fifo. It flattens
    the copy with a pinned `update-index --no-split-index`, so neither reader takes a
    `sharedindex.*` from the admin dir, checks the copy, hands codegraph `GIT_INDEX_FILE=<copy>`
    and removes it once codegraph returns. git opens that `sharedindex.*` itself, so the flatten
    and the check run under codegraph's timeout, and a fifo there costs the graph rather than
    holding the caller. Without `core.splitIndex=false`, a split turned on in the shared config
    or the operator's global one had codegraph's first `status` split the checked copy again and
    write its base to `<GIT_DIR>/sharedindex.*`, in the admin dir, so its next `ls-files` loaded
    whatever base a sibling session had swapped in there (CI review of #173). (4) `launchSession` takes the project's `repoPath` from its three callers
    (session-lifecycle, session-handoff, fix-round), and never derives it from the row's
    `worktree_path`. A row naming `/tmp/x/.worktrees/<id>` beside a session-built `/tmp/x/.git`
    is checked against the project's admin dir, which its gitfile does not name, and is refused.
    (5) The gate's checkout and the conductor's sit under `<common>/worktrees/` beside the
    sessions' admin dirs, whose `commondir` a session can rewrite. Their git after the add now
    runs pinned, after the same check: the gate's `read-tree -u` and `ls-tree`, the conductor's
    `checkout --detach` and its index. The nested-package listing of the gate's checkout goes
    further. It lists the sha the gate checked, carried on the capability context as
    `measureSha`, from the main checkout's repo, and never reads through the checkout's admin
    dir, whose HEAD a session can rewrite too. Read through it, a HEAD at another commit changed
    the measured package set, and one git refuses to open emptied it, so no nested package's own
    stages ran. A rewritten `commondir` ran a planted promisor remote's `uploadpack` on the lazy
    fetch of the commit the planted repo lacks (security and CI review of #173). The gate's own
    pinned listing of the links still reads through the admin dir, so a HEAD git refuses to open
    stops the gate there with an error, before any stage. The pins close that `commondir` route
    only, not the lazy fetch. `runGit` sets neither `GIT_NO_LAZY_FETCH` nor
    `protocol.<name>.allow=never`, and the pins name the main `.git`, whose config a session can
    write (decision 41). So a promisor remote planted there still fires on any missing object:
    that is the transport pinning decision 99 records as owed (t-mvb0lvqr). A plain `worktree
    add` writes the admin dir's `commondir`, then checks out in a child git that reads it back
    before any check could run. So every add
    pup runs over the repo takes `--no-checkout`, and `checkoutPinned` fills the tree with a
    pinned `read-tree -u` once the pointers are checked: the gate's checkout, the conductor's
    first cut, a launch's worktree and a fix round's (conductor review of t-mve8vgej).
    `--no-checkout` removes the add's checkout, not every git child the add starts: one, the
    `update-ref` or `symbolic-ref` that writes HEAD, still reads the fresh `commondir` before
    `checkoutPinned` checks it. It runs under the `-c` pins, `core.hooksPath=/dev/null` among
    them, but without lazy fetch off, so the owed transport pinning covers it too. The add and
    its checkout each take one sha resolved before both, so a target that moves between them
    cannot leave HEAD and the index apart. A
    launch whose checkout throws removes the directory, prunes, and deletes the branch while it
    still holds that sha, so the retry that mints the same id adds it again (decision 40). Its
    refusal then says the worktree and branch were removed: a rewritten pointer's refusal is
    raised again with that in place of its `worktree repair` advice, and any other failure
    carries it appended. A fix round whose checkout throws is undone the same way, its branch
    kept, since it holds the head the retry starts from. Both undos check that the admin dir is
    gone after the prune, which keeps a locked registration without a word, and they claim the
    removal only then (CI review of #173). The conductor's first cut has no undo and needs none.
    A later start that finds its checkout without an index, as an interrupted or failed
    `read-tree` leaves it, removes the checkout and cuts it again from the tip, as a first start
    would, and no catch sees an interrupt (CI review of #173). Not in place: a `checkout` refuses
    the files already written as untracked, and a `read-tree` over them left HEAD at the old cut
    and kept the files the tip had dropped since, so the next start's `checkout` aborted once the
    target moved (conductor review of the round). Its admin dir is checked gone after the prune, as
    the undos check theirs: a `locked` file, which a `worktree add` killed before it finished
    leaves, kept the registration, and the add then failed on every start. The start now refuses
    before the add and names `git worktree unlock` on the checkout as the way out, without its
    path: the line that prints it opens with the path, and cuts the reason at 300 characters. The
    gate's checkout is named after its `mkdtemp` root,
    since as `checkout` it took the admin dir `checkout1` whenever the conductor's held
    `checkout`, a name the pins cannot predict. `GIT_WORK_TREE` replaces the gate's
    `--work-tree`, which was there to outrank a `core.worktree` in the shared config.
    *Ceilings.* The admin dir is taken to be the worktree's basename. A launch where git had to
    pick another name, because a stale admin dir held it, is refused at launch, never followed;
    a conductor checkout whose admin dir is not `checkout` costs the conductor its graph until
    the checkout is deleted and re-cut, and a re-cut while `checkout` is still registered after
    the prune is refused before the add. The served code graph server runs pinned since decision
    124, to the dirs checked when `mcp.json` is handed over, and is never checked again: its `git
    status` runs outside the sandbox for the window's whole life. A session that can write the shared config (decision 41's exposure) arms a
    `filter.<x>.clean` that server runs, there or in `<admin dir>/config.worktree` once it turns
    `extensions.worktreeConfig` on there after the check, and a gitlink planted with a
    `.gitmodules` override still reaches it, as it reaches any git Claude Code runs after its
    startup. With `all`, the hooks and the gate's worktree-clean stage no longer see a gitlink change. The
    gate's scope audit, on the branch's own diff, still does. A project that commits submodules
    gets no code graph.
    The shell check reads the gitfile with `head` after a `-f` test, so a fifo swapped in
    between blocks the read until the hook's deadline kills it (decision 124), as it does decision
    99's MERGE_HEAD read. A
    session's own `pup session done` runs `runGit` with the GIT_DIR family scrubbed, inside the
    session's sandbox, where following its own pointers gains it nothing.
    Tests: a repointed gitfile and a rewritten commondir, each naming a repo whose clean filter
    writes a marker, fire it under plain `git status`. They are refused by
    `verifiedWorktreeGitEnv`, by the re-check after a Bash call, by the conflict-resolution Edit
    and by the gate before its rebase, and pinned git leaves no marker. A gitlink over a
    session-made `.git` with the same filter fires it under plain status, and leaves no marker
    after a re-check run, a pinned status, or a gate that merges the branch holding it. A
    symlinked or fifo gitfile is refused without blocking. The driver check reads the trusted
    config whatever the gitfile names. A launch passes the submodule config to tmux and none of
    the three variables, and opens nothing over either rewritten pointer. A `git init` in a temp
    dir under the window's environment leaves `<common>/config` untouched, while the same init
    with the three variables added writes `core.worktree` there. With `worktree.useRelativePaths`
    on in the global config, `runGit`'s `worktree add` writes an absolute gitfile the check
    accepts. From Git 2.48, plain git writes a relative one, which the check refuses (skipped on
    an older git, which has no such option). In a gitlink over an armed
    `.git`, `status` and `diff` run under the window's own environment leave no marker, while a
    control with `GIT_CONFIG_COUNT=0` fires it, and so does the window's `status` once
    `.gitmodules` sets `ignore = none`. Under that override, in the worktree or in the index
    alone, git with `diff.ignoreSubmodules=all` fires the filter, and a re-check run and a gate
    (rejecting at its worktree-clean stage, or at its scope audit after the rebase) leave no
    marker. Each gitlink test in the hooks and the gate fails with `--ignore-submodules=all`
    taken out of the status it runs. A `config.worktree` arming the filter, with the
    extension on, fires it under plain status and is refused by both checks. So is the file
    alone, the extension alone, and an unreadable value. `assertNoWorktreeConfig` refuses a repo
    `git sparse-checkout set` left, before and after `disable`, asking for both files to be
    inspected before anything is removed, and refuses `<repo>/.git/config.worktree` alone, the
    extension alone and an unreadable value, which its own unset hint then clears. A
    `pup launch` and a `pup new` it refuses leave no session row, worktree or branch. A swap after the check, by a `head` on
    the hook's PATH that shows the check the trusted gitfile, and in the gate by a wrapper that
    restores the trusted gitfile around each check and puts the armed one back after it, leaves
    no marker. The gate merges, and only the teardown's `worktree remove` refuses the swapped
    gitfile. Each swap test fails with the pins taken out of `safe_git` or out of the gate.
    A respawn over a repointed gitfile whose repo's fsmonitor fires under plain `git status` is
    refused before codegraph runs or a window opens, and a respawn over an untracked nested repo
    naming the same armed repo indexes without firing it. The fake codegraph runs 1.6.0's git
    calls, in the tree and in the nested repo, and fires it on a plain environment. That test
    fails with the pins taken out of `indexEnv`. A respawn of a row naming an unminted worktree is
    refused before the kill. codegraph is handed the three pins and the config, and is never run
    over an index holding a gitlink or after a refused pin check. It is handed a copy of the
    index, gone once it returns, and its git still lists only the checked entries after the
    admin dir's index gains a gitlink, or loses the shared half of a split index. Each fails
    with the snapshot taken out. An index swapped for a fifo is refused without blocking, and a
    split index whose shared half is a fifo stops at the timeout, which the test fails without. The served config carries the
    git config, and the pins since decision 124. A launch over a row naming another repo's valid worktree opens
    nothing, while the same worktree checks clean against its own repo. A conductor checkout
    whose `commondir` names an armed repo fires it under plain `ls-files`, and a start then
    fires nothing, indexes nothing and launches without a graph. `pup fix` with the extension
    on refuses before any worktree add or event, and fails without the new call. A `pup launch`
    from a `--separate-git-dir` checkout, and `assertNoWorktreeConfig` on a linked worktree,
    are refused before any row, worktree or branch exists. The gate merges while another
    worktree holds the admin dir `checkout`, and fails with its checkout named `checkout`.
    A git that rewrites the new admin dir's `commondir` as soon as `worktree add` returns gets a
    refusal from the gate and the conductor's first cut, with nothing fired, no index and only
    `.git` in the tree the add left; with the add's own checkout back, the tree holds the files.
    A respawn refused after the kill says the old window is gone. A launch whose `read-tree`
    fails once, or whose `commondir` is rewritten right after the add, leaves no row, worktree,
    registration or branch, says they were removed, and the retry launches; the commondir
    case's refusal names no `worktree repair`. A fix round over the same two failures leaves no
    worktree or registration, keeps its branch at the head, says the worktree was removed and
    starts on the retry. A prune that keeps the registration gets the cleanup named instead, for
    a launch and a round alike. A gate whose checkout's HEAD is moved to a commit without the
    marker after the cut, or whose `commondir` is rewritten then, still finds the nested
    package, runs its test and typecheck, and runs nothing the rewrite named. The listing alone
    gets the same answer over a HEAD git refuses to open. A refusal raised with no
    advice of its own still closes on the repair advice, word for word. A
    conductor whose target moves right after the add cuts a clean checkout at the old tip, and
    the next start moves it to the new one.
