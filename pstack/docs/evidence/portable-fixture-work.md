# Portable fixture workload

Issue #64 reduces test fixture work. Production installation, verification, recovery, native probes, timeouts and required lanes are unchanged. A measured scheduling experiment was rejected; the existing concurrency policy remains. All 224 existing tests and their behavioral assertions remain; a new fixture-execution regression brings the suite to 225 tests.

`tests/fixtures/runtime-source.mjs` copies real shipped installer, renderer and recovery scripts; runtime/model code; how/why skills; both agents; metadata; README; and the poteto skill, feature playbook and executable audit script used by scenario assertions. It excludes unrelated catalog entries, assets, tests and documentation. These scenario fixtures are not release packages and do not establish complete catalog coverage.

| Scenario | Fixture |
| --- | --- |
| Eight single-host project/global lifecycle rows | Compact runtime, shared read-only source per test file; all 56 CLI operations retained |
| Both all-host project/global lifecycle rows | Complete package; all 14 CLI operations retained |
| Five per-host catalog/resource portability paths | Complete package, including repeat install and uninstall |
| Other portability behavior scenarios | Compact runtime, including the real resource paths checked by existing assertions |
| Three updates, exact rollback and full uninstall anchor | Complete package |
| Seven other rollback scenarios | Independent compact runtime copies; actual model loader/recovery module edits retained |
| Public schema 1 migration/rollback/repair/relocation | Compact runtime |
| Public schema 2 migration/rollback/repair/relocation and legacy full uninstall | Complete package |
| Public fresh/legacy source-deleted crash recovery | Complete package |
| Exhaustive 22 crash boundaries and other compact activation/recovery scenarios | Same compact package contents as before; source prepared once per test file |
| Other full source-deleted recovery and global/XDG recovery anchors | Complete package |

Shared source directories are immutable test inputs. Each installation, retained generation, home, configuration and mutation journal remains isolated. Source-deletion and source-modification scenarios use independent copies. Test-file cleanup runs after all its tests. Full catalog/manifest tests and real native lanes remain unchanged.

## Deterministic workload

The checked-in diagnostic measures both fixture builders against one fixed payload:

```sh
git worktree add --detach /tmp/pstack-64-baseline 358cf5984efb5aa3f2c338cdbab02fb0b661827c
node pstack/tests/diagnostics/fixture-workload.mjs /tmp/pstack-64-baseline/pstack
```

That payload contains 328 files and 4,132,350 bytes. The runtime fixture contains 82 files and 409,566 bytes. The activation fixture keeps its existing 64 files and 273,569 bytes.

For the eight compact lifecycle rows, the 16 fresh stages previously copied 5,248 files/66,117,600 bytes. Including the new shared source preparation, they now copy 1,394 files/6,962,622 bytes: **3,854 fewer files and 59,154,978 fewer bytes**. This excludes additional savings from repeated hashing and teardown.

The recovery test's control, 22 crash cases and five other compact scenarios previously prepared 28 identical sources. Preparing one saves **1,728 file copies and 7,386,363 bytes**. All 28 independent stages and every crash/recovery operation still execute. Activation tests similarly reuse only their immutable source preparation.

## Local comparison

Baseline is main `358cf5984efb5aa3f2c338cdbab02fb0b661827c`. Candidate changes only the fixtures described above. On the same local macOS machine with Node 22, each side ran the existing `node pstack/scripts/test.mjs --unit --repeat 3` entrypoint with `PSTACK_TIMING_DIR`, `PSTACK_TIMING_ORIGIN` and `PSTACK_TIMING_SCOPE=unit` enabled. Every run passed all 224 tests and confirmed its source checkout was unchanged.

Test-process durations were 49.489, 56.131 and 55.554 seconds before, and 32.922, 32.927 and 33.330 seconds after. Median file intervals from the precise timing records:

| Test file | Baseline seconds | Candidate seconds |
| --- | ---: | ---: |
| lifecycle | 53.249 | 30.641 |
| portability | 36.124 | 21.113 |
| installation-recovery | 30.868 | 23.488 |
| installation-rollback | 28.886 | 11.882 |
| installation-public | 25.188 | 16.742 |
| installation-activation | 17.040 | 13.977 |

File intervals overlap and must not be summed as suite elapsed time. Local tests ran amid other agent work; grouped before/after samples, cache state and load limit causal timing claims. Deterministic fixture reductions establish the removed work. Current-head hosted reports establish platform behavior and report actual phase cost; no timing threshold is added to tests.

Full package anchors and real process startup still cost time. Source hashing and verification boundaries remain production behavior rather than test bypasses. This task does not resolve the complete CI-cost tracker #52.

## Hosted scheduling experiment

The fixture-only head `d47689b6d9ca3022103f566f786350a659ac00e0` passed all eight required checks in run 38102549371, attempt 1. All 224 tests passed on both platforms and all six artifacts matched the source, tested checkout, run and attempt. Portable phases took 55.954 seconds on macOS and 40.528 seconds on Linux. Mac file intervals totaled 110.191 seconds at concurrency 2, almost exactly the 55.096-second work-packing lower bound. Linux totaled 114.217 seconds at concurrency 3 versus 40.528 seconds elapsed. Reordering alone cannot deliver the desired reduction.

A controlled experiment changed only file concurrency to `max(availableParallelism, 1)`, selecting three macOS and four Linux files with the same fixtures, runners and timeouts. Run 38102747039 passed all checks at head `9aa126cf98e32b708669a5d702a797cca4c0a495`, but phases took 74.722 seconds on macOS and 40.890 seconds on Linux. Mac file intervals grew to 219.973 seconds and Linux to 136.260 seconds. The experiment provided no benefit on either platform and was reverted. There is no concurrency increase in the final implementation.

## Version-only fixture startup

The existing unit-only fake providers launched Node merely to compare the first argument and print a constant version. On POSIX, they now use `/bin/sh` with builtin argument comparison and `printf`. Every production version probe still launches an executable, reads stdout and validates the version; non-version commands still exit 99. The existing Node implementation remains on Windows. Real native-provider lanes and their versions are unchanged.

The added test executes every fixture with an empty PATH, checks exact version/newline output and confirms both absent and unsupported arguments produce exit 99 without stdout. This removes one Node runtime startup per fake version probe without removing any probe or weakening preflight.
