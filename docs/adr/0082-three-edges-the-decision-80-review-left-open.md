# 0082. Three edges the decision 80 review left open: git-lfs transfer agents, the PR head, and ledger truth (2026-10-13)

- Status: accepted

82. **Three edges the decision 80 review left open: git-lfs transfer agents, the PR head, and ledger
    truth (2026-10-13).**
    *git-lfs.* With `git lfs install` in the operator's global config, the lfs smudge filter is
    armed for every checkout git runs, the gate's rebase, its checkout's `read-tree` and the
    fast-forward included, and decision 50 leaves global drivers to the operator. But git-lfs reads
    `lfs.customtransfer.<name>.path` and `.args`, and `lfs.standalonetransferagent`, from the same
    shared config a session can write, and runs the program they name, and it also runs the
    `lfs.extension.<name>.clean` and `.smudge` commands on every lfs object. So `armedGitDrivers`
    refuses those five keys in local or worktree scope, beside `filter.*` and `merge.*` and under
    the same message, matched looser than git lists them because git-lfs is (found on CI review):
    git keeps a subsection's case and git-lfs ignores it, the agent can be named per endpoint url as
    `lfs.<url>.standalonetransferagent`, and the `customtransfer` pattern differs by version,
    unescaped dots in 3.x and unanchored on main, so the refusal is the union of both,
    `lfs.customtransfer.<name>.path` and `.args` anywhere in the key, with the separating dots
    unescaped so each matches any character and the name dot-free as git-lfs captures it; other
    `lfs.*` keys (`lfs.concurrenttransfers`, an agent's `concurrent`, `fetchexclude`, an extension's
    `priority`) name no program and stay allowed, and so does an ordinary branch or remote name
    carrying the word. The keys are judged the way git-lfs reads them as well as the way git lists
    them: git-lfs parses plain `git config -l`, splitting on newlines and each line on its first
    `=`, so a line hidden inside another key's value, or an `=` inside a subsection, is a key to it
    and is tested as one, and a line without `=` is not (found on CI review, reproduced with `git
    lfs env`). The pattern carries the `s` flag: git allows `\r` and the Unicode line separators
    inside a subsection, and its attribute parser keeps them in a filter name, where a `.` without
    `s` stops matching (found on security review). An operator whose setup puts the agent keys in
    local config, as lfs-folderstore and lfs-s3 instruct, is refused at launch, conductor start and
    merge until they move to global scope, which decision 50 leaves to them; that cost is accepted.
    The key refusals are the second layer. The first is that no pup git call runs git-lfs at all:
    `GIT_SAFE_CONFIG` gains `-c filter.lfs.required=false -c filter.lfs.process= -c
    filter.lfs.smudge= -c filter.lfs.clean=`, because with a global `git lfs install`, a tracked
    `.gitattributes` naming `filter=lfs` makes the global filter the smudge driver of every
    checkout, and its download runs programs named by general shared-config keys, `core.sshCommand`
    for an ssh lfs endpoint among them (found on security review, reproduced), which no key list can
    cover. So no pup git call materialises LFS content: the gate's checkout, the rebase and the
    fast-forward hold the pointer files, and so do a session's worktree and the conductor's
    checkout, which the same client creates. That is a ceiling: a repo whose build or tests need the
    binaries fails its stages under the gate until a later decision fetches them outside the
    session's reach; a session that needs them runs `git lfs pull` in its own worktree, whose git
    carries none of pup's pins; and a fast-forward leaves pointers in the main checkout for the
    operator's own `git lfs pull`. Not covered: a tracked `.lfsconfig`, whose allowlist admits any
    `remote.<x>.*` key of more than three parts, so a `remote.<x>.lfs.customtransfer.<name>.path`
    there registers an agent (found on security review, reproduced with `git lfs env`); that is
    git-lfs's to fix, and the first layer is what keeps it out of pup's own calls.
    *The PR head.* After `gh pr create` or the adopt-and-rewrite, the gate reads `headRefOid` back
    with `gh pr view --json` and refuses unless it is the pinned sha it pushed, naming both: the
    body vouches for the commit the gate measured and nothing else, and a session holding the
    operator's ambient gh login can push its branch between pup's push and the PR call. The PR stays
    open with the body, so the refusal says to find out who pushed and close or fix it before
    re-running. The body now names that sha above the gate report, because the read-back answers
    only for its own moment: GitHub can still move the head later, by a push or a "update branch"
    click, and a reviewer must be able to tell the report is for another commit. A head GitHub has
    not caught up with after a force-push to an adopted PR reads as moved too; the refusal is
    retryable, and that cost is accepted over trusting the lag.
    *Ledger truth.* `--accept-debt` filed its ledger entries before the under-lock refusals, so a
    refusal left entries reading as merged from session X with nothing merged. The target re-read
    that guards the fast-forward now also runs before the ledger write, in local mode, so a target
    moved during the stages refuses with no entry filed; `fastForward` keeps its own re-read before
    the checkout, the compare-and-swap still the backstop. The refusals that must stay after the
    write, because they guard the checkout or the PR (the HEAD re-read, the driver re-check, the
    checkout, the compare-and-swap, the push, gh and the head read-back), now end by saying the
    entries were kept for the retry, which files none twice (they name the session, and
    `hasOpenLedgerEntry` dedupes); the message is extended in place so the error keeps its type. The
    entries are not rolled back: the retry needs them unchanged, and the first approver stands
    (decision 75).
    Tests: each of the five lfs keys is refused with the armed-driver wording, so are four looser
    forms git-lfs accepts, an lfs key on a second line of another key's value, one an `=` in
    its subsection hides, and two whose subsection holds a Unicode line separator, and three
    lfs keys that run nothing and a value line without `=` are not; a `worktree add` through
    `runGit` of a tracked `*.bin filter=lfs` pointer, with the lfs smudge and then the lfs process
    filter planted as a marker, writes the pointer unchanged and never runs it, where a plain `git
    worktree add` does; a PR head read back as another sha is refused naming both and saying the
    entry was kept, and a matching head passes, the fake gh serving origin's branch by default; an
    `--accept-debt` merge whose target moved during the stages files no entry; one refused by
    drivers armed during the stages keeps its entry, keeps `ArmedGitDriverError`, and says so.
