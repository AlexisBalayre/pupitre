import { join } from 'node:path';
import { sanitizeReason } from '../../adapters/capability.utils.js';
import { shellWord } from '../shell-quote.utils.js';
import type { WorktreeConfigCause } from '../types/git-diff.types.js';

/** What a refusal over rewritten pointers asks the operator to do, unless its caller knows better. */
const REPAIR_ADVICE =
  'Restore them (`git -c worktree.useRelativePaths=false worktree repair` from the main ' +
  'checkout) and retry';

/**
 * Kept in its parts, so a caller that has already undone what `advice` would
 * fix (a launch that removed its new worktree) re-raises the same refusal with
 * advice of its own, rather than one message asking for both.
 */
export class WorktreeRepointedError extends Error {
  constructor(
    readonly worktreePath: string,
    readonly problem: string,
    advice: string = REPAIR_ADVICE,
  ) {
    super(
      `Refusing to run git in ${sanitizeReason(worktreePath)}: ${problem}. ${advice}, and ` +
        'treat the session that did it as compromised.',
    );
    this.name = 'WorktreeRepointedError';
  }
}

/**
 * The command that unsets every copy of `key` in the repo's `.git/config`, for
 * a refusal to ask the operator to paste. Pasted, the line must name the very
 * file: sanitizeReason folds runs of whitespace, blanks control chars and
 * truncates, so a path it changes is left for the operator to type rather than
 * printed as another file. `-C /`, because git opens the repo for nothing else
 * while the file holds a value it cannot read or a `core.worktree` it cannot
 * enter.
 */
function unsetCommand(repoPath: string, key: string): string {
  const raw = join(repoPath, '.git', 'config');
  return sanitizeReason(raw) === raw
    ? `\`git -C / config --file ${shellWord(raw)} --unset-all ${key}\``
    : `\`git -C / config --file <repo>/.git/config --unset-all ${key}\` ` +
        "with <repo> typed by hand, as the repo's path holds characters this message cannot " +
        'show as they are';
}

export class WorktreeConfigError extends Error {
  constructor(repoPath: string, cause: WorktreeConfigCause) {
    const dotGit = join(repoPath, '.git');
    const config = sanitizeReason(join(dotGit, 'config'));
    const problem =
      cause === 'file'
        ? `${sanitizeReason(join(dotGit, 'config.worktree'))} exists`
        : cause === 'on'
          ? `extensions.worktreeConfig is on in ${config}`
          : `extensions.worktreeConfig is on, or holds a value git cannot read, in ${config}`;
    const unset = unsetCommand(repoPath, 'extensions.worktreeConfig');
    // `disable` turns the extension back on, so the unset comes after it, and
    // again after it when git needed the unset first to open the repo at all.
    const steps =
      cause === 'unreadable'
        ? `${unset} first (\`-C /\`: git opens the repo for nothing else while the value is ` +
          'unreadable), then `git sparse-checkout disable` if the checkout is sparse and, as ' +
          'that turns the extension back on, the unset again'
        : `\`git sparse-checkout disable\` if the checkout is sparse, then ${unset}`;
    super(
      `Refusing to launch a session in ${sanitizeReason(repoPath)}: ${problem}. Usually ` +
        '`git sparse-checkout` or `git clone --sparse` turned per-worktree config on, and with ' +
        "it on a session's git would read a config.worktree the session can write (decision " +
        '101). If no sparse checkout ran here, a session may have written it: inspect ' +
        '.git/config and .git/config.worktree before removing anything, and treat a session ' +
        `that wrote them as compromised. Otherwise run ${steps}, remove .git/config.worktree, ` +
        'and retry.',
    );
    this.name = 'WorktreeConfigError';
  }
}

export class SharedWorktreeKeyError extends Error {
  constructor(repoPath: string) {
    const config = sanitizeReason(join(repoPath, '.git', 'config'));
    super(
      `Refusing to run the merge gate in ${sanitizeReason(repoPath)}: core.worktree is set in ` +
        `${config}, or git cannot read that file. Git takes the key from there alone, before ` +
        "any of pup's pins applies, and it moves the work tree every git run in the main " +
        'checkout reads, so the paths the gate lists would be those of another directory. ' +
        'A session can write the file from inside its sandbox and no diff shows it: inspect ' +
        'it, treat a session that set the key as compromised, then run ' +
        `${unsetCommand(repoPath, 'core.worktree')} and retry.`,
    );
    this.name = 'SharedWorktreeKeyError';
  }
}

/**
 * A `.git` git would follow to a repo a session chose (decision 172). Its own
 * class, so a catch that reads a failed git as "no such ref" can let it through.
 */
export class RewrittenGitDirError extends Error {
  constructor(cwd: string, problem: string) {
    super(
      `Refusing to run git in ${sanitizeReason(cwd)}: ${problem}. With it there, git reads ` +
        'every ref and the shared config from a repo the session chose, and a session can ' +
        "write the main checkout's .git from inside its sandbox (decision 172). Inspect it, " +
        'restore it, and treat the session that wrote it as compromised.',
    );
    this.name = 'RewrittenGitDirError';
  }
}

/** Armed surfaces named in a refusal before the count takes over. */
const ARMED_NAMES_SHOWN = 4;

export class ArmedGitDriverError extends Error {
  constructor(gitPath: string, armed: string[]) {
    const shown = armed.slice(0, ARMED_NAMES_SHOWN).join(', ');
    const rest = armed.length - ARMED_NAMES_SHOWN;
    super(
      `Refusing to run git in ${gitPath}: a filter or merge driver is armed, or a config ` +
        `include could arm one, and git would run it with your environment — ${shown}${rest > 0 ? ` +${rest} more` : ''}. ` +
        'These live in the untracked $GIT_COMMON_DIR, so no diff and no scope audit shows ' +
        'them. Clear them (`git config --unset <key>`, `rm .git/info/attributes`) and retry, ' +
        'and treat a session that wrote them as compromised.',
    );
    this.name = 'ArmedGitDriverError';
  }
}
