import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/temp-dir.mock.js';
import { IntentStatus } from './intent.enums.js';
import { IntentRefusedError } from './intent.errors.js';
import {
  acceptIntent,
  createIntent,
  INTENT_DIR,
  intentTemplate,
  listIntents,
  readIntent,
} from './intent.service.js';

/** A repo with `docs/intent/` holding the given files. */
function repoWith(files: Record<string, string> = {}): string {
  const repo = tempDir('pup-intent-');
  mkdirSync(join(repo, INTENT_DIR), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(repo, INTENT_DIR, name), text);
  }
  return repo;
}

/** A draft whose understanding section holds these lines. */
function draft(id: string, understanding: string[]): string {
  return `${intentTemplate(id, 'Ship the gate')}\n${understanding.join('\n')}\n`;
}

describe('intents on disk', () => {
  it('numbers each new intent one past the highest, from a template', () => {
    const repo = tempDir('pup-intent-');

    const first = createIntent(repo, '  Ship the gate, café-style  ');
    const second = createIntent(repo, 'Second');

    expect(first.id).toBe('0001');
    expect(first.path).toBe(join(repo, INTENT_DIR, '0001-ship-the-gate-cafe-style.md'));
    expect(readFileSync(first.path, 'utf8')).toBe(
      intentTemplate('0001', 'Ship the gate, café-style'),
    );
    expect(first.status).toBe(IntentStatus.Draft);
    expect(second.id).toBe('0002');
  });

  it('carries the five sections and a draft status line', () => {
    const text = intentTemplate('0007', 'A title');

    expect(text.split('\n').slice(0, 3)).toEqual(['# 0007. A title', '', '- Status: draft']);
    for (const heading of [
      'Problem',
      'Outcome',
      'Constraints',
      'Open questions',
      'What I must understand after review',
    ]) {
      expect(text).toContain(`\n## ${heading}\n`);
    }
  });

  it('cuts the slug to eight words, and names a title with none `intent`', () => {
    const repo = tempDir('pup-intent-');

    createIntent(repo, 'one two three four five six seven eight nine ten');
    createIntent(repo, '日本語');

    expect(readdirSync(join(repo, INTENT_DIR)).sort()).toEqual([
      '0001-one-two-three-four-five-six-seven-eight.md',
      '0002-intent.md',
    ]);
  });

  it.each([
    ['an empty title', '   '],
    ['a newline', 'Two\nlines'],
    ['an escape', 'Ship \u001b[2J the gate'],
    ['a C1 control', 'Ship \u009b the gate'],
    // `.` ends at these as at a newline, so the title line would not read back.
    ['a line separator', 'Ship\u2028the gate'],
    ['a paragraph separator', 'Ship\u2029the gate'],
  ])('refuses %s as a title, creating nothing', (_what, title) => {
    const repo = repoWith();

    expect(() => createIntent(repo, title)).toThrow(IntentRefusedError);
    expect(readdirSync(join(repo, INTENT_DIR))).toEqual([]);
  });

  it('lists each intent by id with its title and status', () => {
    const repo = repoWith({
      '0002-later.md': intentTemplate('0002', 'Later').replace('Status: draft', 'Status: accepted'),
      '0001-first.md': intentTemplate('0001', 'First'),
    });

    const listed = listIntents(repo).map((entry) =>
      'intent' in entry ? [entry.id, entry.intent.title, entry.intent.status] : entry,
    );

    expect(listed).toEqual([
      ['0001', 'First', IntentStatus.Draft],
      ['0002', 'Later', IntentStatus.Accepted],
    ]);
  });

  it('lists nothing when the repo has no docs/intent/', () => {
    expect(listIntents(tempDir('pup-intent-'))).toEqual([]);
  });

  // A malformed file is listed as one, not hidden and not failing the list;
  // a name that is not `NNNN-slug.md` is never an intent at all.
  it('lists a malformed intent with why, and skips names that are not intents', () => {
    const repo = repoWith({
      '0001-no-status.md': '# 0001. No status\n\n## Problem\n',
      '0002-wrong-number.md': intentTemplate('0003', 'Wrong number'),
      'notes.md': 'not an intent',
      '0004-Upper.md': intentTemplate('0004', 'Upper'),
      '0005-escape\u001b.md': intentTemplate('0005', 'Escape'),
    });

    expect(listIntents(repo)).toEqual([
      {
        id: '0001',
        unreadable: expect.stringContaining('needs exactly one "- Status: draft|accepted|closed"'),
      },
      { id: '0002', unreadable: expect.stringContaining('does not open with "# 0002. <title>"') },
    ]);
  });

  /**
   * pup must read the status the rendered file shows: a status line in a
   * comment or a fence renders as nothing or as code, so a draft carrying a
   * hidden `accepted` would read as accepted to pup alone.
   */
  it.each([
    ['above a shown draft, in an HTML comment', '<!--\n- Status: accepted\n-->\n- Status: draft'],
    ['below a shown draft, in an HTML comment', '- Status: draft\n<!-- x\n- Status: accepted\n-->'],
    ['above a shown draft, in a code fence', '```\n- Status: accepted\n```\n- Status: draft'],
    ['alone, in an HTML comment', '<!--\n- Status: accepted\n-->'],
    ['alone, in a code fence', '~~~\n- Status: accepted\n~~~'],
    ['twice, both shown', '- Status: draft\n- Status: accepted'],
  ])('refuses a status line %s', (_where, head) => {
    const text = draft('0001', ['- a?', '- b?']).replace('- Status: draft', head);
    const repo = repoWith({ '0001-ship.md': text });

    expect(() => readIntent(repo, '0001')).toThrow(
      'needs exactly one "- Status: draft|accepted|closed" line above its first section, ' +
        'outside any code fence or HTML comment.',
    );
    expect(() => acceptIntent(repo, '0001')).toThrow('needs exactly one');
    expect(readFileSync(join(repo, INTENT_DIR, '0001-ship.md'), 'utf8')).toBe(text);
  });

  it('reads the status past a closed comment and fence above it', () => {
    const head = '<!-- a note --> \n```\n## Not a section\n```\n- Status: draft';
    const repo = repoWith({
      '0001-ship.md': draft('0001', ['- a?', '- b?']).replace('- Status: draft', head),
    });

    expect(acceptIntent(repo, '0001').status).toBe(IntentStatus.Accepted);
  });

  it('reads an intent back with control characters stripped', () => {
    const repo = repoWith({
      '0001-ship.md': `${intentTemplate('0001', 'Ship')}\r\n\u001b[2Jhello\u009b6n\tthere\n`,
    });

    const intent = readIntent(repo, '0001');

    expect(intent.title).toBe('Ship');
    expect(intent.text).toContain('\n[2Jhello6n\tthere\n');
    for (const control of ['\u001b', '\u009b', '\r']) expect(intent.text).not.toContain(control);
  });

  it('refuses an id with two files', () => {
    const repo = repoWith({
      '0001-a.md': intentTemplate('0001', 'A'),
      '0001-b.md': intentTemplate('0001', 'B'),
    });

    expect(() => readIntent(repo, '0001')).toThrow('Intent 0001 has 2 files');
  });

  it('refuses an id no file holds', () => {
    expect(() => readIntent(repoWith(), '0001')).toThrow('No intent 0001 in docs/intent/.');
  });
});

