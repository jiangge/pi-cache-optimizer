# Tighten Chinese rejection evidence boundaries

## Approved scope

User approved the three read-only review findings, with no subagents.
- Reject negated Chinese reasoning_effort recommendations.
- Reject Chinese value errors and conditional restrictions rather than treating them as field-level rejection.
- Exercise ordinary `fix` before evidence, after evidence, and for a different model.
- Preserve exact real UNKNOWN_FIELD positives and confirmation gates; do not alter user configuration.

## Validation

Regression-first: targeted tests reproduced 2 failures on the previous matcher; ordinary fix integration passed once switched to the evidence-gated command. After tightening the matcher, targeted tests passed 3/3. Full npm run check passed twice, most recently after adding decimal-condition and trailing-condition regressions: 179/179 tests, typecheck, diff, module graph (26 modules, no cycles), and pack (31 files) all passed.

Implementation now requires Chinese diagnostic clause boundaries, rejects value/feature suffixes, checks conditional sentence context on both sides without splitting decimal values, and rejects negative recommendations including 不建议、不能、不推荐 (including 参数 qualifiers). Ordinary fix is exercised before evidence, for another model, after evidence/cancellation, and after confirmation. No user config changes.

The original Mainline overlap was resolved under the user's explicit handoff authorization: int_fc7474c5 was retired as superseded by int_c2a24061, while its implementation commit b9c3ee8 remains intact. Mainline preflight now passes. The current user explicitly authorizes commit, push, PR review/merge, and npm release after verification; all delivery steps must still use the repository's normal checks and trusted-publishing workflow. Earlier task archive deletions and staged journal changes are tracked separately from implementation commits.

## Release preparation

The current npm latest is 2.8.19; 2.8.20 and tag v2.8.20 were absent from registry/local/remote at preparation. The manifest and both lockfile root versions were raised to 2.8.20 in commit 45280b0; `npm run check` then passed with 179/179 tests, typecheck, diff, module graph, and pack. The repository targets `master`; the PR for this delivery must merge before an annotated v2.8.20 tag triggers the existing GitHub OIDC Trusted Publishing workflow. Workflow success and registry visibility remain required before claiming publication.

## Mainline overlap

This is an explicitly approved corrective follow-up to int_fc7474c5, whose implementation commit b9c3ee8 is preserved in branch history. Shared matcher/test/spec paths are intentional and non-competing. The replacement intent is int_c2a24061; record the predecessor relationship in its seal.
