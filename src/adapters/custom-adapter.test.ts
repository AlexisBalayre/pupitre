import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localContext } from './capability.utils.js';
import { loadCustomAdapter } from './custom.adapter.js';
import { CustomAdapterCommandError, CustomAdapterConfigError } from './custom-adapter.errors.js';

function makeRepo(adapterYml?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-custom-')));
  if (adapterYml !== undefined) {
    mkdirSync(join(dir, '.pupitre'));
    writeFileSync(join(dir, '.pupitre', 'adapter.yml'), adapterYml);
  }
  return dir;
}

describe('loadCustomAdapter', () => {
  it('returns undefined when the repo has no .pupitre/adapter.yml', () => {
    expect(loadCustomAdapter(makeRepo())).toBeUndefined();
  });

  it('maps configured gate stages to sh -c commands and omits the rest', () => {
    const adapter = loadCustomAdapter(makeRepo('id: exotic\nbuild: make build\nlint: make lint\n'));

    expect(adapter?.id).toBe('exotic');
    expect(adapter?.gateCommands('unused')).toEqual([
      { stage: 'build', command: 'sh', args: ['-c', 'make build'] },
      { stage: 'lint', command: 'sh', args: ['-c', 'make lint'] },
    ]);
  });

  it('rejects unknown keys so a typo cannot silently drop a stage', () => {
    expect(() => loadCustomAdapter(makeRepo('biuld: make\n'))).toThrow(CustomAdapterConfigError);
  });

  it('rejects non-string values', () => {
    expect(() => loadCustomAdapter(makeRepo('build:\n  cmd: make\n'))).toThrow(
      CustomAdapterConfigError,
    );
  });

  it("parses a capability command's stdout as JSON", () => {
    const repo = makeRepo(`deadCode: echo '[{"file":"src/a.ex","exportName":"orphan"}]'\n`);

    const adapter = loadCustomAdapter(repo);

    expect(adapter?.deadCode?.(localContext(repo))).toEqual([
      { file: 'src/a.ex', exportName: 'orphan' },
    ]);
  });

  it('feeds complexity the file list as JSON on stdin', () => {
    // `cat` echoes stdin back, proving the contract end to end.
    const repo = makeRepo('complexity: cat\n');

    const adapter = loadCustomAdapter(repo);

    expect(adapter?.complexity?.(localContext(repo), ['a.ex', 'b.ex'])).toEqual(['a.ex', 'b.ex']);
  });

  it('throws a named error when a capability command emits invalid JSON', () => {
    const repo = makeRepo('deadCode: echo not-json\n');

    expect(() => loadCustomAdapter(repo)?.deadCode?.(localContext(repo))).toThrow(
      CustomAdapterCommandError,
    );
  });

  it('throws a named error when a capability command fails', () => {
    const repo = makeRepo('deadCode: exit 3\n');

    expect(() => loadCustomAdapter(repo)?.deadCode?.(localContext(repo))).toThrow(
      CustomAdapterCommandError,
    );
  });

  it('rejects a capability result whose JSON is the wrong shape', () => {
    // `{"unavailable": …}` now means "stage skipped" to the gate, so a command
    // measuring session code must not be able to produce one; `null` used to
    // throw inside the gate's type guard.
    for (const stdout of ['{"unavailable":"nothing to see"}', 'null', '"a string"']) {
      const repo = makeRepo(`deadCode: echo '${stdout}'\n`);

      expect(() => loadCustomAdapter(repo)?.deadCode?.(localContext(repo))).toThrow(
        CustomAdapterCommandError,
      );
    }
  });

  it('degrades a failing coverage command to unavailable, naming the failure', () => {
    const repo = makeRepo('coverage: echo boom >&2; exit 1\n');

    const result = loadCustomAdapter(repo)?.coverage?.(localContext(repo));

    expect(result).toEqual({ unavailable: expect.stringContaining('coverage command failed') });
    expect(result).toEqual({ unavailable: expect.stringContaining('boom') });
  });

  it('scrubs the GIT_DIR family from capability command environments', () => {
    // When pup runs inside a git hook, an inherited GIT_DIR would misdirect any
    // git usage in the command at the hook's repo (same rationale as the gate).
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion inside a yaml fixture, not a JS template
    const repo = makeRepo('deadCode: echo "[\\"${GIT_DIR:-scrubbed}\\"]"\n');
    process.env.GIT_DIR = '/somewhere/.git';
    try {
      expect(loadCustomAdapter(repo)?.deadCode?.(localContext(repo))).toEqual(['scrubbed']);
    } finally {
      delete process.env.GIT_DIR;
    }
  });
});
