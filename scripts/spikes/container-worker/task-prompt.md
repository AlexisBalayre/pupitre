# Pupitre session t-mwj2srvp (container spike) — task t-mwj2srvp

## Goal
pup status does not list an open question from a session in state awaiting-review under 'Needs you'. On 2026-11-16 four questions sat unseen this way: t-mw9e0cpd (twice), t-mw9559w5 and t-mwafv8ms, the oldest for three days; the operator only learned of them from the conductor's prose. A session can ask after it reported done, typically during a merge of main or a fix asked by the conductor. Make every unanswered question event show in 'Needs you' (status, TUI, web overview) whatever the session's state, as long as the session is live (not landed, killed or retired), with the same 'pup answer' hint.

## Scope
- In: src/core/dashboard.service.ts, src/core/dashboard.test.ts, src/core/types/dashboard.types.ts, src/cli/index*.test.ts, test/unit/**
Edit nothing else.

## Acceptance criteria
- an awaiting-review session with an unanswered question appears under Needs you with its options, with a test
- an answered question, or one from a landed, killed or retired session, does not appear

## Conventions
Priority: correct > simple > readable > fast.
No new abstraction until the third use. No new dependency.
Read 2-3 neighbouring files and match their patterns before writing.
Delete replaced code; leave no shims or commented-out blocks.

## Session protocol
- You run in a Linux container with your own clone at /home/node/work, on branch pup/t-mwj2srvp. There is no gh and no push: commit locally, the operator fetches your branch.
- Run tests only with `pup session test <test files>`, naming the test files for the code you touched and for the code that imports it.
- Run `pnpm typecheck` and `pnpm lint` before your last commit.
- When every acceptance criterion is met and all work is committed, run exactly:
  `pup session done "<one-line summary>"`
- If you are blocked on something only a human can decide, run `pup session ask "<question>"` and end your turn; the operator answers with a steer.
