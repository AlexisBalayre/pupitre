import { execFileSync } from 'node:child_process';
import { UTILITY_ROUTE } from './model-ladder.constants.js';

// Gate-time Claude work is a one-shot `claude -p` call (decision 11): fixed
// prompt in, text out, no tools, no session state. Uses the operator's normal
// interactive login (decision 12) — never tokens or keys — on Haiku at low
// effort, named in the argv so the operator's own model setting never decides
// it (decision 92).

const UTILITY_TIMEOUT_MS = 120_000;

// Drafting works from the prompt alone, so the request carries nothing else.
// Claude Code caches up to the system prompt and then to the end of the first
// user message, and it puts CLAUDE.md, git status, the date and the tool, skill
// and agent listings in that message ahead of the prompt: one varying prompt
// re-wrote all of them on every call. With no tools (which also keeps the
// utility read-only), no MCP servers, no customizations and no git
// instructions, the cached system prompt is most of each call. Measured on
// `claude` 2.1.322 in the repo: cache hit 53% of ~22.2k tokens, now 78% of ~3.1k.
const UTILITY_FLAGS = ['--tools', '', '--strict-mcp-config', '--safe-mode'];
const UTILITY_ENV = { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' };

export interface UtilityResult {
  ok: boolean;
  output: string;
}

export function runUtility(prompt: string, timeoutMs = UTILITY_TIMEOUT_MS): UtilityResult {
  try {
    const output = execFileSync(
      'claude',
      [
        '-p',
        prompt,
        '--model',
        UTILITY_ROUTE.model,
        '--effort',
        UTILITY_ROUTE.effort,
        ...UTILITY_FLAGS,
      ],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...UTILITY_ENV },
      },
    );
    return { ok: true, output: output.trim() };
  } catch (error) {
    const failure = error as { message?: string };
    return { ok: false, output: failure.message ?? 'claude -p failed' };
  }
}
