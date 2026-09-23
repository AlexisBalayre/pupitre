import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Context size comes from transcript JSONL usage fields, never pane scraping
// (decision 2). The newest assistant entry's input+cache tokens are what the
// model actually carried into its last turn.

interface TranscriptUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function newestTranscript(transcriptDir: string): string | undefined {
  try {
    const files = readdirSync(transcriptDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(transcriptDir, f));
    if (files.length === 0) return undefined;
    return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

/** Tokens in the session's current context window, or undefined when unknowable. */
export function latestContextTokens(transcriptDir: string): number | undefined {
  const transcript = newestTranscript(transcriptDir);
  if (!transcript) return undefined;
  let lines: string[];
  try {
    lines = readFileSync(transcript, 'utf8').trim().split('\n');
  } catch {
    // Same answer as a directory with no transcript in it, and for the same
    // reason: a reading that cannot be taken is unknown, not fatal. The
    // listing only matched a name, so `<anything>.jsonl` may be a directory
    // (EISDIR), a file whose mode changed since the stat, or a dangling
    // symlink — and every caller here is sweeping rows a session wrote, where
    // one unreadable file must not take the whole surface down.
    return undefined;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: string; message?: { usage?: TranscriptUsage } };
    try {
      entry = JSON.parse(lines[i] as string) as typeof entry;
    } catch {
      continue;
    }
    const usage = entry.type === 'assistant' ? entry.message?.usage : undefined;
    if (usage) {
      return (
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0)
      );
    }
  }
  return undefined;
}
