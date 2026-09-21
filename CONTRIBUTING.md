# Contributing to Pupitre

Thanks for looking. Pupitre is small, opinionated, and built by the tool it is: most of its pull requests are opened by its own sessions and pass through its own merge gate. A human contribution goes through the same door. This page is the short version; [`AGENTS.md`](AGENTS.md) is the brief every session gets, and the design docs under [`docs/`](docs/) are the long version.

## Before you start

- Open an issue for anything bigger than a fix, or for a fix whose cause is not obvious. The design is deliberate, and [`docs/09-decisions.md`](docs/09-decisions.md) records why things are the way they are. It wins over `docs/00` to `08` where they disagree, so read the entries that touch your area before proposing a change to it.
- Small fixes, doc corrections and test additions do not need an issue.

## Setup

Requirements: the Node in [`.nvmrc`](.nvmrc) (the native modules are built for it; older Nodes segfault on `pnpm dev` while the tests still pass), pnpm, git, tmux, and the Claude Code CLI if you want to launch sessions. `gh` is needed for `pup merge --pr`.

```bash
git clone https://github.com/AlexisBalayre/pupitre.git
cd pupitre
pnpm install
cp scripts/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
pnpm test
```

The pre-commit hook lints the staged sources, typechecks, and runs the test suite before every commit, so a commit can be refused with no test failure involved. Nothing installs it for you, and CI does not run any of those, so a clone without it is a clone with no gate.

## The loop

Never commit on `main`. One git worktree per unit of work:

```bash
pnpm worktree:create my-change      # .worktrees/my-change on branch feature/my-change
cd .worktrees/my-change
# ... work, commit ...
git push -u origin feature/my-change
gh pr create --base main
pnpm worktree:clean                 # after the merge; removes worktrees whose remote branch is gone
```

`main` is protected: pull requests only, no force-push, no deletion. The scripts read the trunk name and branch prefix from [`.claude/project.env`](.claude/project.env), so they stay in agreement with the guard hooks.

## Commands

| What | Command |
| --- | --- |
| Run the CLI from source | `pnpm dev <command>` |
| Tests | `pnpm test` (Vitest); `pnpm test:watch` while working |
| Lint and format | `pnpm lint` (Biome); `pnpm lint:fix` to apply |
| Typecheck | `pnpm typecheck` |
| Build | `pnpm build` |
| Review tooling under `tools/review` | `pnpm --dir tools/review typecheck && pnpm --dir tools/review test` |

## Code

The rules live in [`docs/conventions/`](docs/conventions/): `general.md` and `naming.md` for every TypeScript file, `testing.md` for tests. The ones people trip on:

- **Read two or three neighbouring files first** and match their patterns. The codebase is consistent on purpose.
- **Files are `kebab-case.role.ts`**, for example `merge-gate.service.ts`, `session.repository.ts`, `db-client.test.ts`. A Claude Code hook refuses a name that does not match; if you write files by hand, match it yourself. The roles and what each means are listed in [`docs/conventions/naming.md`](docs/conventions/naming.md).
- **Module boundaries:** `src/cli/` stays thin and delegates to `src/core/`; `src/claude/` is the only module that touches Claude Code (tmux, hooks, `claude -p`). For orientation, the per-language toolchains live in `src/adapters/`.
- **Priority is correct, then simple, then readable, then fast.** No abstraction until its third use. No new dependency without checking the stack decisions in [`docs/08-roadmap.md`](docs/08-roadmap.md).
- **Comments say why, never what.** If deleting a comment would not confuse a competent reader, delete it.
- **Tests prove the behaviour, not the code.** Reviews here routinely ask, for a change that adds a guard, whether a test fails when the guard is removed; checking that before you open the PR, and saying so, saves a round.

## Decisions

A change that alters a rule, a boundary, a gate stage, a persisted noun, or anything hard to reverse gets a numbered entry in [`docs/09-decisions.md`](docs/09-decisions.md): what was decided, what it replaces, the alternatives rejected, and the ceilings it knowingly leaves. Number it as the next free entry at the time it lands, and expect a trivial rebase if another PR lands an entry first. Bug fixes and doc corrections do not need one.

## Pull requests

- Title: `<type>(<scope>): <summary>`, imperative, lowercase after the colon, no trailing period. Types are `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`. Scopes in use: `gate`, `cli`, `ui`, `conductor`, `watch`, `profile`, `init`, `store`, `adapters`, `claude`, `report`, `tooling`, `skills`, `deps`.
- Body: a **Summary** that shows the change as a diff sketch, call tree or file tree rather than prose; **Evidence** that it works, before and after; **Merge Danger**, saying whether it is a one-way or two-way door and what it can break. End with `Lands decision NN.` or `Follow-up to #NNNN.` when either applies.
- Keep the diff to what the title says. The gate refuses a diff over 600 changed lines unless the merge is run with `--accept-debt "<reason>" --review-by "<condition>"`, which records a ledger entry; large tests are the usual reason and are fine, but the reason has to be given.
- An automated review runs when the repository owner opens, pushes to, or comments `@claude review` on a pull request, and posts inline findings. It bills the owner's subscription, so on an external pull request it runs only if the owner asks for it; otherwise expect a human review, with questions grounded in the decisions log.

## Security

The threat model is specific and documented: a session's worktree and shell are attacker-controlled, the main checkout and the store under `~/.pupitre` are the operator's, and the merge gate is the boundary. If your change touches hook generation, profile compilation, the gate, or anything that shells out to `git`, `gh`, `tmux` or `claude`, say so in the pull request and expect the review to ask what a hostile worktree could feed it. To report a vulnerability, open an issue marked security or contact the maintainer directly rather than posting an exploit.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
