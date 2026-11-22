import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { NestedPackageStage } from '../adapters/enums/nested-package-stage.enums.js';
import type { NestedPackage } from '../adapters/types/adapter.types.js';
import { owningLockfile, refuseUninstalled } from './uninstalled-dependency.service.js';

const MEMBER: NestedPackage = {
  dir: 'tools/review',
  changedFiles: ['tools/review/src/r.ts'],
  droppedSources: [],
  commands: [{ stage: NestedPackageStage.Test, command: 'npm', args: ['test'] }],
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
  const declare = (dependencies: Record<string, string>, root = repo): void =>
    write(root, 'tools/review/package.json', JSON.stringify({ devDependencies: dependencies }));
  const yarnWorkspace = (root = repo): void => {
    write(root, 'package.json', JSON.stringify({ workspaces: ['tools/*'] }));
    write(root, 'yarn.lock', '__metadata:\n  version: 8\n');
    declare({ vitest: '^3.0.0' }, root);
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

    // A repo that gitignores `.pnp.*` installs a runtime the pinned tree never
    // holds; asking for that install again would refuse on every merge.
    it("names the Plug'n'Play install the gate cannot link, not another install", () => {
      yarnWorkspace();
      write(repo, '.pnp.cjs');

      expect(refuse).toThrow(
        /tools\/review resolves through the Yarn Plug'n'Play install in \., whose \.pnp\.cjs the pinned tree does not commit.*nothing was merged\. Another `yarn install` does not clear this/,
      );
    });

    // A remeasure's stand-in is a checkout of the target's tracked files, so a
    // gitignored runtime is only ever in the main checkout.
    describe('in a remeasure', () => {
      let standIn: string;
      const remeasure = (): void => refuseUninstalled(repo, standIn, checkout, MEMBER);

      beforeEach(() => {
        standIn = tempDir('pup-uninstalled-stand-in-');
        yarnWorkspace();
        yarnWorkspace(standIn);
        write(repo, '.pnp.cjs');
      });

      it("names the Plug'n'Play install the gate cannot link, not another install", () => {
        expect(remeasure).toThrow(
          /whose \.pnp\.cjs the pinned tree does not commit.*nothing was landed\. Another `yarn install` does not clear this.*then remeasure again/,
        );
      });

      // Past the target the main checkout holds the session's own merge: its
      // runtime names the cause but never skips the refusal.
      it('refuses a member whose runtime the stand-in lacks, though the branch commits one', () => {
        write(checkout, '.pnp.cjs');

        expect(remeasure).toThrow(/whose \.pnp\.cjs the target does not commit/);
      });

      it('runs a zero-install member whose runtime the stand-in and the branch hold', () => {
        write(standIn, '.pnp.cjs');
        write(checkout, '.pnp.cjs');

        expect(remeasure).not.toThrow();
      });
    });
  });

  describe('dependency names', () => {
    // `..` and the empty string name the root's node_modules itself or a
    // directory above it, which always exists.
    it.each(['..', '', '.', '../node_modules', 'a/b', '@scope/a/b'])(
      'refuses a member declaring %j, which names no package',
      (name) => {
        write(repo, 'package-lock.json', '{}\n');
        write(repo, 'package.json', JSON.stringify({ workspaces: ['tools/*'] }));
        mkdirSync(join(repo, 'node_modules', 'vitest'), { recursive: true });
        mkdirSync(join(repo, 'node_modules', 'a', 'b'), { recursive: true });
        mkdirSync(join(repo, 'node_modules', '@scope', 'a', 'b'), { recursive: true });
        declare({ [name]: '^1.0.0' });

        expect(refuse).toThrow(/has no node_modules.*`npm --prefix \. install`/);
      },
    );

    it('runs a member whose scoped dependency the root has', () => {
      write(repo, 'package-lock.json', '{}\n');
      write(repo, 'package.json', JSON.stringify({ workspaces: ['tools/*'] }));
      mkdirSync(join(repo, 'node_modules', '@scope', 'a'), { recursive: true });
      declare({ '@scope/a': '^1.0.0' });

      expect(refuse).not.toThrow();
    });
  });
});

describe('owningLockfile', () => {
  // `dirname('/')` is `/`: a walk that stopped only at `.` never ended.
  it('ends its walk on an absolute path with no lockfile', () => {
    expect(owningLockfile(tempDir('pup-uninstalled-abs-'), '/no/lockfile/here')).toBeUndefined();
  });

  it("finds the workspace root's lockfile above a member", () => {
    const repo = tempDir('pup-uninstalled-member-');
    write(repo, 'package-lock.json', '{}\n');
    write(repo, 'package.json', JSON.stringify({ workspaces: ['tools/*'] }));

    expect(owningLockfile(repo, 'tools/review')).toEqual({
      dir: '.',
      manager: expect.objectContaining({ name: 'npm' }),
    });
  });
});
