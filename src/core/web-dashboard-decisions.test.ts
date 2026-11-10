import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStore } from './db.client.js';
import { insertDecisionRecord } from './decision-record.repository.js';
import { closeLedgerEntry, insertLedgerEntry } from './ledger.repository.js';
import { projectId } from './paths.utils.js';
import { appendEvent, ensureProject, insertSession, insertTask } from './session.repository.js';
import { readDecisionsSheet, renderDecisionsSheet } from './web-dashboard-decisions.service.js';
import { readModuleMap } from './web-dashboard-module-map.service.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: their absence is what is asserted
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

describe('the Decisions sheet', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = tempDir('pup-decisions-');
    ensureProject(db, projectId(repo), repo);
  });

  function seedSession(id: string): void {
    insertTask(db, {
      id: `t-${id}`,
      projectId: projectId(repo),
      spec: JSON.stringify({ id: `t-${id}`, goal: 'g', scopeIn: ['src/**'], acceptance: ['done'] }),
    });
    insertSession(db, {
      id,
      taskId: `t-${id}`,
      worktreePath: join(repo, '.worktrees', id),
      branch: `pup/${id}`,
      profileHash: 'hash',
    });
  }

  function decide(
    sessionId: string,
    summary: string,
    files: string[],
    alternatives?: string,
  ): void {
    seedSession(sessionId);
    insertDecisionRecord(db, { sessionId, summary, files, alternatives });
  }

  function merge(sessionId: string, files: string[], daysAgo = 0): void {
    appendEvent(db, sessionId, 'merge', { branch: `pup/${sessionId}`, target: 'main', files });
    db.prepare(
      "UPDATE events SET created_at = datetime('now', ?) WHERE id = (SELECT MAX(id) FROM events)",
    ).run(`-${daysAgo} days`);
  }

  function write(path: string, text: string): void {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }

  function fileDebt(files: string[]): number {
    return insertLedgerEntry(db, {
      projectId: projectId(repo),
      description: 'Oversize diff',
      files,
      reason: 'r',
      acceptedBy: 'alexis',
      reviewBy: '2999-01-01',
    });
  }

  const sheet = (): string => renderDecisionsSheet(readDecisionsSheet(db, repo, Date.now()));

  it('renders on an empty store and no src/ with a one-line hint for each chart', () => {
    const page = sheet();

    expect(page).not.toContain('<svg');
    expect(page).toContain('No decision recorded yet — each merge records one.');
    expect(page).toContain('No source under src/ to map.');
  });

  it('places each record under the directory most of its files sit in, a tie to the first by path', () => {
    decide('s-1', 'core work', ['src/core/x.ts', 'src/core/y.ts', 'src/cli/z.ts']);
    decide('s-2', 'split work', ['src/core/b.ts', 'src/cli/a.ts']);
    decide('s-3', 'no files', []);

    const { records } = readDecisionsSheet(db, repo, Date.now());

    expect(records.map((record) => [record.summary[0], record.module])).toEqual([
      ['no files', '(no file named)'],
      ['split work', 'src/cli'],
      ['core work', 'src/core'],
    ]);
  });

  it('shows each module newest first with its summary and alternatives, and charts the count', () => {
    decide('s-1', 'first core', ['src/core/a.ts'], 'keep it\nor drop it');
    db.prepare(
      "UPDATE decision_records SET created_at = '2026-11-02 09:15:00' WHERE session_id = 's-1'",
    ).run();
    decide('s-2', 'a cli change', ['src/cli/a.ts']);
    decide('s-3', 'second core', ['src/core/b.ts']);

    const page = sheet();

    expect(page).toContain('3 decisions across 2 modules');
    expect(page).toContain(
      '<figcaption>Decisions by module, top 10: src/core 2 · src/cli 1</figcaption>',
    );
    expect(page.indexOf('src/core — 2')).toBeLessThan(page.indexOf('src/cli — 1'));
    expect(page.indexOf('second core')).toBeLessThan(page.indexOf('first core'));
    expect(page).toContain(
      '<div class="fact">alternatives: keep it</div><div class="fact">or drop it</div>',
    );
    expect(page).toContain('#1</span> s-1, 2026-11-02 09:15 UTC</div>');
    db.prepare("UPDATE decision_records SET created_at = 'torn' WHERE session_id = 's-1'").run();
    expect(sheet()).toContain('#1</span> s-1</div>');
  });

  it('reads src/ only, skipping links, node_modules, .worktrees and anything but a plain file', () => {
    const outside = tempDir('pup-decisions-outside-');
    writeFileSync(join(outside, 'secret.ts'), 'a\nb\nc\nd\n');
    write('src/core/a.ts', '1\n2\n3\n');
    write('src/core/b.ts', 'x\ny');
    write('src/cli/empty.ts', '');
    write('src/node_modules/dep/index.js', 'dep\n');
    write('src/.worktrees/s-1/src/x.ts', 'other checkout\n');
    write('docs/readme.md', 'not mapped\n');
    symlinkSync(join(outside, 'secret.ts'), join(repo, 'src/link.ts'));
    symlinkSync(outside, join(repo, 'src/linked-dir'));
    execFileSync('mkfifo', [join(repo, 'src/core/fifo.ts')]);

    const { map } = readDecisionsSheet(db, repo, Date.now());

    expect(map.files.map(({ file, lines }) => [file, lines])).toEqual([
      ['src/cli/empty.ts', 0],
      ['src/core/a.ts', 3],
      ['src/core/b.ts', 2],
    ]);
    expect(map.capped).toBe(false);
  });

  it('reads a file again once it changes, and leaves one over 1 MiB unread, saying so', () => {
    write('src/a.ts', '1\n2\n3\n');
    write('src/huge.ts', 'x'.repeat((1 << 20) + 1));
    const lines = (): number[] =>
      readDecisionsSheet(db, repo, Date.now()).map.files.map((file) => file.lines);

    expect(lines()).toEqual([3]);
    write('src/a.ts', '1\n2\n3\n4\n5\n');
    expect(lines()).toEqual([5]);
    expect(readDecisionsSheet(db, repo, Date.now()).map.unread).toBe(1);
    expect(sheet()).toContain('1 file not read (not a plain file, unreadable, or over 1 MiB).');
  });

  it('counts a file or directory it may not read as unread or empty, not as an error', () => {
    write('src/a.ts', 'a\n');
    write('src/locked.ts', 'b\n');
    write('src/closed/c.ts', 'c\n');
    chmodSync(join(repo, 'src/locked.ts'), 0o000);
    chmodSync(join(repo, 'src/closed'), 0o000);

    const { map } = readDecisionsSheet(db, repo, Date.now());
    // Before any expectation, so the temp dir can be removed whatever they find.
    chmodSync(join(repo, 'src/closed'), 0o755);

    expect(map.files.map(({ file }) => file)).toEqual(['src/a.ts']);
    expect(map.unread).toBe(1);
  });

  it('counts the entries of a directory it can list but not search as unread, not as an error', () => {
    write('src/a.ts', 'a\n');
    write('src/listed/b.ts', 'b\n');
    chmodSync(join(repo, 'src/listed'), 0o644);

    const sheet = readDecisionsSheet(db, repo, Date.now());
    chmodSync(join(repo, 'src/listed'), 0o755);

    expect(sheet.map.files.map(({ file }) => file)).toEqual(['src/a.ts']);
    expect(sheet.map.unread).toBe(1);
  });

  it('stops the walk at its file or byte cap, in path order, and says so', () => {
    write('src/a.ts', 'a\n');
    write('src/b.ts', 'bb\n');
    write('src/c.ts', 'c\n');
    const mapped = (limits: { files: number; bytes: number }) => {
      const map = readModuleMap(db, repo, Date.now(), limits);
      return [map.files.map(({ file }) => file), map.capped];
    };

    expect(mapped({ files: 2, bytes: 1 << 20 })).toEqual([['src/a.ts', 'src/b.ts'], true]);
    expect(mapped({ files: 10, bytes: 5 })).toEqual([['src/a.ts', 'src/b.ts'], true]);
    expect(mapped({ files: 10, bytes: 1 << 20 })).toEqual([
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      false,
    ]);
    expect(sheet()).not.toContain('The walk stopped at its cap');
  });

  it('maps nothing when src/ is itself a link out of the project', () => {
    const outside = tempDir('pup-decisions-outside-');
    writeFileSync(join(outside, 'secret.ts'), 'a\n');
    symlinkSync(outside, join(repo, 'src'));

    expect(readDecisionsSheet(db, repo, Date.now()).map.files).toEqual([]);
    expect(sheet()).toContain('No source under src/ to map.');
  });

  it('counts open debt entries per file, and each session merged into it in 30 days once', () => {
    write('src/core/a.ts', 'a\n');
    write('src/core/b.ts', 'b\n');
    fileDebt(['src/core/a.ts', 'src/core/b.ts']);
    fileDebt(['src/core/a.ts']);
    closeLedgerEntry(db, fileDebt(['src/core/a.ts']));
    seedSession('s-1');
    seedSession('s-2');
    seedSession('s-3');
    merge('s-1', ['src/core/a.ts']);
    // A fix round's re-gate merges again: still one session.
    merge('s-1', ['src/core/a.ts']);
    merge('s-2', ['src/core/a.ts'], 40);
    merge('s-3', ['src/core/b.ts', 'src/core/a.ts'], 29);

    const { map } = readDecisionsSheet(db, repo, Date.now());

    expect(map.files.map(({ file, openDebt, merges }) => [file, openDebt, merges])).toEqual([
      ['src/core/a.ts', 2, 2],
      ['src/core/b.ts', 1, 1],
    ]);
    expect(sheet()).toContain(
      '<title>src/core/a.ts: 1 line, 2 open debt entries, 2 merges in 30 days</title>',
    );
  });

  it('draws the module map with cell areas summing to the total line count', () => {
    const sizes: Record<string, number> = {
      'src/core/a.ts': 412,
      'src/core/b.ts': 37,
      'src/core/deep/c.ts': 1290,
      'src/cli/d.ts': 85,
      'src/cli/e.ts': 3,
      'src/main.ts': 1,
    };
    for (const [path, n] of Object.entries(sizes)) write(path, 'line\n'.repeat(n));
    const total = Object.values(sizes).reduce((sum, n) => sum + n, 0);

    const page = sheet();
    const [, , width, height] = (
      /<div class="treemap">.*?viewBox="([\d. ]+)"/.exec(page)?.[1] ?? ''
    )
      .split(' ')
      .map(Number);
    const areas = [
      ...page.matchAll(
        /<rect class="cell[^"]*" x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="([\d.]+)"/g,
      ),
    ].map(([, w, h]) => Number(w) * Number(h));
    const unit = ((width as number) * (height as number)) / total;

    expect(areas).toHaveLength(6);
    // Coordinates print to two decimals: each area is good to well under a line.
    expect(areas.reduce((sum, area) => sum + area, 0) / unit).toBeCloseTo(total, 0);
    expect(areas.map((area) => Math.round(area / unit)).sort((a, b) => a - b)).toEqual(
      Object.values(sizes).sort((a, b) => a - b),
    );
    expect(page).toContain(`<title>Module map of src/: ${total} lines in total · `);
    expect(page).toContain(`<figcaption>Module map of src/: ${total} lines in total · `);
  });

  it('escapes every store string and file name, markup and control characters alike', () => {
    const evil = '<img src=x onerror=alert(1)>\u001b[31m\u009b2J‮';
    decide('s-evil', `${evil}\nsecond ${evil}`, [`src/${evil}.ts`], evil);
    seedSession('<b>s</b>');
    insertDecisionRecord(db, { sessionId: '<b>s</b>', summary: 's', files: [] });
    fileDebt([`src/${evil}.ts`]);
    write(`src/<img src=y>\u001b.ts`, 'x\n');

    const page = sheet();

    expect(page).not.toMatch(/<img|<b>/);
    expect(page).not.toMatch(CONTROL);
    expect(page).not.toContain('‮');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).toContain('&lt;img src=y&gt;');
    expect(page).toContain('(unminted session id)');
  });
});
