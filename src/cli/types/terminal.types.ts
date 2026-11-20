export interface SessionStatus {
  status: string;
  indicator: string;
  detail: string;
}

export interface TerminalStatus {
  title: string;
  session: SessionStatus;
}

export interface TerminalSize {
  rows: number;
  columns: number;
}

export type StatusStream = { isTTY?: boolean; write: (chunk: string) => unknown };
