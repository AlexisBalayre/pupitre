# 0205. The gate's history reads ignore a planted `info/grafts` or `shallow` file rather than refuse it (2026-11-18, amends 89 and 203)

- Status: accepted
- Amends: [0089](0089-pup-s-git-reads-history-without-replace-refs.md)
- Amends: [0203](0203-pup-s-git-reads-past-submodule-config-a-session.md)

205. **The gate's history reads ignore a planted `info/grafts` or `shallow` file rather than
    refuse it (2026-11-18, amends 89 and 203).** The conductor's security reviews of 2026-11-16
    raised this follow-up. A session can write `info/grafts` or a `shallow` file in the shared
    `$GIT_COMMON_DIR`. Either one rewrites a commit's parents for any git that reads it, which
    changes history as the gate, `pup land`, the ADR-number check and the diff client see it. The
    follow-up asked that every out-of-sandbox history read be pinned against both files, beside
    the replace-ref pins, and that pup refuse when either file exists and pup did not create it.
    *What reads history outside the sandbox.* Decision 203's list: the gate, `pup land` and
    the diff client, which run git in the main checkout over a branch a session wrote, plus the
    ADR-number check (decision 146), which runs under the gate. Each one runs git only through
    `runGit` or `runGitBytes` (decision 73's single entry point), and gh runs its git under
    `pinnedGitEnv`. Every one of those children already carries decision 89's pins, beside the
    replace-ref pins (`core.useReplaceRefs=false` and `GIT_NO_REPLACE_OBJECTS=1`) and
    `core.commitGraph=false`:
    - `GIT_GRAFT_FILE=/dev/null/no-grafts`, for `<common>/info/grafts`;
    - `GIT_SHALLOW_FILE=/dev/null/no-shallow`, for `<common>/shallow`.
    Each names a path that cannot exist, which git reads as no grafts and no shallow edge.
    `spawnOptions` lays them over a call site's own `env`, so no caller can hand either file
    back. Decision 203's pins for out-of-sandbox git therefore include these two.
    *Ignored, not refused.* The pins already make the gate's history reads ignore both files.
    The refusal is not added, for three reasons:
    - a refusal is check-then-run (decision 50). A session can plant the file after the check and
      before the read. The pin holds at every read, so a refusal would guard nothing the pin
      leaves open;
    - pup creates neither file, so no record says which copy is "the store's". A real shallow
      clone's `shallow` is written by git's own fetch and looks the same as a planted one;
    - a real shallow clone already fails the gate and `pup land` on the parent its edge lacks
      (decision 89's cost). A refusal would only reword that failure. It would also stop a repo
      that has a legacy grafts file pup never reads.
    *What was missing.* A gate-level test. `git-diff-client.test.ts` and `adr-number.test.ts`
    planted each file against a single read. No test ran the gate over a branch with one
    planted, so nothing showed that the scope audit, the ADR-number check and the commit
    subjects the decision record keeps each read the real history.
    *Tests.* `merge-gate-history.test.ts` runs the gate with the file planted after the branch
    is committed:
    - an `info/grafts` that re-parents main's tip onto the branch tip;
    - a `shallow` file that lists the branch tip, which turns the tip into a root commit.
    Main's tip is dated after the branch, as a target tip is once a branch forks. Otherwise
    plain git's merge-base walk under the graft sometimes stops before it meets the branch, and
    the control reads "no merge base" rather than an empty diff.
    The controls show what plain git in the checkout reads:
    - under the graft, `diff main...pup/s1` and `log main..pup/s1` both print nothing;
    - under the shallow file, the log lists only the tip, and the three-dot diff finds no merge
      base.
    With each plant, the gate:
    - refuses a branch ADR whose number the target holds;
    - rejects an out-of-scope file at `scope-audit`;
    - merges a clean branch, fast-forwarding main to its tip, with both commit subjects in the
      decision record.
    With the two pins taken out, the grafts tests and the shallow merge test failed on every
    run. The shallow ADR and scope tests depend on how git's auto-rebase replays the cut
    branch. The shallow ADR test failed when run alone (`fresh-base` read the branch as not
    based on main) but passed in full-file runs. So the merge test is the one that always
    guards the shallow pin.
    *Ceilings.* Decision 89's ceilings still hold. The session hooks' `safe_git` and
    codegraph's git carry `GIT_SAFE_CONFIG` but not `GIT_HISTORY_ENV`, so grafts and a shallow
    file still bend what they read. Both are outside this decision's files. Under decision
    191's worker sandbox, `info/` and `shallow` are also denied to a worker's Bash. That deny
    applies only when the setting is on, and only to Bash.
