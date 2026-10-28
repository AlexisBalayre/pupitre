import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/temp-dir.mock.js';
import { sandboxProfile, writeProfile } from './sandbox-profile.utils.js';

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
        `(deny file-write*\n  (subpath "${home}/.pupitre")\n  (subpath "${policyDir}")\n  (subpath "/x/checkout/.git"))`,
        String.raw`(deny file-write* (require-all (subpath "/x/checkout") (regex #"/\.git(/|$)")))`,
        '(deny file-write-unlink\n  (literal "/x/checkout")\n  (literal "/x/scratch")\n  (literal "/x")\n  (literal "/"))',
        '',
      ].join('\n'),
    );
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
  it('seals a directory the walk cannot read, and pins it and what leads to it', () => {
    const checkout = tempDir('pup-nested-');
    const hidden = join(checkout, 'a', '.worktrees');
    mkdirSync(join(hidden, 's1'), { recursive: true });
    writeFileSync(join(hidden, 's1', '.git'), 'gitdir: /x\n');
    chmodSync(hidden, 0o000);
    let generated: string;
    try {
      generated = readFileSync(writeProfile(tempDir('pup-profile-'), [checkout]), 'utf8');
    } finally {
      chmodSync(hidden, 0o755);
    }

    const pinned = [...generated.matchAll(/\(literal "([^"]*)"\)/g)].map(([, path = '']) => path);
    expect(pinned.filter((path) => path.startsWith(`${checkout}/`)).sort()).toEqual([
      join(checkout, 'a'),
      hidden,
    ]);
    expect(generated).toContain(`(subpath "${hidden}"))`);
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
});
