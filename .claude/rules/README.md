# Rule catalog

Path-scoped convention rules. Each auto-loads when you open or edit a file matching its `paths:`
frontmatter — you never invoke them. A rule is a thin trigger that imports the full convention
doc (the "split pattern"), so always-on context stays small while full detail loads on demand.

| Rule | Auto-loads for | Enforces (full doc) |
| :--- | :------------- | :------------------ |
| `universal-conventions` | every `**/*.ts`, `**/*.tsx` | Naming, named-exports-only, type separation, JSDoc, comment discipline → `general.md` + `naming.md` |
| `testing-conventions` | `**/*.test.ts`, `**/*.integration.test.ts` | Vitest, mock ordering, fake timers, behaviour-not-internals → `testing.md` |

**How to use:** just edit files in a matching path; the rule and its `docs/conventions/*.md`
import load automatically. To add a rule, see [`.claude/README.md`](../README.md) ("New rule").
