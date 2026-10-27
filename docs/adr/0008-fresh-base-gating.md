# 0008. Fresh-base gating

- Status: accepted
- Amended by: [0088](0088-the-merge-lock-records-its-holder-survives-every.md), [0105](0105-a-branch-an-open-pr-holds-is-never.md)

8. **Fresh-base gating**: the gate refuses branches that are stale vs main. **Pupitre auto-rebases
   mechanically**; only conflicts go back to the session as a re-steer ("rebase onto main and
   resolve"). Merges are serialized under a lock.
   *Amended by decision 105:* a branch an open PR holds takes the target as a merge commit
   instead, and is pushed without force; the rebase stays for a branch no open PR holds.
