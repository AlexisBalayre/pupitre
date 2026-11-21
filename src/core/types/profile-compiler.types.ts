import type { GateCommand } from '../../adapters/types/adapter.types.js';
import type { CompileInput } from './profile.types.js';
import type { SessionPeer } from './session-lifecycle.types.js';

/** What a session's compile takes beyond the task: launch-time facts (decisions 96, 99). */
export type SessionCompileInput = CompileInput & {
  peers?: SessionPeer[];
  testCommand?: GateCommand;
};
