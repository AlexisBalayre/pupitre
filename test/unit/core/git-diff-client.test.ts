import { execFileSync } from 'node:child_process';
import { runGit } from '@src/core/git-diff.client.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/** How a push over HTTPS reaches its remote, which a spawned git inherits (decision 181). */
const HTTPS_VARS = [
  'GIT_SSL_CERT',
  'GIT_SSL_KEY',
  'GIT_SSL_CERT_PASSWORD_PROTECTED',
  'GIT_PROXY_SSL_CERT',
  'GIT_PROXY_SSL_KEY',
  'GIT_PROXY_SSL_CERT_PASSWORD_PROTECTED',
  'GIT_PROXY_SSL_CAINFO',
  'GIT_HTTP_PROXY_AUTHMETHOD',
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runGit's inherited env", () => {
  it('keeps what a push over HTTPS needs, and drops GIT_SSL_NO_VERIFY', () => {
    const repo = tempDir('pup-git-env-');
    execFileSync('git', ['init', '-q'], { cwd: repo, env: GIT_ENV });
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
    for (const name of HTTPS_VARS) vi.stubEnv(name, `kept-${name}`);
    vi.stubEnv('GIT_SSL_NO_VERIFY', '1');

    // What git hands its own children is what it was spawned with.
    const seen = runGit(repo, ['-c', 'alias.env=!env', 'env']);

    for (const name of HTTPS_VARS) expect(seen).toMatch(new RegExp(`^${name}=kept-${name}$`, 'm'));
    expect(seen).not.toMatch(/^GIT_SSL_NO_VERIFY=/m);
  });
});
