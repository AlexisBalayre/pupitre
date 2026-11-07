# 0147. `pup plan drop` retires a task whose sessions were all killed (2026-11-07)

- Status: accepted
- Amends: [0040](0040-a-task-can-exist-before-a-session-the.md)

147. **`pup plan drop` retires a task whose sessions were all killed (2026-11-07).**
    Decision 40 sends a killed session's task back to the backlog, and made `deleteTask` refuse
    any task a session ever ran for, because `sessions.task_id` is a NOT NULL foreign key. The
    two together left a task nobody could remove: `pup plan` listed it, and `pup plan drop`
    refused it with "a session may already have claimed it", which was false. Decision 40
    named this as a ceiling. t-mw3c1cu6, finished by PR #223, was stuck this way.
    *A dropped task is marked, not deleted.* `tasks` gains a nullable `dropped_at` column, added
    to older stores by an `add` migration. `dropTask` (it replaces `deleteTask`) runs in one
    transaction. A task no session ever ran for has no history, so it is still deleted
    outright, as before. A task whose sessions are all `killed` gets `dropped_at` set, and its
    session rows, events and decision records stay. `listBacklogTasks` passes over a dropped
    task, so `pup plan`, the `pup status` backlog, the report and the dashboard all stop
    listing it. `listTasks` and `getTask` still return it, so a session's dossier and the
    report keep the intent its sessions ran under.
    *A claimed task is still refused, and the refusal names the session.* "Claimed" keeps
    decision 40's meaning: a session in any state but `killed`, `merged` included. The message
    is `Task <id> is claimed by session <session>, so it cannot be dropped.`, with the session
    id passed through decision 29's sanitizer because it comes from the store.
    *An unknown task is refused as before*, and so is a task already dropped, since neither is
    in the backlog. The message loses its parenthesis and reads `No planned task <id>.`:
    the claimed case has its own message now. `pup plan edit` treats a dropped task as unknown
    for the same reason.
    *Ceilings.* `pup launch <id>` does not check `dropped_at`, so naming a dropped task still
    launches it (`launchTask` is in `session-lifecycle.service.ts`, outside this change's scope).
    That takes an explicit id the backlog no longer shows, and if the new session is killed the
    task stays dropped. There is no `pup plan undrop`: a task dropped by mistake is planned
    again with `pup plan add`. A task whose `--pr` session stays `merged` after its pull request
    was closed unmerged is still claimed, so it still cannot be dropped (decision 40).
    *Tests.* `session-repository.test.ts`: a task with no sessions is deleted; a task whose two
    sessions were killed leaves the backlog with both sessions kept, and a second drop or an edit
    on it says unknown; a running session's task is refused with that session's id; a store
    without the column gains it with its tasks still in the backlog. `index-3.test.ts`: `pup plan
    drop` on a killed session's task prints `Dropped`, removes it from `pup plan` and leaves the
    session `killed`; on a running session's task it exits 1 naming `s1`.
