# 0069. The profile readers scrub what they print, and the scan learned the layer fields (2026-09-24)

- Status: accepted

69. **The profile readers scrub what they print, and the scan learned the layer fields
    (2026-09-24).** Two hygiene items reviews had pushed out of scope. `pup profile list` printed
    `layer.name`, `layer.extends` and `layer.contextBudget` raw in its row, and `pup profile show`
    printed the whole YAML dump raw — and a layer is a file under `~/.pupitre/<id>/profiles/`,
    which a session's shell reaches through decision 28's HOME, so every field of one is text a
    session can write and the operator's terminal then renders. Fixed at the print site, as
    decision 68 has it: the row sanitizes its three fields, the dump is sanitized line by line.
    *The error path carries more of a layer than either reader does*, which the security review
    found and the first cut missed: `InvalidProfileError` is built from `${fileName}: ${detail}`,
    and the YAML parser's detail quotes the offending source line under its message with a caret
    under the column. So a layer file named `e<ESC>[31m.yml` holding `name: [x<ESC>[2Jy` put two
    escape sequences on the terminal through `pup profile list`'s refusal, and a file name is not
    a field any producer ever saw. The review read the same sink into `launchOrRefuse` and was
    right about the sink but not its contents: a launch compiles from `DEFAULT_BASE_PROFILE`, not
    from a layer file, so no `InvalidProfileError` carrying YAML reaches it today. What does reach
    it is every other expected launch error, quoting what the store holds — a `ScopeConflictError`
    names the live session a task collides with and the files it claimed. Both refusals are
    scrubbed now.
    *The blocks keep their indentation as well as their lines.* Whole-string scrubbing would fold
    a block onto one row, which is decision 68's per-line rule; but `sanitizeReason` also trims,
    and in these blocks the indentation is meaning — the nesting of a YAML layer, the column a
    parser's `^` points at. `sanitizeLines` re-applies each line's leading spaces and tabs around
    the scrubbed text; only ` ` and `\t`, so nothing the text wrote rides along in front. It is
    one helper rather than three copies because the third use is what pays for it, and the three
    sinks are exactly the dump and the two refusals.
    *`show` is a scrubbed dump, not a faithful one,* and the difference is worth naming: scrubbing
    a line also collapses its inner space runs and cuts it at 300 characters, so a layer with
    aligned values or a long convention reads back changed. `pup profile edit` — not implemented
    yet — is what a round trip would go through; this reader is for looking.
    *What `show` is actually defended against is not `\u001b`.* `yaml.stringify` escapes the C0
    block itself — a planted escape comes out as a literal `\e` — but it emits DEL and the C1
    block raw, and `\u009b` is the 8-bit CSI, an escape sequence on its own. So the `show` test
    plants a C1 character rather than the `\u001b` every other scrub test plants, and says why;
    a `\u001b` assertion there would have passed with the sanitizer taken back out.
    *The scan's field list gained `name`, `extends` and `contextBudget`*, and that immediately
    flagged two sinks nobody was looking for: `pup conductor`'s running line and its attach line,
    both printing `handle.name`. Scrubbed rather than allowlisted beside `conductorSocket(...)`'s
    entry — the name is composed the same way, but it arrives as a local, and chasing a local's
    provenance per line is exactly the carve-out decision 68 dropped.
    *A layer's fields are not the types its interface claims,* which the same review caught:
    `parseProfileLayer` validates `name` and the three list fields and passes everything else
    through, so `extends: 5` made `sanitizeReason` throw a `TypeError` on a value the type said
    was a string. Both it and `contextBudget` go through `String` before the sanitizer.
    *Six mutants, each applied to a backup copy and restored from it.* Taking the sanitizers off
    the list row is caught by the scan and by the row test; printing the dump raw is caught by the
    `show` test, and scrubbing it whole by the same test's line assertions; printing either
    refusal raw is caught by its own test; dropping the `String` around `extends` reproduces the
    `TypeError`. Of the four sinks the scan sees only the list row: `sanitizeLines` has no field
    name left in it by the time it prints, and the two refusals go out through `console.error`
    besides — both ceilings decision 68 already enumerated, so the tests carry those three. Its synthetic self-test now holds a raw layer row and a
    scrubbed one. What stays untested is the *multi-line* half of the launch refusal: no expected
    launch error spans lines today, so that sink is proven scrubbed but not proven per-line, and
    it is the profile refusal's test that pins the helper's line behaviour.
    *And two bare generics,* pre-existing violations of docs/conventions/general.md: `parseJsonOr<T>`
    is `parseJsonOr<TParsed>` and `runOrReportNoAdapter<T>` is `runOrReportNoAdapter<TResult>`. No
    behaviour change, no call site touched, every existing test passing unchanged.
