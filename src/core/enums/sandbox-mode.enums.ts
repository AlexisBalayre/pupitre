/**
 * `applied` — pup wrapped the child in its own profile. `inherited` — pup is
 * itself sandboxed, so the child runs under *that* profile (see `sandboxMode`).
 * `declared-vm` — no mechanism on this platform, and the operator said the
 * machine pup runs on is the disposable boundary (see `declaredMode`).
 */
export enum SandboxMode {
  Applied = 'applied',
  Inherited = 'inherited',
  DeclaredVm = 'declared-vm',
}
