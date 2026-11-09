# 0151. The CI review runs at opening and on demand only (2026-11-07)

- Status: accepted
- Amends: [0090](0090-pup-fix-session-hands-the-ci-review-s.md)

151. **The CI review runs at opening and on demand only (2026-11-07).**
    Amends decision 90, whose fix loop relied on the review re-running at every push. The
    workflow triggers on `opened`, `ready_for_review`, `reopened` and the owner's `@claude
    review` comment; `synchronize` is gone. A review costs a median $1.30 and 141 s, and a push
    burst or a nit round bought a full review each time.
    *The marker.* `claude-review-push-marker.yml` sets the pushed head's `claude-review` status to
    pending "Not reviewed: push since last review", for the owner's same-repo, non-draft PRs.
    `pr-status.yml` reads that one "Not reviewed" description as awaiting a review
    (`ci-pending`), where the preflight's comment-only skip stays final. `pup ci wait` ends
    on it at once with a digest naming the ask, as it does on the comment-only skip.
    *The ask.* After a gated fix round, the comment `pup` posts on the PR ends with `@claude
    review`, so a round pup gated gets its review. A push `pup` did not make gets none until the
    operator comments.
    *Ceiling.* The owner's own comment is the only trigger, so a worker cannot ask for a review
    outside `pup fix`.
