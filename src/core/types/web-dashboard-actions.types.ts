import type { ACTIONS, CONFIRMED_ACTIONS } from '../constants/web-dashboard-actions.constants.js';

export type ActionName = (typeof ACTIONS)[number];

export type ConfirmedAction = (typeof CONFIRMED_ACTIONS)[number];

export type ActionFields = Record<string, string>;
