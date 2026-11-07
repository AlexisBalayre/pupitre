# 0132. `pup land --no-audit` lets several lands share one `pup audit` (2026-11-07)

- Status: accepted
- Amends: [0084](0084-pup-land-session-closes-the-github-half-of.md)

132. **`pup land --no-audit` lets several lands share one `pup audit` (2026-11-07).**
    Amends decision 84. A land is a second of checks, a fetch, a fast-forward and a teardown; the
    audit that follows it is the full suite with coverage, five to seven minutes, and landing six
    sessions paid it six times for a baseline only the last one leaves. `--no-audit` ends the land
    after the steer of overlapping sessions: every refusal, the fast-forward, the teardown and the
    `landed` event are as before, the outcome carries no `audit`, and the CLI says to run `pup
    audit` once after the last land. The `landed` event is already the lock's last write, so
    skipping the audit changes no refusal and no re-run: a failed or skipped audit never undid a
    land. With no audit to run, the check that an adapter exists is skipped too. The default is
    unchanged, so the conductor, which runs `pup land` without the flag, still re-stamps the
    baseline after every land.
