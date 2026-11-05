# 0071. `parseProfileLayer` types `extends` and `contextBudget` at the parser, because a wrong `contextBudget` would disable the budget refusal in silence (2026-09-25)

- Status: accepted

71. **`parseProfileLayer` types `extends` and `contextBudget` at the parser, because a wrong
    `contextBudget` would disable the budget refusal in silence (2026-09-25).** `ProfileLayer`
    declares `extends?: string` and `contextBudget?: number`, but the parser only checked `name`
    and the three list fields, so a layer file could carry any YAML value. For `contextBudget` that
    is not a visible type error but a disabled guard: a non-numeric string, a map or a list of two
    or more elements reaches `compileProfile`'s check as `tokenEstimate > NaN` (a one-element numeric
    list coerces to its number, which is luck, not a rule), and every comparison with `NaN` is false, so
    the check passes an over-budget context instead of refusing — the one failure mode where the
    wrong type is indistinguishable from no budget at all. *This was latent, not a live escape:*
    every `compileProfile` caller passes `base: DEFAULT_BASE_PROFILE` and none passes a `role`
    (`index.ts` 700, 845, 885, 1893), so no launch compiles from a layer file today, as decision 69
    and the comment at `index.ts:480` already say. The guard is fixed now because the day a layer
    file does reach `compileProfile` it would be off without a sound. `extends` is the milder case:
    nothing consumes it yet — `mergeLayers` builds a fresh object that never copies it, and neither
    `getProfileLayer` nor `listProfileLayers` resolves it — so typing it only makes the value match
    the interface and the row `pup profile list` prints, its single reader (`index.ts:1829`).
    Both are refused at `parseProfileLayer`, the single seam the two readers share (`loadLayerFile`
    wraps its message with the file name), rather than at each reader: `extends` must be a
    non-empty string, `contextBudget` a positive integer (`Number.isInteger(x) && x > 0`, which
    also rules out a float and a negative). An empty value is refused too, in both cases: YAML
    reads a bare `contextBudget:` as null, which is not `undefined`, so it no longer slips past as
    an absent field and falls back to the default 6000. "Non-empty" for `extends` means the empty
    string only — `"   "` passes, and that is the rule rather than an oversight; no trim is added,
    because a name that is spaces is a lookup nothing performs yet. Decision 69 had already made
    the print sites safe by coercing both with `String`, which is why nothing under `src/cli`
    changes here — that fix kept the terminal honest about a bad value, this one stops the value
    existing.
    *The `compileProfile` regression was checked red first,* against a backup copy of the service
    with the old parser: `compileProfile` on a base layer whose `contextBudget` is `nine` threw
    nothing. It now throws inside `parseProfileLayer`, before `compileProfile` runs, which is the
    point — the test is named for the path it guards, not for reaching the budget check.
    *Decision 69's two CLI tests planted exactly the shapes now refused,* so tightening the parser
    rewrote both rather than deleting them. The list-row scrub test now plants a valid integer
    budget and keeps its escapes in `name` and `extends`, the two fields that can still carry one;
    the test that asserted a row for `extends: 5, contextBudget: nine` became its inverse and
    asserts `pup profile list` refuses that file, which is what keeps CLI coverage of
    `loadLayerFile`'s file-name wrap for a field-type refusal, not only for a YAML syntax error.
    `src/cli/index.ts` is untouched: the `String` coercion at the print sink stays as belt and
    braces now that the parser guarantees the type, and `sanitizeReason` takes a string regardless.
