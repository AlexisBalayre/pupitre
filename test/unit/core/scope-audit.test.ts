import { auditScope, scopedPaths } from '@src/core/scope-audit.utils.js';
import { describe, expect, it } from 'vitest';

describe('auditScope', () => {
  const scopeIn = ['src/net/**', 'docs/net.md'];
  const scopeOut = ['src/net/legacy/**'];

  it('passes paths inside scope-in', () => {
    expect(auditScope(['src/net/client.ts', 'docs/net.md'], scopeIn, scopeOut)).toEqual([]);
  });

  it('flags paths outside every scope-in glob', () => {
    expect(auditScope(['src/db/schema.ts'], scopeIn, scopeOut)).toEqual([
      { path: 'src/db/schema.ts', reason: 'outside scope-in' },
    ]);
  });

  it('lets scope-out win over scope-in', () => {
    expect(auditScope(['src/net/legacy/old.ts'], scopeIn, scopeOut)).toEqual([
      { path: 'src/net/legacy/old.ts', reason: 'matches scope-out' },
    ]);
  });

  it('always flags protected .claude paths, even when scope-in covers them', () => {
    expect(auditScope(['.claude/settings.json'], ['**'], [])).toEqual([
      { path: '.claude/settings.json', reason: 'protected path' },
    ]);
  });

  it('flags protected paths case-insensitively', () => {
    expect(auditScope(['.CLAUDE/settings.json'], ['**'], [])).toEqual([
      { path: '.CLAUDE/settings.json', reason: 'protected path' },
    ]);
  });

  // Decision 208: `.claude/skills/**` is an exception, any skill directory included.
  it('passes a skill under .claude/skills when scope-in covers it', () => {
    const skill = '.claude/skills/domain-modeling/SKILL.md';

    expect(auditScope([skill, '.claude/skills/new-skill/SKILL.md'], ['.claude/skills/**'])).toEqual(
      [],
    );
    expect(auditScope([skill], ['src/**'])).toEqual([{ path: skill, reason: 'outside scope-in' }]);
  });

  it.each([
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/agents/x.md',
    '.claude/hooks/x.sh',
    '.claude/rules/x.md',
    '.claude/project.env',
    '.claude/statusline.sh',
    '.claude/spot-checks.tsv',
    '.claude/skills',
    '.claude/skills/pr-ci-review/SKILL.md',
    '.CLAUDE/Skills/PR-CI-Review/SKILL.md',
    '.pupitre/x',
  ])('still flags %s as protected, even when scope-in covers it', (path) => {
    expect(auditScope([path], ['**'])).toEqual([{ path, reason: 'protected path' }]);
  });

  it('treats a missing scope-out as empty', () => {
    expect(auditScope(['src/net/client.ts'], scopeIn)).toEqual([]);
  });
});

describe('scopedPaths', () => {
  it('keeps exactly the paths auditScope would not flag', () => {
    const paths = ['src/net/client.ts', 'src/net/legacy/old.ts', 'docs/readme.md'];

    expect(scopedPaths(paths, ['src/net/**'], ['src/net/legacy/**'])).toEqual([
      'src/net/client.ts',
    ]);
  });

  // Two scopes both naming a protected path are not a collision anyone could
  // act on: neither session could ever commit the file (decision 41).
  it('drops a protected path even when scope-in names it', () => {
    expect(scopedPaths(['.claude/settings.json', 'src/a.ts'], ['**'])).toEqual(['src/a.ts']);
  });

  it('returns nothing for a scope that names no path in the list', () => {
    expect(scopedPaths(['src/a.ts'], ['docs/**'])).toEqual([]);
  });
});
