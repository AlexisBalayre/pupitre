# 0136. The PR title is a commit subject a squash merge can land as is (2026-11-07)

- Status: accepted
- Amends: [0026](0026-pup-merge-pr-same-gate-pull-request-instead.md)

136. **The PR title is a commit subject a squash merge can land as is (2026-11-07).**
    Amends decision 26, whose mechanical title was the task goal's first line, cut at 72
    characters with an ellipsis. The operator squash-merges on GitHub, and with the repo's "commit
    or PR title" setting a multi-commit PR's title becomes the subject of the one commit main
    gets, so main collected subjects cut mid-word (`… whose content is exactly w… (#222)`).
    The gate now titles the PR with the session's first non-merge commit subject, oldest first,
    when it is 72 characters or fewer: the worker wrote it as a commit subject, and on a
    one-commit PR it is the subject GitHub would use anyway. Merge commits are skipped by
    parentage (`git log --no-merges`), not by their message, so neither the `Merge main into …`
    commit the gate writes on a stale PR branch (decision 105) nor a merge the session ran is
    ever the title, while a commit of the session's whose message only reads like a merge is still
    its own.
    The subject is untrusted: the session wrote it, and it now leaves pupitre's custody unfenced,
    first as the PR title and then, under the squash setting, as the subject of a commit on main.
    That is where GitHub acts on closing keywords, so a session could close any issue the repo
    holds by naming it, and where a terminal shows the subject on every `git log`. The body's
    fence (decision 26) does not reach a title, so the subject is scrubbed instead: terminal
    escape sequences and the characters that render as nothing or reorder text (the soft hyphen,
    the combining grapheme joiner, the Hangul fillers, the Mongolian vowel separator, zero-width
    spaces and joiners, directional marks, bidi embeddings, overrides and isolates, invisible
    operators, variation selectors, the byte-order mark, and the tag block, which spells out text
    no one sees and is how instructions get hidden from AI reviewers) are dropped, then
    `sanitizeReason` spaces out C0 and C1 controls and makes it one line. Dropping before the check means an invisible character cannot split a keyword
    past it. A subject that still holds a closing keyword (`close`, `fix`, `resolve` in any
    tense and case) followed by an issue reference (`#n`, `owner/repo#n`, `GH-n` or an issue or pull URL)
    is not used: the goal is the title. The goal is scrubbed the same way but not checked for
    keywords, since the operator wrote it and decision 26 already titled PRs from it. Both
    subject reads, this one and the body's list, run with replace refs and the commit graph off,
    as decision 131's history reads do: both live in the object store a session can write, and a
    planted commit graph can hand `log` other parents, so a merge could read as a commit of the
    session's.
    When no commit subject fits, the goal's first line is the title, and one over 72 characters
    is cut at the last whitespace that leaves 72 or fewer, with no ellipsis and no trailing
    separator (`,;:` or a dash), never mid-word. A first line with no such whitespace and an
    empty goal both fall back to `pup session <id>`, as before. Re-gating an adopted PR (decision
    86) rewrites the title by the same rule, so a fix round's commits do not change it unless the
    first commit changed. The body is unchanged and still lists every commit subject.
    Tests: a one-commit session's PR is titled with its subject; a subject over 72 characters
    falls back to the goal; a goal over 72 characters is cut at a word boundary; a gate-written
    merge commit is not chosen, and a non-merge commit whose message reads `Merge main into …` is;
    a subject with an ANSI escape, a C0 and a C1 control, a bidi override, a zero-width space,
    the other blank characters and a line spelled in tag characters comes out scrubbed; a subject
    naming an issue to close, by `GH-n` too and with a zero-width or tag character splitting the
    keyword, falls back to the goal; the read pins replace refs and the commit graph off; a re-gate
    rewrites the title by the rule.
