import { auditScope, isMisnamedSkill, scopedPaths } from '@src/core/scope-audit.utils.js';
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

  describe('a skill named other than its directory (decision 208)', () => {
    const skill = (name: string): string => `---\nname: ${name}\ndescription: x\n---\n# Body\n`;
    const audit = (path: string, content: string | undefined) =>
      auditScope([path], ['.claude/skills/**'], [], () => content);

    it('refuses a SKILL.md that names itself pr-ci-review', () => {
      const path = '.claude/skills/zz/SKILL.md';

      expect(audit(path, skill('pr-ci-review'))).toEqual([{ path, reason: 'protected path' }]);
    });

    it('refuses a SKILL.md whose name differs from its directory', () => {
      const path = '.claude/skills/zz/SKILL.md';

      expect(audit(path, skill('tdd'))).toEqual([{ path, reason: 'protected path' }]);
    });

    it('passes a SKILL.md whose name is its directory, or that has no name', () => {
      expect(audit('.claude/skills/zz/SKILL.md', skill('zz'))).toEqual([]);
      expect(audit('.claude/skills/zz/SKILL.md', '# No frontmatter\n')).toEqual([]);
      expect(audit('.claude/skills/zz/SKILL.md', undefined)).toEqual([]);
    });

    it('refuses a SKILL.md the reader cannot read as a plain file', () => {
      const path = '.claude/skills/zz/SKILL.md';
      const read = (): string => {
        throw new Error(`${path} is not a plain file`);
      };

      expect(auditScope([path], ['.claude/skills/**'], [], read)).toEqual([
        { path, reason: 'protected path' },
      ]);
    });

    it('reads only a skill manifest, and only when the scope takes it', () => {
      const read = vi.fn(() => skill('pr-ci-review'));

      expect(auditScope(['.claude/skills/zz/notes.md'], ['.claude/skills/**'], [], read)).toEqual(
        [],
      );
      expect(auditScope(['.claude/skills/zz/SKILL.md'], ['src/**'], [], read)).toEqual([
        { path: '.claude/skills/zz/SKILL.md', reason: 'outside scope-in' },
      ]);
      expect(read).not.toHaveBeenCalled();
    });

    it.each([
      ['a quoted name', '---\nname: "pr-ci-review"\n---\n'],
      ['a name in another case', '---\nname: PR-CI-Review\n---\n'],
      ['a merged name', '---\nbase: &b {name: pr-ci-review}\n<<: *b\n---\n'],
      ['a flow mapping', '---\n{name: pr-ci-review}\n---\n'],
      ['a name that is not a string', '---\nname: [zz]\n---\n'],
      ['a duplicated name', '---\nname: zz\nname: pr-ci-review\n---\n'],
      ['a second document', '---\nname: zz\n--- name: pr-ci-review\n---\n'],
      ['a line a looser reader closes on', '---\nname: zz\n---x\nname: pr-ci-review\n---\n'],
      ['a frontmatter left open', '---\nname: zz\n'],
      ['a BOM and CRLF', '\uFEFF---\r\nname: pr-ci-review\r\n---\r\n'],
    ])('refuses %s', (_label, content) => {
      expect(isMisnamedSkill('.claude/skills/zz/SKILL.md', content)).toBe(true);
    });

    it('reads the directory a SKILL.md sits in, at any depth and case', () => {
      expect(isMisnamedSkill('.claude/skills/a/zz/SKILL.md', skill('zz'))).toBe(false);
      expect(isMisnamedSkill('.Claude/Skills/zz/skill.md', skill('tdd'))).toBe(true);
      expect(isMisnamedSkill('.claude/skills/zz/README.md', skill('tdd'))).toBe(false);
      expect(isMisnamedSkill('skills/zz/SKILL.md', skill('tdd'))).toBe(false);
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
