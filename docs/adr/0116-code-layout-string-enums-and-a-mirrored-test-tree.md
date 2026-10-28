# 0116. Code is laid out in per-area folders with string enums, and tests mirror `src/` under `test/unit` (2026-10-28).

- Status: accepted

116. **Code is laid out in per-area folders with string enums, and tests mirror `src/` under
    `test/unit` (2026-10-28).** The operator's layout and naming convention, recorded so a
    worker reads it instead of inferring it from whichever neighbour it opened.
    *Source.* `src/` is split into per-area folders. Inside an area, behavioural files sit at
    the root and declarations in `types/`, `enums/` and `errors/` subfolders. Every closed
    value set is a string `enum` in a `*.enums.ts` file, not a literal union or an `as const`
    object. No exported or reused type, interface or `Error` subclass is declared inline in a
    behavioural file.
    *Tests.* A unit test lives at `test/unit/<path under src>/` and is named for its subject
    with the role's dot turned into a hyphen: `src/core/bar.service.ts` →
    `test/unit/core/bar-service.test.ts`. A scenario spanning several subjects goes in
    `test/integration/`, and shared mocks and fixtures in `test/helpers/`. Tests import the
    unit through `@src/…` and helpers through `@test/…`; the aliases are for tests only, and
    `src/` keeps relative `.js` imports.
    *Replaces.* The rule that a test sits next to the file it covers. The flattened filename
    stays, because the kebab-case part may still not contain a dot.
    *Rejected.* Colocated tests (the old rule): the source tree mixes with tests, and a
    scenario test has no natural home. Literal unions for value sets: they cannot be iterated
    or documented per member, and a typo in a bare string compiles.
    *Ceilings.* This task changes the conventions only. Existing tests, the `@src` / `@test`
    aliases in `tsconfig.json` and Vitest, `validate-file-naming.sh` and the spot-check hooks
    still encode the old layout until follow-up tasks move them, so the conventions describe
    the target and new code follows them.
