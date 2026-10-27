# 0006. Bash scope checking is best-effort

- Status: accepted

6. **Bash scope checking is best-effort**: a real shell parser denies clear write patterns
   (`>`, `>>`, `tee`, `sed -i`, `rm`/`mv`/`cp`, `git apply`…) whose resolved target is out of scope
   or inside `.claude/`. Unparseable commands pass. The authoritative backstop is the gate:
   diff-vs-scope is a hard fail, and a `.claude/` drift-hash mismatch is a hard fail.
