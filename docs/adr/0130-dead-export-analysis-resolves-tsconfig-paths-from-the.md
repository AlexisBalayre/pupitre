# 0130. Dead-export analysis resolves tsconfig `paths` from the measured checkout (2026-10-30)

- Status: accepted

130. **Dead-export analysis resolves tsconfig `paths` from the measured checkout (2026-10-30).**
    `resolveImport` only followed relative specifiers, and `collectUsage` skipped every other
    one, so an export imported only through a `paths` alias (`@src/*`, `@test/*`) read as
    unimported. That is fine while nothing here uses aliases. Once tests import through them,
    every export used only by tests would turn up as new dead code and trip the ratchet (task
    t-mvqj9rz9).
    *The rule.* `deadCode` reads the root `tsconfig.json`'s `compilerOptions.paths` and
    `baseUrl` with `readPlainFile`, parses it with `ts.parseConfigFileTextToJson` (comments and
    all), and passes the aliases to `findDeadExports`. A bare specifier resolves through the
    pattern TypeScript would pick: an exact key first, else the wildcard with the longest
    prefix, its substitutions tried in order. Each target then goes through the same `.js`→`.ts`
    / `.tsx`, extension and `index` candidates a relative import does. A bare specifier no alias
    matches resolves to nothing, as before, so `import ts from 'typescript'` never lands on a
    repo file named `typescript.ts`.
    *Measured checkout, not the trusted one.* This is the opposite of `manifestEntryFiles` and
    `nestedPackageDirs`, which read `configPath` because their answer exempts files. An alias
    exempts nothing: it can only point an import at a repo file, which a relative import from
    the same file can already reach, and `resolveFile` refuses a target that climbs out of the
    repo. Taking the session's tsconfig therefore opens no hiding place. Taking the trusted one would make the branch that introduces an alias read
    its own alias imports as unresolved and fail its own gate.
    *Ceilings.* `extends` is not followed. Only the root `tsconfig.json` is read, not a
    `tsconfig.*.json` or a nested one. `baseUrl` alone does not make bare specifiers resolve.
    `depGraph` still makes edges from relative imports only, so the code map does not show
    alias edges yet. A missing, unreadable or unparseable tsconfig, or one without `paths`,
    yields no aliases, which is exactly the old relative-only behaviour, and a test asserts it.
    Each of these misses in the safe direction: an alias import goes unresolved, and an
    export looks deader than it is.
    *No re-stamp.* This repo's tsconfig declares no `paths`, so today's dead-export count is
    unchanged, and dead exports are compared as sets with no rule id (decision 58). As decision
    39 learned, the gate cannot validate its own change: this branch's merge runs main's adapter.
    Five mutants were each run against the three adapter test files and restored from a backup
    copy, and each failed at least one test. They were: reading aliases from `configPath`;
    dropping them in `collectUsage`; resolving a bare specifier as a relative one; taking the
    first matching wildcard instead of the longest prefix; and ignoring `baseUrl`.
