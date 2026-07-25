# Naming Taxonomy

The authoritative source for the `kebab-case.role.ts` file-naming system. The
`validate-file-naming.sh` PreToolUse hook and `universal-conventions.md` both defer to this
document.

## The pattern

```
<kebab-case-name>.<role>.ts        (or .tsx)
```

- **kebab-case** = lowercase letters, digits, and hyphens only. No `PascalCase`, no
  `camelCase`, no `snake_case`.
- **role** = exactly one of the 25 valid roles below. The role suffix is a *contract*: it
  declares the calling convention the file's exports must follow.

```
session.service.ts        ✓
SessionService.service.ts ✗ (PascalCase name)
sessionFrame.types.ts     ✗ (camelCase name)
session-adapter.ts        ✗ (missing role)
```

## The 25 valid roles

Each role locks in a calling convention, not just a label.

### Behavioral (11)

| Role         | Locks in                                                                     |
| :----------- | :--------------------------------------------------------------------------- |
| `service`    | Stateless named functions; business logic; first param often `db: Database`. |
| `repository` | Data-access functions; the only layer that talks to the database.            |
| `serializer` | Pure DB-entity → API-shape transforms; never leaks raw rows.                 |
| `middleware` | Request/connection interceptors (`requireAuth`, rate limit).                 |
| `routes`     | HTTP route definitions; exports a `create<Domain>V1Routes` factory.          |
| `manager`    | Stateful runtime resource with a lifecycle (pools, monitors, schedulers).    |
| `factory`    | `create<Thing>(deps)` builders for stateless logic and dependency wiring.    |
| `client`     | Wrapper around an outbound dependency (the SQLite store, `git`, `gh`).       |
| `adapter`    | Translates between an external system's shape and our domain.                |
| `registry`   | Lookup table mapping a key (e.g. Channel) to an implementation.              |
| `config`     | Typed configuration loaded from YAML / env (not `*.config.ts` tool config).  |

### Declarations (6)

| Role        | Locks in                                            |
| :---------- | :-------------------------------------------------- |
| `types`     | `type` aliases and exported type definitions.       |
| `interface` | A single primary `interface` definition.            |
| `schemas`   | Validation schemas (no validation library in use yet). |
| `enums`     | `enum` / `as const` enumerations.                   |
| `constants` | Exported constant values.                           |
| `errors`    | Typed `Error` subclasses callers `instanceof`-narrow. |

### Frontend (3)

| Role        | Locks in                                              |
| :---------- | :---------------------------------------------------- |
| `component` | A React component (`.tsx`).                           |
| `hook`      | A single React hook (`useX`).                         |
| `store`     | Client-side state store.                              |

### Tests + data (3)

| Role               | Locks in                                                  |
| :----------------- | :-------------------------------------------------------- |
| `test`             | Vitest unit test (`*.test.ts`).                           |
| `integration.test` | Integration test needing a real server + DB.              |
| `mock`             | Hand-written test doubles / fixtures.                     |

### Constrained (1)

| Role    | Locks in                                                                                   |
| :------ | :----------------------------------------------------------------------------------------- |
| `utils` | **Pure functions only.** Cannot import `service`, `manager`, `repository`, or `client`. If it needs one of those, it isn't a util. |

### Entrypoint (1)

| Role     | Locks in                                                                          |
| :------- | :-------------------------------------------------------------------------------- |
| `script` | A runnable file with a `main()` block, invoked via `tsx`/`node` from `package.json` or a shell. |

## Plurality is locked

The singular/plural form is part of the role. Inverses are **banned**.

- **Plural only:** `types`, `schemas`, `enums`, `constants`, `errors`, `utils`.
- **Singular only:** `interface`, `hook`.

So `session.types.ts` ✓ but `session.type.ts` ✗; `use-session.hook.ts` ✓ but
`use-session.hooks.ts` ✗.

## Banned roles

These are rejected by `validate-file-naming.sh`. Rename to the role that matches the calling
convention:

| Banned                  | Use instead                                              |
| :---------------------- | :------------------------------------------------------- |
| `helper`                | `utils` (pure) or `mock` (test data)                     |
| `builder`               | `factory`                                                |
| `controller`            | `service` (logic) or `routes` (HTTP wiring)              |
| `monitor` / `pool`      | `manager`                                                |
| `router`                | `routes`                                                 |
| `handler`               | `routes` (HTTP) or `service` (logic)                     |
| domain word (e.g. a verb like `notify`, `dispatch`) | the role matching what it does (`dispatch-message.service.ts`) |

A file named after a domain verb hides its calling convention. Name it after its *role*; let
the kebab-case part carry the domain (`message-dispatch.service.ts`, not `dispatcher.ts`).

## Exceptions (no role suffix)

These filenames are allowed as-is:

- `index.ts`, `env.ts`, `main.ts`, `app.ts`, `setup.ts`
- `*.d.ts` (ambient declarations)
- `*.config.ts` (tool config — Vitest, Biome, etc.)
- anything under a `generated/` directory

## Test files

The kebab-case part may not contain a dot, so a test's name is its subject's filename with
dots flattened to hyphens — `db.client.ts` → `db-client.test.ts`, `capability.utils.ts` →
`capability-utils.test.ts`. Mirroring the source name verbatim (`db.client.test.ts`) is
**blocked**. Drop the role suffix when the test covers a whole subject rather than a single
file: `overlap.test.ts` covers both `overlap.service.ts` and `overlap.repository.ts`.

## Enforcement

`.claude/hooks/validate-file-naming.sh` runs on `Write` and **blocks** creation of any
`*.ts`/`*.tsx` file whose path contains `/src/` and whose name doesn't match
`kebab-case.<role>.ts`. The error message lists the valid roles and links back here.
