# Repeated verification in a public no-change installation

This change removes the `verifyGeneration` call immediately after synchronous `stagePackage` in `prepareStagedActivation`. Staging has already verified the retained bytes, provenance, inventory and selected source identity. Preparation obtains the same scoped path and immediately starts importing the model loader. No await, callback or caller-controlled code runs between the completed staging verification and that import. The renderer remains independently verified after the import await.

The preview, under-lock diagnostics, renderer, journal and subsequent-operation checks remain. Fresh staging still compares the source after copying and verifies the stored destination. No persistent cache or caller-supplied validation bypass is introduced.

The source scans remain because provenance acquisition runs Git subprocesses between its payload digest and staging's selected-source inventory. Reusing the earlier inventory would stop detecting a source mutation during those subprocesses on the retained-package path. A regression now exercises that mutation. Another regression replaces retained model code with a write side effect and proves preparation rejects the payload before executing it.

## Reproduce the work counts

Use the candidate's diagnostic against both implementations and one fixed payload. The diagnostic calls `applyPublicInstallation`, the same public operation used by the install CLI. It creates isolated projects and homes, completes an initial installation, then measures a no-change installation. The initial installation and cleanup are outside the measurement. It checks the unchanged receipt and verifies that the fixed payload was not modified.

```sh
git worktree add --detach /tmp/pstack-verification-baseline 1a4e41162d17a5aff902d40f4629b73fd3aebf54
node pstack/tests/diagnostics/public-reuse.mjs /tmp/pstack-verification-baseline /tmp/pstack-verification-baseline/pstack
node pstack/tests/diagnostics/public-reuse.mjs "$PWD" /tmp/pstack-verification-baseline/pstack
```

One warmup plus five measured samples per implementation, local macOS/Node 26.0.0. The fixed payload contains 322 files and 4,079,345 bytes. Counts were identical in every sample:

| Measurement per unchanged public operation | Baseline | Candidate |
| --- | ---: | ---: |
| Retained payload reads | 1,934 | 1,612 |
| Retained payload bytes | 24,478,710 | 20,399,365 |
| Source payload reads | 970 | 970 |
| Source payload bytes | 12,240,899 | 12,240,899 |
| Git subprocesses | 12 | 12 |
| All synchronous subprocesses | 13 | 13 |

The reduction is exactly one complete retained payload traversal: 322 reads and 4,079,345 bytes. Counts include direct payload file reads outside inventories, which explains the extra reads above the complete traversal multiples. Detached provenance and inventory sidecars are excluded from payload byte counts.

Baseline durations were 744.986, 470.883, 390.585, 419.198 and 396.090 ms, median 419.198 ms. Candidate durations were 346.009, 320.265, 369.085, 379.162 and 368.603 ms, median 368.603 ms. These sequential groups ran amid other agents' work. Filesystem cache, order and competing load prevent attributing the wall-time difference to this change. The deterministic read reduction is the result; no timing threshold enters the unit suite and this is not a whole-CI speedup claim.

The diagnostic uses a fixed older retained renderer for both implementations so payload size and rendered behavior match. The ordinary unit and native CI checks separately exercise the candidate's own complete package.
