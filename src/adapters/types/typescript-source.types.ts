/**
 * A tsconfig's `compilerOptions.paths`: pattern -> substitutions, each already
 * joined to the repo-relative directory it resolves from (`baseUrl`, else the
 * tsconfig's own, which is the repo root), in longest-wildcard-prefix-first
 * order. A Map, so no specifier can reach a prototype key.
 */
export type PathAliases = Map<string, string[]>;
