import { describe, expect, it } from 'vitest';
import { gateChildEnv } from './gate-env.utils.js';

describe('gateChildEnv', () => {
  it('keeps the toolchain vars a build needs', () => {
    const env = gateChildEnv({ PATH: '/usr/bin', HOME: '/home/dev', LANG: 'en_US.UTF-8' });

    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/dev', LANG: 'en_US.UTF-8' });
  });

  it('drops secrets the operator happens to have exported', () => {
    const env = gateChildEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-secret',
      GH_TOKEN: 'ghp-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });

    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('drops the GIT_DIR family, keeping the scrubbedGitEnv invariant', () => {
    const env = gateChildEnv({
      PATH: '/usr/bin',
      GIT_DIR: '/elsewhere/.git',
      GIT_INDEX_FILE: '/i',
    });

    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('drops NODE_OPTIONS, which could --require a module into every node it runs', () => {
    const env = gateChildEnv({ PATH: '/usr/bin', NODE_OPTIONS: '--require /tmp/evil.js' });

    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('adds the names the operator passed through', () => {
    const env = gateChildEnv({
      PATH: '/usr/bin',
      PUP_GATE_ENV: 'DATABASE_URL, CI',
      DATABASE_URL: 'postgres://localhost/test',
      CI: 'true',
      OTHER: 'no',
    });

    expect(env).toMatchObject({ DATABASE_URL: 'postgres://localhost/test', CI: 'true' });
    expect(env.OTHER).toBeUndefined();
    // The passthrough list itself is not a toolchain var and stays out.
    expect(env.PUP_GATE_ENV).toBeUndefined();
  });
});
