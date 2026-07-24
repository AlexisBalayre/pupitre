import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { scrubbedGitEnv } from './git-diff.client.js';
import { globToRegExp } from './glob.utils.js';
import { listLedgerEntries } from './ledger.repository.js';
import type { CodeMapNode } from './types/code-map.types.js';

const CHURN_WINDOW = '30.days';

/** Nodes and per-node files are capped in the injected slice, not the map. */
const SLICE_MAX_NODES = 12;
const SLICE_MAX_FILES_PER_NODE = 10;

function moduleOf(file: string): string {
  const dir = dirname(file);
  return dir === '.' ? '(root)' : dir;
}

/** Commits per module in the churn window — one git call for the whole repo. */
function churnByModule(repoPath: string): Map<string, number> {
  const output = execFileSync(
    'git',
    ['-C', repoPath, 'log', `--since=${CHURN_WINDOW}`, '--name-only', '--format=%H'],
    { encoding: 'utf8', env: scrubbedGitEnv() },
  );
  const churn = new Map<string, number>();
  let commitModules = new Set<string>();
  const flush = () => {
    for (const id of commitModules) churn.set(id, (churn.get(id) ?? 0) + 1);
    commitModules = new Set();
  };
  for (const line of output.split('\n')) {
    if (/^[0-9a-f]{40}$/.test(line)) flush();
    else if (line) commitModules.add(moduleOf(line));
  }
  flush();
  return churn;
}

export function buildCodeMap(
  db: Database,
  projectId: string,
  repoPath: string,
  adapter: Adapter,
): CodeMapNode[] {
  if (!adapter.depGraph) {
    throw new Error(`Adapter ${adapter.id} has no depGraph capability; no code map available.`);
  }
  const graph = adapter.depGraph(repoPath);
  const churn = churnByModule(repoPath);
  const debtByModule = new Map<string, number>();
  for (const entry of listLedgerEntries(db, projectId)) {
    for (const id of new Set((JSON.parse(entry.files) as string[]).map(moduleOf))) {
      debtByModule.set(id, (debtByModule.get(id) ?? 0) + 1);
    }
  }
  return Object.entries(graph.modules)
    .map(([id, files]) => ({
      id,
      files,
      churn: churn.get(id) ?? 0,
      openDebt: debtByModule.get(id) ?? 0,
      dependsOn: graph.edges.filter((e) => e.from === id).map((e) => e.to),
      usedBy: graph.edges.filter((e) => e.to === id).map((e) => e.from),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function nodeLine(node: CodeMapNode): string {
  const badges = [
    `${node.files.length} files`,
    `churn ${node.churn}`,
    node.openDebt > 0 ? `DEBT ${node.openDebt}` : undefined,
  ].filter(Boolean);
  return `${node.id}  (${badges.join(', ')})`;
}

/** `pup map` text view: every node, or one node in detail. */
export function renderCodeMap(nodes: CodeMapNode[], moduleFilter?: string): string {
  if (!moduleFilter) {
    return nodes
      .map((node) => {
        const edges = [
          node.dependsOn.length ? `-> ${node.dependsOn.join(', ')}` : undefined,
          node.usedBy.length ? `<- ${node.usedBy.join(', ')}` : undefined,
        ].filter(Boolean);
        return [nodeLine(node), ...edges.map((e) => `  ${e}`)].join('\n');
      })
      .join('\n');
  }
  const node = nodes.find((n) => n.id === moduleFilter);
  if (!node) {
    const known = nodes.map((n) => n.id).join(', ');
    return `No module ${moduleFilter}. Known modules: ${known}`;
  }
  return [
    nodeLine(node),
    ...node.files.map((f) => `  ${f}`),
    node.dependsOn.length ? `depends on: ${node.dependsOn.join(', ')}` : 'depends on: nothing',
    node.usedBy.length ? `used by: ${node.usedBy.join(', ')}` : 'used by: nothing',
  ].join('\n');
}

/**
 * Compact index of in-scope nodes plus their direct neighbours, injected into
 * the task layer (docs/05: "this already exists, reuse it"). In-scope nodes
 * list files; neighbours appear as one line. Sized for a small context budget.
 */
export function buildKnowledgeSlice(nodes: CodeMapNode[], scopeIn: string[]): string {
  const regexes = scopeIn.map(globToRegExp);
  const inScope = nodes.filter((n) => n.files.some((f) => regexes.some((re) => re.test(f))));
  const neighbourIds = new Set(inScope.flatMap((n) => [...n.dependsOn, ...n.usedBy]));
  for (const node of inScope) neighbourIds.delete(node.id);
  const neighbours = nodes.filter((n) => neighbourIds.has(n.id));

  const lines: string[] = [];
  for (const node of [...inScope, ...neighbours].slice(0, SLICE_MAX_NODES)) {
    lines.push(nodeLine(node));
    if (inScope.includes(node)) {
      const shown = node.files.slice(0, SLICE_MAX_FILES_PER_NODE);
      lines.push(...shown.map((f) => `  ${f}`));
      if (node.files.length > shown.length) {
        lines.push(`  … ${node.files.length - shown.length} more files`);
      }
    }
    if (node.dependsOn.length) lines.push(`  depends on: ${node.dependsOn.join(', ')}`);
    if (node.usedBy.length) lines.push(`  used by: ${node.usedBy.join(', ')}`);
  }
  return lines.join('\n');
}
