import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

interface TerminalSize {
  rows: number;
  columns: number;
}

const sizeOf = (stdout: NodeJS.WriteStream): TerminalSize => ({
  rows: stdout.rows ?? Number.POSITIVE_INFINITY,
  columns: stdout.columns ?? Number.POSITIVE_INFINITY,
});

/**
 * The terminal's height and width, re-read when it is resized so the frame
 * re-fits. A stream that is not a terminal has no size, and reads as unbounded:
 * there is nothing for a frame to overflow and no line to wrap (decision 121).
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => sizeOf(stdout));
  useEffect(() => {
    const onResize = () => setSize(sizeOf(stdout));
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}
