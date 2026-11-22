import { isMisnamedSkill } from '@src/core/skill-name.utils.js';
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
    ['a second document after an end marker', '---\nname: zz\n...\nname: pr-ci-review\n---\n'],
    ['a line a looser reader closes on', '---\nname: zz\n---x\nname: pr-ci-review\n---\n'],
    ['a frontmatter left open', '---\nname: zz\n'],
    ['a BOM and CRLF', '\uFEFF---\r\nname: pr-ci-review\r\n---\r\n'],
  ])('refuses %s', (_label, content) => {
    expect(isMisnamedSkill('.claude/skills/zz/SKILL.md', content)).toBe(true);
  });

  it.each([
    ['no frontmatter', '# Body\n'],
    ['a BOM', '\uFEFF---\nname: zz\n---\n'],
    ['a blank line before it', '\n---\nname: zz\n---\n'],
    ['CRLF line ends', '---\r\nname: zz\r\n---\r\n'],
    ['four dashes', '----\nname: zz\n----\n'],
    ['a closing line with a trailing space', '---\nname: zz\n--- \n'],
    ['a closing line of four dashes', '---\nname: zz\n----\n'],
    ['three dashes in a value', '---\nname: zz\ndescription: a --- b\n---\n'],
  ])('refuses a well-named skill with %s, outside the one form accepted', (_label, content) => {
    expect(isMisnamedSkill('.claude/skills/zz/SKILL.md', content)).toBe(true);
  });

  it.each([
    ['a space', ' '],
    ['an NBSP', ' '],
    ['a form feed', '\f'],
    ['a vertical tab', '\v'],
  ])('refuses an opening line with %s after the dashes, whatever the name', (_label, space) => {
    expect(
      isMisnamedSkill('.claude/skills/zz/SKILL.md', `---${space}\nname: pr-ci-review\n---\n`),
    ).toBe(true);
    expect(isMisnamedSkill('.claude/skills/zz/SKILL.md', `---${space}\nname: zz\n---\n`)).toBe(
      true,
    );
  });

  it('refuses a name holding three dashes mid-line, even when its directory matches', () => {
    expect(
      isMisnamedSkill(
        '.claude/skills/pr-ci-review---/SKILL.md',
        '---\nname: pr-ci-review---\n---\n',
      ),
    ).toBe(true);
    expect(isMisnamedSkill('.claude/skills/zz/SKILL.md', '---\nname: pr-ci-review---\n---\n')).toBe(
      true,
    );
  });

  it.each([
    ['its name', skill('zz')],
    ['no name', '---\ndescription: x\n---\n# Body\n'],
    ['an empty frontmatter', '---\n---\n# Body\n'],
    ['a frontmatter that ends the file', '---\nname: zz\n---'],
    ['three dashes in its body', '---\nname: zz\n---\n# Body\n\n---\n\nname: pr-ci-review\n'],
  ])('passes a skill with %s in the one form accepted', (_label, content) => {
    expect(isMisnamedSkill('.claude/skills/zz/SKILL.md', content)).toBe(false);
  });

  it('reads the directory a SKILL.md sits in, at any depth and case', () => {
    expect(isMisnamedSkill('.claude/skills/a/zz/SKILL.md', skill('zz'))).toBe(false);
    expect(isMisnamedSkill('.Claude/Skills/zz/skill.md', skill('tdd'))).toBe(true);
    expect(isMisnamedSkill('.claude/skills/zz/README.md', skill('tdd'))).toBe(false);
    expect(isMisnamedSkill('.claude/skills/SKILL.md', skill('tdd'))).toBe(false);
    expect(isMisnamedSkill('skills/zz/SKILL.md', skill('tdd'))).toBe(false);
  });
});
