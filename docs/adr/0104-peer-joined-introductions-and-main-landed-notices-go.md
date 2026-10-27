# 0104. Peer-joined introductions and main-landed notices go only to running sessions, and an overlap on this log alone introduces no one (2026-10-25)

- Status: accepted
- Amends: [0099](0099-workers-share-files-and-collaborate-a-launch-overlapping.md)

104. **Peer-joined introductions and main-landed notices go only to running sessions, and an
    overlap on this log alone introduces no one (2026-10-25).**
    Amends decision 99. Both notices went to every session holding its scope, so in any
    non-terminal state: one awaiting review, rejected or blocked, including one in a fix round
    whose PR is already open. A steer into an idle window wakes it, and a wake re-reads or
    re-writes the session's whole cached context. Measured from 10-13 to 10-23, 14 such notices
    cost about $9.5, and four cold wakes up to $2 each, for a notice the session could not act
    on until it worked again.
    `introduceToPeers` now steers a peer only while its state is `running`, and
    `steerOverlappingSessions` lists `running` sessions instead of `holdingStates()`. A running
    session in a fix round still gets the main-landed notice, with the merge-commit wording its
    open PR asks for. The rest are covered where they next work. A session sent to the gate
    meets the target at the gate's fresh-base stage, which takes it in mechanically or rejects
    the session with the conflict (decision 8), so a land it missed reaches it there. A session
    handed back by `pup fix` runs `recordOverlaps` after its fix kickoff (decision 90): its
    kickoff names every running peer and each is introduced to it, so a peer that joined while
    it waited is met then. A rejected or unblocked session resumes on a steer of its own and is
    gated again.
    *This log is left out of peer-joined introductions, and kept in main-landed notices.* Every
    entry in `docs/09-decisions.md` is appended at its end, just before `## Implementation
    notes`, so two branches that each add one insert different lines at the same point, and a
    rebase of either onto the other always stops there. No merge driver can take that in, since
    git does not run while one is armed (decision 50), and the gate counts a failed fresh-base
    rebase as a rejection (decision 8), steered back into a session that is by then idle. An
    introduction settles none of it: whatever two workers agree, the one that lands second meets
    the conflict. So `filesWorthANotice` in `overlap.service.ts` drops the log from the files an
    introduction names: a peer sharing nothing else is not introduced, and one sharing more is
    told the rest. The main-landed notice is what resolves it, so it keeps the log: a running
    session whose only overlap with a land is the log is told to take the target in now. That
    costs one turn of a window already working, where the gate meeting it instead costs a
    counted rejection, a wake and a second gate run.
    *The kickoff's `## Peers` follows the same rule.* Its protocol tells the worker to message
    each peer listed there before editing a shared file, and that message wakes an idle peer as
    surely as a steer does (decision 47). So a launch's kickoff and a fix round's list only the
    peers `introduceToPeers` would steer, through one filter, `overlapsWorthANotice`: running,
    with the log dropped from the files, and a peer left with no files not listed. The record
    is unchanged: the `scope_overlap` event still names every overlap in full, log included,
    since it is what the radar and the report read.
    *Ceilings.* The state is read when the kickoff is compiled and again when the notice is
    sent. A session that turns running a moment later is neither listed nor told, and meets
    the change at its gate as above. A peer left out while it waited, then resumed by a steer
    rather than a fix round (after a rejection or an unblock), never meets the newcomer:
    neither side is told of the other, and their edits to a shared file meet only at the gate's
    fresh-base stage, which takes them in or rejects with the conflict. A session not running
    when another's log entry lands meets that conflict at its gate as a counted rejection, as it
    would on any shared file; treating a conflict confined to the log as something other than a
    rejection is the gate's to decide, and is not decided here. The log's path is pupitre's own;
    a project keeping its decisions elsewhere gets no exemption for it.
    *Tests.* In `session-lifecycle.test.ts`, a launch over a running, an awaiting-review and a
    blocked holder with an open PR introduces itself to the running one only, while its
    `scope_overlap` still names all three, and its kickoff lists the running one only. A launch
    sharing only the log steers no one and lists no peer in its kickoff, but still records the
    overlap, and one sharing the log and a source file names only the source file in the steer
    and the kickoff. A fix round's recompiled kickoff lists a running peer and not an
    awaiting-review one, and returns both for `recordOverlaps`. In `land.test.ts`, a land steers
    the running peer and not the awaiting-review, rejected or blocked ones, and steers a running
    peer sharing only the log with a notice that names it.
