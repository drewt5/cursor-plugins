# Portable release metadata

## Unreleased installer default change

Fresh standalone installs no longer select all CLI hosts automatically. Without `--target`, the sole usable CLI host is selected; zero or multiple usable hosts require an explicit target before any writes. `--target all` still selects Codex, OpenCode, and Claude Code; Cursor remains explicit. Receipt-backed updates retain recorded targets, and offline uninstall uses those targets.


`pstack/release.json` owns the portable SemVer version. Its initial `0.16.0` value preserves existing manifests; future portable versions are independent of upstream plugin versions. The plugin remains `pstack`, authored by Lauren Tan. `upstreamCommit` records the incorporated upstream commit separately. After an ancestry-preserving upstream merge and review described in [FORK.md](../../FORK.md), update that field to the incorporated commit, not a moving branch name.

From the repository root, edit only the authoritative version, then synchronize its consumers:

```sh
node pstack/scripts/release.mjs --sync
node pstack/scripts/release.mjs --check
```

The consumers are `pstack/package.json`, `pstack/plugin.json`, and the Cursor, Claude Code, and Codex `plugin.json` manifests. OpenCode has no separate package version. The repository's Cursor and Claude marketplace entries currently refer to the local package without a version; if those pstack entries acquire version fields, the same command checks and synchronizes them. Unrelated plugins are outside this release. `--check` never writes. `--sync` changes mismatched version consumers and a second run produces no diff. The required portable `node pstack/scripts/test.mjs --unit` path executes the validator before regression tests, including a test that deliberately mismatches an isolated manifest.

## Choose a version

- Patch: compatible bug fixes, documentation corrections, and tooling fixes that preserve the supported invocation, installation, and host contracts.
- Minor: additive skills or capabilities, new host support, and compatible installation-schema support.
- Major: incompatible invocation names, defaults, installation-schema support, or removed host support. While the project is `0.x`, these breaking changes increment the minor version rather than the major version; a stable `1.0.0` establishes the major-version contract.

Invocation renames, default behavior changes, installation-schema support changes, and dropped host support always need explicit release notes, including during `0.x`. Notes must explain migration, reload requirements, and relevant verification limits. Upstream version changes alone do not require matching portable version numbers. Installation receipts and model configuration retain their independent schema versions; `release.json`'s `schemaVersion` describes this metadata's format, not installation compatibility.

## Validate source identity

Commit the synchronized files before validation. Use a full Git checkout containing the recorded upstream history (fetch the missing history if a shallow checkout cannot verify it). Tags follow `pstack-v<version>`:

```sh
node pstack/scripts/release.mjs --release --tag pstack-v0.16.0
```

Use the selected version in place of `0.16.0`. This read-only command checks version consistency, requires a clean checkout, verifies that the recorded upstream commit exists and is an ancestor of `HEAD`, and derives the exact portable `sourceCommit` from Git. It rejects a tag name that disagrees with the version or an existing tag pointing to another source commit, including annotated tags. An absent tag is permitted for validation of the intended release name; the command creates no tag and publishes nothing. Its JSON output retains the version, upstream commit, intended tag, and source commit for downstream release tooling. No self-referential source SHA is committed into `release.json`.

This is metadata and ancestry validation, not the complete release-candidate gate, an authenticity signature, or proof of workflow semantics. Before a release, also run the existing full suite and follow [the CI evidence protocol](ci.md). Mock invocation does not establish real-model reasoning or Cursor GUI behavior. Installed provenance is described in [installation](install.md); the candidate command below retains exact CI evidence.


## Prepare a candidate with durable evidence

