# 0198. `pup land --remeasure` reads its config and "before" from a checkout of the merge's base, wherever local main is (2026-11-17)

- Status: accepted
- Amends: [0185](0185-pup-land-remeasure-takes-a-moved-head-on-the.md)

198. **`pup land --remeasure` reads its config and "before" from a checkout of the merge's base,
    wherever local main is (2026-11-17).** Decision 185 ran a remeasure only with the local target
    at the commit the merge went onto (`landedOn`). `measureBranch` read the complexity stage's
    "before" from the main checkout, so any other position would read the wrong side: past it,
    another PR's change or this merge's own; behind it, files the base had changed since. The same
    guard kept decision 29's trusted config source honest: past `landedOn`, the main checkout holds
    the session's own merge, and the gate would take its commands and declared tools from files the
    session wrote. That refused the live cases t-mw6hh1hz (#278) and t-mvry2mew (#283), whose merges
    local main already holds. It also made every merge that a later land moved past impossible to
    remeasure for good.
    *The rule.* `measureBranch` takes an optional `targetDir` beside its pin. When given, it cuts a
    detached checkout of the pin's `targetSha` there with `cutGateCheckout`, the gate checkout's own
    cut, so the same refusals apply: armed drivers, shared-config or per-worktree `core.worktree`
    keys, and committed links that reach outside the checkout. That checkout stands in for the main
    checkout everywhere `measureBranch` reads config or "before". A remeasure passes `targetDir` as
    its gate checkout's path with `-target` appended. That is a sibling under the same private
    `mkdtemp` root, so the remeasure's `finally` removes both and prunes their registrations, on a
    pass, a refusal and a throw alike. The main-at-`landedOn` refusal is gone. The checks after the
    stages stay: the lock, the main checkout's branch, the local target at the commit read before
    the stages, and origin still holding its tip.
    *Where the config is read.* From the stand-in, at `landedOn`: it is the capability context's
    `configPath`, and the root `gateCommands` and `skipsTestsOnUntestedChanges` are given. Nested
    packages' scripts and manifests, the owning lockfiles and the uninstalled-package refusal read it
    too; that refusal names the main checkout as where to install, and a land, not a merge, as what
    did not happen. What git reads through the stand-in stays pinned: `configSha` is `targetSha`.
    A capability's child is keyed to the toolchain cache by its `configPath`, so a remeasure's
    capabilities start from a cache of their own; a stage's child keeps the repo's. No later run
    shares the stand-in's path, so the remeasure's `finally` removes that cache with the checkouts.
    Keying it on the repo instead would take a field on the capability context, which this change
    does not touch.
    *The installed environment.* Nothing installs the stand-in, so it is the main checkout's. Each
    `node_modules` the gate links is linked into the stand-in first, entry by entry, from the main
    checkout's, as `linkEnvironment` links the gate checkout. The gate checkout then links the
    stand-in's, which is what an adapter checks its links against, so that check cannot tell an
    environment the merge chose from the base's. Past `landedOn`, the operator may have installed
    the merge's lockfile on main. So before linking each one, the remeasure refuses unless the
    working tree's owning lockfile matches `landedOn`'s: in the same place, of the same manager and
    the same bytes in the main checkout's working tree as in the stand-in. It also refuses unless
    the main checkout's HEAD commits exactly what `landedOn` commits under that `node_modules`. The
    lockfile match is a proxy: it does not show that the environment was installed from that
    lockfile, only that the working tree holds the one the base holds, and an install the operator
    ran from another one is theirs, as in a gate run. A lockfile that is no regular file, a link
    included, counts as none, and none refuses. A `package.json` the merge changed without its lockfile is not caught here: an install
    from an unchanged lockfile installs what the base declared. Python gets no environment, as
    decision 81's ceiling says for the gate checkout. Python's capabilities run in the gate
    checkout, where no venv is linked, and Python has no complexity capability, so a venv in the
    stand-in would reach only a custom adapter's complexity command. Linking one brings decision
    81's two reasons with it: an editable install's `.pth` names the main checkout's source root,
    and `uv run` syncs into the environment it finds.
    *Where "before" is read.* From the stand-in, as `measurePath` and `configPath` with `measureSha`
    and `configSha` at `targetSha`. It is measured once the environments are linked, before any
    stage runs the session's code, and that figure is the one compared; nothing reads it again.
    *Where the checkout lives.* In the system temp dir, as the gate's own checkout is, not under
    the store (`~/.pupitre`). The sandbox denies every gate child reads under the store (decision
    36), and a custom adapter's complexity command runs as one, with the measured path as its cwd.
    Where pup sandboxes, a stage's child may write only its own cwd (the gate checkout or a nested
    package in it), the sandbox's scratch and cache dirs, and the paths the caller grants. Each is a
    `subpath` grant, which covers that directory and what is under it and not a sibling whose name
    merely starts with it, so the `-target` stand-in and the `mkdtemp` root holding both are outside
    every grant a stage gets; the root, as an ancestor of a grant, is pinned against being moved
    besides. Checked with `sandbox-exec` on a profile granting `<root>/a`: a write to `<root>/a`
    succeeds, and writes to `<root>/a-target` and `<root>` are refused. The only child whose cwd is
    the stand-in is "before"'s complexity command, which runs before any stage, with the command the
    base's adapter config gives (see below). Its `.git` file and admin dir lie outside every write a
    sandboxed stage is granted, as the main checkout's do (decision 101). Where pup does not
    sandbox, a stage can write beside its cwd, so the sandbox is not what keeps "before" honest. The
    order is: the figure is taken before the first stage starts, so a later write to the stand-in
    changes nothing read. The config read after the stages is as open to that write as the main
    checkout's is to the same write in a gate run.
    *Which adapters run.* The adapter list, a custom adapter's commands among them, is resolved by
    the CLI before the land, from the main checkout, and in the past case that is the merge itself.
    `.pupitre/**` is in no critical area, so `--approved-by` does not cover it. So the remeasure
    refuses before any stage when the local target's committed tree and `landedOn`'s differ in a
    file that resolution, or the commands it picks, reads: a protected path (`PROTECTED_PATH_GLOBS`,
    which holds the custom adapter's `.pupitre/adapter.yml`) other than `.claude/**`, so a protected
    config path added later is guarded too, or at the root the `package.json`,
    `pnpm-workspace.yaml`, `tsconfig.json`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`,
    `bun.lock`, `bun.lockb`, `.yarnrc.yml`, `.npmrc`, `.pnp.cjs`, `.pnp.js`, `.pnp.loader.mjs`,
    `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `uv.lock`, `poetry.lock`,
    `Pipfile`, `Pipfile.lock` or `.python-version` the built-in adapters detect by or run with.
    Each counts with every directory above it, up to its first wildcard, so the bare `.pupitre`
    counts, and so would the directories of a deeper protected glob added later. `.claude/**` does not: nothing on the remeasure path reads it
    from the main checkout, and a repo that commits a link under it, such as `.claude/skills`,
    would otherwise refuse every remeasure with no override. It
    refuses as well when the local target's tree commits any of those paths as a symlink or a
    submodule. A link there would have resolution read files no difference names: `.pupitre`
    linked to `cfg/` reads `cfg/adapter.yml`. That holds even when `landedOn` commits the same link,
    which fails closed. Paths are compared as a case- and normalization-insensitive filesystem
    such as macOS's default APFS reads them: both sides NFKD-normalized and case-folded, so
    `.Pupitre/adapter.yml`, `PACKAGE.JSON` and a name spelled with U+212A KELVIN SIGN for `K` all
    count. Folding more than a filesystem does only refuses more. No approval lets any of it through. The difference is the two
    trees', so it counts a change on either side, behind as well as past. Only the local target's
    commit is compared; the main checkout's uncommitted files stay trusted as the operator's own, as
    the gate trusts them (decision 29). The list is kept beside the check rather than exported from
    each adapter, which this change does not touch. Resolving the adapters from the stand-in instead was not taken: the land is handed
    the adapters, as the gate is, and the tests drive it through that. The audit after a land reads
    the main checkout as it now is, as it always has.
    *The gate is unchanged.* `runMergeGate` and the re-gate pass no `targetDir`, so a gate run reads
    config and "before" from the main checkout as before, which the merge lock holds at the target
    it measures against, and neither new refusal applies. The merge-gate tests pass unchanged.
    *Tests.* In `land.test.ts`, the test that refused a remeasure with local main behind the base or
    past it holding the merge now lands both. Behind: another PR added `src/other.ts` on GitHub, and
    the head past the pin changes it. Past: the merge changes `src/app.ts`, and local main
    fast-forwarded onto it. An adapter's complexity capability records what its "before" call read
    at the measured path. In each case that is the file as the base holds it, read from a directory
    other than the repo. The directory is gone after the land, and no worktree lists it. A build
    stage that marks it ran and rewrites the stand-in beside it is not seen: "before" read the
    base's file before the mark existed. With local main fast-forwarded onto a merge that raises a
    file from 1 to 40, the remeasure flags a rise of 39 against the base, where a read at local main
    would find none. With local main fast-forwarded onto the merge, and an environment installed in
    the main checkout from the lockfile the base holds, `gateCommands` and both complexity calls
    read the base's file at the path they are given. The gate checkout's `node_modules` entry links
    the stand-in's, and resolves to the main checkout's. With a merge that changed the lockfile on
    local main, the remeasure refuses before `gateCommands` is called and changes nothing. So it does
    with a merge that changed `.pupitre/adapter.yml`, `.Pupitre/adapter.yml`, `package.json`,
    `Package.json`, `package-lock.json` or `uv.lock`, and with one whose head commits `.pupitre` or
    `.PUPITRE` as a link to a `cfg/` holding `adapter.yml`, the base's `package.json` as a link, or
    a submodule at `.pupitre`. With local main fast-forwarded onto a merge that changed none of those, an
    environment beside a working-tree lockfile the base does not hold, beside a lockfile that links
    to the bytes the base holds, or under committed `node_modules` files the base does not hold
    refuses the same way. With local main fast-forwarded onto a merge whose base commits
    `.claude/skills` as a link, the remeasure lands. A capability's child run with the stand-in as
    its `configPath` creates its toolchain cache, and the cache is gone after the land, with no
    `pup-removing-*` entry left beside it. The refusal covers a file under each protected path but
    `.claude/**`.
