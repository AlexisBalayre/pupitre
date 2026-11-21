/** The machine's 1-minute load average and the cores it is held to. */
export interface MachineLoad {
  average: number;
  cores: number;
  /** The project's `loadAllowanceFactor` the cores are multiplied by: set once by `launchRoom`, from the project's config. */
  factor: number;
}

/** The merge-lock work the project's sessions have ahead of them (decision 197). */
export interface LockBacklog {
  minutes: number;
  budgetMinutes: number;
  /** Gates and lands the working and unlanded sessions still need. */
  uses: number;
  /** The median gate run's time within its bounds, `UNTIMED_GATE_MS` while `gatesTimed` is 0. */
  gateMs: number;
  gatesTimed: number;
  /** The merged sessions counted for a land, for the operator to land or close a stale one. */
  unlanded: string[];
}

/** Both signals a launch is held to, as `pup status` prints them and `pup launch` reads them. */
export interface LaunchRoom {
  backlog: LockBacklog;
  load: MachineLoad;
}

/**
 * What holds a launch beside the two signals, which `--over-cap` does not
 * lift: the memory floor (decision 96) and the plan's usage hold (decision 156).
 */
export interface LaunchHolds {
  memoryBytes: number;
  usageHeld: boolean;
}