The supported policy is the current portable release plus the immediately previous supported portable release’s upgrade fixture. Before the first portable release (no `pstack-v*` tags exist), the explicit migration baseline is legacy receipt schemas 1 and 2. This is not support for arbitrary historical packages. A later review must identify the previous tag/commit/package digest and retain its upgrade-fixture evidence digest. For that baseline, add `--upgrade-evidence FILE`: schema 1, kind `release-upgrade-fixture`, status `passed`, exact `from` tag/sourceCommit/packageDigest, exact `to` candidate tag/sourceCommit/runId/runAttempt, and unique named successful `cases`. The review’s `upgradeFixtureDigest` is SHA-256 of canonical `JSON.stringify(proof)`. Missing, failed or stale proof is rejected; the complete proof is retained in the output.

Commit synchronized version metadata first. Select the exact candidate source and complete the required baseline workflow for that commit. A main push or an explicit required-workflow dispatch on the selected commit makes source and tested checkout identical; PR evidence also retains its exact tested merge checkout. Follow [the CI protocol](ci.md) and recheck current head/base before handoff. Advisory canary evidence cannot replace required baseline evidence.

From the repository root, replace the run/attempt and expected tag with the selected candidate’s values. Download fresh evidence while the inputs still exist:

```sh
pstack_run=RUN_ID
pstack_attempt=1
pstack_tag=pstack-v0.16.0
pstack_evidence_dir=$(mktemp -d)
gh api "repos/drewt5/cursor-plugins/actions/runs/$pstack_run" > "$pstack_evidence_dir/run.json"
gh api "repos/drewt5/cursor-plugins/actions/runs/$pstack_run/attempts/$pstack_attempt/jobs" > "$pstack_evidence_dir/jobs.json"
gh run download "$pstack_run" --repo drewt5/cursor-plugins --pattern "pstack-*-$pstack_attempt" --dir "$pstack_evidence_dir/reports"
gh run view "$pstack_run" --repo drewt5/cursor-plugins --log > "$pstack_evidence_dir/checkout.log"
node pstack/scripts/release-candidate.mjs --tag "$pstack_tag" \
  --run "$pstack_run" --attempt "$pstack_attempt" \
  --reports "$pstack_evidence_dir/reports" --run-meta "$pstack_evidence_dir/run.json" \
  --jobs "$pstack_evidence_dir/jobs.json" --checkout-log "$pstack_evidence_dir/checkout.log" \
  --review pstack/docs/upstream-review.json --output "$pstack_evidence_dir/release-candidate.json"
```

The output is compact self-contained JSON: exact source/upstream/digest/tag state, required workflow/run/attempt, eight job and complete step outcomes with their GitHub timestamps, six report digests, source/tested SHA, every phase command/outcome/log digest, actual tested host versions, upgrade baseline, and reviewed upstream intent delta. Re-running against the same inputs is deterministic; run IDs, job IDs, phase durations and other retained run metadata naturally differ between runs. Missing/expired input reports or logs, stale attempts/commits, failed/incomplete jobs/phases, unknown versions, dirty/version/tag mismatches, and advisory substitution are rejected before output. Existing evidence files are not overwritten.

Validation launches no provider, model request, or user installer and creates no tag/release. A missing expected tag is a pre-tag candidate; an existing matching tag is explicitly verified. Candidate validation remains `candidate-validated`. Supply fresh `--lifecycle-evidence FILE` from the [lifecycle acceptance protocol](lifecycle-acceptance.md) to bind the exact public-clone/manifesto/cost evidence to this source/run/attempt and mark the lifecycle gate `verified-for-maintainer-review`. Without that proof it stays pending, even after the roadmap issue closes. Maintainer review still decides readiness; no tag/release is created. At explicit publication, attach this evidence JSON to the selected release so identities/outcomes remain interpretable after ordinary artifacts/logs expire at their normal short retention. The record is not a publisher-authenticity signature or semantic-parity proof.

## Review upstream intent proportionally

