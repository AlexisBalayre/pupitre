# 0031. A Python file is exempt from coverage only if both checkouts call it a test (2026-07-25)

- Status: accepted

31. **A Python file is exempt from coverage only if both checkouts call it a test
    (2026-07-25).** Closes the ceiling decision 30 stated and deferred: `isPythonTestFile`
    followed pytest's *default* `python_files`, which any config file can redefine. Since
    `coverableFiles` is the only input to both of decision 30's flags, a name it exempts is
    invisible to the gate entirely — so a session put production code in `test_payments.py`
    and narrowed `python_files` in its worktree, leaving a module pytest never collects,
    never executes and never covers, which pup waved through on the strength of its name.
    `python_files` now resolves from *both* checkouts and a file is exempt only when both
    classify it as a test. Reading it from the trusted checkout alone was considered and
    rejected: the trusted value *is* the default the attack relies on, so the AND is the
    part that does the work. The failure directions are deliberately asymmetric — an
    unparsed or empty declaration yields no patterns, which leaves more files coverable,
    never fewer. `conftest.py` stays exempt unconditionally, as pytest's own special case.
    **Two holes were in the fix, not the original**, both found by re-running
    `security-reviewer` on the revision and reproduced before being acted on.
    First, reading the pattern list from `configPath` created a channel that did not exist
    when the classification was a hardcoded constant: the trusted side is only trusted one
    merge deep, so a PR touching no `.py` file at all — and therefore passing the coverage
    stage as a skip — can land `python_files = ["*.py"]` and switch decision 30's check off
    permanently, silently, for every later merge. Second, the same change fed
    attacker-authored patterns to `globToRegExp`, whose `*` becomes `[^/]*`: measured
    against a 254-character basename, `*a*a*a*a*b.py` backtracks for 41 seconds and grows
    about 8x per added wildcard. That spin happens inside the merge lock, which is released
    in a `finally` a Ctrl-C'd process never reaches and which has no TTL, so any session
    could wedge every subsequent merge in the repo. Before this change neither was
    reachable: the old predicate was `startsWith`/`endsWith`, no config, no regex.
    Both are answered by one filter, `isDiscoveryConvention`, applied to both sides. A
    pattern is honoured only if it is within a wildcard budget *and* fails to match an
    arbitrary canary basename — a pattern matching `zzpupcanaryzz.py` is a blanket, not a
    convention. The budget is checked first so the canary match cannot itself become the
    payload, and a canary-only filter would not have closed the second hole: the ReDoS
    pattern does not match the canary.
    Two further holes were in the fix itself. **The first was a parser differential**: pytest
    treats `pytest.ini` as its config by *existing*, even empty, and modelling that as
    "carries a `[pytest]` section" let a session commit an empty `pytest.ini` beside the
    shared `pyproject.toml`. pytest then reverts to its defaults while pup keeps reading the
    pyproject, so a `check_payments.py` both checkouts agree is a test is one pytest never
    collects, never runs and never covers — a one-PR bypass of the whole AND, with the two
    checkouts never visibly disagreeing. `pytest.ini` now claims the config by presence; the
    other three still require their section, which is also pytest's rule.
    **The second was the canary itself.** A canary of ordinary letters is a fixed string the
    adversary reads, and the wildcard budget of two is exactly enough to dodge it:
    `zzpupcanaryzz.py` contains no `_`, so `*_*.py` cleared the filter while claiming nearly
    all snake_case Python. Zero-wildcard entries were not screened at all, so a declaration
    could simply enumerate the modules it wanted exempted. The canary now carries every
    character a blanket can key on (`zz_0123456789-abcdefghijklmnopqrstuvwxyz.py`) — a real
    convention anchors at one end and cannot match it, while anything shaped "contains an X"
    must — and at least one wildcard is now required.
    **A third hole was in that filter**, and it is the reason the budget counts wildcards in
    the *compiled* source rather than in the pattern text. `globToRegExpSource` swaps
    globstars for NUL-delimited sentinels before expanding them, and nothing stops those
    sentinel bytes arriving from a config file: `\0g\0m\0g\0e\0g\0t\0g\0s.py` presents zero
    wildcards to a textual count, compiles to `^.*m.*e.*t.*s\.py$`, and — built from letters
    the canary lacks — clears the blanket check too, leaving a targeted exemption for
    `payments.py` specifically. The first attempt at a regression test here was a wall-clock
    bound, and it passed against the broken counter: the payload took 505ms against a 1000ms
    bound. Asserting the *exemption* rather than the elapsed time is what made it discriminate.
    Ceilings, stated rather than implied. The canary stops the blanket, not a *targeted*
    planted pattern: `python_files = ["payments.py"]` merged into the trusted config exempts
    exactly that file, and requiring a wildcard would not help, since `payment?.py` reaches
    the same place. That residual is decision 29's accepted position — main is trusted only
    in the sense that the gate let it in one merge earlier — and it is visible in a PR diff
    in a way the blanket is not. `conftest.py` remains an unconditional name-only exemption
    at any depth, so production code reached through a registry from an already-merged
    caller is exempt there; narrowing it would flag ordinary fixtures. Pattern count is
    capped at 64: nothing else bounds a declaration, which can be one very long line that the
    diff-size stage counts as a single changed line, and 50,000 patterns measured 2.5s of
    regex compilation per merge inside that same untimed lock.
    The blanket rule has a false-positive that is worth naming, because decision 30 warns
    that reflexive `--accept-debt` destroys the ledger: `python_files = ["*.py"]` scoped by
    `testpaths = ["tests"]` is a real if uncommon layout, and it is now rejected wholesale,
    so every changed file under `tests/` becomes coverable and — if the coverage config also
    scopes to `src` — flags on every merge that touches a test. It is deferred rather than
    adopted: it is a judgement about false-flag load, and this repo has no Python to dogfood
    it against.
    **Correction (2026-07-27):** this entry originally proposed falling back to the defaults
    when the *entire* declared list is rejected, and claimed that would restore the old
    behaviour for such a repo. It would not, and the remedy should not be implemented as
    written. The defaults are `test_*.py`/`*_test.py`, and a repo declares
    `python_files = ["*.py"]` precisely because its tests are *not* named that way — if they
    were, the blanket would buy it nothing. So the fallback returns exactly the patterns that
    already fail there, and every non-default-named file under `tests/` keeps flagging. The
    fallback would only help a repo whose blanket was redundant to begin with. It remains
    safe (the AND still anchors on the trusted side), just ineffective for the layout that
    motivated it.
    Actually fixing that layout means honouring `testpaths`, which nothing in `src/` parses
    today: scope a blanket to the declared test directories rather than reject it. That is a
    larger change carrying its own attack surface — `testpaths` is attacker-controlled too, so
    it needs a convention filter of its own, a declaration of `testpaths = ["src"]` being the
    obvious payload — and it is what the deferral should be understood to cover.
    Adding `pytest.ini` and `tox.ini` to the files read widens the uncaught-throw surface
    (`mkdir pytest.ini` gives `EISDIR`), which fails closed: the merge refuses and the lock
    releases. Character classes (`test_[ab].py`) are escaped by `globToRegExp` rather than
    honoured, so they fail to match and land on the coverable side.
