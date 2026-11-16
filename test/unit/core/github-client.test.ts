import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The local names an import clause of `child_process` binds, its type-only ones left out. */
function boundNames(clause: string): string[] {
  if (clause.startsWith('type ')) return [];
  const named = (/\{([^}]*)\}/.exec(clause)?.[1] ?? '')
    .split(',')
    .map((spec) => spec.trim())
    .filter((spec) => spec && !spec.startsWith('type '))
    .map((spec) => spec.split(/\s+as\s+/).at(-1) as string);
  // A namespace or default binding: `* as cp`, `cp`.
  const whole = clause
    .replace(/\{[^}]*\}/, '')
    .replace(/[*,]|\bas\b/g, ' ')
    .trim();
  return [...named, ...(whole ? whole.split(/\s+/) : [])];
}

/**
 * Every use of a `child_process` binding in `source`, in source order, with
 * what holds the main checkout around it: `ghInCheckout` for the spawn it
 * wraps (`ghInCheckout(<path>, () => <use>`), `probe` for `gh --version`,
 * which runs no git and has no checkout, and undefined for anything else: a
 * spawn outside the wrap, a use that is not a call, and a `require` or dynamic
 * import of the module. Whatever the binary: an aliased or namespace import
 * counts too.
 */
function ghSpawnGuards(source: string): (string | undefined)[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fromModule = /import\s+([^;]*?)\s+from\s+['"](?:node:)?child_process['"];?/g;
  const names = [...code.matchAll(fromModule)].flatMap(([, clause = '']) => boundNames(clause));
  const body = code.replace(fromModule, '');
  const uses: { at: number; guard: string | undefined }[] = [];
  for (const name of names) {
    for (const match of body.matchAll(new RegExp(`(?<![.\\w$])${name}(?:\\.\\w+)?\\b`, 'g'))) {
      const before = body.slice(0, match.index);
      const after = body.slice(match.index + match[0].length);
      const guard = /\bghInCheckout\(\s*[^,()]+,\s*\(\)\s*=>\s*$/.test(before)
        ? 'ghInCheckout'
        : /^\(\s*'gh',\s*\['--version'\]\s*,/.test(after)
          ? 'probe'
          : undefined;
      uses.push({ at: match.index, guard });
    }
  }
  for (const match of body.matchAll(/\b(?:require|import)\(\s*['"`](?:node:)?child_process/g)) {
    uses.push({ at: match.index, guard: undefined });
  }
  return uses.sort((a, b) => a.at - b.at).map((use) => use.guard);
}

describe('the .git check around every gh spawn (decision 181)', () => {
  it('wraps every child_process call in github.client.ts in ghInCheckout, but the version probe', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'core', 'github.client.ts'), 'utf8');
    const ghInCheckout =
      /function ghInCheckout<T>\([^)]*\)[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? '';
    const guards = ghSpawnGuards(source);

    expect(guards.filter((guard) => guard === 'ghInCheckout').length).toBeGreaterThan(0);
    expect(guards.every((guard) => guard !== undefined)).toBe(true);
    expect(ghInCheckout).toMatch(
      /^\s*assertGitDirUnplanted\(repoPath\);\s*return checkedAfter\(repoPath, undefined, spawn\);\s*$/,
    );
  });

  it('flags any child_process use ghInCheckout does not wrap, whatever the binary', () => {
    const source = [
      `import { execFileSync, spawn as run, type ExecFileSyncOptions } from 'node:child_process';`,
      `import * as cp from 'child_process';`,
      `execFileSync('gh', ['--version'], { stdio: 'ignore' });`,
      `ghInCheckout(repoPath, () =>\n  execFileSync('gh', args, {}));`,
      `execFileSync('gh', ['pr', 'view'], {});`,
      `ghInCheckout(repoPath, () => run(bin, args));`,
      `run('/usr/local/bin/gh', ['--version', 'x']);`,
      `cp.spawnSync('gh', args);`,
      `ghInCheckout(repoPath, () => { prepare(); return execFileSync('gh', args); });`,
      `const alias = execFileSync;`,
      `// execFileSync in a comment is no use`,
      `const options: ExecFileSyncOptions = {};`,
      `const legacy = require('node:child_process');`,
    ].join('\n');

    expect(ghSpawnGuards(source)).toEqual([
      'probe',
      'ghInCheckout',
      undefined,
      'ghInCheckout',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
