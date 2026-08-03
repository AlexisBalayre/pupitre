import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CACHE_VAR_SUBDIRS, gateChildEnv, parseGateEnv } from './gate-env.utils.js';

const CACHE_DIR = '/scratch/pup-toolchain-cache';
const SCRATCH_DIR = '/scratch/pup-gate-x';

/** The two arguments every case shares; only the source env and the flag vary. */
function childEnv(env: NodeJS.ProcessEnv, passthrough?: string[]): NodeJS.ProcessEnv {
  return gateChildEnv({
    cacheDir: CACHE_DIR,
    scratchDir: SCRATCH_DIR,
    env,
    ...(passthrough ? { passthrough } : {}),
  });
}

/** Every call redirects the cache vars, so the assertions below are about the rest. */
function withoutCacheVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  for (const name of [...Object.keys(CACHE_VAR_SUBDIRS), 'TMPDIR']) delete rest[name];
  return rest;
}

describe('gateChildEnv', () => {
  it('keeps the toolchain vars a build needs', () => {
    const env = childEnv({ PATH: '/usr/bin', HOME: '/home/dev', LANG: 'en_US.UTF-8' });

    expect(withoutCacheVars(env)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      LANG: 'en_US.UTF-8',
    });
  });

  it('drops secrets the operator happens to have exported', () => {
    const env = childEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-secret',
      GH_TOKEN: 'ghp-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });

    expect(withoutCacheVars(env)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops the GIT_DIR family, keeping the scrubbedGitEnv invariant', () => {
    const env = childEnv({ PATH: '/usr/bin', GIT_DIR: '/elsewhere/.git', GIT_INDEX_FILE: '/i' });

    expect(withoutCacheVars(env)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops NODE_OPTIONS, which could --require a module into every node it runs', () => {
    const env = childEnv({ PATH: '/usr/bin', NODE_OPTIONS: '--require /tmp/evil.js' });

    expect(withoutCacheVars(env)).toEqual({ PATH: '/usr/bin' });
  });

  it('adds the names the operator passed on the command line', () => {
    const env = childEnv(
      {
        PATH: '/usr/bin',
        DATABASE_URL: 'postgres://localhost/test',
        CI: 'true',
        OTHER: 'no',
      },
      ['DATABASE_URL', 'CI'],
    );

    expect(env).toMatchObject({ DATABASE_URL: 'postgres://localhost/test', CI: 'true' });
    expect(env.OTHER).toBeUndefined();
  });

  it('refuses to pass through the loader vars, whatever the operator asked for', () => {
    // These load attacker-chosen code into every process the child starts, so
    // the flag cannot hand back what decision 28 excluded NODE_OPTIONS for.
    const env = childEnv(
      {
        NODE_OPTIONS: '--require /tmp/evil.js',
        DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
        LD_PRELOAD: '/tmp/evil.so',
        CI: 'true',
      },
      ['NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'CI'],
    );

    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    // The ordinary name in the same list still comes through.
    expect(env.CI).toBe('true');
  });

  it('no longer honours PUP_GATE_ENV, whatever the ambient environment says', () => {
    // The variable was the escape hatch until decision 36; an .envrc, a CI job
    // or a shell wrapper could set it without the operator's command changing.
    const env = childEnv({
      PATH: '/usr/bin',
      PUP_GATE_ENV: 'DATABASE_URL',
      DATABASE_URL: 'postgres://leak',
    });

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PUP_GATE_ENV).toBeUndefined();
  });

  it('points every toolchain cache at the run scratch dir, away from a write-denied HOME', () => {
    const env = childEnv({
      HOME: '/home/dev',
      TMPDIR: '/home/dev/tmp',
      npm_config_cache: '/home/dev/.npm',
    });

    // TMPDIR is the run's own scratch, not the cache that outlives it.
    expect(env.TMPDIR).toBe(SCRATCH_DIR);
    expect(env.npm_config_cache).toBe(join(CACHE_DIR, 'npm'));
    expect(env.XDG_CACHE_HOME).toBe(join(CACHE_DIR, 'xdg-cache'));
    // HOME itself stays: dropping it breaks every toolchain (decision 28).
    expect(env.HOME).toBe('/home/dev');
  });

  it('redirects a cache var even when the operator passed its name through', () => {
    const env = childEnv({ npm_config_cache: '/home/dev/.npm' }, ['npm_config_cache']);

    expect(env.npm_config_cache).toBe(join(CACHE_DIR, 'npm'));
  });
});

describe('parseGateEnv', () => {
  it('reads a comma-separated list, ignoring spacing and empties', () => {
    expect(parseGateEnv('DATABASE_URL, CI ,')).toEqual(['DATABASE_URL', 'CI']);
  });

  it('is empty when the flag was not passed', () => {
    expect(parseGateEnv(undefined)).toEqual([]);
  });
});
