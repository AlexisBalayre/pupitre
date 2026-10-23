import { useEffect, useMemo } from 'react';
import { createTerminalStatus } from './terminal-status.manager.js';
import type { DashboardReading } from './use-snapshot.hook.js';

type StatusStream = { isTTY?: boolean; write: (chunk: string) => unknown };

/**
 * Keeps the terminal tab in step with the snapshot on screen (decision 97).
 * One writer lives for the component's life and its `stop` runs on unmount, so
 * every way out of `pup ui` — `q`, Ctrl-C, a SIGINT that unmounts — restores
 * the tab; a new reading only updates it.
 */
export function useTerminalStatus(
  reading: DashboardReading,
  stream: StatusStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const writer = useMemo(() => createTerminalStatus(stream, env), [stream, env]);
  useEffect(() => writer.stop, [writer]);
  useEffect(() => writer.update(reading), [writer, reading]);
}
