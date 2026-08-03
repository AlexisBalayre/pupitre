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

/** Top-level SBPL rules: each starts with `(` at column 0, subpaths are indented. */
function rules(generated: string): string[] {
  return generated.split(/\n(?=\()/);
}

describe('sandboxProfile', () => {
  it('denies every write before granting the paths a gate needs', () => {
    // Order is the policy: the blanket deny lands first and the enumerated
    // paths override it. Denying only HOME left `/opt/homebrew/bin` — writable
    // on a standard install — open to a child that could then replace the `gh`
    // or `git` binary pup itself runs afterwards, unsandboxed.
    const generated = profile([`${HOME}/code/repo/.worktrees/s1`]);

    expect(generated).toContain('(allow default)');
    expect(generated.indexOf('(deny file-write*)')).toBeLessThan(
      generated.indexOf(`(allow file-write*\n  (subpath "${HOME}/code/repo/.worktrees/s1")`),
    );
  });

  it('grants exactly the enumerated allow list and nothing else', () => {
    // Decision 36's review deleted the profile-text test, leaving only runtime
    // proofs that specific paths are denied — an EXTRA grant quietly added to
    // the allow list would have passed every one of them. Exact equality over
    // the complete set of allow rules closes that: a new grant, a widened
    // subpath, or a second allow rule fails by construction.
    const allowRules = rules(profile(['/repo', '/reports'])).filter((rule) =>
      rule.startsWith('(allow'),
    );

    expect(allowRules).toEqual([
      '(allow default)',
      '(allow file-write*\n  (subpath "/repo")\n  (subpath "/reports")\n  (subpath "/dev"))',
    ]);
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

  it('escapes a path that would otherwise break out of the SBPL string', () => {
    const generated = profile([String.raw`/repo/a"b\c`]);

    expect(generated).toContain(String.raw`(subpath "/repo/a\"b\\c")`);
  });
});
