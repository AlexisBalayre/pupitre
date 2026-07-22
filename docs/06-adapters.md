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
