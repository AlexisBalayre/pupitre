import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readPlainFile } from '../adapters/capability.utils.js';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import { InvalidProfileError } from './profile.errors.js';
import { parseProfileLayer } from './profile-compiler.service.js';
import { UnknownProfileError } from './profile-store.errors.js';
import type { ProfileLayer } from './types/profile.types.js';

// Layer names come from the CLI; restricting them keeps `<name>.yml` inside profilesDir.
const LAYER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * A layer lives under `~/.pupitre/<project>/`, where a session can write, so it
 * is opened without following a link and read only when it is a regular file:
 * a layer swapped for a symlink would otherwise have pup read, and print in its
 * parse error, whatever the link points at (decision 194).
 */
function loadLayerFile(profilesDir: string, fileName: string): ProfileLayer {
  try {
    return parseProfileLayer(
      readPlainFile(join(profilesDir, fileName), { followLinks: false, soleLink: true }),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const linked = (error as NodeJS.ErrnoException).code === 'ELOOP';
    throw new InvalidProfileError(
      `${fileName}: ${linked ? 'is a symlink, which pup does not read a layer through' : detail}`,
    );
  }
}

/** All layers, built-in base first unless a base.yml on disk overrides it. */
export function listProfileLayers(profilesDir: string): ProfileLayer[] {
  const files = existsSync(profilesDir)
    ? readdirSync(profilesDir)
        .filter((f) => f.endsWith('.yml'))
        .sort()
    : [];
  const layers = files.map((f) => loadLayerFile(profilesDir, f));
  if (!files.includes('base.yml')) layers.unshift(DEFAULT_BASE_PROFILE);
  return layers;
}

export function getProfileLayer(profilesDir: string, name: string): ProfileLayer {
  // lstat, not exists: a dangling link must reach the refusal, not fall back to the built-in base.
  if (
    LAYER_NAME.test(name) &&
    lstatSync(join(profilesDir, `${name}.yml`), { throwIfNoEntry: false })
  ) {
    return loadLayerFile(profilesDir, `${name}.yml`);
  }
  if (name === DEFAULT_BASE_PROFILE.name) return DEFAULT_BASE_PROFILE;
  throw new UnknownProfileError(name, profilesDir);
}
