import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { makeInput } from '@test/helpers/profile-compiler.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOOK_TIMEOUT_SECONDS } from './profile.constants.js';
import * as ProfileCompiler from './profile-compiler.service.js';

// Many tests here spawn real git and sh; under load or coverage the 5 s default
// times out a different one each run, which also stops `pup audit` measuring coverage.
vi.setConfig({ testTimeout: 30_000 });

// Decision 99: a worker takes main in by merging it, with real git in a linked
// worktree, as a session's is.
describe('generated hooks over a merge of the target', () => {
  const GIT_ENV: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  let root: string;
  let repo: string;
  let worktree: string;
  let events: string;

  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });

  function commit(cwd: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'change');
  }

  /**
   * main and a session branch forked from it, each committing its own files on
   * top, and the session's profile compiled for its worktree. Both change
   * `src/net/client.ts`, in scope, so `git merge main` stops on a conflict with
   * main's other files staged beside it.
   */
  function fork(branchFiles: Record<string, string>, mainFiles: Record<string, string>): void {
    commit(worktree, { 'src/net/client.ts': 'branch\n', ...branchFiles });
    commit(repo, { 'src/net/client.ts': 'main\n', ...mainFiles });
    const outDir = join(root, 'compiled');
    const compiled = ProfileCompiler.compileProfile(
      makeInput({ repoPath: repo, worktreePath: worktree, eventsFile: events, outDir }),
    );
    ProfileCompiler.writeCompiledProfile(compiled, outDir);
  }

  beforeEach(() => {
    root = tempDir('pup-merge-hooks-');
    repo = join(root, 'repo');
    worktree = join(repo, '.worktrees', 's-1');
    events = join(root, 'events.jsonl');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');
    commit(repo, {
      '.gitignore': '.worktrees/\n',
      'src/net/client.ts': 'base\n',
      'src/cli/index.ts': 'base\n',
      'src/cli/decoy.ts': 'one\ntwo\n',
    });
    git(repo, 'worktree', 'add', '-q', '-b', 'pup/s-1', worktree, 'main');
  });

  function runScript(
    script: string,
    payload: object,
    env: NodeJS.ProcessEnv = {},
    timeout = 4_000,
  ) {
    return spawnSync('/bin/sh', [join(root, 'compiled/hooks', script)], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout,
      env: { ...GIT_ENV, PUP_SESSION_ID: 's-1', ...env },
    });
  }

  /** The Bash call as Claude Code runs it: the pre hook, the command, the post hook. */
  function bash(command: string) {
    const payload = (phase: string) => ({
      hook_event_name: phase,
      tool_use_id: 'toolu_01merge',
      tool_input: { command },
    });
    expect(runScript('bash-recheck.sh', payload('PreToolUse')).status).toBe(0);
    spawnSync('sh', ['-c', command], { cwd: worktree, env: GIT_ENV });
    return runScript('bash-recheck.sh', payload('PostToolUse'));
  }

  function edit(path: string, oldString: string, newString: string, tool = 'Edit') {
    return runScript('scope-enforce.sh', {
      tool_name: tool,
      tool_input: {
        file_path: join(worktree, path),
        ...(tool === 'Edit'
          ? { old_string: oldString, new_string: newString }
          : { content: newString }),
      },
    });
  }

  function violations(): string[] {
    if (!existsSync(events)) return [];
    return readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, string>)
      .filter((event) => event.type === 'scope_violation')
      .map((event) => `${event.path} ${event.reason}`);
  }

  it("passes a merge of main whose conflicts stop it with main's out-of-scope files staged", () => {
    fork({}, { 'src/cli/index.ts': 'main\n', 'src/net/legacy/old.ts': 'main\n' });

    const merge = bash('git merge main');

    // What the re-check reads: main's files staged, out of scope, mid-merge.
    expect(git(worktree, 'status', '--porcelain').stdout).toContain('M  src/cli/index.ts');
    expect(merge.stderr).toBe('');
    expect(merge.status).toBe(0);
    expect(violations()).toEqual([]);
    expect(edit('src/net/client.ts', 'branch', 'resolved').status).toBe(0);
    expect(
      bash('printf "resolved\\n" > src/net/client.ts && git add -A && git commit -q --no-edit')
        .status,
    ).toBe(0);
    expect(violations()).toEqual([]);
  });

  it('still refuses a write to an out-of-scope file once main is merged in', () => {
    fork({}, { 'src/cli/index.ts': 'main\n' });
    bash('git merge main');

    expect(edit('src/cli/index.ts', 'main', 'evil').status).toBe(2);
    expect(edit('src/cli/index.ts', 'main', 'evil', 'Write').status).toBe(2);
    expect(bash('printf "evil\\n" > src/cli/index.ts').status).toBe(2);
    expect(violations()).toEqual(['src/cli/index.ts outside-scope-in']);
  });

  // Four runs of the generated re-check, each some fifty forks (jq, two git
  // statuses, a diff, a hash per dirty path, a watcher and a sleep per bounded
  // read), around a real merge and the eight git calls that plant the replace:
  // under 2 s idle, past vitest's default 5 s once the load passes the cores.
  it('reads the merged tip through no replace ref a session planted', () => {
    fork({}, { 'src/cli/index.ts': 'main\n' });
    bash('git merge main');
    // A commit like the tip but holding the session's own index.ts, swapped in
    // for the tip by `git replace` in the shared ref store.
    const evilIndex = join(root, 'evil-index');
    spawnSync(
      'sh',
      [
        '-c',
        'b=$(printf "evil\\n" | git hash-object -w --stdin) && ' +
          `GIT_INDEX_FILE='${evilIndex}' git read-tree main && ` +
          `GIT_INDEX_FILE='${evilIndex}' git update-index --cacheinfo 100644,$b,src/cli/index.ts && ` +
          `t=$(GIT_INDEX_FILE='${evilIndex}' git write-tree) && ` +
          'git replace "$(git rev-parse main)" "$(git commit-tree "$t" -p main~1 -m e)"',
      ],
      { cwd: repo, env: GIT_ENV },
    );
    expect(git(repo, 'cat-file', '-p', 'main:src/cli/index.ts').stdout).toBe('evil\n');

    expect(bash('printf "evil\\n" > src/cli/index.ts').status).toBe(2);
    expect(violations()).toEqual(['src/cli/index.ts outside-scope-in']);
  }, 20_000);

  it('refuses an Edit over marker lines whose conflict was staged by hand', () => {
    const markers = '<<<<<<< a\nkeep\n=======\ngate()\n>>>>>>> b';
    fork({ 'src/cli/decoy.ts': `${markers}\n` }, { 'src/cli/index.ts': 'main\n' });
    // No merge ran: MERGE_HEAD is written by hand and the file given all three
    // stages at the blob it already holds.
    spawnSync(
      'sh',
      [
        '-c',
        'git rev-parse main > "$(git rev-parse --git-path MERGE_HEAD)" && ' +
          'b=$(git rev-parse HEAD:src/cli/decoy.ts) && ' +
          'printf "0 0000000000000000000000000000000000000000\\tsrc/cli/decoy.ts\\n' +
          '100644 $b 1\\tsrc/cli/decoy.ts\\n100644 $b 2\\tsrc/cli/decoy.ts\\n' +
          '100644 $b 3\\tsrc/cli/decoy.ts\\n" | git update-index --index-info',
      ],
      { cwd: worktree, env: GIT_ENV },
    );
    expect(git(worktree, 'ls-files', '-u').stdout.trim().split('\n')).toHaveLength(3);

    expect(edit('src/cli/decoy.ts', markers, 'keep').status).toBe(2);
  });

  it('allows resolving a conflict main left in a scope-out file, and nothing else there', () => {
    fork({ 'src/net/legacy/old.ts': 'branch\n' }, { 'src/net/legacy/old.ts': 'main\n' });
    bash('git merge main');
    const conflict = '<<<<<<< HEAD\nbranch\n=======\nmain\n>>>>>>> main';

    expect(edit('src/net/legacy/old.ts', conflict, 'main').status).toBe(0);
    expect(edit('src/net/legacy/old.ts', conflict, 'other').status).toBe(2);
  });

  it('reads no MERGE_HEAD a worktree planted in the shared refs', () => {
    fork({}, { 'src/cli/index.ts': 'main\n' });
    // No merge runs here; any worktree can write a ref by that name.
    git(repo, 'update-ref', 'refs/heads/MERGE_HEAD', 'main');
    git(repo, 'tag', 'MERGE_HEAD', 'main');

    expect(bash('printf "main\\n" > src/cli/index.ts').status).toBe(2);
    expect(violations()).toEqual(['src/cli/index.ts outside-scope-in']);
  });

  it('allows one whole block only, never a span of blocks and the code between', () => {
    const lines = (tag: string) => `a ${tag}\nx1\nx2\nx3\nx4\nx5\nx6\nx7\nb ${tag}\n`;
    fork({ 'src/cli/decoy.ts': lines('branch') }, { 'src/cli/decoy.ts': lines('main') });
    bash('git merge main');
    const text = readFileSync(join(worktree, 'src/cli/decoy.ts'), 'utf8');
    expect(text.match(/^<<<<<<< /gm)).toHaveLength(2);
    const span = text.slice(text.indexOf('<<<<<<<'));

    expect(edit('src/cli/decoy.ts', span, 'a main\n').status).toBe(2);
    expect(edit('src/cli/decoy.ts', span, '').status).toBe(2);
    expect(edit('src/cli/decoy.ts', span.slice(0, span.indexOf('x1')), 'a main\n').status).toBe(0);
  });

  it('reads a marker line ending in a CR as a marker', () => {
    fork(
      { 'src/cli/decoy.ts': 'one branch\r\ntwo\r\n' },
      { 'src/cli/decoy.ts': 'one main\r\ntwo\r\n' },
    );
    bash('git merge main');
    const text = readFileSync(join(worktree, 'src/cli/decoy.ts'), 'utf8');
    const crlfBlock = text.slice(0, text.indexOf('two'));
    expect(crlfBlock).toContain('one main\r\n');
    // A side carrying a separator of its own, typed with a CR.
    const forged = crlfBlock.replace('one main\r\n', 'one main\r\n=======\r\n');

    expect(edit('src/cli/decoy.ts', crlfBlock, 'one main\r\n').status).toBe(0);
    expect(edit('src/cli/decoy.ts', crlfBlock, 'one main\r\n=======\r\n').status).toBe(2);
    expect(edit('src/cli/decoy.ts', forged, 'one main\r\n=======\r\n').status).toBe(2);
  });

  describe('a conflict main left in an out-of-scope file', () => {
    const block = '<<<<<<< HEAD\none branch\n=======\none main\n>>>>>>> main';

    beforeEach(() => {
      fork({ 'src/cli/decoy.ts': 'one branch\ntwo\n' }, { 'src/cli/decoy.ts': 'one main\ntwo\n' });
    });

    it('allows an Edit that keeps one side, the other, or ours then theirs', () => {
      bash('git merge main');
      expect(readFileSync(join(worktree, 'src/cli/decoy.ts'), 'utf8')).toContain(block);

      expect(edit('src/cli/decoy.ts', block, 'one main').status).toBe(0);
      expect(edit('src/cli/decoy.ts', block, 'one branch').status).toBe(0);
      expect(edit('src/cli/decoy.ts', block, 'one branch\none main').status).toBe(0);
      expect(edit('src/cli/decoy.ts', `${block}\n`, 'one main\n').status).toBe(0);
    });

    it('refuses an Edit that writes a line of its own, reorders, leaves a marker, or is a Write', () => {
      bash('git merge main');

      expect(edit('src/cli/decoy.ts', block, 'one main\nevil()').status).toBe(2);
      expect(edit('src/cli/decoy.ts', block, 'one main\none branch').status).toBe(2);
      expect(edit('src/cli/decoy.ts', block, 'one main\none main').status).toBe(2);
      expect(edit('src/cli/decoy.ts', block, 'one main\n=======').status).toBe(2);
      // Without its final newline, an emptied block would leave a blank line.
      expect(edit('src/cli/decoy.ts', block, '').status).toBe(2);
      expect(edit('src/cli/decoy.ts', `${block}\n`, 'one main').status).toBe(2);
      expect(edit('src/cli/decoy.ts', 'two', 'two').status).toBe(2);
      expect(edit('src/cli/decoy.ts', block, 'one main', 'Write').status).toBe(2);
    });

    it('reads no further than an object id into a MERGE_HEAD the session grew', () => {
      bash('git merge main');
      const headFile = git(
        worktree,
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'MERGE_HEAD',
      ).stdout.trim();
      writeFileSync(headFile, '');
      truncateSync(headFile, 2 ** 31);

      expect(edit('src/cli/decoy.ts', block, 'one main').status).toBe(2);
      expect(bash('printf "evil\\n" > src/cli/index.ts').status).toBe(2);
    });

    /**
     * The resolving Edit's scope hook, timed. The test's own timeout sits well past
     * the hook's, so a hook that blocks reads as a slow or null status rather than
     * as the test's kill passing for a refusal (decision 124).
     */
    function timedResolvingEdit(env: NodeJS.ProcessEnv = {}) {
      const started = Date.now();
      const result = runScript(
        'scope-enforce.sh',
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: join(worktree, 'src/cli/decoy.ts'),
            old_string: block,
            new_string: 'one main',
          },
        },
        env,
        15_000,
      );
      return { ...result, elapsed: Date.now() - started };
    }

    // The swap lands between the hook's `-f` test and its read: a head on the
    // hook's PATH turns MERGE_HEAD into a fifo, then reads it as the real one.
    it('refuses the resolving Edit within the hook timeout once MERGE_HEAD turns into a fifo mid-check', () => {
      bash('git merge main');
      expect(timedResolvingEdit().status).toBe(0);
      const headFile = git(
        worktree,
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'MERGE_HEAD',
      ).stdout.trim();
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const realHead = spawnSync('/bin/sh', ['-c', 'command -v head'], { encoding: 'utf8' });
      writeFileSync(
        join(bin, 'head'),
        `#!/bin/sh\nfor arg; do last=$arg; done\nif [ "$last" = '${headFile}' ]; then rm -f "$last" && mkfifo "$last"; fi\nexec ${realHead.stdout.trim()} "$@"\n`,
        { mode: 0o755 },
      );

      const result = timedResolvingEdit({ PATH: `${bin}:${process.env.PATH}` });
      expect(lstatSync(headFile).isFIFO()).toBe(true);
      expect(result.status).toBe(2);
      expect(result.elapsed).toBeLessThan(HOOK_TIMEOUT_SECONDS * 1000);
      expect(result.stderr).toContain('outran the hook deadline');
    }, 30_000);

    // The shared config is the session's to write (decision 41's exposure), and
    // git opens what an include names before it runs any command.
    it('refuses the resolving Edit within the hook timeout while the repo config includes a fifo', () => {
      bash('git merge main');
      const fifo = join(root, 'included');
      spawnSync('mkfifo', [fifo]);
      git(repo, 'config', 'include.path', fifo);

      const result = timedResolvingEdit();
      expect(result.status).toBe(2);
      expect(result.elapsed).toBeLessThan(HOOK_TIMEOUT_SECONDS * 1000);
    }, 30_000);

    // The hook runs outside the sandbox, the gitfile is writable inside it, and
    // git that followed it would read another repo's config (decision 101).
    it('refuses the resolving Edit once the gitfile names another repo', () => {
      bash('git merge main');
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      git(elsewhere, 'init', '-q');
      writeFileSync(join(worktree, '.git'), `gitdir: ${join(elsewhere, '.git')}\n`);

      const result = edit('src/cli/decoy.ts', block, 'one main');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('or its commondir no longer names');
    });

    // Ten hook runs and two merges, each hook with its pointer check: well past
    // vitest's default under a full parallel run.
    it('refuses the same Edit once the file is resolved, or over a merge of anything but the tip', () => {
      bash('git merge main');
      bash('git add src/cli/decoy.ts');
      expect(edit('src/cli/decoy.ts', block, 'one main').status).toBe(2);

      bash('git merge --abort');
      git(repo, 'branch', 'side', 'main');
      commit(repo, { 'src/net/other.ts': 'moved on\n' });
      bash('git merge side');
      expect(readFileSync(join(worktree, 'src/cli/decoy.ts'), 'utf8')).toContain('<<<<<<< HEAD');
      expect(
        edit('src/cli/decoy.ts', block.replace('>>>>>>> main', '>>>>>>> side'), 'one main').status,
      ).toBe(2);
    }, 20_000);
  });
});
