# Getting started

## Requirements

Node 22 or later, git, [tmux](https://github.com/tmux/tmux) and the
[Claude Code](https://docs.claude.com/en/docs/claude-code) CLI. [`gh`](https://cli.github.com/) is
needed for `pup merge --pr`. The gate refuses to run off macOS unless the operator declares the VM
as the sandbox ([decision 78](../adr/0078-off-macos-the-gate-refuses-unless-the-operator.md)).

## Install

```bash
git clone https://github.com/AlexisBalayre/pupitre.git
cd pupitre
pnpm install
pnpm build
pnpm link --global      # puts `pup` on your PATH
pup --help
```

## Onboard a repo

Run this in the repo you want to work on. Only you may run it, not a session
([decision 64](../adr/0064-pup-init-is-operator-only-like-pup-audit.md)).

```bash
pup init
```

`pup init` detects the stack (a TypeScript or Python adapter, or a custom one: see
[06 Adapters](../06-adapters.md)), measures a baseline of build, tests, lint and the debt metrics
as they are today, and records origin's URL as the push target. It fails if no adapter matches.
Day one blocks nothing: the gate only refuses regressions from this baseline. Nothing is
committed to your repo; state lives under `~/.pupitre/<project-id>/`.

Flags: `--gate-env <names>`, `--session-env <names>` and `--origin-moved`; see
[Configuration](configuration.md#environment-variables).

## Your first task, end to end

```bash
# 1. Start a session: worktree, compiled profile, claude in a tmux window
pup new "Add retry to the payments client" \
  --scope "src/payments/**" \
  --accept "a failed request is retried 3 times" \
  --accept "existing payment tests pass"

# 2. See who needs you
pup status

# 3. Watch it work (Ctrl-b d detaches)
pup attach <session>

# 4. Correct it without restarting
pup steer <session> "also cover the timeout case"

# 5. When it reaches awaiting-review: the risk-ordered queue, then one branch in detail
pup review
pup review <session>

# 6. Gate it and open a pull request (or `pup merge <session>` to merge locally, fast-forward only)
pup merge <session> --pr

# 7. After you merge the PR on GitHub, close out the session
pup land <session>

# 8. What landed and why
pup log payments
```

`<session>` is the id `pup new` prints, `t-` followed by a base-36 timestamp. The session works in
`.worktrees/<id>` on branch `pup/<id>`.

What happens in the gate and when it refuses is on [The gate and debt](gate-and-debt.md). The
whole loop as a diagram is on [the command guide](commands.md#the-operator-pr-loop).

## Next

Read [Concepts](concepts.md) once, then keep [the command guide](commands.md) open.
