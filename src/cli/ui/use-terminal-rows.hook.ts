import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

/**
 * The terminal's height, re-read when it is resized so the frame re-fits. A
 * stream that is not a terminal has no height, and reads as unbounded: there is
 * nothing for a frame to overflow (decision 121).
 */
export function useTerminalRows(): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows ?? Number.POSITIVE_INFINITY);
  useEffect(() => {
    const onResize = () => setRows(stdout.rows ?? Number.POSITIVE_INFINITY);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return rows;
}
