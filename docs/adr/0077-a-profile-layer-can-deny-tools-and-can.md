# 0077. A profile layer can deny tools, and can only add to decision 74's denials, never remove one (2026-10-06)

- Status: accepted

77. **A profile layer can deny tools, and can only add to decision 74's denials, never remove one
    (2026-10-06).** From the Copiste grilling: Copiste wants Agent kept out of its workers, and
    pupitre has no reason to deny it everywhere. So `ProfileLayer` gains `deny?: string[]`, typed
    at the parser like `extends` and `contextBudget` (decision 71): anything but a list of
    non-empty strings is refused with an `InvalidProfileError` naming the field. `mergeLayers`
    unions `deny` across base and role, and `compileProfile` writes `permissions.deny` as
    `UNANSWERABLE_TOOLS` followed by the merged layer denials, deduplicated in that order. The
    unanswerable tools come first and no layer field subtracts from the list, so the hooks'
    additive-only invariant (docs/03-profiles.md) now covers denials too. A layer without `deny`
    compiles exactly as before. `compileConductorProfile` is unchanged: the conductor is not built
    from layers, and its denials stay decision 74's three.
