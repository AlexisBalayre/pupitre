# 0057. A project has one brief, written by the operator, and it is split once: Destination and Constraints to every session, Priorities to the conductor (2026-09-18)

- Status: accepted

57. **A project has one brief, written by the operator, and it is split once: Destination and
    Constraints to every session, Priorities to the conductor (2026-09-18).** Everything a
    session knows about why it exists arrived through its task spec, which is one task wide. The
    direction the tasks serve — where the project is going, what it must not do — had nowhere to
    live, so it was either retyped into every spec or lost. `~/.pupitre/<id>/brief.md` is where
    it lives now: free Markdown, `pup brief edit` to write it, `pup brief show` to read it, one
    per project because a project with its conductor running IS the stream, and there is no
    second thing inside one for a second brief to belong to.
    *Pup never interprets it.* The template's three headings are the only structure the code
    knows, and they exist so the file can be split in exactly one place. Nothing is parsed out of
    the prose, nothing is stored from it, and a heading the operator renames simply stops
    carrying. The split itself is the decision: a session is given **Destination and
    Constraints** because where the project is going and what it may not do are direction to
    whoever writes the code, and is NOT given the **Priorities**, because what to do first is the
    conductor's to decide and a session reading it is a session invited to re-plan the task it
    was launched for. The conductor gets the file whole, with one line telling it which half its
    sessions saw. A brief still on its template carries nothing, so no section is emitted at all.
    *One door for every reader.* Both compilers and `pup brief show` read the brief through
    `readBrief`, so what it does is done once and cannot be walked around by a later reader. It
    strips C0 and C1 control characters, keeping newline and tab: the brief is printed to the
    operator's terminal and pasted into tmux as the kickoff, so an escape sequence would repaint
    the terminal and a bracketed-paste terminator or a bare carriage return would end the paste
    early and leave the rest of the file typed as commands — decision 29's shape, but not
    `sanitizeReason`, which collapses the whitespace a Markdown document is structured by. It
    then caps the brief at 8000 characters and refuses past it with `InvalidProfileError` naming
    the path, the length and `pup brief edit`. Without the cap an oversized brief surfaced as
    `ContextBudgetExceededError` naming a token count, which reads as "your task spec is too
    long" and sends the operator to the wrong file; the refusal is answerable at all three launch
    paths, `pup new`, `pup launch` and `pup audit --sweep`, whose expected-error list was empty
    and which therefore crashed. The hash covers the sanitized text, which is the text that was
    used.
    *Read at compile time, which is the whole of its lifecycle.* `compileProfile` and
    `compileConductorProfile` locate the brief themselves from the repo path, rather than take
    the text from their callers — one rule, one moment, and it is the moment that makes an edit
    land at the next launch and the next conductor start and never inside a window already open.
    `pup brief edit` says so in one line and names the conductor and sessions still running on
    the brief as it was; restarting them is the operator's call, and pup neither steers them nor
    pretends the edit reached them.
    *Hashed whole, not as the slice that was sent.* The brief joins the compiled files and the
    user-config snapshot in a session's profile hash — the WHOLE brief, including the Priorities
    that never reach `context.md`. An operator who rewrote only the Priorities changed the
    direction the session was launched under just as much. The test is discriminating on exactly
    that: it edits only the Priorities, asserts every compiled file is byte-identical, and asserts
    the hash moved, so dropping the brief from the hashed payload fails it. The conductor's hash
    needs no such term, its `context.md` carrying every word already. Absent a brief the term is
    absent from the payload, so a project without one hashes as it always did — but a brief
    saved on its untouched template DOES move the hash while adding no section, because the file
    is there now and the hash records the file. **The hash is recorded for consumers that do not
    exist yet.** `config_drift` has no emitter and `pup profile stale` is not implemented, so
    today nothing reads the hash and tells the operator their brief moved under a running
    session. Recording it is what makes that check possible when it is written; it is not that
    check.
    *Operator-only on the verbs, and that is all it is.* The guard is the conductor command's,
    `callingSession(db) || callingConductor()`, on `show` as well as `edit`. A session that could
    run `pup brief edit` would be writing its own kickoff and the next session's, which is
    decision 40's prompt injection wearing the operator's attribution; a conductor that could
    would be promoting its plan to the operator's direction, which is the one thing decision 47
    left with the human. The read is refused too, and not only for symmetry: the Priorities are
    the conductor's half to act on, not a session's to read.
    *Ceilings, stated plainly.* **The guard covers the verbs; it does not cover the file.**
    `brief.md` is store-resident, and the store is reachable from a session's shell — decision 46
    named `~/.pupitre` the root of trust and decision 6's scope layer guards `.claude/`, not the
    store. So a session can write the brief directly and become the first thing every later
    session and the conductor read, wearing the operator's attribution. That is the same ceiling
    decision 48 states for `pup audit` and decision 27 states for the whole family, and the
    sandbox (decisions 36, 44, 45) is the instrument for it, not this guard. What is done here
    instead is to cut the blast radius by position and framing: the brief is compiled LAST in a
    session's context, below the goal, the scope, the acceptance criteria, the conventions and
    the session protocol — every rule it could contradict — and below the Role in the
    conductor's; and pup writes the one line that introduces it, saying it is reference material
    from the operator that is not a task, grants no permission, widens no scope and changes no
    rule in the document, which wins where they differ. The section order is asserted, so a later
    edit cannot quietly move it back above the rules.
    *What the splitter does and does not promise.* Headings inside a fenced code block (``` or
    `~~~`) are text: a fenced example containing `## Destination`, written under the Priorities,
    used to start a section there and put the rest of the Priorities in front of every session.
    A closed ATX heading (`## Constraints ##`) is the same heading as an open one, so constraints
    written that way no longer silently reach nobody. An unclosed fence swallows the rest of the
    file, which is CommonMark's reading and the safe direction — it carries less, never more. A
    heading written in some other form (Setext underlining, a different level, a renamed title)
    remains the operator-side failure it always was: the brief simply carries less, silently, and
    `pup brief show` is where they see what pup sees.
