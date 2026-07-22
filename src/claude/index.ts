// All Claude Code interaction is isolated behind this module (see docs/08-roadmap.md, Risks).
// Runtime: interactive `claude` in tmux panes; state from hooks + transcript JSONL, never pane
// contents. Gate-time work (reviewer, decision records, audit) uses one-shot `claude -p` calls.
// See docs/09-decisions.md.

export {};
