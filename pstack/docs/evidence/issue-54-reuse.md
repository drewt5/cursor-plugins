# Retained package reuse measurement

Issue #54 removes one retained-payload scan during synchronous reuse. It keeps selected-source identity comparison and stored inventory validation. Missing inventory still requires matching ownership and verified payload before exclusive metadata creation. No result survives into another operation.

The diagnostic script wraps actual `fs.readFileSync` calls and synchronizes the ESM exports before importing storage. It counts only the second `stagePackage` call. Payload reads below the canonical retained directory exclude detached provenance, which is reported separately. Inventory and ownership reads beside the generation are metadata. Source reads are excluded. Each sample uses a new temporary installation and checks successful reuse, identity preservation and nonzero payload reads. Initial staging is outside the timed region.

The immutable payload comes from `a5bc6ab358dd6268a2df25f99a8f56b00f375e86`. It has 320 files and 4,058,531 bytes. Its digest is `b09eceb715c2f431dc8ab6b3da6fb192036b654c94350f10654a21fd45e0ad44`. Both revisions use Node v26.0.0 on darwin arm64, the same filesystem and payload. Before is that base revision. After is this PR's storage implementation. Tests and this document do not enter the immutable fixture.

| Reads per reuse | Before | After |
| --- | ---: | ---: |
| Retained payload bodies | 640 | 320 |
| Retained payload bytes | 8,117,062 | 4,058,531 |
| Detached provenance reads | 3 | 2 |
| Detached provenance bytes | 978 | 652 |
| Stored inventory reads | 1 | 1 |
| Stored inventory bytes | 50,321 | 50,321 |

Every warmup and measured sample produced these counts with zero failures. This proves removal of the redundant body reads, not an end-to-end installation speedup. Source scans, fresh-copy checks, later executable loading checks and scoped mutation boundaries are unchanged.

One warmup and five measured reuse samples per revision are listed below. Elapsed time includes selected-source hashing and provenance subprocesses. The machine had 11 cores and a load average of 4.45 at initial inspection. Other agents ran tests during measurement. The sides ran sequentially, so timing is descriptive and the speedup verdict is inconclusive. The filesystem read counts are the primary claim.

| Sample | Before ms | After ms |
| --- | ---: | ---: |
| Warmup | 101.670 | 79.319 |
| 1 | 83.846 | 94.680 |
| 2 | 91.051 | 75.712 |
| 3 | 128.796 | 85.807 |
| 4 | 96.157 | 105.527 |
| 5 | 95.145 | 79.641 |
| Measured median | 95.145 | 85.807 |

## Reproduce

Run from the PR checkout. Keep the script fixed when comparing revisions. The commands create a baseline worktree and one immutable payload outside the checkout.

```sh
measure_dir=$(mktemp -d)
git worktree add --detach "$measure_dir/before" a5bc6ab358dd6268a2df25f99a8f56b00f375e86
mkdir "$measure_dir/payload"
git archive a5bc6ab358dd6268a2df25f99a8f56b00f375e86 pstack | tar -x -C "$measure_dir/payload"
node pstack/tests/diagnostics/reuse-package.mjs "$measure_dir/before" "$measure_dir/payload/pstack"
node pstack/tests/diagnostics/reuse-package.mjs "$PWD" "$measure_dir/payload/pstack"
```

The regression suite checks active receipt and link preservation, later byte/mode/provenance edits, source identity mismatch, malformed/oversized/digest-mismatched inventory, inventory directories/symlinks/pipes, missing inventory with matching/absent/mismatched ownership, and rejection of edited payloads before metadata regeneration. Existing real filesystem failure and unsafe-tree tests remain. `installation-storage.md` is unchanged because the supported verified-owned behavior is unchanged.
