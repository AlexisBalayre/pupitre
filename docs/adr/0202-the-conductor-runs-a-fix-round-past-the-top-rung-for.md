# 0202. The conductor runs a fix round past the top rung for a security or wrong-result finding (2026-11-18)

- Status: accepted
- Amends: [0092](0092-pup-routes-every-window-s-model-and-effort.md)

202. **The conductor runs a fix round past the top rung for a security or wrong-result finding
    (2026-11-18).**
    Decision 92 refuses a repeat CI fix round (decision 90) once the session's worker is on the
    top rung of its ladder, and only the operator's explicit `--model`/`--effort` gets past it. On
    2026-11-16 that left PR #353 (rounds 3 and 4, sandbox escapes) and PR #357 (round 3, a gate
    evasion) waiting on the operator's console. The findings were real, the next round could only
    run on the rung the worker was already on, and the operator had nothing to choose but "yes".
    - *The flag.* `pup fix <session-id> --finding security|wrong-result` names the class of the
      open finding. A security finding is a sandbox or scope escape, a gate evasion or a leaked
      secret. A wrong result is code that computes, returns or writes the wrong thing. The round
      stays on the top rung: it climbs nowhere, because there is nowhere to climb, and it records
      no override.
    - *Who may pass it.* Only the project's conductor. `PUP_CONDUCTOR` must name this project, and
      the process tree, walked past the conductor's own window as decision 188 walks it for
      `pup merge --pr`, must find no session's window above the caller and must be readable. A
      session is refused `pup fix` outright, as before. The operator is refused the flag too and
      keeps `--model`/`--effort`, which choose a route rather than vouch for a finding.
    - *When it applies.* Only where the plain round is refused at the top rung. A round below the
      top, or a first round on the rung the last window ran on, is refused with the flag and told to
      run without it. So a `fix_round` event carrying `finding` is exactly a round past the top.
      The flag takes no `--model` or `--effort`.
    - *The open important thread.* The round needs at least one. `pup fix` already refuses a PR
      with no open, unanswered bot thread before it computes a route, and every bot thread is an
      important finding (decision 90), so no new check is needed.
    - *What is recorded.* Every `fix_round` event now records `startedBy`, `operator` or
      `conductor`, and a past-the-top round also records `finding`. `pup status`, `pup ui` and the
      web dashboard show both on a running or awaiting-review session's route, as
      `; fix round by the conductor, past the top rung for a security finding`. A round from
      before this decision recorded no starter and shows nothing.
    - *No cap.* Such rounds are not counted against a limit. Each one is a `fix_round` event with
      `finding`, which a retro can count per PR and per class. The gate's rejection cap
      (decision 90) still bounds each round.
    - *Unchanged.* An unflagged call, the conductor's included, is refused at the top rung exactly
      as before, and a launch, relaunch or respawn refused there is still the operator's
      to decide. The conductor's compiled rules name the flag only for a refused fix round whose
      open thread is a security or wrong-result finding. Anything else (style, naming, a test
      gap, a design question) is still reported to the operator.
    - *Rejected.* Letting the conductor pass `--model`/`--effort` on a fix round: that hands it the
      route, not just the round. Inferring the class from the thread text: the text is reviewer
      output, which a worker can sway, and the class is the conductor's judgement to record.