describe('an intent id', () => {
  // The id reaches the disk only as a filter over the directory listing, and
  // only once it is exactly four ASCII digits.
  it.each([
    ['a relative path', '../0001'],
    ['an absolute path', '/etc/passwd'],
    ['a path under the dir', '0001/../0002'],
    ['too few digits', '1'],
    ['too many digits', '00001'],
    ['a trailing newline', '0001\n'],
    ['an escape', '0001\u001b'],
    ['a C1 control', '\u009b0001'],
    ['full-width digits', '０００１'],
    ['a glob', '000*'],
    ['a file name', '0001-ship.md'],
  ])('refuses %s', (_what, id) => {
    const repo = repoWith({ '0001-ship.md': draft('0001', ['- a?', '- b?']) });

    expect(() => readIntent(repo, id)).toThrow('An intent id is four digits');
    expect(() => acceptIntent(repo, id)).toThrow('An intent id is four digits');
  });

  it('refuses an intent file that is a link, on read and on accept', () => {
    const repo = repoWith();
    const target = join(tempDir('pup-intent-target-'), 'elsewhere.md');
    writeFileSync(target, draft('0001', ['- a?', '- b?']));
    symlinkSync(target, join(repo, INTENT_DIR, '0001-link.md'));

    expect(() => readIntent(repo, '0001')).toThrow('is not a plain file');
    expect(() => acceptIntent(repo, '0001')).toThrow('is not a plain file');
    expect(readFileSync(target, 'utf8')).toContain('- Status: draft');
    expect(listIntents(repo)).toEqual([
      { id: '0001', unreadable: expect.stringContaining('is not a plain file') },
    ]);
  });

  it.each([['docs'], ['docs/intent']])(
    'refuses a %s that is a link, creating nothing behind it',
    (linked) => {
      const repo = tempDir('pup-intent-');
      const elsewhere = tempDir('pup-intent-elsewhere-');
      if (linked === 'docs/intent') mkdirSync(join(repo, 'docs'));
      mkdirSync(join(elsewhere, 'intent'));
      writeFileSync(join(elsewhere, 'intent', '0001-x.md'), intentTemplate('0001', 'X'));
      symlinkSync(linked === 'docs' ? elsewhere : join(elsewhere, 'intent'), join(repo, linked));

      expect(() => createIntent(repo, 'Planted')).toThrow('is not a directory');
      expect(() => listIntents(repo)).toThrow('is not a directory');
      expect(() => readIntent(repo, '0001')).toThrow('is not a directory');
      expect(readdirSync(join(elsewhere, 'intent'))).toEqual(['0001-x.md']);
    },
  );
});

