import { describe, expect, it } from 'vitest';
import { originRepoSlug } from './github.client.js';

describe('originRepoSlug', () => {
  it('parses scp-style ssh remotes', () => {
    expect(originRepoSlug('git@github.com:owner/repo.git')).toBe('github.com/owner/repo');
  });

  it('parses https remotes with and without .git', () => {
    expect(originRepoSlug('https://github.com/owner/repo.git')).toBe('github.com/owner/repo');
    expect(originRepoSlug('https://ghe.example.com/owner/repo')).toBe('ghe.example.com/owner/repo');
  });

  it('parses ssh:// remotes', () => {
    expect(originRepoSlug('ssh://git@github.com/owner/repo.git')).toBe('github.com/owner/repo');
  });

  it('rejects remotes it cannot pin to a host repo, like local paths', () => {
    expect(() => originRepoSlug('/tmp/some/bare/repo')).toThrow('Cannot derive');
  });
});
