import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The real lstatSync, wrapped so one test can report a directory on another
// device, as a volume mounted over it would be.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { sandboxProfile, writeProfile } from './sandbox-profile.utils.js';

afterEach(() => {
  vi.mocked(lstatSync).mockReset();
});

const HOME = '/Users/dev';

/**
 * Restated rather than imported from the module under test: a test that reads
 * the very list it is checking passes whatever that list happens to say, and
 * the point here is that removing a path from the policy fails a test.
 */
const CURATED_SECRET_PATHS =
  '.ssh .aws .config/gh .netrc .npmrc .gnupg .kube .docker/config.json Library/Keychains .pupitre';

function profile(
  writablePaths: string[] = ['/repo'],
  protectedPaths: string[] = [],
  checkoutPaths: string[] = [],
  pinnedPaths: string[] = [],
  sealedPaths: string[] = [],
): string {
  return sandboxProfile({
    writablePaths,
    protectedPaths,
    checkoutPaths,
    pinnedPaths,
    sealedPaths,
    home: HOME,
    policyDir: '/scratch/pup-sandbox-x',
  });
}

describe('sandboxProfile', () => {
  it('denies every write before granting the paths a gate needs', () => {
    // Order is the policy: the blanket deny lands first and the enumerated
    // paths override it. Denying only HOME left `/opt/homebrew/bin` — writable
    // on a standard install — open to a child that could then replace the `gh`
    // or `git` binary pup itself runs afterwards, unsandboxed.
    const generated = profile([`${HOME}/code/repo/.worktrees/s1`]);

    expect(generated).toContain('(allow default)');
    // Presence first: indexOf returns -1 for a missing rule, and -1 is less
    // than any index, so the comparison alone would PASS when the blanket
    // deny — the whole inversion — is deleted.
    expect(generated).toContain('(deny file-write*)');
    expect(generated.indexOf('(deny file-write*)')).toBeLessThan(
      generated.indexOf(`(allow file-write*\n  (subpath "${HOME}/code/repo/.worktrees/s1")`),
    );
  });

  it('generates exactly this policy and nothing more', () => {
    // Decision 36's review deleted the profile-text test, leaving only runtime
    // proofs that specific paths are denied — an extra grant would have passed
    // every one of them. Structural assertions (splitting into rules, matching
    // the allow set) were tried and evaded: SBPL ignores leading whitespace, so
    // an allow rule indented one space, or appended to the last subpath's line,
    // is live policy that a line-oriented parse absorbs into the preceding
    // deny. Whole-text equality is the only formatting-proof pin: any grant
    // added, deny dropped, or subpath widened — anywhere, however spelled —
    // fails by construction.
    expect(profile(['/repo', '/reports'], ['/repo/.git'], ['/repo'], ['/repo', '/'])).toBe(
      [
        '(version 1)',
        '(allow default)',
        '(deny file-write*)',
        `(deny file-read*${CURATED_SECRET_PATHS.split(' ')
          .map((path) => `\n  (subpath "${HOME}/${path}")`)
          .join('')})`,
        '(allow file-write*\n  (subpath "/repo")\n  (subpath "/reports")\n  (subpath "/dev"))',
        `(deny file-write*\n  (subpath "${HOME}/.pupitre")\n  (subpath "/scratch/pup-sandbox-x")\n  (subpath "/repo/.git"))`,
        String.raw`(deny file-write* (require-all (subpath "/repo") (regex #"/\.git(/|$)")))`,
        '(deny file-mount file-mount-update file-unmount)',
        '(deny file-write-unlink\n  (literal "/repo")\n  (literal "/"))',
        '',
      ].join('\n'),
    );
  });

  it('read-denies the curated secret paths', () => {
    const generated = profile();

    for (const path of CURATED_SECRET_PATHS.split(' ')) {
      expect(generated).toContain(`(subpath "${HOME}/${path}")`);
    }
  });

  it('keeps pup its own store and the profile file unwritable, whatever the caller passed', () => {
    // Last rule wins, so these two sit after the allow list on purpose: the
    // store holds the baselines a gate ratchets and the ledger it writes, and a
    // writable profile is a widened *next* stage.
    const generated = profile([HOME]);
    const lastDeny = generated.indexOf(`(deny file-write*\n  (subpath "${HOME}/.pupitre")`);

    expect(lastDeny).toBeGreaterThan(generated.indexOf('(allow file-write*'));
    expect(generated.slice(lastDeny)).toContain('(subpath "/scratch/pup-sandbox-x")');
  });

  it('denies .git at any depth under each checkout, and only under checkouts', () => {
    // `protectedPaths` names each grant's own .git and nothing deeper, which
    // is how #49's sibling-worktree attack reached the worktrees' `.git`
    // pointer files through a grant of the repo root. The regex matches the
    // path itself — directory or pointer file, at any depth — and sits last,
    // where SBPL's later-rule-wins ordering puts it above every allow. It is
    // scoped per checkout: pup's own scratch and cache grants carry no such
    // rule, because `git init` there is a legitimate toolchain move.
    const checkout = `${HOME}/code/repo`;
    const generated = profile([checkout, '/scratch-grant'], [], [checkout]);
    const gitDeny = String.raw`(deny file-write* (require-all (subpath "${checkout}") (regex #"/\.git(/|$)")))`;

    expect(generated).toContain(gitDeny);
    expect(generated).not.toContain('(require-all (subpath "/scratch-grant")');
    expect(generated.indexOf(gitDeny)).toBeGreaterThan(generated.indexOf('(allow file-write*'));
  });

  // A volume mounted over a worktree or a `.git` swaps what pup's next git call
  // reads without one unlink, and no write rule refused a mount (decision 117).
  it('denies every mount, remount and unmount, after the grants', () => {
    const generated = profile(['/repo']);
    const mountDeny = '(deny file-mount file-mount-update file-unmount)';

    expect(generated).toContain(mountDeny);
    expect(generated.indexOf(mountDeny)).toBeGreaterThan(generated.indexOf('(allow file-write*'));
  });

  it('leaves the unlink deny out when nothing is pinned, since bare it denies every unlink', () => {
    expect(profile(['/repo'], [], [], [], [])).not.toContain('file-write-unlink');
  });

  it('seals a path whole, under the same unlink deny as the pins', () => {
    expect(profile(['/repo'], [], [], ['/repo/a'], ['/repo/b'])).toContain(
      '(deny file-write-unlink\n  (literal "/repo/a")\n  (subpath "/repo/b"))',
    );
    expect(profile(['/repo'], [], [], [], ['/repo/b'])).toContain(
      '(deny file-write-unlink\n  (subpath "/repo/b"))',
    );
  });

  it('escapes a path that would otherwise break out of the SBPL string', () => {
    const generated = profile([String.raw`/repo/a"b\c`]);

    expect(generated).toContain(String.raw`(subpath "/repo/a\"b\\c")`);
  });
});

