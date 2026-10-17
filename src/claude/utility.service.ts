import { execFileSync } from 'node:child_process';
import { UTILITY_ROUTE } from './model-ladder.constants.js';

// Gate-time Claude work is a one-shot `claude -p` call (decision 11): fixed
// prompt in, text out, no tools, no session state. Uses the operator's normal
// interactive login (decision 12) — never tokens or keys — on Haiku at low
// effort, named in the argv so the operator's own model setting never decides
// it (decision 92).

const UTILITY_TIMEOUT_MS = 120_000;

export interface UtilityResult {
  ok: boolean;
  output: string;
}

export function runUtility(prompt: string, timeoutMs = UTILITY_TIMEOUT_MS): UtilityResult {
  try {
    // Drafting works from the prompt alone; denying the write/exec tools keeps
    // the utility read-only even if the model tries to use one.
    const output = execFileSync(
      'claude',
      [
        '-p',
        prompt,
        '--model',
        UTILITY_ROUTE.model,
        '--effort',
        UTILITY_ROUTE.effort,
        '--disallowedTools',
        'Bash',
        'Edit',
        'Write',
        'NotebookEdit',
        'WebFetch',
      ],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { ok: true, output: output.trim() };
  } catch (error) {
    const failure = error as { message?: string };
    return { ok: false, output: failure.message ?? 'claude -p failed' };
  }
}
