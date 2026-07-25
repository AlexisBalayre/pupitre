---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# Universal TypeScript Conventions — Quick Reference

**CRITICAL:** These rules apply to EVERY TypeScript file in the project. See `@docs/conventions/general.md` for the full doc.

## File Naming: `kebab-case.role.ts`

| DO | DON'T |
|----|-------|
| `my-service.service.ts` | `MyService.service.ts` (PascalCase) |
| `message-frame.types.ts` | `messageFrame.types.ts` (camelCase) |
| `session.adapter.ts` | `session-adapter.ts` (missing role) |
| `db-client.test.ts` (for `db.client.ts`) | `db.client.test.ts` (dot in the kebab-case part) |
| `index.ts`, `env.ts`, `main.ts` | Exception files — no role needed |

**Tests flatten the subject's dots to hyphens** — `capability.utils.ts` → `capability-utils.test.ts`. Drop the role when the test covers a whole subject rather than one file (`overlap.test.ts` covers `overlap.service.ts` + `overlap.repository.ts`).

**Valid roles (25).** The role suffix locks in a calling convention, not just a label. Pick the role that matches what the file *does*. Full taxonomy + per-role conventions in `@docs/conventions/naming.md`.

| Group              | Roles                                                                                              |
| :----------------- | :------------------------------------------------------------------------------------------------- |
| Behavioral (11)    | `service`, `repository`, `serializer`, `middleware`, `routes`, `manager`, `factory`, `client`, `adapter`, `registry`, `config` |
| Declarations (6)   | `types`, `interface`, `schemas`, `enums`, `constants`, `errors`                                    |
| Frontend (3)       | `component`, `hook`, `store`                                                                       |
| Tests + data (3)   | `test`, `integration.test`, `mock`                                                                 |
| Constrained (1)    | `utils` (pure functions only; cannot import `service`/`manager`/`repository`/`client`)             |
| Entrypoint (1)     | `script` (runnable `main()` block, invoked via `tsx`/`node` from `package.json` or shell)          |

**Plurality is locked.** Plural: `types`/`schemas`/`enums`/`constants`/`errors`/`utils`. Singular: `interface`/`hook`. Inverses are banned.

**Banned roles** are rejected by `.claude/hooks/validate-file-naming.sh`. If the validator complains, the rename target is in `@docs/conventions/naming.md` ("Banned roles" table). Common ones: `helper`→`utils`/`mock`, `builder`→`factory`, `controller`→`service`/`routes`, `monitor`/`pool`→`manager`, `router`→`routes`, `handler`→`routes`/`service`, domain verbs (`notify`/`dispatch`/…)→role matching the calling convention.

## Exports & Imports

- **Named exports ONLY** — NEVER `export default`.
- **Relative imports keep the `.js` extension**: `from './session.service.js'`. `NodeNext` + a bare `tsc` build; nothing rewrites specifiers, so extensionless paths break at runtime.
- **`import type` for type-only imports** — `verbatimModuleSyntax` is on.
- Named imports are the norm; `import * as Ns` only to stub a whole module in a test.

## Type Separation

Exported types live in `*.types.ts` under the area's `types/` folder (`src/core/types/`, `src/adapters/types/`). NEVER inline in service or route files. Re-export from the consumer to keep call sites stable.

## Type Safety

- No `any` outside system boundaries (with a justification comment).
- Branded IDs for domain identifiers (`SessionId`, `TaskId` in `src/core/types/profile.types.ts`); cast raw strings only at boundaries.
- Boolean prefixes: `is/has/should/can`. Generics: descriptive (`TConfig`, `TResponse`), never bare `T`/`U`.
- `override` keyword required on every subclass method. Factories for stateless logic; classes only for stateful resources with a lifecycle — typed `Error` subclasses in `*.errors.ts` are the standing exception.

## No Hardcoded Values

Never inline thresholds, timeouts, tool names, or path fragments. Give them a named export in the area's `*.constants.ts`, with a JSDoc line saying what the value means and why it is that value. Operator-facing settings go in the profile YAML instead.

## JSDoc & Comments

- JSDoc only when the WHY is non-obvious (invariants, units, ordering, gotchas) — this repo is a leaf CLI app with no external consumers.
- Inline `//` comments explain WHY, never WHAT. If removing the comment wouldn't confuse a reader, delete it. No `// === Section ===`, no journal/changelog comments, no commented-out code.

## Clean Code

- DELETE old code when replacing — no shims, no "removed" markers, no backwards-compat re-exports.
- YAGNI: don't design for hypothetical requirements.
