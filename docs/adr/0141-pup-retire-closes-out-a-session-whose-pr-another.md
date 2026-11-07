# 0141. `pup retire` closes out a session whose PR another PR re-landed (2026-11-07)

- Status: accepted
- Amends: [0083](0083-pup-status-opens-with-a-needs-you-inbox.md), [0084](0084-pup-land-session-closes-the-github-half-of.md)

141. **`pup retire <session> --superseded-by <pr>` closes out a session whose PR another PR
    re-landed (2026-11-07).**
    Amends decisions 83 and 84. Decision 84 gave a `--pr` merge one way out of the inbox: `pup
    land`, once GitHub says the PR is `MERGED`. A PR closed unmerged because another PR carried
    its work to main (#188, superseded by #195) had none. `pup land` refuses it, so t-mvl9b0p2
    sat in Needs you as `PR opened, not landed` with nothing to clear it, and its worktree and
    branch stayed behind.
    `pup retire` is that way out. It is operator-only, refused to sessions and to the conductor:
    calling work superseded is a judgement about what landed, and the command deletes a branch.
    It needs `--superseded-by <pr>`, a PR number (`195` or `#195`) read as a PR of the session's
    recorded origin, or a url on that repo. Every refusal comes before anything moves: the
    session must be `merged`, its newest merge must have opened a PR, it must not have landed
    or been retired, GitHub must say its PR is `CLOSED` (an `OPEN` PR is closed or landed first,
    a `MERGED` one is `pup land`'s), and the named PR must be `MERGED` into the target the
    session's PR was for. The repo is pinned the way `pup land` pins it (decisions 56, 84), so
    neither url can make gh answer for another repo's PR.
    Then, under the merge lock, with the state re-checked as `pup land` does (a `pup fix` may
    have taken the session out of `merged` meanwhile), the session's worker window is stopped,
    by pane and by name as the gate stops it (decision 46), so no live agent has its tree removed
    under it. Then the worktree is removed and the branch
    deleted while it holds no commit past the sha the gate pinned. A branch past it carries work
    nothing re-landed and is kept, and the outcome names it. A worktree git cannot remove (a
    lock) refuses with no event written, so a re-run after the operator unlocks it finishes the
    job. Last under the lock, a `retired` event records the closed PR and the superseding one
    (`{ prUrl, supersededBy }`). The inbox is to treat `retired` as it treats `landed`, so the
    session leaves Needs you; that reader change, `openPullRequest` stopping at a `retired`
    event, is task t-mw6a2pfo, which follows this one, and until it lands the line stays. The
    session stays `merged`; no new state is added, since nothing transitions out of it.
    The operator names the superseding PR. pup does not read it off PR comments or GitHub's
    "closed in favour of" links: that text is anyone's to write, and the command it would feed
    deletes a branch.
    Tests: a retire removes the worktree and branch and records both PRs; it stops the window by
    pane and name while the worktree still stands, and a refusal stops nothing; `#9` and `9` read as
    the session's repo's PR; a re-run after an earlier teardown finishes; a branch past the pin
    is kept; it refuses an unknown session, one not merged, one whose merge opened no PR, one
    landed or already retired, an open PR, a merged PR, a superseding PR that is open, closed or
    merged into another branch, and one of another repo, each with nothing moved. The CLI
    refuses a session, the conductor and a missing `--superseded-by`, and prints what it
    removed and kept.
