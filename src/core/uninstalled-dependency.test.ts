import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { NestedPackage } from '../adapters/types/adapter.types.js';
import { refuseUninstalled } from './uninstalled-dependency.service.js';

const MEMBER: NestedPackage = {
  dir: 'tools/review',
  changedFiles: ['tools/review/src/r.ts'],
  droppedSources: [],
  commands: [{ stage: 'test', command: 'npm', args: ['test'] }],
  missing: [],
};

function write(root: string, rel: string, content = ''): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

describe('refuseUninstalled', () => {
  // The main checkout, which the gate trusts, and the gate's checkout of the
  // branch, which the session wrote.
  let repo: string;
  let checkout: string;
  const declare = (dependencies: Record<string, string>): void =>
    write(repo, 'tools/review/package.json', JSON.stringify({ devDependencies: dependencies }));
  const yarnWorkspace = (): void => {
    write(repo, 'package.json', JSON.stringify({ workspaces: ['tools/*'] }));
    write(repo, 'yarn.lock', '__metadata:\n  version: 8\n');
    declare({ vitest: '^3.0.0' });
  };
  const refuse = (): void => refuseUninstalled(repo, repo, checkout, MEMBER);

  beforeEach(() => {
    repo = tempDir('pup-uninstalled-repo-');
    checkout = tempDir('pup-uninstalled-checkout-');
  });

  describe("Yarn's Plug'n'Play runtime", () => {
    it('runs a zero-install member whose runtime both checkouts hold', () => {
      yarnWorkspace();
      write(repo, '.pnp.cjs');
      write(checkout, '.pnp.cjs');

      expect(refuse).not.toThrow();
    });

    // The branch is the session's to write: its runtime is no evidence that
    // the main checkout installed anything.
    it('refuses a member whose .pnp.cjs only the branch commits', () => {
      yarnWorkspace();
      write(checkout, '.pnp.cjs');

      expect(refuse).toThrow(/has no node_modules.*`yarn --cwd \. install`/);
    });

    it("refuses under a .pnp.cjs beside a lockfile that is not yarn's", () => {
      write(repo, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
      write(repo, 'pnpm-workspace.yaml', "packages:\n  - 'tools/*'\n");
      declare({ vitest: '^3.0.0' });
      write(repo, '.pnp.cjs');
      write(checkout, '.pnp.cjs');

      expect(refuse).toThrow(/has no node_modules.*`pnpm --dir \. install`/);
    });
  });
});
