---
paths:
  - ".claude/rules/**"
---

# Rule catalog

Path-scoped convention rules. Each auto-loads when you open or edit a file matching its `paths:`
frontmatter — you never invoke them. A rule is a **pure loader**: `paths:` frontmatter plus
`@docs/conventions/<area>.md` imports, no content of its own. `docs/conventions/` is the
single source of truth, so always-on context stays small while full detail loads on demand.

| Rule | Auto-loads for | Enforces (full doc) |
| :--- | :------------- | :------------------ |
| `core-conventions` | `**/*.ts`, `**/*.tsx` | File naming, exports, imports, type separation and safety, hardcoded values, JSDoc, comments, Altitude/YAGNI → `general.md`; naming → `naming.md` |
| `testing-conventions` | `**/*.test.ts`, `**/*.integration.test.ts`, `**/test/**/*.test.ts(x)` | Real dependency over mock, hermetic environment, faking an external CLI, when `vi.mock` is right, structure → `testing.md` |

Add one rule per area whose conventions differ from core, and list each new rule here and in the
conventions table of `AGENTS.md`.

**How to use:** just edit files in a matching path; the rule and its `docs/conventions/*.md`
imports load automatically. To add a rule, see [`.claude/README.md`](../README.md) ("New rule").
