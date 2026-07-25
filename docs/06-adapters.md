# Adapters

Language and toolchain support is an interface, never hardcoded. `pup init` detects the stack (lockfiles, manifests) and selects adapters; a repo can use several.

## Interface

Each adapter declares five capabilities. Any capability may be absent; features degrade gracefully.

```ts
interface Adapter {
  id: string;                      // "typescript", "python"
  detect(repo: Path): boolean;
  build?(ctx): Result;             // compile or typecheck
  test?(ctx): TestResult;          // includes per-file coverage when available
  lint?(ctx): LintResult;          // lint + format check
  depGraph?(ctx): Graph;           // code map source
  deadCode?(ctx): Finding[];      // unused exports, unreachable code
  duplication?(ctx, diff): Finding[];
  complexity?(ctx, files): Metric[];
}
```

`ctx` is `{ measurePath, configPath }` (decision 29). Measure `measurePath` — the session's
worktree during a gate — but resolve which tools are declared from `configPath`, the main
checkout a session cannot edit, or a session silences a stage by editing its own manifest.
Outside the gate both are the same path. A capability that measured nothing returns
`{ unavailable: "<reason>" }`; the reason is what the gate report shows the operator.

Two limits to keep in mind when writing a capability. A tool still runs with `measurePath`
as its working directory, so per-tool config *there* applies — if that config can make the
tool report nothing, prefer returning `unavailable` over reporting a hollow measurement,
since an empty result is a PASS that ratchets the baseline. And dead-export entry points
come from `configPath`, so a change that adds a new `bin`/`exports` entry is flagged in its
own merge and cleared by the next `pup audit`.

An adapter with `coverage` should also implement `coverableFiles(ctx, files)`: the subset of
a changed-file list the toolchain expects coverage for. The gate flags changed files that
never reach the report, which is otherwise a free pass for code no test loads (decision 30).
Mirror your coverage tool's own default excludes — specs, build config, test directories —
or every change to a `vite.config.ts` gets flagged, and drop paths that no longer exist so
deletions stay free.

## Degradation rules

- No depGraph: code map falls back to Claude-generated (flagged as approximate on the map).
- No deadCode or duplication: those gate stages are skipped and marked "not measured", never silently passed.
- No test: gate stage 1 runs build only; coverage gating disabled; `pup init` reports the gap as a debt finding.

## v1 adapters

- TypeScript: tsc, vitest or jest, eslint + prettier, dependency-cruiser or ts-morph, knip or ts-prune, jscpd.
- Python: uv or pip build check, pytest + coverage, ruff, grimp or pydeps, vulture, jscpd.

Commands are resolved from the repo's own config first (package.json scripts, pyproject); adapter defaults are the fallback. Pupitre never imposes toolchain choices on an existing project.

## Custom adapters

- A repo can supply `.pupitre/adapter.yml` mapping the five capabilities to shell commands with a defined JSON output contract. This is the escape hatch for exotic stacks without writing a plugin.
- Contract (decision 24): every value is a shell command run via `sh -c` in the checkout under
  measurement. `build`/`test`/`lint` gate on exit code. `depGraph`, `deadCode`, `duplication`,
  `complexity`, and `coverage` must print the matching capability's JSON on stdout;
  `complexity` receives the touched-file list as a JSON array on stdin. `id` names the adapter
  (default `custom`). Unknown keys and non-string values are load errors, a failing capability
  command fails loudly, and only `coverage` degrades to "not measured". When the file exists,
  the custom adapter outranks the built-ins. `.pupitre/**` is a protected path: the merge gate
  hard-fails any session diff that touches it, so only humans can change what the gate runs.
