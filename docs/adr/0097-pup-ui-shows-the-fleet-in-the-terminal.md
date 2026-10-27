# 0097. `pup ui` shows the fleet in the terminal tab: an OSC 2 title everywhere, iTerm2's Session Status where it is read (2026-10-18)

- Status: accepted
- Amended by: [0102](0102-while-the-project-s-conductor-runs-a-session.md)

97. **`pup ui` shows the fleet in the terminal tab: an OSC 2 title everywhere, iTerm2's Session
    Status where it is read (2026-10-18).** The tab used to read `pup (node)` while a Claude Code
    tab shows a title, a coloured dot and a line. On each snapshot `pup ui` writes `ESC ] 2 ; pup
    <project> · N running · M need you BEL` (`fleet` for `--all`), where N counts `running`
    sessions and M the needs-you inbox (decision 83) without its `pr-open` lines, since an open
    PR is work waiting to land, not a session that has stopped. Under `TERM_PROGRAM=iTerm.app` it
    also writes iTerm2's Session Status, `ESC ] 21337 ; status=… ; indicator=… ; status-color=… ;
    detail=… BEL`: `needs you` in orange when any session is blocked, stalled, asking, at its top
    rung or awaiting review, with the inbox's first line as the detail; `working` in blue while
    sessions run; `idle` in green otherwise. The title is pushed on the xterm stack (`CSI 22 ; 0
    t`) before the first write and popped (`CSI 23 ; 0 t`) on the way out, with every status key
    set empty, so the shell gets its own title back. The writer is `terminal-status.manager.ts`;
    `useTerminalStatus` holds one for the life of `App`, so `q`, Ctrl-C and the SIGINT/SIGTERM
    unmount all run the restore.
    Every interpolated value loses C0, ESC, BEL, DEL and the C1 range, removed rather than
    spaced so a split sequence cannot be put back together, and `;` becomes `,`: a goal or reason
    holding `;status=idle` would otherwise open a key of its own. Nothing is written when stdout
    is not a TTY, under tmux (`TMUX` set; tmux drops these sequences) or when
    `PUP_DISABLE_TERMINAL_TITLE=1`. A terminal that implements the title stack but not OSC 21337
    gets the title alone. A tab closed by SIGKILL keeps its last title and status, as with any
    program that sets them.
    Tests: each fleet state writes fixed title and status bytes; a question holding `ESC ] 0 ;
    … BEL`, `\u009b`, DEL and `;status=idle` comes out inert; no TTY, `TMUX` and the opt-out each
    write nothing; stop and unmount pop the title and clear the status once.
    *Amended by decision 102:* an awaiting-review session counts toward `need you` and sets the
    `needs you` status only with no conductor running, or once its gate was refused.
