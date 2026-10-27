# 0068. Every store-read, repo-read and child-read string is scrubbed where it prints, and a source scan holds the line (2026-09-24)

- Status: accepted

68. **Every store-read, repo-read and child-read string is scrubbed where it prints, and a source
    scan holds the line (2026-09-24).** Decision 67 left the raw sinks as a list in prose, one
    task each. That is the shape that had already failed twice: decision 61 scrubbed the fleet's
    session rows and left `pup review` a whole page of raw ones, decision 67 scrubbed `pup review`
    and left `pup watch`, `pup ledger` and `pup log`. A list of known sinks is not a rule, and a
    rule nothing checks is a list.
    *The five it named, fixed at the print site.* `pup watch`'s `OVERLAP` line printed
    `pair.sessionA` and `pair.sessionB` raw beside a files list that was already scrubbed, and
    its `STALLED` line printed the session id the same way. `pup debt` printed an entry's
    `description`, `reason`, `review_by`, `accepted_by` and `created_at` — every column of a
    ledger row a `--accept-debt "<reason>"` argument fills. `pup log` printed a record's
    `summary`, `alternatives`, `conventions`, `session_id` and `created_at`. `printGateReport`,
    the live report `pup merge` prints, printed `stage.stage`, `stage.status`, `stage.detail` —
    typically a failing command's stderr from the session's own worktree — and `report.sandbox`,
    while `pup review`'s copy of the same report had been scrubbing all four since decision 67.
    `printBaselineTail`, which ends both `pup init` and `pup audit`, printed `report.sandbox` and
    every finding, and the findings interpolate an adapter id that comes out of
    `.pupitre/adapter.yml` unvalidated. Producers were not touched: the fold is the surface, as
    decision 29 has it, because a producer has other readers and a sanitized value is no longer
    the value they compare against.
    *A dozen more the scan found once it was written*, which is the whole argument for writing
    it: `pup merge`'s open-debt line (`c.description`, straight off a ledger row) and its refusal
    line (the flagged stage names), `pup init`'s and `pup audit`'s failing-stage tails
    (`detail.split('\n').at(-1)`, the adapter's own stderr), `pup init`'s `adapters:` line and
    per-stage lines, `pup audit`'s transition lines (`t.stage` and the `before -> after` move,
    both read back out of the stored baseline), `pup status`'s overdue-debt, radar and backlog
    lines and `pup plan list`'s rows (each already scrubbed by its producer, and now scrubbed
    where they print as well), `pup brief edit`'s created-file line, and the ids `pup session
    done`, `pup session handoff-done`, `pup plan`, `pup debt close` and every launch echo back.
    *The rule the scan encodes:* every named field a `console.log` interpolates is sanitized where
    it prints, whatever its provenance. The first cut carved out values pup had computed in the
    same process — a stage name `runBaselineStage` had just returned, the `t.delta`
    `compareBaselines` had just derived — and the carve-out cost more than it saved: it is a rule
    a reader has to re-derive per line, and a field that becomes store-read later changes
    provenance without changing shape. Scrubbing a `'build'` literal costs one idempotent call.
    *Details are scrubbed line by line, never whole.* `plainDetail` in `merge-gate.service.ts`
    keeps newlines and `GATE_OUTPUT_TAIL_CHARS` (2000) on purpose, because `scope-audit` prints
    one path per line and `worktree-clean` one file per line, while `sanitizeReason` collapses
    whitespace and cuts at 300 characters. The first cut of this decision passed a whole detail
    through it, which turned a twelve-path scope audit into about six paths on one line with
    nothing to say the rest had been dropped — a behaviour regression on every terminal surface,
    caught by the security review. `printGateStage` now prints the first line beside the stage
    and the rest indented under it, each scrubbed on its own, and `printRecordField` does the
    same for a decision record's prose. A single line still over 300 characters is still cut,
    with no marker: the mechanical summary a merge drafts — the goal and the commit subjects
    joined by `|` — is routinely that long, and `pup log` cuts it.
    *The scan itself* lives in `index.test.ts`, reads `src/cli/index.ts`, and walks it rather than
    matching it with a regex: these interpolations nest — a ternary whose branch is another
    template — and a pattern that stops at the first `}` reads half of one. It collects every
    top-level `${…}` of every template literal a `console.log` takes, and fails the suite when one
    names `description`, `reason`, `review_by`, `accepted_by`, `summary`, `alternatives`,
    `conventions`, `detail`, `sandbox`, `sessionA`, `sessionB` and nineteen more — `id`, `files`,
    `path`, `stage`, `status`, `move`, `state`, `branch`, `goal`, `acceptance`, `adapters`,
    `finding`, `created_at`, `session_id`, `sessionId`, `reviewBy`, `worktreePath` among them —
    and carries neither `sanitizeReason` nor `goalHeadline`. Only a name followed by `(` is
    skipped, as a function rather than a field. The first cut skipped a name followed by `.` as
    well, on the theory that it was an object being walked through, and that silently exempted
    the two sinks spelled `detail.split('\n')`: removing their sanitizer returned no findings.
    *Twelve interpolations are allowlisted, whole and by name*, in three groups. Two name a listed
    field only inside a quoted constant: `'sandbox'.padEnd(16)`, the column label on the sandbox
    line, and `blockedReason(db, session) ?? '(no reason recorded)'` on `pup unblock`'s, whose
    function sanitizes what it returns. Seven print a number rather than text: `pup review`'s
    four counters reached through a local called `detail` (`.risk`, `.rejectCount`,
    `.scopeViolations`, `.overlaps`), and `entry.id`, `record.id` and `c.id`, which are
    `INTEGER PRIMARY KEY AUTOINCREMENT` — a rowid alias SQLite refuses a non-integer for, whatever
    wrote the row. Three print a derivation of the repo path rather than the path:
    `codegraphLabel(repoPath)`, a label pup composes; `conductorSocket(projectId(repoPath))`, a
    hex socket name; and `briefPath(repoPath)`, a store path pup built — the path itself, in the
    `Project <id> (<repo>)` header `pup init` and `pup audit` open on, prints scrubbed, and
    `repoPath`/`repo_path` are on the field list so the header cannot regress. Listed whole
    rather than by pattern, so a sink that grows out of one stops matching and is flagged again.
    *Tests,* on temp stores with a throwaway `HOME`, one per sink, each planting a control
    character in the field and asserting no `\u001b` reaches stdout: an overlapping pair for
    `pup watch`, a ledger row for `pup debt`, a decision record for `pup log`, a mocked gate
    report for `pup merge`, and for `pup init` a `.pupitre/adapter.yml` whose `id` carries an
    escape and whose `coverage` command fails, which is the real path an adapter id reaches a
    finding by. Beside them: a failing build stage whose stderr carries one, the same repo
    audited after its build flips to failing, `pup status`'s two snapshot lines, and the record
    a merge offers for review — that last one printed with `isTTY` forced and `setRawMode`
    raising the `ENOTTY` a stdin that is not a terminal raises, because the keystroke that
    follows the print cannot be fed under vitest (`readSync(0, …)` returns `EAGAIN` forever).
    *Thirty-five mutants, each applied to a backup copy and restored from it*, one per sanitized
    sink: the scan catches thirty-four. The one it misses is `pup merge`'s refusal line, whose
    stage names are joined into a local called `flagged` before the template sees them — the
    field name is gone by the time the interpolation is written, which is the limit of the
    approach rather than a gap to patch. Two sinks were rewritten because the harness showed the
    same shape creeping in: `reportLaunched` sanitizes on each interpolation instead of once into
    a local, and `printRecordField` prints every line from one site rather than lifting the first
    into a `head` the scan cannot see through. An earlier run of the harness is what found the
    `detail.split` exemption and the whole-detail regression. The scan's own behaviour is pinned by a second
    test over a synthetic source holding a raw sink, a sanitized one, both constant shapes, an
    integer key, a nested ternary, a raw `detail.split`, and a `console.error`, and expects
    exactly the raw ones back.
    *Two small deduplications,* both of a block that had already drifted: `printDecisionRecordBody`
    prints the three prose fields for both readers of a record, and `printGateStage` prints one
    stage for both the live report and `pup review`'s copy of the stored one. Each pair printed
    the same fields two different ways, which is how one of each came to be scrubbed and the
    other not — and, once both were scrubbed the same wrong way, how the whole-detail regression
    landed on two surfaces at once.
    *Ceilings, enumerated rather than claimed.* What the scan guards is narrow and exact: a
    `${…}` inside a template literal passed to `console.log`, in `src/cli/index.ts`, whose text
    contains one of the listed field names not followed by `(`. Everything else is outside it,
    and the thirty-five-mutant run is what measures the gap rather than argues it away. It does not
    see a value precomputed into a local before the template — `flagged` is the live example, and
    any `const x = row.reason` ahead of a print is the same shape. It does not see `console.error`
    or `process.stdout.write`. It does not see a field whose name is not on the list, and the
    list is the columns that exist today: a new one is unguarded until it is added, and a name
    that does not survive a `.join`, a `.map` or a rename is unguarded for good. It does not see
    an expression that sanitizes one field and prints another raw beside it, since one
    `sanitizeReason` anywhere in the expression clears it. It does not see any other file: the
    Ink surfaces under `src/cli/ui` are covered by `dashboard.service.ts`'s producers instead,
    which is a different guarantee with no scan behind it. And it says nothing about the shape of
    what is printed — it would pass a whole multi-line detail folded into one line, which is
    exactly the regression this decision's first cut shipped and its own tests, not the scan,
    caught. What *is* closed is narrower than decision 67's ceiling and wider than nothing: every
    sink decision 67 listed, every sink the scan found beside them, and thirty-four of the thirty-five
    ways a reviewer could take a sanitizer back out of `index.ts` today.
