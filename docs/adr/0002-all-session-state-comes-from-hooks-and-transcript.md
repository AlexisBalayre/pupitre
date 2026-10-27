# 0002. All session state comes from hooks and transcript JSONL

- Status: accepted
- Amended by: [0103](0103-the-idle-prompt-is-a-turn-end-a.md)

2. **All session state comes from hooks and transcript JSONL**, never from pane contents.
   PostToolUse = activity, Notification = blocked on input, Stop = turn end. Hooks identify their
   session via a `PUP_SESSION_ID` env var injected at launch.
