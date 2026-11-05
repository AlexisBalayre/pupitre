# 0073. Git has one entry point: `runGit` in `git-diff.client.ts`, and a source scan holds the line (2026-10-06)

- Status: accepted

73. **Git has one entry point: `runGit` in `git-diff.client.ts`, and a source scan holds the
    line (2026-10-06).** Decisions 28, 41 and 50 made every git spawn carry `GIT_SAFE_CONFIG` in
    argv and `scrubbedGitEnv()` in env, and sixteen call sites carried both by hand: five private
    `git()` helpers (session lifecycle, codegraph, merge gate, git-diff, conductor) and inline
    `execFileSync('git', …)` calls in the review queue, the overlap radar, the code map, `pup
    init`'s origin read, the trust-dialog seeding, `pup`'s project resolution and the nested-package
    listing. A rule that sixteen sites remember is a rule the seventeenth forgets, and forgetting
    either half runs whatever a session wrote into the shared `$GIT_COMMON_DIR/config`.
    *So `runGit(cwd, args, opts?)` is exported, and `GIT_SAFE_CONFIG` is not.* `opts` takes only
    what the call sites actually differ by: `stdio`, `timeout`, and `env` laid over the scrubbed
    environment rather than replacing it (`LC_ALL=C` for project resolution,
    `GIT_OBJECT_DIRECTORY` for the gate's push). The output comes back untrimmed, because a `-z`
    listing whose first path starts with a space must reach its parser whole, so callers reading a
    single value call `.trim()`, as the old helpers did for them. `currentBranch(cwd)` replaces the
    four `branch --show-current` copies. `scrubbedGitEnv` stays exported, because `gh` and the gate
    environment need the scrub without git's argv. Every spawn keeps `encoding: 'utf8'`, so a
    failure's `stderr` is still the string `failureSummary` and `enclosingProject` read. The one
    byte reader, `blobIsBinary`, shares `runGit`'s argv and env inside the module. The gate's push
    keeps its `--git-dir <scratch>` (decision 54) as an argument after `-C <scratch>`.
    *The scan* is in `git-diff-client.test.ts`: it reads every non-test source under `src/` and
    fails on any `execFileSync`, `execFile`, `spawnSync`, `spawn`, `execSync` or `exec` whose
    first argument is `git`, except in `git-diff.client.ts`. A synthetic-source test pins what
    it flags and what it leaves alone, as decision 68's does. Beside it, a temp repo plants
    `core.hooksPath` and `core.fsmonitor` in its own config. A plain git call is shown to run
    both, and `runGit` runs neither. The scan matches a literal `'git'`, so a spawn through a
    variable holding the name would pass; nothing does that today, and review is the backstop.
    The change is mechanical: every call site keeps its arguments, its trimming and its error
    handling.
