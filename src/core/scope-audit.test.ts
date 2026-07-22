import { describe, expect, it } from 'vitest';
import { auditScope } from './scope-audit.utils.js';

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

  it('treats a missing scope-out as empty', () => {
    expect(auditScope(['src/net/client.ts'], scopeIn)).toEqual([]);
  });
});
