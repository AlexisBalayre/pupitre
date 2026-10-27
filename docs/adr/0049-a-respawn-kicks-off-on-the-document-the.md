# 0049. A respawn kicks off on the document the session signalled for, or on nothing (2026-09-13)

- Status: accepted

49. **A respawn kicks off on the document the session signalled for, or on nothing
    (2026-09-13).** Decision 44 closed the staged respawn — readiness needs a real
    `handoff-request` steer, so a `handoff_ready` nobody asked for no longer makes a session
    ready — and named what it left open: the file itself. `handoff.md` lives under the store's
    sessions directory, writable by anything running as this user, and nothing recorded or
    verified who wrote it. So the victim's own handoff-done, honestly steered and honestly
    signalled, still handed `pup respawn` a path rather than a document: `awaitHandoffReady`
    polls every 5 s and `respawnSession` reads the file afterwards, and whatever occupies that
    path at the moment of the read is what the fresh window is kicked off on. A session with
    nothing to do but watch could overwrite it in that window and author the victim's next
    context with no steer, no event and no trace on its own record.
    *The signal names the content, not the path.* `pup session handoff-done` now reads the
    document and records `{ hash }` — sha256 of the bytes — on the `handoff_ready` event, and
    `respawnSession` reads the file once, hashes that read, and refuses unless it equals what
    the event says, naming the session and the file. Hashing the read rather than the path is
    the point: two reads would be two chances for the file to change between them, so the
    bytes that are verified are the bytes that reach the kickoff. A signal with no document to
    hash is refused outright (`HandoffMissingError`, printed as a refusal by the CLI) — an
    agent reporting done a step early would otherwise arm a respawn on whatever wrote that
    path next, which is the hole in a different shape.
    *A new request answers with a new file.* `requestHandoff` removes any `handoff.md` before
    steering. Without that, an old document — the session's own from an earlier round, or one
    planted while waiting for this moment — sits there already satisfying a request the session
    has not answered yet.
    *Readiness is hash-aware, so tamper is a re-ask and not a wedge.* `isHandoffReady` takes
    the repo path and compares the file to the recorded hash, which is a change decision 44 did
    not ask for and the alternative made necessary: with readiness event-only, a tampered file
    left `pup respawn` looping — ready, refuse, ready, refuse — with `pup kill --respawn` and
    the loss of the whole handoff as the only exit. Hash-aware, a substituted document is
    simply not ready, so the command asks again, the stale file goes with the request, and the
    session writes a fresh one. The cost is that a session that keeps rewriting another's
    handoff can keep a respawn re-steering its victim; that is noise on a pane, not authored
    context, and it is bounded by the same sandbox everything else here is.
    *Proof by removal.* Each check has one test that fails when it is deleted, run against the
    mutated source: the comparison in `respawnSession` (the substituted document is kicked off
    on), the `rmSync` in `requestHandoff` (the stale file survives the steer), the hash on the
    event (four tests, readiness and respawn alike), and the CLI's refusal of a signal with no
    document.
    *What this leaves open.* The boundary is still the OS user, as in decisions 44, 45 and 47.
    This makes a substitution detectable and refused, not impossible: a session that can write
    the victim's `handoff.md` can also write it before handoff-done rather than after, and
    from inside the victim's worktree with the victim's id exported it is the victim to every
    check here. What is closed is the race the operator cannot see — the silent swap between a
    genuine signal and the read that acts on it.
