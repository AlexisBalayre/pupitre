import type { machineLoad } from '../session-cap.service.js';
import type { ChartDatum } from './chart.types.js';
import type { DashboardNeed, DashboardSnapshot } from './dashboard.types.js';

/** The machine's load as `pup launch` reads it. */
export type MachineLoad = ReturnType<typeof machineLoad>;

/** One open ledger entry as the page lists it, every field already through `sanitizeReason`. */
export interface WebDebtEntry {
  id: string;
  description: string;
}

/** One figure tile: what it counts, the figure, how it moved over a week, and its captures. */
export interface FigureTile {
  label: string;
  figure: string;
  change: string;
  trend: ChartDatum[];
  format: (value: number) => string;
}

/** What one render of the Overview reads (decision 98). */
export interface OverviewView {
  snapshot: DashboardSnapshot;
  needs: DashboardNeed[];
  openDebt: WebDebtEntry[];
  /** Fix rounds re-gated per session with an open PR, keyed by session id (decision 86). */
  fixRounds: Map<string, number>;
  /** The brief's Destination, or the one line that says why there is none. */
  goal: { text: string } | { hint: string };
  tiles: FigureTile[];
  tasks: { done: number; inFlight: number; planned: number };
  merges: ChartDatum[];
  /** `pup status`'s launch verdict, with the load it was read at. */
  launch: string;
}
