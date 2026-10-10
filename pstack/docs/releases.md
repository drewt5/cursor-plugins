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

This is metadata and ancestry validation, not the complete release-candidate gate, an authenticity signature, or proof of workflow semantics. Before a release, also run the existing full suite and follow [the CI evidence protocol](ci.md). Mock invocation does not establish real-model reasoning or Cursor GUI behavior. Automated release-candidate evidence and installed provenance are separate follow-up work.
