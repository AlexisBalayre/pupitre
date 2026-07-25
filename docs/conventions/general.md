# General Conventions

Universal rules for **every** `*.ts` file in `src/`. Area-specific docs ([naming](naming.md),
[testing](testing.md)) layer on top of these; they never relax them. The thin
`@docs/conventions/general.md` import in `.claude/rules/universal-conventions.md` points here.

## File naming

Files follow `kebab-case.role.ts`. The `role` suffix is not decoration — it locks in a
calling convention. The full taxonomy, plurality rules, and banned roles live in
[naming.md](naming.md), enforced by `.claude/hooks/validate-file-naming.sh`.

**Tests flatten the source name.** The kebab-case part may not contain a dot, so a test's
name is its subject's full filename with dots turned into hyphens:

```
db.client.ts          → db-client.test.ts
capability.utils.ts   → capability-utils.test.ts
session.repository.ts → session-repository.test.ts
```

Drop the role when the test covers a whole subject rather than one file — `overlap.test.ts`
exercises both `overlap.service.ts` and `overlap.repository.ts`.

`merge-gate.service.test.ts` is **invalid**: `validate-file-naming.sh` blocks it, because
`merge-gate.service` is not kebab-case. Tests sit next to the file they cover.

## Exports

**Named exports only. Never `export default`.**

```ts
// session.repository.ts
export function insertSession(db: Database, input: NewSessionInput): void { … }

// ✗ export default insertSession
```

Default exports break namespace imports, defeat tree-shaking hints, and make rename-across-
files unreliable. The `convention-spot-check` Stop hook flags any `export default`.

## Imports

- **Relative imports carry the `.js` extension**, pointing at the emitted file, not the source:

  ```ts
  import { getById } from './session.service.js';   // ✓  even though the file is .ts
  // ✗ import { getById } from './session.service';
  ```

  `tsconfig.json` sets `module` and `moduleResolution` to `NodeNext`, and `pnpm build` is a
  bare `tsc` — nothing rewrites specifiers afterwards, so an extensionless path fails to
  resolve at runtime.

- **Type-only imports use `import type`.** `verbatimModuleSyntax` is on, so a value import of
  a type-only symbol survives into the emitted JS and fails at runtime.

- **Named imports are the norm.** Reach for `import * as Ns` only when a test needs to stub a
  whole module.

## Type separation

Exported types live in `*.types.ts` under the area's `types/` folder — `src/core/types/`,
`src/adapters/types/`. **Never inline an exported `type`/`interface` in a `*.service.ts` or
`*.routes.ts` file** — the spot-check hook warns on this. Re-export from the consumer if you
want a stable call-site path.

## Type safety

- **No `any` outside system boundaries.** `src/` currently has none — keep it that way. Where
  an untyped payload genuinely forces it (a tool's JSON output with no published schema),
  isolate it at the parse site and add a one-line justification comment:
  ```ts
  // any: coverage-py ships no schema for this report shape
  const report = JSON.parse(raw) as any;
  ```
  Prefer declaring the shape in a `*.types.ts` and narrowing into it.
- **Branded IDs.** Use `SessionId`, `TaskId`, … from `src/core/types/profile.types.ts`. Cast a
  raw `string` to a branded ID **only at a boundary** (CLI argument parsing, DB row mapping),
  never deep in business logic.
- **Boolean names** start with `is` / `has` / `should` / `can` (`isTerminal`, `canTransition`,
  `hasOpenLedgerEntry`).
- **Generics are descriptive** — `TConfig`, `TResponse`. Never bare `T` / `U`.
- **`override` is required** on every method that overrides a superclass method.
- **Factories for stateless logic; classes only for stateful resources** with a real
  lifecycle (a connection pool, a session state machine). A bag of pure functions is a
  module of named exports, not a class. Typed `Error` subclasses in a `*.errors.ts` file are
  the standing exception — subclassing is how a caller `instanceof`-narrows a failure.

## No hardcoded values

Thresholds, timeouts, tool names, path fragments — none are inlined at the use site. They go
in the area's `*.constants.ts` as a named export with a JSDoc line saying what the number
means and why it is that number.

```ts
// merge-gate.constants.ts
/** Changed-line count (adds + deletes, lockfiles excluded) above which the diff-size stage flags. */
export const DIFF_SIZE_FLAG_LINES = 600;

// ✗ if (changedLines > 600) flag();
if (changedLines > DIFF_SIZE_FLAG_LINES) flag();
```

Operator-facing settings belong in the profile YAML instead, not in a constant.

## JSDoc

This is a leaf CLI app with no external consumers, so JSDoc earns its place by carrying the
*why* — invariants, units, ordering guarantees, gotchas — not by restating the signature.
Summary is an imperative verb phrase, ≤120 chars.

```ts
/** A repo's `.pupitre/adapter.yml` outranks the built-ins — it exists to override them. */
export function detectAdapters(repoPath: string): Adapter[] { … }

// ✗ /** Detects the adapters for a repo. */  — the signature already says this
```

In practice exported constants and types are almost always documented, because a bare
threshold or field name rarely explains itself.

## Comments

- Inline `//` comments explain **WHY, not WHAT**. If deleting the comment wouldn't confuse a
  reader, delete it.
- No `// === Section ===` banners.
- No journal / changelog comments (`// 2026-05: changed by …`).
- No commented-out code. Git is the history.

## Clean code

- **Delete old code when you replace it.** No compatibility shims, no `// removed` markers,
  no backwards-compat re-exports. The replacement *is* the change.
- **YAGNI.** Don't add parameters, abstractions, or config for requirements that don't exist
  yet. Build for what is in front of you.
