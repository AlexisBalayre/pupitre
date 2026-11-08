# 0017. Diff-size flag blocks unless `--accept-debt`

- Status: accepted
- Amended by: [0110](0110-the-diff-size-flag-counts-source-lines-only.md)

17. **Diff-size flag blocks unless `--accept-debt`.** The v1 soft stage follows stage-4
    semantics from 04-gates-and-debt: a flagged oversize diff refuses to merge unless
    `--accept-debt "<reason>" --review-by "<condition>"` is passed, which writes a ledger
    entry. Threshold is a tunable constant; lockfiles are excluded from the count.
    *Amended by decision 110:* test files and `docs/` are left out of the count too, which now
    counts source lines only.
