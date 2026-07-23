import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import { InvalidProfileError } from './profile.errors.js';
import { UnknownProfileError } from './profile-store.errors.js';
import { getProfileLayer, listProfileLayers } from './profile-store.service.js';

describe('profile store', () => {
  let profilesDir: string;
  beforeEach(() => {
    profilesDir = mkdtempSync(join(tmpdir(), 'pup-profiles-'));
  });

  it('lists only the built-in base when the profiles dir is empty or missing', () => {
    expect(listProfileLayers(profilesDir)).toEqual([DEFAULT_BASE_PROFILE]);
    expect(listProfileLayers(join(profilesDir, 'missing'))).toEqual([DEFAULT_BASE_PROFILE]);
  });

  it('lists on-disk layers after the built-in base', () => {
    writeFileSync(
      join(profilesDir, 'backend.yml'),
      'name: backend\nextends: base\ncontextBudget: 8000\n',
    );

    const layers = listProfileLayers(profilesDir);

    expect(layers.map((l) => l.name)).toEqual(['base', 'backend']);
    expect(layers[1]).toMatchObject({ extends: 'base', contextBudget: 8000 });
  });

  it('lets a base.yml on disk replace the built-in base', () => {
    writeFileSync(join(profilesDir, 'base.yml'), 'name: base\ncontextBudget: 9000\n');

    expect(listProfileLayers(profilesDir)).toEqual([{ name: 'base', contextBudget: 9000 }]);
    expect(getProfileLayer(profilesDir, 'base').contextBudget).toBe(9000);
  });

  it('shows a named on-disk layer', () => {
    writeFileSync(join(profilesDir, 'backend.yml'), 'name: backend\nskills:\n  - tdd\n');

    expect(getProfileLayer(profilesDir, 'backend')).toEqual({ name: 'backend', skills: ['tdd'] });
  });

  it('falls back to the built-in base for show when no base.yml exists', () => {
    expect(getProfileLayer(profilesDir, 'base')).toEqual(DEFAULT_BASE_PROFILE);
  });

  it('rejects an unknown layer name', () => {
    expect(() => getProfileLayer(profilesDir, 'nope')).toThrow(UnknownProfileError);
  });

  it('names the file when a layer is malformed YAML', () => {
    writeFileSync(join(profilesDir, 'broken.yml'), 'name: "unterminated\n');

    expect(() => listProfileLayers(profilesDir)).toThrow(InvalidProfileError);
    expect(() => getProfileLayer(profilesDir, 'broken')).toThrow(/broken\.yml/);
  });
});
