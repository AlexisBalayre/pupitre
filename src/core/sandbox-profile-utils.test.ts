import { describe, expect, it } from 'vitest';
import { sandboxProfile } from './sandbox-profile.utils.js';

const HOME = '/Users/dev';

/**
 * Restated rather than imported from the module under test: a test that reads
 * the very list it is checking passes whatever that list happens to say, and
 * the point here is that removing a path from the policy fails a test.
 */
const CURATED_SECRET_PATHS =
  '.ssh .aws .config/gh .netrc .npmrc .gnupg .kube .docker/config.json Library/Keychains .pupitre';

function profile(writablePaths: string[] = ['/repo'], protectedPaths: string[] = []): string {
  return sandboxProfile({
    writablePaths,
    protectedPaths,
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
    expect(profile(['/repo', '/reports'])).toBe(
      [
        '(version 1)',
        '(allow default)',
        '(deny file-write*)',
        `(deny file-read*${CURATED_SECRET_PATHS.split(' ')
          .map((path) => `\n  (subpath "${HOME}/${path}")`)
          .join('')})`,
        '(allow file-write*\n  (subpath "/repo")\n  (subpath "/reports")\n  (subpath "/dev"))',
        `(deny file-write*\n  (subpath "${HOME}/.pupitre")\n  (subpath "/scratch/pup-sandbox-x"))`,
        String.raw`(deny file-write* (regex #"/\.git(/|$)"))`,
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

  it('denies .git by path match, after every allow, so nesting depth is irrelevant', () => {
    // `protectedPaths` names each grant's own .git and nothing deeper, which
    // is how #49's sibling-worktree attack reached `.worktrees/*/.git` pointer
    // files through a grant of the repo root. The regex matches the path
    // itself — directory or pointer file, at any depth — and sits last, where
    // SBPL's later-rule-wins ordering puts it above every allow.
    const generated = profile([`${HOME}/code/repo`]);
    const gitDeny = String.raw`(deny file-write* (regex #"/\.git(/|$)"))`;

    expect(generated).toContain(gitDeny);
    expect(generated.indexOf(gitDeny)).toBeGreaterThan(generated.indexOf('(allow file-write*'));
  });

  it('escapes a path that would otherwise break out of the SBPL string', () => {
    const generated = profile([String.raw`/repo/a"b\c`]);

    expect(generated).toContain(String.raw`(subpath "/repo/a\"b\\c")`);
  });
});
