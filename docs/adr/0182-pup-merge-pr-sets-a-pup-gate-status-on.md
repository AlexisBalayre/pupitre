# 0182. `pup merge --pr` sets a `pup-gate` status on the sha it pinned, and branch protection requires it (2026-11-13)

- Status: accepted
- Amends: [0026](0026-pup-merge-pr-same-gate-pull-request-instead.md)
- Amends: [0086](0086-pup-merge-session-pr-re-gates-a-merged.md)

182. **`pup merge --pr` sets a `pup-gate` status on the sha it pinned, and branch protection requires it (2026-11-13).**
    *The gap.* A PR's description vouches for the sha the gate pinned (decision 82), and `pup land`
    refuses a PR GitHub merged at any other head (decision 84). Both come too late: GitHub's merge
    button reads neither. #278 and #283 were merged at heads pushed after their gate, and only
    `pup land` noticed.
    *The status.* Once `pup merge --pr` has opened or adopted the PR and read its head back as the
    pinned sha, it sets a commit status on that sha through the operator's `gh` (decision 12):
    context `pup-gate`, state `success`, and a description naming the session and the time of the
    run. A re-gate (decisions 86, 90) sets it again, on the head it pinned. A status belongs to a
    commit, not to the PR, so any later push moves the head to a sha without one. When gh fails to
    set it, the run fails before the session moves, and the retry of decision 27 sets it.
    *The protection.* As a required status check on the target branch, `pup-gate` keeps the merge
    button disabled until `pup merge --pr` has gated the PR's head. The operator sets this up once
    per repo, in their own shell. pup does not do it, and neither does a session or the conductor,
    because it is a repo-wide setting and no session's change. `TARGET` below is the branch
    `pup merge --pr` targets, the main checkout's branch. First read the target's protection, then
    run only the command for its state, so no existing rule is wiped:

    ```sh
    gh api repos/OWNER/REPO/branches/TARGET/protection
    ```

    - `Branch not protected` (404): protect it. This `PUT` is safe only here, because it replaces
      any protection the branch already has.

      ```sh
      gh api --method PUT repos/OWNER/REPO/branches/TARGET/protection --input - <<'JSON'
      {
        "required_status_checks": { "strict": false, "contexts": ["pup-gate"] },
        "enforce_admins": true,
        "required_pull_request_reviews": null,
        "restrictions": null
      }
      JSON
      ```

    - Protected, with no `required_status_checks`: turn them on in the target's protection rule
      on GitHub, under the repo's Settings, Branches. Tick "Require status checks to pass before
      merging", add `pup-gate`, leave "Require branches to be up to date before merging" off,
      and save. No REST call does this alone. The `PATCH` and `POST` under
      `required_status_checks` change checks that are already on, and answer 404 in this state.
      Only the `PUT` above turns them on, and it would drop the rules the branch has. The page
      offers only the checks the repo has seen recently, so if it does not list `pup-gate`, run
      one `pup merge --pr` first.

    - Protected, with `required_status_checks`: add `pup-gate` to the checks already required.

      ```sh
      gh api --method POST repos/OWNER/REPO/branches/TARGET/protection/required_status_checks/contexts \
        -f 'contexts[]=pup-gate'
      ```

    In both protected states, also turn on `enforce_admins` unless the read showed it already on:

    ```sh
    gh api --method POST repos/OWNER/REPO/branches/TARGET/protection/enforce_admins
    ```

    Check the result by running the read again: `required_status_checks` must list `pup-gate`,
    and `enforce_admins.enabled` must be `true`. On GitHub Enterprise, add `--hostname HOST` to each
    command. `enforce_admins` is required, not optional. The operator usually administers the repo,
    and without it GitHub lets an admin merge without waiting for the check (`gh pr merge --admin`,
    or the merge box's bypass). Sessions share the operator's gh login, so they could do the same.
    `strict` is off: the gate already brings the branch onto the target (decision 105).
    Strict mode would also make every move of the target a push to the PR, and each push needs a
    re-gate. The check also holds every PR that pup did not open. That is intended: no PR merges
    without the gate.
    *PRs already open.* A PR opened by a `pup merge --pr` from before this decision has no
    `pup-gate` on its head. Once the check is required, its merge button stays off. If its head
    moved after its gate, the usual re-gate sets the status. If its head is still at the pin,
    nothing pup runs sets it, because a re-gate refuses a head at the pin as having nothing new
    to measure (decision 86). For each such PR, the operator does one of two things. They can
    merge it and run `pup land` before turning protection on. Or they can run
    `pup merge <task> --pr`, which refuses and names the PR's head as the sha the gate pinned,
    and then set the status on that sha (`PIN`) in their own shell:

    ```sh
    gh api --method POST repos/OWNER/REPO/statuses/PIN \
      -f state=success -f context=pup-gate -f 'description=Gated before decision 182'
    ```

    This is the only status ever set by hand, and only the operator sets it. A session or the
    conductor never does. `pup land` still refuses a merge at any head but the pin.
    *Limits, accepted.* Anyone who can write to the repo can set a status, including a session
    that holds the operator's gh login. So `pup-gate` stops an honest push made after the gate from
    being merged. It does not stop a session that forges the status. `pup land`, which reads the
    pin from the store, remains the check for that case. Once `pup-gate` is required, GitHub refuses
    a push of the target made after a plain `pup merge`, because that path fast-forwards the local
    target and sets no status. With `enforce_admins` on, that includes the operator's own push, so
    `--pr` is the only way pup's work reaches such a target. On a private repo, branch protection
    needs a paid GitHub plan. Without it, the status is only informational.
