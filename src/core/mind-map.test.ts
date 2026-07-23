import { describe, expect, it } from 'vitest';

import type { DecisionRecordRow } from './decision-record.repository.js';
import { renderMindMapHtml } from './mind-map.service.js';
import type { CodeMapNode } from './types/code-map.types.js';

const NODES: CodeMapNode[] = [
  {
    id: 'src/core',
    files: ['src/core/a.service.ts', 'src/core/b.service.ts'],
    churn: 12,
    openDebt: 2,
    dependsOn: ['src/claude'],
    usedBy: ['src/cli'],
  },
  {
    id: 'src/claude',
    files: ['src/claude/runtime.service.ts'],
    churn: 3,
    openDebt: 0,
    dependsOn: [],
    usedBy: ['src/core'],
  },
  {
    id: 'src/cli',
    files: ['src/cli/index.ts'],
    churn: 7,
    openDebt: 0,
    dependsOn: ['src/core'],
    usedBy: [],
  },
];

const RECORDS: DecisionRecordRow[] = [
  {
    id: 1,
    session_id: 't-1',
    summary: 'Adopted the gate lock',
    alternatives: null,
    conventions: null,
    files: JSON.stringify(['src/core/a.service.ts']),
    created_at: '2026-07-23 10:00:00',
  },
];

describe('renderMindMapHtml', () => {
  it('produces a self-contained document embedding every module', () => {
    const html = renderMindMapHtml('/repo', NODES, RECORDS);

    expect(html).toContain('<!doctype html>');
    for (const node of NODES) expect(html).toContain(JSON.stringify(node.id));
    // Self-contained: no external scripts, styles, or fetches.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain('https://');
  });

  it('attaches decision records to the module owning their files', () => {
    const html = renderMindMapHtml('/repo', NODES, RECORDS);
    const data = JSON.parse(/id="pup-map-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '');

    const core = data.nodes.find((n: { id: string }) => n.id === 'src/core');
    expect(core.records).toEqual([
      { id: 1, summary: 'Adopted the gate lock', createdAt: '2026-07-23 10:00:00' },
    ]);
    const cli = data.nodes.find((n: { id: string }) => n.id === 'src/cli');
    expect(cli.records).toEqual([]);
  });

  it('escapes script-closing sequences in embedded data', () => {
    const hostile: CodeMapNode[] = [
      {
        id: 'src/</script><script>alert(1)',
        files: [],
        churn: 1,
        openDebt: 0,
        dependsOn: [],
        usedBy: [],
      },
    ];

    const html = renderMindMapHtml('/repo', hostile, []);

    expect(html).not.toContain('</script><script>alert');
  });
});
