#!/usr/bin/env tsx
// Throwaway spike for the session runtime (docs/09-decisions.md, decisions 1-4).
// Validates, against a real `claude` in tmux:
//   1. launch with an isolated CLAUDE_CONFIG_DIR (no ~/.claude leakage, no onboarding/trust prompts)
//   2. hook events (PostToolUse/Stop/Notification) flow out as JSONL tagged with PUP_SESSION_ID
//   3. a message pasted mid-turn queues and is processed (steering)
//   4. the transcript JSONL is discoverable under the isolated config dir
// Run: pnpm exec tsx src/claude/runtime-spike.script.ts

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION = 'pup-spike';
const SESSION_ID = 'spike-001';
const READY_TIMEOUT_MS = 45_000;
const RUN_TIMEOUT_MS = 180_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8' });
}

function pasteMessage(text: string): void {
  execFileSync('tmux', ['load-buffer', '-'], { input: text });
  tmux('paste-buffer', '-d', '-t', SESSION);
  tmux('send-keys', '-t', SESSION, 'Enter');
}

function capturePane(): string {
  return tmux('capture-pane', '-p', '-t', SESSION);
}

function readEvents(eventsFile: string): { hook_event_name?: string; pup_session_id?: string }[] {
  if (!existsSync(eventsFile)) return [];
  return readFileSync(eventsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { hook_event_name?: string; pup_session_id?: string });
}

// --- workspace + isolated config ---------------------------------------------

// realpath everything: macOS tmpdir is a /var -> /private/var symlink, and the
// trust pre-seed is keyed by the resolved workspace path.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pup-spike-')));
const configDir = join(root, 'config');
const workspace = join(root, 'workspace');
const eventsFile = join(root, 'events.jsonl');
mkdirSync(configDir, { recursive: true });
mkdirSync(workspace, { recursive: true });

const hookScript = join(root, 'event-hook.sh');
writeFileSync(
  hookScript,
  `#!/bin/sh\njq -c --arg sid "\${PUP_SESSION_ID:-unknown}" '. + {pup_session_id: $sid}' >> "${eventsFile}"\n`,
);
chmodSync(hookScript, 0o755);

const hookEntry = [{ hooks: [{ type: 'command', command: hookScript, timeout: 10 }] }];
writeFileSync(
  join(configDir, 'settings.json'),
  JSON.stringify(
    {
      skipDangerousModePermissionPrompt: true,
      hooks: { PostToolUse: hookEntry, Stop: hookEntry, Notification: hookEntry },
    },
    null,
    2,
  ),
);

// Pre-seed global state so the isolated instance skips onboarding, the trust
// dialog, and the bypass-permissions confirmation. Key names are version-coupled
// (Claude Code 2.1.x) — exactly the coupling this spike exists to surface.
writeFileSync(
  join(configDir, '.claude.json'),
  JSON.stringify(
    {
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      projects: { [workspace]: { hasTrustDialogAccepted: true } },
    },
    null,
    2,
  ),
);

console.log(`spike root: ${root}`);

// --- 1. launch ----------------------------------------------------------------

try {
  tmux('kill-session', '-t', SESSION);
} catch {
  // no stale session — fine
}
// Run claude as the pane command directly — no interactive shell in between, so
// shell startup noise (oh-my-zsh prompts, rc files) can never eat keystrokes.
const claudeBin = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
tmux(
  'new-session',
  '-d',
  '-s',
  SESSION,
  '-x',
  '220',
  '-y',
  '50',
  '-c',
  workspace,
  '-e',
  `CLAUDE_CONFIG_DIR=${configDir}`,
  '-e',
  `PUP_SESSION_ID=${SESSION_ID}`,
  claudeBin,
  '--model',
  'haiku',
  '--dangerously-skip-permissions',
);

const readyDeadline = Date.now() + READY_TIMEOUT_MS;
let ready = false;
let preseedFallback = false;
while (Date.now() < readyDeadline) {
  const pane = capturePane();
  if (/\? for shortcuts|bypass permissions on/i.test(pane)) {
    ready = true;
    break;
  }
  if (/trust this folder|Is this a project you created/i.test(pane)) {
    preseedFallback = true;
    tmux('send-keys', '-t', SESSION, 'Enter');
  } else if (/Yes, I accept/i.test(pane)) {
    preseedFallback = true;
    tmux('send-keys', '-t', SESSION, '2');
  }
  await sleep(1000);
}
if (preseedFallback)
  console.log('NOTE: .claude.json pre-seed did not cover a prompt; fell back to keystrokes');
if (!ready) {
  console.log('NOT READY within timeout. Pane:');
  console.log(capturePane());
  process.exit(1);
}
console.log('1. launch: UI ready, no onboarding/trust prompts');

// --- 2 + 3. prompt, then steer mid-turn ---------------------------------------

pasteMessage(
  'Run this exact bash command: sleep 8 && echo "hello from pupitre spike". Then reply with exactly DONE-SPIKE and stop.',
);
await sleep(3000);
pasteMessage('STEER-CHECK: after finishing, also reply with the single word STEERED.');
console.log('prompt sent; steer message pasted mid-turn');

// --- wait for completion ------------------------------------------------------

const runDeadline = Date.now() + RUN_TIMEOUT_MS;
let stops = 0;
while (Date.now() < runDeadline) {
  stops = readEvents(eventsFile).filter((e) => e.hook_event_name === 'Stop').length;
  const pane = capturePane();
  if (stops >= 1 && /STEERED/.test(pane)) break;
  await sleep(2000);
}

// --- report -------------------------------------------------------------------

const events = readEvents(eventsFile);
const byType = new Map<string, number>();
for (const e of events) {
  const key = e.hook_event_name ?? 'unknown';
  byType.set(key, (byType.get(key) ?? 0) + 1);
}
const tagged = events.filter((e) => e.pup_session_id === SESSION_ID).length;

console.log('2. hook events:', JSON.stringify(Object.fromEntries(byType)));
console.log(`   tagged with PUP_SESSION_ID: ${tagged}/${events.length}`);

const pane = capturePane();
console.log(
  `3. steering: ${/STEERED/.test(pane) ? 'steered message processed' : 'STEERED not seen in pane'}`,
);

const projectsDir = join(configDir, 'projects');
let transcripts: string[] = [];
if (existsSync(projectsDir)) {
  transcripts = execFileSync('find', [projectsDir, '-name', '*.jsonl'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}
console.log(
  `4. transcripts under isolated config: ${transcripts.length ? transcripts.join(', ') : 'NONE FOUND'}`,
);

console.log('--- pane tail ---');
console.log(pane.trim().split('\n').slice(-12).join('\n'));

tmux('kill-session', '-t', SESSION);
console.log(`artifacts kept at: ${root}`);
