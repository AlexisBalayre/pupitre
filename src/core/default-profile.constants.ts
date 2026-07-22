import type { ProfileLayer } from './types/profile.types.js';

/** The always-applied base layer (docs/03-profiles.md). Kept small on purpose. */
export const DEFAULT_BASE_PROFILE: ProfileLayer = {
  name: 'base',
  conventions: [
    'Priority: correct > simple > readable > fast.',
    'No new abstraction until the third use. No new dependency without approval.',
    'Read 2-3 neighbouring files and match their patterns before writing.',
    'Delete replaced code; leave no shims or commented-out blocks.',
  ].join('\n'),
  contextBudget: 6000,
};
