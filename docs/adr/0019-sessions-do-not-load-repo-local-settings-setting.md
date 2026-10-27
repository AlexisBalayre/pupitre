# 0019. Sessions do not load repo/local settings: `--setting-sources user` (2026-07-23)

- Status: accepted

19. **Sessions do not load repo/local settings: `--setting-sources user` (2026-07-23).**
    Repo-committed ask-rules (e.g. `Bash(git rebase *)`) pierce bypass permissions, and
    `ask` outranks `allow` across settings scopes (both verified live on 2.1.218), so no
    compiled allow-rule can neutralize them — the only reliable fix is not loading the
    repo's `.claude/settings.json`/`settings.local.json` in sessions. Consistent with
    decision 5: compiled hooks + the gate are the session enforcement layer; repo
    settings target interactive humans. The compiled `--settings` file and the user's
    `~/.claude` still load; the repo's CLAUDE.md, agents, and skills ride along as
    before (they are not settings sources). Refines decision 10's "rides along
    untouched": the project layer's *settings* are exempt for sessions.
