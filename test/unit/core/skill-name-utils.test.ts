import { isMisnamedSkill, isSkillManifest } from '@src/core/skill-name.utils.js';
import { describe, expect, it } from 'vitest';

describe('isMisnamedSkill (decision 208)', () => {
  const skill = (name: string): string => `---\nname: ${name}\ndescription: x\n---\n# Body\n`;

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
    ['a BOM and CRLF', '﻿---\r\nname: pr-ci-review\r\n---\r\n'],
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

describe('isSkillManifest (decision 208)', () => {
  it('names a SKILL.md under .claude/skills, at any depth and case, and nothing else', () => {
    expect(isSkillManifest('.claude/skills/zz/SKILL.md')).toBe(true);
    expect(isSkillManifest('.Claude/Skills/a/zz/skill.md')).toBe(true);
    expect(isSkillManifest('.claude/skills/zz/notes.md')).toBe(false);
    expect(isSkillManifest('.claude/skills/SKILL.md')).toBe(false);
    expect(isSkillManifest('skills/zz/SKILL.md')).toBe(false);
  });
});
