# 0051. A session's code graph is an external index served over MCP, one per worktree (2026-09-13)

- Status: accepted

51. **A session's code graph is an external index served over MCP, one per worktree
    (2026-09-13).** docs/05 asks a session to reuse what already exists, and the only instrument
    for it was the knowledge slice: a regex code map of files per module, churn, debt, "depends
    on / used by" at directory granularity. It answers *where roughly to look*, which is not the
    question a session has. "How does X work", "how does X reach Y" and "what breaks if I change
    Z" are about symbols and edges, so every session answered them the expensive way — grep,
    read, read again, and rebuild in context a call graph the parser had already built and thrown
    away. CodeGraph (github.com/colbymchenry/codegraph, npm `@colbymchenry/codegraph` 1.6.0, MIT)
    is that parser kept: a local SQLite graph of every symbol, edge and file, 130 files and 1,473
    nodes of this repo in 2.4s, no network, nothing tracked. The slice stays — it answers shape
    and debt at launch, the graph answers code on demand.
    *An external graph over growing our own.* A symbol-level indexer for 30+ languages is not
    adjacent to pup's job, and a regex over paths is not a foundation to build one on. The
    dependency is the cheap kind: one binary, MIT, local, invoked by argv, nothing to migrate if
    it goes.
    *MCP over injecting explore output,* which is what the slice does. Wrong shape twice: the
    questions are the session's, asked while it works and not guessable at launch, and the
    answers are large — the context budget (docs/03) exists because a profile that pastes
    everything useful arrives useless. A tool costs nothing until asked and returns source
    verbatim, line-numbered, ready to Edit. It also keeps pup out of the middle: the server sends
    its own usage instructions on connect, so the `## Code graph` section carries only the thing
    just pup knows — that the graph is *this worktree's*. `mcp.json` is compiled with the
    settings and hooks rather than written beside them, so which binary serves a session's graph
    is recorded in the profile hash at compile time — attribution, not detection: nothing
    re-reads the compiled dir to verify it, which is decision 46's ceiling. No
    `--strict-mcp-config`: it would drop the operator's own MCP
    servers, which decision 9 refuses — sessions inherit user config and pup adds to it.
    *One graph per worktree, which is the design and not a detail.* codegraph resolves a project
    by walking PARENT directories for a `.codegraph/`. A worktree sits at
    `<repo>/.worktrees/<id>`, so one with no index of its own resolves *up* into the main
    checkout and the session is answered out of main's graph while believing it reads its own
    branch — every answer plausible, subtly wrong, unfalsifiable from inside. Hence `--path
    <worktreePath>` pinned explicitly rather than left to the client's root, an index built from
    the worktree right after `worktree add`, and codegraph's watcher keeping it current.
    *So a failed index withholds the config rather than degrading into it.* The launch survives a
    machine with no codegraph and a worktree that will not index: both print one line and launch a
    normal session. But "degrade to no graph" has to mean no graph — launching with the config
    anyway is what hands the session main's index by the walk above. No graph is a poorer session;
    the wrong graph is a lying one. The residual, stated: the compile precedes `worktree add`
    (decision 40 — a throw after it orphans a worktree and branch), so on that path the context
    still carries the section and the session may call a missing tool once, which beats a
    silently wrong branch.
    *The exclude line over editing `.gitignore`.* codegraph's own `.codegraph/.gitignore` hides
    the database but leaves the directory untracked — `?? .codegraph/` in porcelain, which the
    gate and the overlap radar both read. One `.codegraph/` line in `info/exclude`, found through
    `git rev-parse --git-path`, lands in the COMMON dir and so covers the main checkout and every
    worktree including ones that do not exist yet. Not a tracked `.gitignore`: the exclusion is
    the operator's local tooling, not a fact about the project, so pup would be committing to
    every contributor's repo on its own account. Writing it needs the *resolved* path — git
    answers relative from a main checkout and absolute from a worktree, and appending to the
    relative one writes wherever pup's process is standing. Found by the test, not by review.
    *The daemon and the telemetry env.* `CODEGRAPH_TELEMETRY=0` on indexing and on the served
    server alike — the repositories it indexes are not ours to report on. The daemon is
    codegraph's to run and pup starts none: `serve --mcp` brings up one per project path and its
    watcher keeps that path's index current, which is why the graph lags a write by about a
    second, why nothing here polls or re-indexes mid-session, and why "one per worktree" is
    enough to keep two sessions' daemons off each other's index.
    *What stays open.* The conductor gets no graph — whether it should read main's index is a
    separate question with a separate answer (the next task). `pup init` and `pup audit` report
    nothing about the capability, so an operator learns it from a line at launch. And the slice is
    still the regex map: now that a real graph exists at launch it could be cut from one, which is
    why this keeps both rather than replacing either.
    *Addendum, from the security review of the branch (2026-09-13).* Five findings, all of them
    the same mistake in five places — treating a third-party binary and its server as part of
    pup rather than as something pup hands work to.
    1. `which codegraph` echoed the PATH ENTRY it matched, and pnpm prepends the relative
    `./node_modules/.bin`, so under `pnpm dev` the answer was `./node_modules/.bin/codegraph`: a
    gitignored path inside the repo that a session can plant a script at, executed by pup at the
    next launch, and written into `mcp.json` as a relative command every later session
    re-resolves against its own worktree. Now `which -a`, taking the first candidate that is
    both absolute and outside the repository — a repo-local shim is refused, not ranked last,
    so an operator who has only that one has no codegraph.
    2. The exclude line was unanchored, so `.codegraph/` matched at every depth in every
    worktree forever and `src/.codegraph/setup.ts` was invisible to the worktree-clean stage:
    uncommitted code the gate cannot see and a test run can read. Anchored to `/.codegraph/`,
    which hides the one directory codegraph creates and nothing else.
    3. Indexing ran with `{...process.env}`, handing a `#!/usr/bin/env node` shim every secret
    in the operator's environment, `NODE_OPTIONS` (whose `--require` executes inside it), and
    the `CODEGRAPH_DOWNLOAD_BASE` / `CODEGRAPH_INSTALL_DIR` pair its cold path uses to fetch and
    exec a bundle. Now built UP from an allowlist — PATH, HOME, LANG, LC_ALL, TMPDIR, USER —
    plus `CODEGRAPH_TELEMETRY=0` and `CODEGRAPH_NO_DOWNLOAD=1`. An allowlist and not a denylist
    because the variables to fear are the ones nobody has thought of yet.
    4. Claude Code spawns a stdio MCP server as its own child, so the server inherited
    `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` — the peer credentials that
    address other sessions and the conductor, which decision 47 keeps off the tmux server for
    exactly this reason. The served `env` block blanks both; a code indexer has no business
    holding the means to speak as the session.
    5. The index failure printed the CLI's `error.message` raw, ANSI and paths included, onto the
    terminal the operator reads a decision from. Through `failureSummary` now, like every other
    shell-out (decision 29).
    *And one left open by name:* `relaunchWindow` in `session-handoff.service.ts` respawns a
    session with the code-graph context section but without `--mcp-config`, so a respawned
    session is told to use a tool it does not have. It is out of this task's scope and the next
    task fixes it. Worth stating why it is a gap and not a vulnerability: the failure is a wasted
    tool call, and a respawn withholding the config is the same safe direction as a failed index.
    The lesson the five findings share is the one that generalises — every launch flag, env block
    and exclude pattern pup hands to a third party is part of the trust boundary, and the
    interesting half is always what it inherits rather than what it is passed.
    *Second addendum: the conductor's graph, the capability line, and the respawn gap closed
    (2026-09-13).*
    *The conductor gets a graph of the merge target, on the same terms a session gets its
    worktree's.* It plans and reviews from what has merged and edits nothing, so the merge target
    is the right index for it. Same client, same anchored exclude line, same compiled `mcp.json`
    recorded in its profile hash, same `--mcp-config` on its argv, same withholding when the index
    fails. The one thing that differs is the first sentence of the context section, which names
    WHAT the graph is of. That is not decoration: the failure this whole decision is shaped
    around is an answer out of one checkout believed to be about another, and the conductor
    reading one tree while believing it reads another is the same lie pointed the other way. So
    the section is one function with a parameterised opening rather than one constant used twice.
    (This paragraph first said the graph was built from the MAIN CHECKOUT and that main's tree is
    "what has merged". The third addendum below corrects both: a working tree is not what has
    merged, and the graph is now cut from a private detached checkout.)
    *`pup init` and `pup audit` print `codegraph: <version>` or `codegraph: not installed`,*
    beside the sandbox line and for decision 36's reason: an operator who never sees it cannot
    tell a fleet whose sessions query a graph from one whose sessions grep, and "my sessions got
    slower at finding things" is not a diagnosis anyone reaches unaided. The version is the
    binary's own stdout, so it goes through `sanitizeReason` (decision 29) before reaching the
    terminal. A binary that will not answer `--version` reports as installed-with-version-unknown,
    never as absent: pup would still index with it, and telling an operator to install what they
    already have is worse than telling them nothing. Probed at print time rather than carried on
    `InitReport`: what it reports is the operator's machine, not the baseline the stages measured,
    and the report is the baseline's record.
    *The respawn gap is closed.* `relaunchWindow` now re-runs the index on the worktree and passes
    the launch's compiled `mcp.json` when one exists. Three parts worth stating. It does not
    recompile: a respawn is the same session on a fresh context window and its profile hash must
    not move, so the binary and the path are the launch's. It re-INDEXES rather than only
    re-passing, because the previous run has been editing this worktree since the launch and an
    index its commits have outrun answers out of code that is no longer there — and it indexes
    after the kill, when the tree has stopped moving. And it withholds the config when the
    operator's codegraph has gone since the launch, which is the same safe direction as a failed
    index: a config naming an absolute command that no longer exists is a server that cannot
    start.
    *What the slice would cost, recorded and not taken.* `buildKnowledgeSlice` still cuts from the
    adapter import scan even where a graph exists. Reading `codegraph explore` instead would buy
    symbol granularity in the compiled context — the slice could name the functions a task will
    touch rather than the directories — and it would cost: a launch that blocks on a third-party
    binary before the profile can compile (today the index runs AFTER the compile, and a failure
    costs a graph and not a launch); a compile whose output differs by machine, so the profile
    hash stops being comparable across operators; and a second parse-and-shape layer over
    codegraph's output, which is prose for an agent rather than a data structure. The cheap half
    is available today and is the part that matters: the section tells the session to ask the
    graph BEFORE reading files, so the symbol-level answer arrives on demand instead of being
    guessed at compile time. Revisit if the import scan's module granularity is measurably what
    makes a session re-implement something — not before.
    *One duplication left standing, named.* `graphForWorktree` in `session-lifecycle.service.ts`
    is now the same code as `prepareGraph` in the client, which the conductor and the respawn both
    call. Folding it in was outside this task's scope-in list; it is a three-line change and the
    next thing to touch that file should make it.
    *Third addendum, from the operator's security review of the branch (2026-09-13).* Three
    findings, all reproduced against the real binary. Two of them are the same mistake the first
    addendum's five were: the graph is addressed by PATH, and a path is not a capability — whoever
    can write at that path decides what the index says.
    1. **Indexing through someone else's index (HIGH).** A session could replace its worktree's
    `.codegraph` with a symlink at another checkout's — the conductor's, created by `pup conductor
    start`. `existsSync` follows a symlink, so the "is it initialized" probe answered yes, the
    `index` branch was taken, and `codegraph index <worktree>` rebuilt the VICTIM's database from
    the attacker's files. Verified: main's own files vanished from the db. The result is a write
    through a path the attacker chose, and worse than a corrupted graph — the victim's agent is
    answered verbatim out of the attacker's tree, with the feature's whole promise ("this is the
    real source") carrying the lie. Fixed in `indexDirectory`, the one path every caller shares:
    both `.codegraph` and `.codegraph/codegraph.db` are `lstat`ed before anything runs, a symlink
    is refused outright, and anything whose real path lands outside the directory is refused too
    (a symlinked parent, a bind mount). Absent stays fine — that is the `init` path. It throws,
    which the callers' catch already turns into one printed line and no config.
    2. **A live working tree is not "what has merged" (MEDIUM).** The conductor's graph was built
    from the live main working tree, which carries untracked files — and a session's Bash is
    guarded only against `.claude/`, so a session can write into the repo root from its own
    worktree. Two levers, neither needing a privilege the session lacked. A root `codegraph.json`
    steers the indexer: `{"include":[".worktrees/**"]}` pulls every session's worktree into the
    conductor's graph, and an `exclude` blinds it to whatever the session would rather it not see.
    And an untracked source file is returned verbatim into the context of the one agent that
    plans, launches and steers every other one. The conductor is the highest-privilege reader in
    the system; its graph must not be writable by the things it supervises. Fixed structurally
    rather than by blacklisting the two known levers: `pup conductor start` cuts (or refreshes) a
    private detached checkout of the merge target at `~/.pupitre/<pid>/conductor/checkout`, indexes
    THAT, and pins `mcp.json` at it. (That path is derived in `conductor.service.ts` rather than
    added to `projectPaths` beside `conductorCompiledDir`, where the rest of the conductor's state
    layout lives: this is its only consumer, and a second one is the moment to move it.) Tracked content and nothing else, so both levers are gone at
    the root. Detached, so the branch stays free for the main checkout and for `pup merge`.
    Refreshed at start and not after, which the context section now says in as many words — the
    conductor is told its graph is a snapshot of a pristine copy, that it is not the tree it sits
    in, and that answers carry repo-relative paths to read where it stands. `pup conductor stop`
    leaves the checkout in place: it is a cache, and re-cutting it every start is the expensive
    half. The target branch is read the way `runMergeGate` reads it (`git branch --show-current`
    in the main checkout), so the conductor's graph and the gate's destination cannot disagree
    about which branch that is; a detached main checkout has no merge target and gets no graph,
    with the usual one line. One robustness note found while building it: clearing
    `~/.pupitre` leaves the worktree registration behind and `worktree add` then refuses that path
    forever, so the add is preceded by a `worktree prune` — which drops only registrations whose
    directory is already gone, and heals what would otherwise be a conductor that silently never
    gets a graph again.
    3. **Session worktrees swallowed whole (MEDIUM).** In a repo whose `.gitignore` does not list
    `.worktrees/`, the live-root index pulled every session worktree into the conductor's graph on
    its own, without anyone planting anything. Finding 2's private checkout removes this for the
    same reason it removes the other two: `.worktrees/` is not tracked content. Explicitly NOT
    fixed by adding `/.worktrees/` to the shared `info/exclude` — that line lands in the common
    dir and so would also hide a session-created `<worktree>/.worktrees/` from the gate's
    worktree-clean stage, which is the first addendum's finding 2 reintroduced one directory over.
    The through-line of all eight findings across the two reviews: pup's job at every one of these
    boundaries is to decide WHAT a third party is pointed at, and the answer is never "wherever
    the thing being supervised can write".
