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
    repo. Taking the session's tsconfig therefore opens no hiding place. Taking the trusted one
    would make the branch that introduces an alias read its own alias imports as unresolved and
    fail its own gate.
    *Ceilings.* `extends` is not followed. Only the root `tsconfig.json` is read, not a
    `tsconfig.*.json` or a nested one. `baseUrl` alone does not make bare specifiers resolve.
    `depGraph` still makes edges from relative imports only, so the code map does not show
    alias edges yet. A missing, unreadable or unparseable tsconfig, one without `paths`, or one
    whose `paths` has a shape tsc rejects (an array, a string substitution) yields no aliases,
    which is exactly the old relative-only behaviour, and a test asserts it. The malformed
    shapes are not checked one by one: `parsePathAliases` throws on them and `deadCode`'s
    reader treats any throw as no aliases.
    Each of these misses in the safe direction: an alias import goes unresolved, and an
    export looks deader than it is.
    *Bound.* The tsconfig is the session's, and every bare import is resolved synchronously
    inside the merge lock, where no stage timeout or interrupt forwarding reaches (the stall
    decisions 31 and 110 closed). `readPlainFile`'s 1 MiB cap alone still admits about 70k
    patterns. A `paths` over any of three bounds yields no aliases, the same safe direction.
    Each bound caps one term of what an import costs. More than 256 patterns plus
    substitutions caps the wildcard scan. More than 2048 characters across patterns and
    substitutions, an explicit `baseUrl` counted once per substitution, caps the length of
    each candidate path. `baseUrl` counts because it prefixes every substitution. Left out, a
    1 MiB `baseUrl` under `*: ["*" × 8]` passed all three bounds, and every bare import built
    eight 1 MiB targets (CI review, PR #218). Counted only once, a 2039-character `baseUrl`
    still went into all eight, at about 0.8 ms per import, measured. More than 8
    substitutions on one pattern caps the fan-out: every substitution becomes about 17
    candidate paths, each carrying a copy of the matched specifier. The entry cap alone was not
    enough. It let 255 substitutions of 4 KiB sit under `*`, which matches every bare import,
    `node:*` and `vitest` included. That cost about 50 ms per import, measured, so a file of a
    few thousand `import 'a'` lines held the lock for minutes. A characters cap alone was not
    enough either: 255 two-character substitutions still cost about 0.6 ms per import. Under
    all three bounds the worst measured case is about 0.1 ms per import, a 254-character
    `baseUrl` under `*: ["*" × 8]` included (CI review, PR #218).
    The bounds hold only because a target's `*` is replaced literally, so a target is never
    longer than its own text plus the matched specifier. A string replacement read the specifier
    as a template: each `$'` or `` $` `` in it expanded to a copy of the rest of the target, so
    `*: ["*" + 2000 × "x"]` under one `import 'a' + 200,000 × "$'"` built a target of about
    400 million characters, and `$&` resolved somewhere tsc does not. `aliasTargets` passes a
    function instead (CI review, PR #218).
    `parsePathAliases` sorts the wildcards longest prefix first once, and `aliasTargets` takes
    the first match in Map order rather than sorting per import (CI review, PR #218).
    *No re-stamp.* This repo's tsconfig declares no `paths`, so today's dead-export count is
    unchanged, and dead exports are compared as sets with no rule id (decision 58). As decision
    39 learned, the gate cannot validate its own change: this branch's merge runs main's adapter.
    Mutants were each run against the three adapter test files and restored from a backup
    copy, and each failed at least one test. They were: reading aliases from `configPath`;
    dropping them in `collectUsage`; resolving a bare specifier as a relative one; not sorting
    wildcards longest prefix first; ignoring `baseUrl`; leaving `baseUrl` out of the characters
    bound, or counting it once rather than per substitution; keeping a partly parsed
    tsconfig's aliases; matching a wildcard whose prefix and suffix overlap in the
    specifier; and substituting the matched specifier as a replacement string.
    *Complexity.* The first cut added 20 decision points to `typescript-source.utils.ts`, and
    the gate refused it at its +15 limit. The resolution now shares one path between the
    relative and alias cases. It takes the first wildcard after a longest-prefix sort, not a
    running best, and it leaves shapes tsc rejects to throw. That brought the delta to +9. The entry bound added one more branch, and the
    characters and substitutions bounds two more, and counting `baseUrl` one more, for +13.
