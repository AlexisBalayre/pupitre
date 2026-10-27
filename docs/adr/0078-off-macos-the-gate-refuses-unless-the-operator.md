# 0078. Off macOS the gate refuses unless the operator declares the VM as the sandbox (2026-10-06)

- Status: accepted
- Amends: [0036](0036-gate-children-run-inside-a-pup-generated-sandbox.md)

78. **Off macOS the gate refuses unless the operator declares the VM as the sandbox (2026-10-06).**
    From the Copiste grilling. Decision 36 let gate children run unconfined on any platform without
    `sandbox-exec` and printed `sandbox: none (unsupported platform)` in the gate report, the
    `pup init` line and the `pup audit` line. Nobody reads that line on a machine that already
    merged, so it was a silent absence after all. `sandboxMode` now has no `unsupported` mode. Off
    darwin it is `declared-vm`, labelled `vm (declared by operator)`, when `PUP_SANDBOX=vm` is in
    the environment of the pup process, and otherwise it throws one line naming the variable and
    saying the children would run unconfined. Any other value counts as unset. The variable is read
    from pup's own environment and never from the store or the repo, because a session can write
    both and must not be able to declare its own containment. `runMergeGate` and `initProject`
    (which `pup audit` runs) take the label before they spawn anything, so the refusal comes before
    any child, rebase or baseline stage; `runGateChild` hits the same throw, so no other caller
    runs a child bare either. The off-darwin answer is read on every call and not cached with the
    darwin probe: there is nothing to measure, only the operator's word. On darwin nothing changes:
    `sandbox-exec` is applied or inherited and the variable is ignored.
    *On review:* the declaration is handed to every gate child (`runGateChild` adds `PUP_SANDBOX`
    to the passthrough when pup itself runs in `declared-vm`), because the child is in the same VM
    — the Linux twin of darwin's `inherited`; without it pup gating itself would fail its own test
    stage, which reaches `sandboxLabel()`. A developer running `pnpm test` on bare Linux outside
    pup sets `PUP_SANDBOX=vm` in the shell; a vitest default waits for a Linux CI job. And the
    custom adapter lets `UndeclaredSandboxError` through unwrapped, so `pup map` refuses in pup's
    one line instead of blaming the operator's `depGraph` command.
