import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectAdapters } from './adapter.registry.js';

function makeRepo(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-registry-')));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('detectAdapters', () => {
  it('detects a TypeScript repo', () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ devDependencies: { typescript: '^5' } }),
    });

    expect(detectAdapters(repo).map((a) => a.id)).toEqual(['typescript']);
  });

  it('detects a Python repo', () => {
    const repo = makeRepo({ 'pyproject.toml': '[project]\nname = "x"\n' });

    expect(detectAdapters(repo).map((a) => a.id)).toEqual(['python']);
  });

  it('keeps TypeScript first in a mixed repo so it drives single-adapter flows', () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ devDependencies: { typescript: '^5' } }),
      'pyproject.toml': '[project]\nname = "x"\n',
    });

    expect(detectAdapters(repo).map((a) => a.id)).toEqual(['typescript', 'python']);
  });

  it('detects nothing in an empty repo', () => {
    expect(detectAdapters(makeRepo({}))).toEqual([]);
  });

  it('puts a repo-supplied custom adapter ahead of the built-ins', () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ devDependencies: { typescript: '^5' } }),
    });
    mkdirSync(join(repo, '.pupitre'));
    writeFileSync(join(repo, '.pupitre', 'adapter.yml'), 'id: exotic\nbuild: make\n');

    expect(detectAdapters(repo).map((a) => a.id)).toEqual(['exotic', 'typescript']);
  });
});
