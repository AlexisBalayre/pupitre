# 0033. Duplication does not count import statements (2026-07-27)

- Status: accepted

33. **Duplication does not count import statements (2026-07-27).** `normalizeLines` now drops
    whole `import` statements, single- and multi-line, before the sliding window runs. An
    import member list is not collapsible: two adapters importing the same seven types from
    `adapter.types.js` are reusing a contract, which is the design docs/06 asks for, yet a
    line-window scan reads the shared list as a clone. Every line of it counted, so adding a
    file that imports an existing type raised the repo-wide count and flagged the stage, and
    the only response available to the author was `--accept-debt` — the reflex decision 30
    names as the thing that destroys the ledger. A metric that cannot be acted on is worse
    than no metric, because it teaches the operator to wave the gate through.
    Measured on this repo, 84 of 266 duplicated lines were inside imports, so the baseline
    moves 266 → 182. Every cross-adapter block disappeared, being import noise end to end;
    what survives is real (`cli/index.ts` repeating its `NoAdapterError` guard, the tmux
    invocation in `session-runtime.service.ts`, and test scaffolding).
    Measured back through main, the noise is a near-constant offset, not the drift: 206 → 230
    → 266 over the last three sessions decomposes into imports 78 → 78 → 84 and real
    duplication 128 → 152 → 182. So the absolute figure was inflated by about a third all
    along, but +54 of the +60 rise the handoff flagged is genuine copy-paste and is **not**
    addressed here. Fixing the metric makes that growth legible instead of explaining it away.
    Detection is line-based like the rest of the scan: a dynamic `import(...)` is excluded by
    hand, and an `import` inside a template literal is skipped as if it were real, which is
    acceptable since that line is still an import. Re-export statements (`export … from`) are
    deliberately left in scope; they are rare here and the same argument has not been tested
    against them.
