# 0193. `pull_request_target` workflows run under a repository Actions event policy (2026-11-16)

- Status: accepted

193. **`pull_request_target` workflows run under a repository Actions event policy (2026-11-16).**
    *What failed.* From 2026-11-16 16:28:08 UTC every `pull_request_target` run of `PR status`
    and `Claude Review push marker` ended `startup_failure` with zero jobs, while `PR status` runs
    on `push`, `pull_request_review` and `workflow_run` kept succeeding. The last successes were
    at 15:51:45 UTC, and no file under `.github` had changed. The API exposes no reason: the check
    suite has no check run, there is no annotation, the logs return 404 and the run cannot be
    re-run. The run page gives the reason: "Workflows are being blocked due to a scheduled
    brownout of the default pull_request_target protection for affected public repositories. This
    window ends at November 16, 2026 at 18:00:00 UTC." GitHub's guide ("Securely using
    pull_request_target") explains it. GitHub adds a default event policy that blocks
    `pull_request_target` in a public repository that has no applicable Actions event policy of
    its own. The policy is in evaluate mode now and is enforced on 2026-12-02. An event policy the
    repository already has is not replaced. This repository had none
    (`GET /repos/AlexisBalayre/pupitre/actions/policies` returned `total_count: 0`). No workflow
    file is wrong. From 2026-12-02 the three workflows below stop for good unless something
    changes: the push marker, `claude-review-base-change.yml`, and the `pull_request_target`
    half of `pr-status.yml`.
    *The rule.* The repository carries an Actions event policy that allows `pull_request_target`
    for exactly those three workflow files, and the workflows keep the event. The operator sets it
    under Settings → Actions → Policies → New policy:
    - Name: `pull_request_target for status workflows`.
    - Enforcement: Active.
    - Target workflows: `.github/workflows/claude-review-push-marker.yml`,
      `.github/workflows/claude-review-base-change.yml` and `.github/workflows/pr-status.yml`.
    - Restrict events: `pull_request_target`, `pull_request_review`, `workflow_run` and `push`.

    Or through the REST API, as the repository's admin:

    ```sh
    gh api -X POST repos/AlexisBalayre/pupitre/actions/policies --input - <<'EOF'
    {
      "name": "pull_request_target for status workflows",
      "enforcement": "active",
      "conditions": { "workflow_path": {
        "include": [".github/workflows/claude-review-push-marker.yml",
                    ".github/workflows/claude-review-base-change.yml",
                    ".github/workflows/pr-status.yml"],
        "exclude": [] } },
      "rules": [{ "type": "restrict_action_events",
                  "parameters": { "allowed_events":
                    ["pull_request_target", "pull_request_review", "workflow_run", "push"] } }]
    }
    EOF
    ```

    An event rule is an allowlist for the workflows it targets, so it lists every event those
    files trigger on, not only `pull_request_target`. Otherwise it would block `PR status` on
    review, `workflow_run` and push. Scoping the policy to the three files keeps the allowlist off
    the other workflows (`claude-code-review.yml` runs on `pull_request` and `issue_comment`). It
    also means no other file can gain `pull_request_target` without a change to the policy. There
    is no actor rule: `PR status` relabels fork PRs through `pull_request_target`, and the two
    marker jobs already check that the PR belongs to the owner in their `if`.
    *Why not `pull_request`.* The guide's other path moves the three triggers to `pull_request`.
    That event reads the workflow from the PR's merge commit. A same-repo PR's token gets the
    permissions the file declares, and every pup session's branch is a same-repo PR (decision 26).
    So a session whose scope covers `.github/workflows/**` could edit the push marker or
    `pr-status.yml` in its own branch. Once the gate pushes the branch, that edited file runs with
    `statuses: write` or `pull-requests: write` before anyone reads the diff, and can post a
    `claude-review` success or set `ready` on its own head. GitHub does not tie a status context
    to the file that posts it. A required check pinned to the GitHub Actions app cannot tell one
    job from another. What would stand in front of `.github/workflows` is pup's scope hook, which
    is best-effort for Bash (decision 6), the gate's scope re-check, and a human diff read that
    comes after the runs. Forks would lose too: a fork's `pull_request` token is read-only, so
    `PR status` would stop relabelling fork PRs on push, retarget and close. Only the next push to
    `main` would relabel them. `pull_request_target` is what makes these statuses come from
    reviewed code on `main`, and none of the three checks out or runs PR code.
    *Known gap.* `claude-code-review.yml` already runs on `pull_request` (`opened`, `reopened`,
    `ready_for_review`) with `statuses: write`. A branch that edits that file can post its own
    `claude-review` today. This decision does not widen that gap and does not close it.
    *Checking it.* After the policy is created,
    `gh api repos/AlexisBalayre/pupitre/actions/policies` lists it with the three paths. Outside a
    brownout, runs succeed with or without the policy until 2026-12-02. So the check is
    Settings → Actions → Policy insights: no run of the three workflows after the policy's
    creation time may show as blocked, or as would-be-blocked, by the default policy. After
    2026-12-02, a push to an open owner PR must start a `Claude Review push marker` run that
    concludes `success`, and its head must carry the "Not reviewed: push since last review"
    status.
    *Cost.* The policy lives outside the repository. A new `pull_request_target` workflow, or a
    new event in one of the three, does not run until the policy names it. A copy or fork of this
    repository needs the same policy.