Use `node pstack/scripts/release-candidate.mjs --inspect-upstream` to obtain the incorporated-upstream identity, exact shared instruction diff digest, changed paths, and added/removed skill inventory. Read the Git diff and account for material deviations in `upstream-review.json`; a hash/ancestor check cannot make this intent judgment. The current review preserves the original 51 skills and adds one runtime skill, identifies model/delegation/history/service/default changes, and records generic helper/security fixes worth proposing upstream separately. It does not publish those proposals automatically.

The validator binds review rationale to every changed shared workflow path and inventory change. If the upstream base and shared diff are unchanged, reuse the reviewed evidence for a metadata/adapter-only candidate. When they change, refresh the affected rationale and inventory delta rather than re-reviewing unchanged library content or keeping duplicate snapshots. Review the deliberate model-inheritance and invocation/default changes in release notes; do not infer actual independent reasoning or Cursor GUI behavior from mock loading.

## Select and install a published portable release

After a portable release is explicitly published, use its actual tag (the example is not a claim that `pstack-v0.16.0` exists today):

```sh
git clone https://github.com/drewt5/cursor-plugins.git pstack-fork
cd pstack-fork
git fetch origin --tags
pstack_tag=pstack-v0.16.0
git rev-parse "$pstack_tag^{commit}"
git switch --detach "$pstack_tag"
node pstack/scripts/release.mjs --release --tag "$pstack_tag"
node pstack/scripts/install.mjs --target codex --project /absolute/path/to/project
```

Compare the selected commit/digest with the published self-contained evidence before the installer command. Choose the actual intended target or `all`, or replace project scope with `--global`. The one-command promise starts from this already-selected checkout; there is no automatic latest downloader. `git pull` alone does not update installed copies. Restart an existing host session after changes, then use doctor if needed.

## Maintainer checkpoint

- Choose/sync/check the version once; commit clean source, verify expected tag/upstream/digest, and collect exact current-head required evidence.
- Read default/invocation/model changes: fresh target selection is now single-host or explicit; model setup is optional inheritance; metadata identifiers and Codex qualified invocation differ by host. Provide migration/restart notes.
- Account for upstream skill inventory and material instruction deltas, identify generally useful upstream proposals, and retain explicit semantic/GUI/Windows/independence gaps.
- Exercise the immediately previous supported upgrade fixture, or explicit schema-1/2 legacy baseline for the first release. Link recovery/rollback documentation and pass the later complete lifecycle gate before readiness/publication.
- Publish only through an explicit maintainer action; retain the self-contained evidence with that release while leaving ordinary CI artifact retention and repository protection unchanged.

For an exact pre-tag integration candidate (the published-tag example above applies only after publication):

```sh
git clone https://github.com/drewt5/cursor-plugins.git pstack-fork
cd pstack-fork
git fetch origin --tags
pstack_candidate=REPLACE_WITH_EXACT_CANDIDATE_COMMIT
git switch --detach "$pstack_candidate"
node pstack/scripts/release.mjs --check
node pstack/scripts/install.mjs --target codex --project /absolute/path/to/project
```

The [public-clone integration](lifecycle-acceptance.md) executes this exact-commit sequence and the user lifecycle with disposable state. Keep its evidence outside the hashed package and attach it with the self-contained candidate record.

Lifecycle cost validation requires complete measured baseline and current samples, including explicit successful run/job conclusions and baseline report provenance. Follow the [cost field reference and collection instructions](lifecycle-acceptance.md#cost-evidence-fields) for the exact accepted fields, timestamp arithmetic, and the narrow historical baseline exception. Current timings, job IDs, step conclusions, phases, and digests must correspond to the required evidence supplied to this command. Step and phase durations must fit their enclosing job with a one-second rounding allowance. Current job times and step durations are checked against the retained supplied GitHub timestamps. Empty jobs and missing measurements fail before an output file is created. A valid input produces a deterministic self-contained record. The validator checks correspondence and arithmetic; it does not authenticate baseline attestations, prove scenarios from digests, or evaluate manifesto prose. Preserve older archived records and their hashes; collect complete evidence for a new validation.
