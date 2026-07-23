import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import { InvalidProfileError } from './profile.errors.js';
import { parseProfileLayer } from './profile-compiler.service.js';
import { UnknownProfileError } from './profile-store.errors.js';
import type { ProfileLayer } from './types/profile.types.js';

// Layer names come from the CLI; restricting them keeps `<name>.yml` inside profilesDir.
const LAYER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function loadLayerFile(profilesDir: string, fileName: string): ProfileLayer {
  const text = readFileSync(join(profilesDir, fileName), 'utf8');
  try {
    return parseProfileLayer(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidProfileError(`${fileName}: ${detail}`);
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
  if (LAYER_NAME.test(name) && existsSync(join(profilesDir, `${name}.yml`))) {
    return loadLayerFile(profilesDir, `${name}.yml`);
  }
  if (name === DEFAULT_BASE_PROFILE.name) return DEFAULT_BASE_PROFILE;
  throw new UnknownProfileError(name, profilesDir);
}
