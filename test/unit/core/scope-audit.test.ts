import { auditScope, scopedPaths } from '@src/core/scope-audit.utils.js';
import { describe, expect, it, vi } from 'vitest';

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

  // Decision 208: a skill's Markdown is an exception, any skill directory included.
  it('passes a skill under .claude/skills when scope-in covers it', () => {
    const skill = '.claude/skills/domain-modeling/SKILL.md';
    const skills = [skill, '.claude/skills/new-skill/SKILL.md', '.claude/skills/tdd/mocking.md'];

    expect(auditScope(skills, ['.claude/skills/**'])).toEqual([]);
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
    '.claude/skills/wizard/template.sh',
    '.claude/skills/diagnosing-bugs/scripts/hitl-loop.template.sh',
    '.claude/skills/x.py',
    '.claude/skills/pr-ci-review/SKILL.md',
    '.CLAUDE/Skills/PR-CI-Review/SKILL.md',
    '.pupitre/x',
  ])('still flags %s as protected, even when scope-in covers it', (path) => {
    expect(auditScope([path], ['**'])).toEqual([{ path, reason: 'protected path' }]);
  });

  describe('what the exception lifts is read (decision 208)', () => {
    const skill = (name: string): string => `---\nname: ${name}\ndescription: x\n---\n# Body\n`;
    const audit = (path: string, content: string | null | undefined) =>
      auditScope([path], ['.claude/skills/**'], [], () => content);

    it('refuses a SKILL.md that names itself pr-ci-review', () => {
      const path = '.claude/skills/zz/SKILL.md';

      expect(audit(path, skill('pr-ci-review'))).toEqual([{ path, reason: 'misnamed skill' }]);
    });

    it('refuses a SKILL.md whose name differs from its directory', () => {
      const path = '.claude/skills/zz/SKILL.md';

      expect(audit(path, skill('tdd'))).toEqual([{ path, reason: 'misnamed skill' }]);
    });

    it('passes a SKILL.md whose name is its directory, that has no name, or that is deleted', () => {
      expect(audit('.claude/skills/zz/SKILL.md', skill('zz'))).toEqual([]);
      expect(audit('.claude/skills/zz/SKILL.md', '---\ndescription: x\n---\n')).toEqual([]);
      expect(audit('.claude/skills/zz/SKILL.md', undefined)).toEqual([]);
    });

    it('refuses a SKILL.md outside the one frontmatter form accepted', () => {
      const path = '.claude/skills/zz/SKILL.md';

      expect(audit(path, '# No frontmatter\n')).toEqual([{ path, reason: 'misnamed skill' }]);
    });

    it.each([
      '.claude/skills/zz/SKILL.md',
      '.claude/skills/zz/notes.md',
      '.claude/skills/shadow.md',
    ])('refuses %s when the reader cannot read it as a plain file', (path) => {
      expect(audit(path, null)).toEqual([{ path, reason: 'not a plain file' }]);
    });

    it('lets a failing reader throw rather than read its failure as an answer', () => {
      const read = (): string => {
        throw new Error('git failed');
      };

      expect(() =>
        auditScope(['.claude/skills/zz/SKILL.md'], ['.claude/skills/**'], [], read),
      ).toThrow('git failed');
    });

    it('reads every path the exception lifts, and only when the scope takes it', () => {
      const read = vi.fn(() => skill('pr-ci-review'));

      expect(auditScope(['.claude/skills/zz/notes.md'], ['.claude/skills/**'], [], read)).toEqual(
        [],
      );
      expect(read).toHaveBeenCalledWith('.claude/skills/zz/notes.md');
      read.mockClear();
      expect(auditScope(['docs/zz/SKILL.md'], ['docs/**'], [], read)).toEqual([]);
      expect(auditScope(['.claude/skills/zz/SKILL.md'], ['src/**'], [], read)).toEqual([
        { path: '.claude/skills/zz/SKILL.md', reason: 'outside scope-in' },
      ]);
      expect(read).not.toHaveBeenCalled();
    });
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
