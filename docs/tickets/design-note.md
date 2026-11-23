# Design note template

The comment a specifier or a human posts on a ticket that needs a design. A feature always needs
one; any other type needs one when a trigger of
[decision 176](../adr/0176-a-ticket-has-a-type-and-only-some-types-need.md) fires: it touches an ADR
area, crosses a module boundary, adds a dependency, or its estimate exceeds a cap of
[decision 173](../adr/0173-the-diff-size-and-complexity-caps-are-hard-and.md). Agents review the
note; the operator validates it once per ticket by adding `design-approved`.

Answer each part in a sentence or a short list. If a part does not apply, say why in one line
rather than leaving it empty or writing "n/a".

## The template

Copy this into a comment on the ticket. The prompts are HTML comments, so they vanish once posted.

```markdown
## Design note

### Context
<!-- What the ticket asks, and why now. Two sentences. -->

### Options considered
<!-- At least two. For each: what it is, what it costs, what it buys. -->
1. **…**: …
2. **…**: …

### Recommended approach
<!-- Which option, and the reason that decided it. -->

### Risks
<!-- What could go wrong, and what we would see that makes us change course. -->

### Slices
<!-- One row per slice, each under the size cap. Two slices that share a file get an edge:
     the later one depends on the earlier, so it starts only after that one merges. -->
| Slice | Files | Size | Depends on |
| --- | --- | --- | --- |
| 1 | … | ~… lines | none |

### Test plan
<!-- The test each slice adds. For a bug, the failing test that reproduces it comes first. -->

### ADRs and conventions touched
<!-- Each decision or convention this follows, amends or needs. "None" only if you checked. -->

### Rollout and rollback
<!-- How it ships (on, or behind a setting) and how to undo it. -->
```

## A filled example

For a feature ticket, "Intake comments on a `ready` issue that fails the check".

```markdown
## Design note

### Context
A `ready` label on an issue with a vague field starts work that stalls later. Intake should catch
it first, now that `checkTicketIntake` exists and nothing calls it yet.

### Options considered
1. **Check inside `pup watch`**: no new infrastructure, but intake waits for the operator's
   machine to be up.
2. **A GitHub workflow on the `labeled` event**: answers within a minute, but needs a token with
   write access in CI and a second place to run the check.

### Recommended approach
Option 1. The operator runs `pup watch` whenever the factory runs, so the delay costs nothing,
and the check keeps one runtime and one token.

### Risks
A busy repo could mean many tracker calls per poll. If a poll takes over 5 seconds, or hits the
rate limit, we move to option 2.

### Slices
| Slice | Files | Size | Depends on |
| --- | --- | --- | --- |
| 1 | `src/core/ticket-intake.service.ts` (new), `src/core/github-tracker.service.ts`, their tests | ~150 lines | none |
| 2 | `src/cli/index.ts` (the `pup watch` loop), `src/core/ticket-intake.service.ts`, their tests | ~120 lines | 1 (shares `ticket-intake.service.ts`) |
| 3 | `docs/02-cli.md` | ~30 lines | none |

### Test plan
Slice 1: a body with a missing and a vague field yields one comment naming both, and the label is
removed; a complete body leaves the label. Slice 2: a watch tick with one `ready` issue calls
intake once, and a second tick does not call it again.

### ADRs and conventions touched
Follows decision 176 (intake) and 187 (the task carries the ticket's copy). Ships behind the
setting of decision 178. No new dependency.

### Rollout and rollback
Off until the project turns on its decision 178 setting. To roll back, turn the setting off;
nothing is stored that needs undoing.
```
