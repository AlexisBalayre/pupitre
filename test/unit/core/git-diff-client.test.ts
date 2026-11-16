import { execFileSync } from 'node:child_process';
import { runGit } from '@src/core/git-diff.client.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runGit's inherited env", () => {
  // How a push over HTTPS reaches its remote is the operator's (decision 181).
  it('keeps the client certificate and proxy a push over HTTPS needs, and drops GIT_SSL_NO_VERIFY', () => {
    const repo = tempDir('pup-git-env-');
    execFileSync('git', ['init', '-q'], { cwd: repo, env: GIT_ENV });
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
    vi.stubEnv('GIT_SSL_CERT', '/operator/cert.pem');
    vi.stubEnv('GIT_PROXY_SSL_KEY', '/operator/proxy-key.pem');
    vi.stubEnv('GIT_HTTP_PROXY_AUTHMETHOD', 'negotiate');
    vi.stubEnv('GIT_SSL_NO_VERIFY', '1');

    // What git hands its own children is what it was spawned with.
    const seen = runGit(repo, ['-c', 'alias.env=!env', 'env']);

    expect(seen).toMatch(/^GIT_SSL_CERT=\/operator\/cert\.pem$/m);
    expect(seen).toMatch(/^GIT_PROXY_SSL_KEY=\/operator\/proxy-key\.pem$/m);
    expect(seen).toMatch(/^GIT_HTTP_PROXY_AUTHMETHOD=negotiate$/m);
    expect(seen).not.toMatch(/^GIT_SSL_NO_VERIFY=/m);
  });
});