describe('accepting an intent', () => {
  it('moves a draft with two questions to accepted, changing only its status line', () => {
    const text = draft('0001', ['1. Why does the gate re-run?', '2. What does it pin?']);
    const repo = repoWith({ '0001-ship.md': text });

    const accepted = acceptIntent(repo, '0001');

    expect(accepted.status).toBe(IntentStatus.Accepted);
    expect(accepted.questions).toEqual(['Why does the gate re-run?', 'What does it pin?']);
    expect(readFileSync(accepted.path, 'utf8')).toBe(
      text.replace('- Status: draft', '- Status: accepted'),
    );
    expect(readdirSync(join(repo, INTENT_DIR))).toEqual(['0001-ship.md']);
  });

  it('accepts three questions, and keeps a CRLF file CRLF', () => {
    const text = draft('0001', ['- a?', '- b?', '- c?']).replaceAll('\n', '\r\n');
    const repo = repoWith({ '0001-ship.md': text });

    acceptIntent(repo, '0001');

    expect(readFileSync(join(repo, INTENT_DIR, '0001-ship.md'), 'utf8')).toBe(
      text.replace('- Status: draft', '- Status: accepted'),
    );
  });

  it.each([
    ['no question', []],
    ['one question', ['- Why?']],
    ['four questions', ['- a?', '- b?', '- c?', '- d?']],
    ['items that are not questions', ['- the gate', '- the pin', '- Why?']],
    ['questions outside a list', ['Why?', 'What?']],
    ['questions inside a code fence', ['```', '- a?', '- b?', '```']],
    ['questions inside an HTML comment', ['<!--', '- a?', '- b?', '-->']],
    ['questions on a one-line HTML comment', ['<!-- - a? -->', '<!-- - b? -->']],
  ])('refuses a draft with %s, leaving it a draft', (_what, understanding) => {
    const text = draft('0001', understanding);
    const repo = repoWith({ '0001-ship.md': text });

    expect(() => acceptIntent(repo, '0001')).toThrow(
      'accepting it takes 2 or 3, one list item each, ending in "?"',
    );
    expect(readFileSync(join(repo, INTENT_DIR, '0001-ship.md'), 'utf8')).toBe(text);
  });

  // The questions must sit under the understanding heading itself: two in
  // Open questions, or under a fenced heading, are not the operator's checks.
  it('counts only the understanding section', () => {
    const text = intentTemplate('0001', 'Ship')
      .replace('## Open questions\n', '## Open questions\n\n- a?\n- b?\n')
      .replace(
        '## What I must',
        '```\n## What I must understand after review\n- c?\n- d?\n```\n## What I must',
      );
    const repo = repoWith({ '0001-ship.md': text });

    expect(readIntent(repo, '0001').questions).toEqual([]);
    expect(() => acceptIntent(repo, '0001')).toThrow('has 0 questions');
  });

  it.each([[IntentStatus.Accepted], [IntentStatus.Closed]])(
    'refuses an intent already %s',
    (status) => {
      const text = draft('0001', ['- a?', '- b?']).replace('Status: draft', `Status: ${status}`);
      const repo = repoWith({ '0001-ship.md': text });

      expect(() => acceptIntent(repo, '0001')).toThrow(
        `Intent 0001 is ${status}; only a draft is accepted.`,
      );
    },
  );

  it('leaves no staged file behind', () => {
    const repo = repoWith({ '0001-ship.md': draft('0001', ['- a?', '- b?']) });

    acceptIntent(repo, '0001');

    expect(existsSync(join(repo, INTENT_DIR, `0001-ship.md.${process.pid}.tmp`))).toBe(false);
  });
});
