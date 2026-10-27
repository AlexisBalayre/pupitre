# 0056. The push target is recorded at setup, and a merge whose config disagrees is refused (2026-09-17)

- Status: accepted

56. **The push target is recorded at setup, and a merge whose config disagrees is refused
    (2026-09-17).** Decision 54 pushed from a git dir that reads no shared config, which closed
    `url.*` rewrites, and stated the ceiling it could not close from there: `remote.origin.url`
    itself lives in that same session-writable config, so a session that rewrites the value
    rather than a rewrite rule still aims both the push and the gh `--repo` pin. Reproduced in
    the gate's own fixture before this was written, and again afterwards with the check taken
    back out: a `remote.origin.url` written from the worktree lands the session's branch in a
    second bare repo, and the pull request is pinned to that repo's slug.
    *The trusted copy is taken once, where trust actually exists.* `pup init` reads
    `git config --get remote.origin.url` from the checkout the operator is standing in — before
    any session for the project exists — and stores it on `projects.origin_url`; `pup audit`, operator-only
    since decision 48, records one the same way when there is none. Raw, through the
    same `readOriginUrl` the gate reads with, never `remote get-url`: one function, so the
    recorded value and the compared value cannot drift into being read two different ways. A repo
    with no origin records nothing; `--pr` there already refuses on the missing remote.
    *The gate pushes the record, and reads the config only to catch it moving.* `pushTarget`
    runs in `runMergeGate`, right after the `gh` probe and before the adoption probe, and what it
    returns — carried to the push and to `originRepoSlug` exactly as decision 54 carries it — is
    the recorded value, not the configured one. The live read is the tripwire, not the source:
    when the two disagree the merge is refused with both values named, and when nothing is
    recorded it is refused pointing at `pup init`. Both refusals land before the gate runs, so
    nothing is pushed, no PR is opened, and the session stays `awaiting-review`. This is decision
    6's loud backstop, decision 50's shape: pup could quietly push to the recorded URL and say
    nothing, but a `remote.origin.url` the operator did not write is a session that wrote it, and
    that is worth stopping for rather than working around.
    *Re-recording is a flag, and the flag is operator-only.* Origin does legitimately move — a
    repo renamed, a fork promoted — so `pup init --origin-moved` re-records from the current
    config. A plain `pup init` re-run never overwrites a disagreeing value; it reports it as a
    finding naming both, with the flag. That is the considered-override shape `--accept-debt` and
    `--allow-overlap` established: the flag refuses a calling session, because re-aiming where
    sessions' work is pushed is not a session's call (decisions 41, 48).
    *A session's own `pup init` records nothing at all.* The first record is as dangerous as a
    re-record — a project set up before this column existed has none, and a session that got
    there first would nominate the target the gate then holds it to. So the CLI passes `'skip'`
    when `callingSession` answers, and the row stays empty until an operator runs it. The merge
    refusing loudly on an unrecorded target is what makes that safe rather than silent.
    *The operator can see the value they are held to.* `push target: <url>` prints beside the
    `sandbox:` and `codegraph:` lines on `pup init` and `pup audit` alike, read from the row the
    gate reads, and says "not recorded" in as many words when there is nothing there
    (decisions 36, 51).
    *What is refused rather than recorded.* A configured URL that does not survive
    `sanitizeReason` — control characters, newlines, 300-plus characters — is reported as a
    finding and not stored: no remote URL anyone types needs an escape sequence, a stored one
    would repaint the terminal every time the line is printed, and a sanitized copy is not the
    value the gate could compare against. The print sanitizes too, for rows written before this.
    And the first record is only trust-on-first-use while nothing else has had the config: on a
    project that has already run sessions — every project set up before the column existed — it
    is held back with a finding, and `--origin-moved` is how the operator confirms it.
    *Ceilings.* **`pup init` is not operator-only**, unlike `pup audit` (decision 48), so a
    session can still re-run it and re-stamp the debt baseline through the command decision 48
    did not cover. The push target is defended against that by the `'skip'` above; the baseline
    is not, and closing it is decision 48's shape applied to one more command — its own change
    (closed by decision 64, which refuses a calling session outright and deletes `'skip'`).
    **A project whose origin moved and whose operator has not re-recorded cannot merge with
    `--pr`** until they do; that is the intended refusal, but it is a stop-the-world one, and the
    same is true of every project set up before the column existed. **The record is only as good
    as the checkout `pup init` ran in:** an operator who onboards a repo whose `remote.origin.url`
    was already poisoned records the poison, and nothing here can tell — holding the first record
    back narrows this to a project with no sessions yet, where the operator is the only writer the
    config has had, but a repo cloned from a poisoned source is recorded as it stands.
    **The store is the root of trust:** the recorded URL is a row in the same SQLite store a
    session can reach on disk, so this is loud against a session that rewrites git config and
    silent against one that rewrites the store — decision 46's ceiling, and the one every check
    pup makes against its own rows stands on. **Decision 27's ceiling
    stands:** a session that `cd`s out of its worktree and unsets `PUP_SESSION_ID` is an operator
    to `callingSession`, so the `'skip'` and the flag's refusal make the audit trail honest, not
    tamper-proof — the sandbox is the instrument for the rest. (The `'skip'` is gone since
    decision 64; the whole command's refusal stands at the same ceiling.)
