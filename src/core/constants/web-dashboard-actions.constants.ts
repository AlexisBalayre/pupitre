import type { ActionName } from '../types/web-dashboard-actions.types.js';

/** What the page can ask the server to do, each the core call its CLI command makes (decision 91). */
export const ACTIONS = [
  'answer',
  'tell',
  'steer',
  'launch',
  'kill',
  'merge',
  'fix',
  'land',
  'debt-close',
] as const;

/** The ones that cannot be taken back: the page asks before each runs (decision 91). */
export const CONFIRMED_ACTIONS = [
  'kill',
  'merge',
  'land',
  'debt-close',
] as const satisfies readonly ActionName[];
