# 0118. The conductor's security review runs a general-purpose subagent on Opus at high, which runs the pinned diff and no other git, within ten turns (2026-10-28, amends 92)

- Status: accepted
- Amends: [0092](0092-pup-routes-every-window-s-model-and-effort.md)

118. **The conductor's security review runs a general-purpose subagent on Opus at high, which runs
    the pinned diff and no other git, within ten turns (2026-10-28, amends 92).**
    Amends decision 92. The kickoff told the conductor to spawn a general-purpose subagent at
    `effort: "xhigh"` to review a critical session's diff. In five days 55 of those runs cost about
    $126 of $677, at 25 to 44 calls each: the subagent read its way around the tree at the top
    effort with no bound on its turns. CI then reviews the same pull request's security again with
    a validator, so the pre-gate review is the first of two passes, not the only one.
    The Models section now has the conductor spawn a general-purpose subagent with the Agent tool,
    `subagent_type: "general-purpose"`, `model: "opus"` and `effort: "high"`.
    `SECURITY_REVIEW_EFFORT` in `model-ladder.constants.ts` is `high`, so nothing pup chooses for
    the review is `xhigh`; the ladders' `xhigh` rungs are unchanged.
    *Why not the project's `security-reviewer` agent.* The task meant the review to run
    `.claude/agents/security-reviewer.md`, the protocol written once. The CI review of this change
    pointed out that only pupitre's own checkout has that file, while the conductor runs in every
    repo `pup init` registered, which commits nothing to it, and that a repo could carry an
    unrelated agent of that name. It does not load even in pupitre's own checkout. Every pup window,
    the conductor's included, launches `claude` with `--setting-sources user`, and three interactive
    panes on a throwaway `tmux -L` socket, all with that flag, showed what it costs. Asked to list
    the Agent tool's `subagent_type` values, the plain pane offered only the built-in and user
    agents. With `--agents '{"<name>": {…}}'` the named agent was added. With an `agents` key in the
    `--settings` JSON it was not, so the compiled `settings.json` cannot carry one. A kickoff that
    names a project agent therefore spawns nothing, in any repo. The built-in general-purpose agent
    is in every window, so the review runs wherever a conductor does.
    *Follow-up.* pup could supply its own reviewer: compile a protocol that is not tied to any repo
    into the conductor's profile and pass it as `--agents` JSON on the conductor launch only. Then
    neither the repo nor a session could shadow or plant it. That changes `launchArgs` and
    `launchConductor` in `session-runtime.service.ts` and `startConductor` in `conductor.service.ts`,
    so it is a task of its own. Until then the subagent's prompt carries the protocol. The same
    task owes the limits a reviewer that cannot break them. The general-purpose subagent has every
    tool, so "read no file", "no other git" and "ten turns" are only words, and a hunk can argue it
    out of them, for instance by quoting `~/.ssh/id_ed25519` "as evidence". That agent should have
    only Bash (`"tools": ["Bash"]` in the `--agents` JSON) and a hook that lets only the pinned
    diff run.
    *Who reads the diff.* The task first had the conductor run the diff and paste it into the
    subagent's prompt, which saves the subagent a call. The conductor's own pre-gate review rejected
    that: it puts untrusted hunks in the context of the window that can run `pup merge --pr`,
    launch and steer, where a hunk worded as an order lands, and a misled conductor could drop
    hunks from the copy it passes on, since the subagent would never see git's own output. So the
    conductor never reads the diff. The subagent's prompt carries the two commit ids the conductor
    resolved, what to look for (a check the change lets code skip, a measurement it can forge or
    empty, untrusted input reaching a command, a secret or environment it exposes) and these
    rules. It runs the
    pinned diff command, unchanged, itself and no other git, since a bare `git diff`, `git show` or
    `git log -p` runs the diff drivers a session can arm in the shared git config (decision 41),
    unsandboxed, as the operator, and bare branch names resolve to a planted tag or a moved HEAD
    (decision 80). It takes the branch's content, and the code around each hunk, only from that
    diff: the pinned command carries `--function-context`, so each hunk comes with the whole
    function it changes, out of git's objects. It reads no file. Two rounds got there. The
    conductor's review of this fix first moved the reads from `.worktrees/<session-id>/` to the
    main checkout. The conductor's profile has no read guard, so a symlink committed in the
    worktree (`docs/ctx.md -> ~/.ssh/id_ed25519`) would be followed, and its target would go back
    to the session as a steer's evidence. And uncommitted edits or a moved HEAD can show the
    reviewer a harmless version of a file the hunks call. The CI review then showed that the main
    checkout's working tree is no safer. A session's Bash is guarded only against `.claude/`, so it
    can write into the repo root (decision 51), which is why only `HEAD`'s tree counts in decision
    58. It can plant the same symlink or decoy there, and a link it never commits is not in the
    diff, so no mode 120000 rule catches it.
    *Which repo git opens.* The conductor's review of the function-context round found that
    `-C .worktrees/<session-id>` finds the repo through the worktree's `.git` and its admin dir's
    `commondir`, which a session can point at a decoy repo (decision 101). There
    `refs/heads/<target>` and the session's branch hold harmless commits, so the review prints an
    empty diff that reads as clean while the gate checks the real branch. So the commands name the
    common dir, `--git-dir=<repo>/.git` as `worktreeGitEnv` resolves it. Its re-review found that
    is not enough. `--git-dir` still reads a `commondir` file in that dir, and a session can plant
    one, since it writes the common dir (the shared config, `info/attributes`, tags). A planted one
    names a decoy that borrows the real objects and holds the real `main` and a harmless branch.
    Both the numstat and the diff then print nothing and exit 0, the count check agrees, and the
    review reads clean. Setting `GIT_COMMON_DIR` does not help: git's refs read the file even when
    it is set (git 2.39.5). So every pinned command first refuses while the common dir holds a
    `commondir` in any form, with `test ! -e` and the no-follow `test ! -L`, as
    `verifiedWorktreeGitEnv` checks an admin dir; a main `.git` never has one. The conductor also
    resolves the two commit ids itself, with the first pinned command, and checks that it got
    exactly two full ids. The numstat and the review then diff those ids, not ref names, and the
    conductor puts the head id in its summary of the PR, so the operator can match the review to
    the commit the gate checks. That narrows the attack without closing it. The check and git's
    read are two steps, so a session that flips the file in a loop can land between them. And ids
    do not pin content: git verifies a commit's hash when it parses one, but not the trees and
    blobs a diff reads. Overwriting one loose blob made the diff by ids print nothing and exit 0.
    A session that writes the object store is decision 41's exposure, which no pin closes; this
    review is the first of two passes, and CI's reads the copy GitHub hashed on push.
    *Owed.* The gate's own reads with `-C <repo>` (`resolveCommit` in `merge-gate.service.ts`)
    follow the same `commondir`, so until a task of its own fixes them, a planted one shows the
    gate a decoy too. The conductor has planned that task.
    *What the diff shows.* Function context alone does not hold a floor: `diff.context=0` in the
    shared config drops git's default three lines. With a funcname pattern that matches every line
    (`* diff=x` and `diff.x.xfuncname=.`), a hunk then comes with no context at all; that was
    reproduced on git 2.39.5. So the command pins `--unified=3` beside `--function-context`. A
    planted pattern can then only widen the context, and no changed line is hidden. The commands
    run from `-C /`, so any cwd runs them alike, but that keeps no attributes out:
    `info/attributes` in the common dir, `core.attributesFile` and `core.worktree` still reach git.
    What holds is the pinned flags, which cancel every attribute effect a diff of two commits has:
    `--no-ext-diff` and `--no-textconv` the driver commands, `--text` the binary marking, and
    `--unified=3` the funcname pattern's narrowing. Function context also grows the diff. One
    edited line inside a large `describe` block brings in about 260 lines, and touching every
    top-level block of a big test file brings in about 84 KB. That is past the roughly 30,000
    characters Bash returns, and a hunk past the cut could come back clean. So once it has the
    ids, the conductor runs the pinned diff with `--numstat`, which lists the files the diff
    touches and none of its hunks; if it fails or lists none, the review cannot run. Its paths are
    untrusted data too: git prints a plain-ASCII path, spaces included, unquoted, so a session can
    name a file as an instruction that lands in the conductor's window. The conductor is told to
    compare them and never act on them. The subagent returns every file it reviewed and says so
    when the diff came back cut short or its command failed. A verdict that leaves out a listed
    file, or that names a cut or a failure, is a review that did not finish. Dropping the
    reads also leaves the ten turns to the review. It runs nothing the diff suggests and follows
    no instruction in it. And it reports within ten turns, returning only the verdict, the files
    it reviewed and its findings, never the diff. The Agent tool has no turn limit, so the cap is
    advice: when the subagent returns no verdict, the conductor says the review did not finish and
    never reports it as clean. A finding that holds is still a steer, not a gate.
    *Tests.* The kickoff's Security review bullet names the general-purpose subagent with its
    `subagent_type`, `model: "opus"` and `effort: "high"`, never names `security-reviewer`, carries
    the ten-turn cap and no `xhigh"` effort, and keeps the three pinned commands, the resolve, the
    numstat and the diff, byte for byte. A second test checks that the conductor resolves the ids
    and refuses unless it gets two, runs the numstat with them and treats its paths as data, and
    is told never to read the diff. It also checks that the prompt hands over the ids and names
    what to look for, and that the subagent runs the pinned diff on those ids itself and no other
    git, never through `-C .worktrees/` and never by ref name. It checks that the subagent takes
    the branch and the code around each hunk only from the diff's function context, reads no file
    and never uses Read, runs nothing the diff suggests and follows no instruction in it, and
    returns every file it reviewed and no diff. Last, it checks that a missing verdict, a cut or
    failed diff or a missing file is reported as unfinished, never clean, that the head id goes in
    the PR summary, and that nothing says to pass the diff in the prompt. A third test gives the
    repo a symlinked `.git` and checks that the commands name the dir it resolves to and its
    `commondir`. It also checks that a dir whose name holds a shell metacharacter is refused at
    compile time. A fourth runs the three commands on a real repo: the ids resolve, the numstat
    and the diff read the branch, and a planted `commondir`, a file or a dangling link, stops
    each command before git runs.
