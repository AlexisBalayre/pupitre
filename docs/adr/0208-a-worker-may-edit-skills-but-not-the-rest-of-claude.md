# 0208. A worker may edit skills but not the rest of .claude (2026-11-22)

- Status: accepted
- Amends: [0006](0006-bash-scope-checking-is-best-effort.md)

208. **A worker may edit skills but not the rest of .claude (2026-11-22).**
    Decision 6 makes the gate the backstop, and its protected paths (`.claude/**`, `.pupitre/**`)
    refuse a diff whatever the task's scope. So the skills rework of
    `docs/spikes/2026-11-22-skills-rework.md` could only land by hand, outside the gate and the
    CI review. A skill is prose a model reads, not config pup or Claude Code acts on, so it can
    go through a task's scope like any other file.
    *An allow list of exceptions.* `PROTECTED_PATH_EXCEPTIONS` (`.claude/skills/**`) lifts paths
    out of `PROTECTED_PATH_GLOBS`, and `PROTECTED_WITHIN_EXCEPTIONS`
    (`.claude/skills/pr-ci-review/**`) puts paths inside an exception back. A path is protected
    when a protected glob matches it and no exception does, or when a path in
    `PROTECTED_WITHIN_EXCEPTIONS` matches it, case-insensitively as before. A new skill
    directory is allowed with no change to the lists. Everything else under `.claude/` stays
    refused: `settings.json`, `settings.local.json`, `agents/`, `hooks/`, `rules/`,
    `project.env`, `statusline.sh`, `spot-checks.tsv`, and a file named `.claude/skills`
    itself. `.pupitre/**` stays refused too. `PROTECTED_PATH_GLOBS` is unchanged, so the land
    re-measure's adapter paths, which take it without `.claude/**`, still read `.pupitre/**` and
    nothing more (decision 198).
    *The rescope follows the gate.* `pup plan edit --rescope` refuses a glob that can share a
    path with a protected glob unless the glob lies inside an exception, and it refuses a glob
    that lies wholly inside `PROTECTED_WITHIN_EXCEPTIONS`. So `.claude/skills/**` and
    `.claude/skills/<name>/SKILL.md` are taken, and `.claude/**`, `.claude/*/SKILL.md`, bare
    `.claude/skills` and `.claude/skills/pr-ci-review/**` are refused. A taken glob that covers
    the CI review's skill, as `.claude/skills/**` does, does not let it through: the gate still
    refuses that path, whatever the scope.
    *Who reads a skill, and why a worker's edit is still reviewed.* Three readers load
    `.claude/skills/` from the main checkout or the target branch, never from a worker's
    branch. The operator's console session and the conductor read it after a merge. The CI
    review reads the merge base's copy, since claude-code-action restores `.claude/` from the
    base (`.github/workflows/claude-code-review.yml`, the "Restore AGENTS.md from base" note),
    so a PR's skill edit never steers that PR's own review. No reader sees a worker's skill
    before it merges. The CI review reads the edit as part of the diff, and an operator reads it
    before clicking merge, as with any source change. The CI review's own skill is the
    exception kept: its prompt runs with a repo token on every later PR, so an edit to it would
    act with that token on code the edit's reviewer never saw. It stays where only the operator
    edits it by hand. Case folding cannot widen the exception: a spelling the matcher does not
    read as `.claude/skills/` stays protected, and `pr-ci-review` holds no letter that a
    non-ASCII character folds onto.
    *Rejected: listing every allowed skill directory.* Each new skill would need an ADR-backed
    constant change, which is what this decision removes. A list of skill directories that
    stay protected keeps that cost on the rare one, the CI review's skill.
    *Not covered here: the session hooks.* The compiled Edit/Write scope hook, the Bash guard and
    the dirty-path re-check in `profile-compiler.service.ts` still refuse every `.claude/` path,
    so a session cannot yet write a skill even with it in scope. Widening them is a separate,
    operator-scoped change.
    *Tests.* `scope-audit.test.ts` for a skill passing in scope and each protected path still
    flagged; `task-rescope.test.ts` for a rescope taking `.claude/skills/**`, refusing each
    protected glob and the CI review's skill, and the gate refusing that skill under the widened
    scope; `land.test.ts`, unchanged, for the re-measure's adapter paths.
