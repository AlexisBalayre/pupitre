# 0200. Compaction is the default context reset; respawn is for a change of model or topic, or a wedged window (2026-11-18, supersedes decision 18's rationale)

- Status: accepted
- Amends: [0018](0018-context-is-optimized-by-handoff-respawn-not-in.md)
- Amends: [0192](0192-pup-retro-replays-each-transcript-under-lower-compaction.md)
- Amends: [0199](0199-a-compaction-restarts-from-live-state-read-by-a.md)

200. **Compaction is the default context reset; respawn is for a change of model or topic, or a
    wedged window (2026-11-18, supersedes decision 18's rationale).**
    Decision 18 made handoff-respawn the way to reset a window, on the claim that a handoff the
    agent writes keeps more than Claude Code's compaction summary does. A study on 2026-11-16 of
    the month since 2026-10-17 (349 worker, 26 conductor and 14 console transcripts) tested that
    claim and found it does not hold:
    - *What happened.* All 87 resets in the month were automatic compactions, firing at a median
      of about 267k. None was a respawn, though `pup status` suggested one above 120k.
    - *Fidelity.* A blind test on 12 real resets graded the facts each reset kept. Compaction kept
      78% of the tested facts fully and lost 6%. A handoff respawn kept 80% and lost 5%. On 12
      cases, that is the same fidelity. Decision 199's recap, which prints the live state under the summary, also
      covers what a summary is most likely to get wrong: the branch, the commits and the gate.
    - *Cost.* Decision 192's replay of every transcript puts the cheapest reset point at 120k to
      150k. Past that, each request re-reads a context larger than resetting would leave. It
      found that resetting at 120k instead of 267k would have cut 23% of worker, conductor and
      console spend.
    So compaction is the default reset. It costs no operator action, it fires on its own, and it
    keeps the facts as well as a respawn does. The operator chose a 150000 `autoCompactWindow`.
    *Compiled, not inherited.* pup compiles `autoCompactWindow` into every worker's and the
    conductor's settings from the `autoCompactWindow` key of `.pupitre/project.yml`: a whole number
    of tokens from 100000 (the least Claude Code takes) to 1000000, and 150000 by default. A
    session's window is then the project's, not whatever the operator's user settings name
    (decision 9 has sessions inherit those settings, and this one key is pinned against them).
    *Probe.* On Claude Code 2.1.327, on 2026-11-18, `/context` was run in print mode with
    `autoCompactWindow: 110000` in a `--settings` file:
    - with `--setting-sources project`, so no user settings, it reported `12.7k / 110k`;
    - with `--setting-sources user`, where the user settings say 150000, it still reported 110k;
    - the control, the same run without the flag file, reported 150k.
    So the key is honoured from a flag file, and a flag file outranks the user's settings. The
    same probe shows a 33k autocompact buffer under the window, so a compaction fires at the
    window less 33k, about 117k at 150000.
    *Status.* `pup status` no longer suggests a respawn for context size alone. Beside `ctx ~Nk`
    it prints how far the session is from its compaction point, read from the
    `autoCompactWindow` in that session's compiled settings, as `compacts in ~Mk`. When the
    point is passed it prints `at compaction`, and it prints nothing extra for a session whose
    compiled settings carry no window.
    *When respawn is still the right tool.* `pup respawn` and its handoff (decision 18's
    mechanism, unchanged) are for a window that a compaction would carry the wrong things into:
    - a change of model or effort (`--model`, `--effort`, the routing ladder of decision 92),
      which takes a new process;
    - a change of topic: the task is re-scoped or re-planned, so the old window's context is
      noise the summary would keep;
    - a wedged window: a session stuck in a loop, repeating a failure or past a dead turn, where
      a summary of that window carries the wedge with it.
    *Not a respawn case.* A change of rules, a profile, brief or project-config edit with the
    compaction window included, reaches a session only at its next launch or `pup fix` round. A
    respawn resends the stored context and settings and recompiles nothing (decisions 115 and
    183), so it keeps the old window. A session compiled before this decision carries no
    `autoCompactWindow` until then, runs on the operator's user window, and `pup status` shows a
    bare `ctx ~Nk` for it.
    *Rejected.* Keeping the 120k respawn suggestion. Following it costs an operator action per
    session for the same fidelity, and the compaction near 117k now resets the window anyway. Lowering the window below 150000:
    the replay's savings at 120k are an upper bound (decision 192 does not price the summarizing
    request), and 150000 already puts the compaction point (about 117k) at the bottom of the
    cheapest range.
