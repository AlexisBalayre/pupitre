# 0208. A worker may edit skills but not the rest of .claude (2026-11-22)

- Status: accepted
- Amends: [0006](0006-bash-scope-checking-is-best-effort.md)

208. **A worker may edit skills but not the rest of .claude (2026-11-22).**
    Decision 6 makes the gate the backstop, and its protected paths (`.claude/**`, `.pupitre/**`)
    refuse a diff whatever the task's scope. So the skills rework of
    `docs/spikes/2026-11-22-skills-rework.md` could only land by hand, outside the gate and the
    CI review. This decision lets a skill's Markdown go through a task's scope, and says what
    the gate checks in it and what only a human reads.
    *A skill is not inert prose.* Claude Code acts on a skill's frontmatter and on part of its
    body. `name` names the skill and its slash command. `description` decides when a model
    invokes it unprompted, and `disable-model-invocation` stops that. `allowed-tools` grants
    tools without a prompt while the skill runs. `hooks` registers shell commands that run on
    tool events while it is active. In the body, an exclamation mark before a backtick-quoted
    command runs that command when the skill loads and puts its output in the prompt. A skill
    is code that runs in the session that loads it, with that session's permissions.
    *An allow list of exceptions.* `PROTECTED_PATH_EXCEPTIONS` (`.claude/skills/**/*.md`)
    lifts a skill's Markdown out of `PROTECTED_PATH_GLOBS`, and `PROTECTED_WITHIN_EXCEPTIONS`
    (`.claude/skills/pr-ci-review/**`, built from `CI_REVIEW_SKILL`) puts the CI review's skill
    back. A path is protected when a protected glob matches it and no exception does, or when a
    path in `PROTECTED_WITHIN_EXCEPTIONS` matches it, case-insensitively as before. A new skill
    directory is allowed with no change to the lists. A script or template beside a skill stays
    refused (`diagnosing-bugs/scripts/hitl-loop.template.sh`, `wizard/template.sh`): a skill can
    run it, and the gate reads no part of it. Everything else under `.claude/` stays refused:
    `settings.json`, `settings.local.json`, `agents/`, `hooks/`, `rules/`, `project.env`,
    `statusline.sh`, `spot-checks.tsv`, and a file named `.claude/skills` itself. `.pupitre/**`
    stays refused too. `PROTECTED_PATH_GLOBS` is unchanged, so the land re-measure's adapter
    paths, which take it without `.claude/**`, still read `.pupitre/**` and nothing more
    (decision 198). Case folding cannot widen the exception: a spelling the matcher does not
    read as `.claude/skills/` stays protected, and `pr-ci-review` holds no letter that a
    non-ASCII character folds onto.
    *A skill is named by its directory.* Claude Code takes a skill's name, and so its slash
    command, from `name:`, and the CI workflow starts its review with `/pr-ci-review`. A path
    rule alone does not keep that skill: `.claude/skills/zz/SKILL.md` declaring
    `name: pr-ci-review` sits under the exception and outside the directory kept. So the
    scope-audit stage reads each `SKILL.md` the scope takes, as the diff leaves it, and refuses
    it as a misnamed skill unless it is a well-named skill in the one form the gate accepts
    (`isMisnamedSkill`). The gate does not try to read frontmatter the way Claude Code might:
    its parser is not in-tree, and a guess at it fails open wherever it reads narrower. The
    gate accepts this form and refuses everything else: the file opens on a line of exactly
    three dashes ended by a bare LF (no BOM, no leading blank, no space or CR after them);
    the block closes on the first later line of exactly three dashes; the YAML between them
    holds no other run of three dashes, mid-line or not, so a reader that closes earlier
    cannot read a shorter block than the gate did; it parses as one YAML document, with merge
    keys applied as a YAML 1.1 reader applies them; and its `name:` is absent or exactly its
    directory's string and not `pr-ci-review` in any case. A manifest with no frontmatter, a
    duplicated name or a name that is not a string is refused. A skill with no `name:` takes
    its directory's and passes. The gate reads the blob that the branch diff's `--raw` record
    names, by oid (`branchBlobReader`). It does not read the gate's checkout, which a build or
    test stage can rewrite before the audit runs, and it does not look the blob up by path,
    since a name that is not UTF-8 decodes to U+FFFD and can name another file (decision 154).
    *Every lifted path is a plain file.* The stage reads every path the exception lifts and the
    scope takes, not only a `SKILL.md`, and refuses one the branch leaves as anything but a
    regular file, as not a plain file. A symlink there is a name Claude Code can follow to
    content the gate never read: a symlinked `SKILL.md` loads its target's frontmatter, and
    `.claude/skills/shadow.md` linked to a directory holding a `SKILL.md` named `pr-ci-review`
    could be listed as a skill. A gitlink is refused the same way, and so is a decoded path
    that names no record or more than one.
    *The rescope follows the gate.* `pup plan edit --rescope` refuses a glob that can share a
    path with a protected glob unless it lies under an exception, and refuses one that lies
    wholly inside `PROTECTED_WITHIN_EXCEPTIONS`. A glob with a wildcard lies under the
    exception when its fixed prefix lies under `.claude/skills/`, and a path does when it is a
    skill's Markdown. So `.claude/skills/**` and `.claude/skills/<name>/SKILL.md` are taken, and
    `.claude/**`, `.claude/*/SKILL.md`, bare `.claude/skills`, a bare skill directory such as
    `.claude/skills/tdd` (it names a file the exception does not lift; `.claude/skills/tdd/**`
    is taken), a skill's script and `.claude/skills/pr-ci-review/**` are refused. A taken glob
    that also covers a script or the CI review's skill, as `.claude/skills/**` does, does not
    let them through: the gate still refuses those paths, whatever the scope.
    *What the gate checks, and what it does not.* It checks three things in a skill: its path
    against the allow list, that each lifted path is a plain file, and its manifest's form and
    `name:` against its directory. It does not check `allowed-tools`, `hooks`, `description`,
    `disable-model-invocation`, or an inline command, the shell injection a skill's body can
    carry. Those are reviewed only by the human merge click and the CI review reading the
    diff, as any source change is. A check of that content is a follow-up, not part of this
    decision.
    *Who reads a skill.* The operator's console session and the conductor read
    `.claude/skills/` from the main checkout, so a worker's skill reaches them only once it
    merges. There it can grant tools, register hooks and run its inline commands with the
    operator's permissions. A worker session launches with `--setting-sources user` and denies
    the Skill tool unless its profile names a skill (decision 107). The CI review reads the
    merge base's copy, since claude-code-action restores `.claude/` from the base
    (`.github/workflows/claude-code-review.yml`, the "Restore AGENTS.md from base" note), so a
    PR's skill edit never steers that PR's own review. It can steer every later one: the
    workflow's managed settings allow a bare `Skill` (the "Lock the review's permissions"
    step), so every merged skill is listed in every later review, and the reviewer or one of
    its subagents may invoke one whose `description` fits a review. There,
    `allowManagedPermissionRulesOnly` cancels a skill's `allowed-tools`; this decision claims
    nothing about a skill's `hooks` or inline commands in that run.
    *The CI review's skill, and why the carve-out is not yet sound.* Keeping
    `.claude/skills/pr-ci-review/**` protected, and refusing a skill named `pr-ci-review`
    elsewhere, keeps a worker from rewriting or shadowing the prompt every later review starts
    from. It does not keep a worker's skill out of a later review. A hostile skill merged
    under this exception, described to fit a review, can be loaded by the reviewer and tell it
    to drop findings. Narrowing the workflow's allow to `Skill(pr-ci-review)` would close that,
    but it is a change to `.github/workflows/`, which no session may make: it is the
    operator's. Until it lands, this carve-out is not sound against a hostile skill. The
    boundary is the operator's merge click and the CI review of the diff, as it already is for
    `tools/review/**`, which neither the gate nor the rescope protects and which every later
    review installs and runs. The `pr-ci-review` rule is defence in depth behind that click,
    not the boundary.
    *Rejected: listing every allowed skill directory.* Each new skill would need an ADR-backed
    constant change, which is what this decision removes. A list of skill directories that
    stay protected keeps that cost on the rare one, the CI review's skill.
    *Not covered here: the session hooks.* The compiled Edit/Write scope hook, the Bash guard and
    the dirty-path re-check in `profile-compiler.service.ts` still refuse every `.claude/` path,
    so a session cannot yet write a skill even with it in scope. Widening them is a separate,
    operator-scoped change, and it must settle what a skill a worker has just written can do
    in that worker's own session when its profile keeps the Skill tool, and whether the Bash
    guard sees that skill's `hooks` and inline commands.
    *Tests.* `scope-audit.test.ts` for a skill's Markdown passing in scope, each protected path
    still flagged (a skill's scripts among them), a `SKILL.md` named `pr-ci-review`, named
    other than its directory or with no frontmatter refused, a matching one passing, and every
    lifted path read and refused when it is not a plain file; `skill-name-utils.test.ts` for
    each form `isMisnamedSkill` refuses (`skill-name.utils.ts`), among them an opening line
    with a space, NBSP, form feed or vertical tab after the dashes and a name holding three
    dashes mid-line, and each it accepts; `merge-gate.test.ts` for the scope-audit stage
    refusing a `SKILL.md` named `pr-ci-review`, still refusing it after a build stage rewrites
    the checkout's copy, refusing one committed as a symlink and a `.claude/skills/shadow.md`
    committed as a symlink to a directory, and merging a well-named one;
    `task-rescope.test.ts` for a rescope taking `.claude/skills/**`, refusing each protected
    glob, a skill's script and the CI review's skill, and the gate refusing those under the
    widened scope; `land.test.ts`, unchanged, for the re-measure's adapter paths.
