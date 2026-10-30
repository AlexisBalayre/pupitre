import { describe, expect, it } from 'vitest';
import { isInNestedPackage, parsePathAliases, resolveImport } from './typescript-source.utils.js';

describe('isInNestedPackage', () => {
  it('matches a file at any depth inside a nested package and nothing beside it', () => {
    const nested = new Set(['packages/api']);

    expect(isInNestedPackage('packages/api/src/deep/server.ts', nested)).toBe(true);
    expect(isInNestedPackage('packages/api-client/src/app.ts', nested)).toBe(false);
    expect(isInNestedPackage('packages/web/src/app.ts', nested)).toBe(false);
    expect(isInNestedPackage('main.ts', nested)).toBe(false);
  });
});

describe('parsePathAliases', () => {
  it('joins each substitution to baseUrl, and reads a commented tsconfig', () => {
    const aliases = parsePathAliases(
      '{\n  // aliases\n  "compilerOptions": { "baseUrl": "./src", "paths": { "@core/*": ["./core/*"] } }\n}\n',
    );

    expect(aliases).toEqual(new Map([['@core/*', ['src/core/*']]]));
  });

  it('resolves substitutions from the root without a baseUrl', () => {
    expect(
      parsePathAliases('{ "compilerOptions": { "paths": { "@src/*": ["./src/*"] } } }'),
    ).toEqual(new Map([['@src/*', ['src/*']]]));
  });

  it('yields no aliases for a tsconfig without paths or one TypeScript cannot parse', () => {
    expect(parsePathAliases('{ "compilerOptions": { "strict": true } }').size).toBe(0);
    expect(parsePathAliases('{ "compilerOptions": { "paths": ').size).toBe(0);
    expect(parsePathAliases('{ "compilerOptions": { "paths": ["src/*"] } }').size).toBe(0);
  });
});

describe('resolveImport', () => {
  const files = new Set(['src/core/a.ts', 'src/core/deep/b.ts', 'src/ui/c.tsx', 'typescript.ts']);

  it('resolves a relative specifier as before', () => {
    expect(resolveImport('src/core/deep/b.ts', '../a.js', files)).toBe('src/core/a.ts');
    expect(resolveImport('src/core/a.ts', '../../../outside.js', files)).toBeUndefined();
  });

  it('never resolves a bare specifier without an alias, even onto a same-named repo file', () => {
    expect(resolveImport('main.ts', 'typescript', files)).toBeUndefined();
  });

  it('resolves a bare specifier through the longest-prefix wildcard alias', () => {
    const aliases = new Map([
      ['@src/*', ['src/*']],
      ['@src/core/*', ['src/core/deep/*']],
      ['@ui', ['src/ui/c.js']],
    ]);

    expect(resolveImport('x.ts', '@src/core/a.js', files, aliases)).toBeUndefined();
    expect(resolveImport('x.ts', '@src/core/b.js', files, aliases)).toBe('src/core/deep/b.ts');
    expect(resolveImport('x.ts', '@src/ui/c.js', files, aliases)).toBe('src/ui/c.tsx');
    expect(resolveImport('x.ts', '@ui', files, aliases)).toBe('src/ui/c.tsx');
    expect(resolveImport('x.ts', 'typescript', files, aliases)).toBeUndefined();
  });

  it('tries each substitution in order and keeps an alias inside the repo', () => {
    const aliases = new Map([
      ['@x/*', ['missing/*', 'src/core/*']],
      ['@out/*', ['../*']],
      ['constructor', ['src/core/a.ts']],
    ]);

    expect(resolveImport('x.ts', '@x/a.js', files, aliases)).toBe('src/core/a.ts');
    expect(resolveImport('x.ts', '@out/src/core/a.js', files, aliases)).toBeUndefined();
    expect(resolveImport('x.ts', 'toString', files, aliases)).toBeUndefined();
  });
});
