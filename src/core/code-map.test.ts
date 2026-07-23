import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { typescriptAdapter } from '../adapters/typescript.adapter.js';
import { buildCodeMap, buildKnowledgeSlice, renderCodeMap } from './code-map.service.js';
import { openStore } from './db.client.js';
import { insertLedgerEntry } from './ledger.repository.js';
import { ensureProject } from './session.repository.js';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0] as string, args.slice(1), { cwd, encoding: 'utf8', env: GIT_ENV });
}

function initRepo(files: Record<string, string>): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-map-')));
  sh(repo, 'git', 'init', '-b', 'main');
  sh(repo, 'git', 'config', 'user.email', 'map@test');
  sh(repo, 'git', 'config', 'user.name', 'map-test');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), content);
  }
  sh(repo, 'git', 'add', '.');
  sh(repo, 'git', 'commit', '-m', 'seed');
  return repo;
}

const FILES = {
  'src/cli/index.ts': "import { run } from '../core/run.service.js';\nrun();\n",
  'src/core/run.service.ts': 'export const run = () => 1;\n',
};

describe('code map', { timeout: 20_000 }, () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = initRepo(FILES);
    ensureProject(db, 'proj-1', repo);
  });

  it('builds nodes with churn from git history and edges from the adapter graph', () => {
    const nodes = buildCodeMap(db, 'proj-1', repo, typescriptAdapter);

    expect(nodes.map((n) => n.id)).toEqual(['src/cli', 'src/core']);
    expect(nodes[0]).toMatchObject({ churn: 1, openDebt: 0, dependsOn: ['src/core'] });
    expect(nodes[1]).toMatchObject({ usedBy: ['src/cli'] });
  });

  it('counts open ledger entries per module', () => {
    insertLedgerEntry(db, {
      projectId: 'proj-1',
      description: 'shortcut',
      files: ['src/core/run.service.ts'],
      reason: 'r',
      acceptedBy: 'human',
      reviewBy: 'c',
    });

    const nodes = buildCodeMap(db, 'proj-1', repo, typescriptAdapter);

    expect(nodes.find((n) => n.id === 'src/core')?.openDebt).toBe(1);
    expect(renderCodeMap(nodes)).toContain('DEBT 1');
  });

  it('throws a clear error when the adapter has no depGraph capability', () => {
    const bare = { id: 'bare', detect: () => true, gateCommands: () => [] };
    expect(() => buildCodeMap(db, 'proj-1', repo, bare)).toThrow('no depGraph capability');
  });

  it('renders one module in detail and reports unknown modules', () => {
    const nodes = buildCodeMap(db, 'proj-1', repo, typescriptAdapter);

    const detail = renderCodeMap(nodes, 'src/core');
    expect(detail).toContain('src/core/run.service.ts');
    expect(detail).toContain('used by: src/cli');
    expect(renderCodeMap(nodes, 'src/nope')).toContain('No module src/nope');
  });

  it('slices in-scope nodes with files plus neighbours without files', () => {
    const nodes = buildCodeMap(db, 'proj-1', repo, typescriptAdapter);

    const slice = buildKnowledgeSlice(nodes, ['src/core/**']);

    expect(slice).toContain('src/core/run.service.ts');
    expect(slice).toContain('src/cli');
    expect(slice).not.toContain('src/cli/index.ts');
  });

  it('returns an empty slice when nothing matches scope', () => {
    const nodes = buildCodeMap(db, 'proj-1', repo, typescriptAdapter);
    expect(buildKnowledgeSlice(nodes, ['docs/**'])).toBe('');
  });
});