describe('writeProfile', () => {
  it('derives the whole policy from the two grant sets: checkouts protected, scratch exempt', () => {
    // The golden above pins sandboxProfile given explicit arguments; this one
    // pins what writeProfile COMPUTES and passes in — which grants become
    // checkouts, which stay exempt, and the derived .git denies — since a
    // wrong derivation ships a wrong policy with every sandboxProfile test
    // still green.
    const policyDir = tempDir('pup-profile-golden-');
    const home = realpathSync(homedir());

    const profilePath = writeProfile(policyDir, ['/x/checkout'], ['/x/scratch']);

    expect(profilePath).toBe(join(policyDir, 'gate-child.sb'));
    expect(readFileSync(profilePath, 'utf8')).toBe(
      [
        '(version 1)',
        '(allow default)',
        '(deny file-write*)',
        `(deny file-read*${CURATED_SECRET_PATHS.split(' ')
          .map((path) => `\n  (subpath "${home}/${path}")`)
          .join('')})`,
        '(allow file-write*\n  (subpath "/x/checkout")\n  (subpath "/x/scratch")\n  (subpath "/dev"))',
        `(deny file-write*\n  (subpath "${home}/.pupitre")\n  (subpath "${policyDir}")\n  (subpath "/x/checkout/.git")\n  (subpath "/x/checkout/.worktrees"))`,
        String.raw`(deny file-write* (require-all (subpath "/x/checkout") (regex #"/\.git(/|$)")))`,
        '(deny file-mount file-mount-update file-unmount)',
        '(deny file-write-unlink\n  (literal "/x/checkout")\n  (literal "/x/scratch")\n  (literal "/x")\n  (literal "/"))',
        '',
      ].join('\n'),
    );
  });

  // A grant is resolved up to its last name and never through it (decision
  // 108), so a path whose last name is not its own is refused (decision 155).
  it.each([
    ['empty, which named pup’s own cwd', ''],
    ['relative, which resolved against pup’s cwd', 'x/checkout'],
    ['not normalised', '/x//checkout'],
    ['not normalised in a parent', '/x/../y/checkout'],
    ['ending in a slash', '/x/checkout/'],
    ['ending in .', '/x/checkout/.'],
    ['ending in ..', '/x/checkout/..'],
    ['the root', '/'],
  ])('refuses a grant that is %s', (_, path) => {
    const policyDir = tempDir('pup-profile-');

    // As a checkout, as scratch and as an output: every grant goes through it.
    for (const grant of [
      () => writeProfile(policyDir, [path]),
      () => writeProfile(policyDir, [], [path]),
      () => writeProfile(policyDir, [], [], [path]),
    ]) {
      expect(grant).toThrow(
        `Refusing to grant ${JSON.stringify(path)}: a grant is an absolute, normalised path ending in a name.`,
      );
    }
    expect(existsSync(join(policyDir, 'gate-child.sb'))).toBe(false);
  });

  // A failing vitest run removes its empty report directory and the re-run
  // makes it again (decision 108), so an output keeps its own name free; what
  // holds it does not (decision 117).
  it('protects an output as a checkout and pins what holds it, but not its own name', () => {
    const generated = readFileSync(
      writeProfile(tempDir('pup-profile-'), ['/x/checkout'], [], ['/y/holder/report']),
      'utf8',
    );

    expect(generated).toContain(
      String.raw`(deny file-write* (require-all (subpath "/y/holder/report") (regex #"/\.git(/|$)")))`,
    );
    expect(generated).toContain(
      '(deny file-write-unlink\n  (literal "/x/checkout")\n  (literal "/x")\n  (literal "/")\n  (literal "/y/holder")\n  (literal "/y"))',
    );
    // Only the child's own checkout is where pup keeps worktrees.
    expect(generated).toContain('(subpath "/x/checkout/.worktrees")');
    expect(generated).not.toContain('/y/holder/report/.worktrees');
  });

  // An output keeps its name free, so one holding a repo could carry it into
  // scratch, past every .git rule, and back: no profile is written for it.
  it.each([
    ['holds a .git', (output: string) => mkdirSync(join(output, '.git'))],
    [
      'leads to a nested .git',
      (output: string) => mkdirSync(join(output, 'a', '.git'), { recursive: true }),
    ],
    ['cannot be read', (output: string) => chmodSync(output, 0o000)],
  ])('refuses an output that %s, writing no profile', (_, make) => {
    const output = tempDir('pup-output-');
    const policyDir = tempDir('pup-profile-');
    // The control: the same output, fresh, is granted.
    expect(() =>
      writeProfile(tempDir('pup-profile-'), ['/x/checkout'], [], [output]),
    ).not.toThrow();
    make(output);

    try {
      expect(() => writeProfile(policyDir, ['/x/checkout'], [], [output])).toThrow(
        `Refusing to grant ${output} as an output`,
      );
    } finally {
      chmodSync(output, 0o755);
    }
    expect(existsSync(join(policyDir, 'gate-child.sb'))).toBe(false);
  });

  // Moved out and back, a nested worktree came home with its `.git` pointer
  // aimed elsewhere (decision 117): each directory down to one is pinned.
  it('pins every directory below a checkout that leads to a nested .git, and no other', () => {
    const checkout = tempDir('pup-nested-');
    const elsewhere = tempDir('pup-nested-target-');
    mkdirSync(join(checkout, '.worktrees', 's1'), { recursive: true });
    writeFileSync(join(checkout, '.worktrees', 's1', '.git'), 'gitdir: /x\n');
    mkdirSync(join(checkout, 'vendor', 'lib', '.GIT'), { recursive: true });
    mkdirSync(join(checkout, 'src', 'plain'), { recursive: true });
    mkdirSync(join(checkout, '.git'));
    mkdirSync(join(elsewhere, '.git'));
    symlinkSync(elsewhere, join(checkout, 'linked'));

    const generated = readFileSync(writeProfile(tempDir('pup-profile-'), [checkout]), 'utf8');
    const pinned = [...generated.matchAll(/\(literal "([^"]*)"\)/g)].map(([, path = '']) => path);

    expect(pinned.filter((path) => path.startsWith(`${checkout}/`)).sort()).toEqual(
      ['.worktrees', '.worktrees/s1', 'vendor', 'vendor/lib'].map((path) => join(checkout, path)),
    );
  });

  // A child runs as the operator, so it can `chmod 000` a directory its grant
  // covers: read as empty, `.worktrees` hid `s1` from the next profile, and
  // pinned alone it let the next child make it readable and move `s1`.
  // A volume mounted over a directory reads as whatever the volume holds, and
  // can be gone before the next child runs: no real mount here, its device is
  // reported different instead.
  it.each([
    ['cannot read', (dir: string) => chmodSync(dir, 0o000)],
    ['can search but not list', (dir: string) => chmodSync(dir, 0o111)],
    [
      'finds on another device',
      (dir: string) => {
        const real = vi.mocked(lstatSync).getMockImplementation() as unknown as (
          path: string,
          options?: object,
        ) => Stats | undefined;
        vi.mocked(lstatSync).mockImplementation(((path: string, options?: object) => {
          const stat = real(path, options);
          if (stat && path === dir) stat.dev += 1;
          return stat;
        }) as typeof lstatSync);
      },
    ],
  ])('seals a directory the walk %s, and pins it and what leads to it', (_, hide) => {
    const checkout = tempDir('pup-nested-');
    const hidden = join(checkout, 'a', 'b', '.worktrees');
    mkdirSync(join(hidden, 's1'), { recursive: true });
    writeFileSync(join(hidden, 's1', '.git'), 'gitdir: /x\n');
    hide(hidden);
    let generated: string;
    try {
      generated = readFileSync(writeProfile(tempDir('pup-profile-'), [checkout]), 'utf8');
    } finally {
      chmodSync(hidden, 0o755);
    }

    const pinned = [...generated.matchAll(/\(literal "([^"]*)"\)/g)].map(([, path = '']) => path);
    expect(pinned.filter((path) => path.startsWith(`${checkout}/`)).sort()).toEqual([
      join(checkout, 'a'),
      join(checkout, 'a', 'b'),
      hidden,
    ]);
    expect(generated).toContain(`(subpath "${hidden}"))`);
  });

  // The fail-closed cost: a child that hides the checkout itself seals it whole.
  it('seals the whole checkout when the checkout itself cannot be read', () => {
    const checkout = tempDir('pup-nested-');
    mkdirSync(join(checkout, '.worktrees', 's1'), { recursive: true });
    chmodSync(checkout, 0o000);
    let generated: string;
    try {
      generated = readFileSync(writeProfile(tempDir('pup-profile-'), [checkout]), 'utf8');
    } finally {
      chmodSync(checkout, 0o755);
    }

    expect(generated).toContain(`(subpath "${checkout}"))`);
  });

  // An SBPL string carries a newline raw; such a name never reaches the profile.
  it('seals the parent of a directory named with a control character, not the name', () => {
    const checkout = tempDir('pup-nested-');
    mkdirSync(join(checkout, 'vendor', 'a\nb', '.git'), { recursive: true });
    mkdirSync(join(checkout, 'vendor', 'c\u009bd', '.git'), { recursive: true });

    const generated = readFileSync(writeProfile(tempDir('pup-profile-'), [checkout]), 'utf8');

    expect(generated).toContain(`(subpath "${join(checkout, 'vendor')}"))`);
    expect(generated).toContain(`(literal "${join(checkout, 'vendor')}")`);
    expect(generated).not.toContain('a\nb');
    expect(generated).not.toContain('\u009b');
  });

  // A child can put a link at its own grant, and the next child's profile is
  // written afresh: followed, it granted the link's target (decision 108).
  it('grants a link left at a grant as the link, never its target', () => {
    const holder = tempDir('pup-grant-holder-');
    const target = tempDir('pup-grant-target-');
    symlinkSync(target, join(holder, 'report'));

    const generated = readFileSync(
      writeProfile(tempDir('pup-profile-'), [join(holder, 'report')]),
      'utf8',
    );

    expect(generated).toContain(`(subpath "${join(holder, 'report')}")`);
    expect(generated).not.toContain(target);
  });

  // A failing vitest run removes its report directory before the re-run's
  // profile is written; named as given, `/var/...` never matched the kernel's
  // `/private/var/...`. A directory that is there resolves the same way.
  it.each([
    ['is gone', () => {}],
    ['is a directory', (path: string) => mkdirSync(path)],
  ])('grants a path that %s under its resolved parent', (_, make) => {
    const holder = tempDir('pup-grant-holder-');
    const unresolved = join(tmpdir(), basename(holder), 'report');
    make(unresolved);

    const generated = readFileSync(writeProfile(tempDir('pup-profile-'), [unresolved]), 'utf8');

    expect(generated).toContain(`(subpath "${join(holder, 'report')}")`);
  });

  // A nested package's cwd is `join(checkout, pkg.dir)`, and an earlier child
  // can make an outer segment of it a link to a directory holding the same
  // inner name: the parent is followed, so the grant was the link's target
  // (decision 180).
  it('refuses a grant whose resolved path leaves the root, writing no profile', () => {
    const checkout = tempDir('pup-checkout-');
    const elsewhere = tempDir('pup-main-checkout-');
    mkdirSync(join(elsewhere, 'packages', 'app'), { recursive: true });
    symlinkSync(join(elsewhere, 'packages'), join(checkout, 'packages'));
    const policyDir = tempDir('pup-profile-');

    expect(() =>
      writeProfile(policyDir, [join(checkout, 'packages', 'app')], [], [], checkout),
    ).toThrow(
      `Refusing to grant ${join(checkout, 'packages', 'app')}: it resolves to ${join(elsewhere, 'packages', 'app')}, outside ${checkout}.`,
    );
    expect(existsSync(join(policyDir, 'gate-child.sb'))).toBe(false);
  });

  it.each([
    ['the root itself', [] as string[]],
    ['a nested package under it', ['packages', 'app']],
  ])('grants %s, the root named unresolved', (_, segments) => {
    const checkout = tempDir('pup-checkout-');
    mkdirSync(join(checkout, ...segments), { recursive: true });
    const unresolved = join(tmpdir(), basename(checkout));

    const generated = readFileSync(
      writeProfile(tempDir('pup-profile-'), [join(unresolved, ...segments)], [], [], unresolved),
      'utf8',
    );

    expect(generated).toContain(`(subpath "${join(checkout, ...segments)}")`);
  });
});
