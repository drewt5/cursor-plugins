# Install pstack for your coding host

This fork extends Cursor's pstack workflows to Codex, OpenCode, and Claude Code. It keeps the original skills, playbooks, agent roles, helper tools, and optional Benny pack. A shared runtime skill adapts capabilities and model preferences to the active host. See the [workflow guide](guide/README.md) and [fork maintenance](../../FORK.md).

## Install

Requires Node.js 20 or newer and an installed coding host. Run these commands from the repository root:

```sh
node pstack/scripts/install.mjs --target all --project /absolute/path/to/your/project
```

For all your projects, use `--global` instead of `--project PATH`. Select `codex`, `opencode`, or `claude-code` instead of `all` to install one host. Cursor is available separately with `--target cursor`. Restart the coding host after installation. No model configuration is required.

Re-running installation updates owned files and restores missing links. Targets are additive. `--dry-run` previews changes without writing. Existing conflicting skills and modified package files are preserved and reported; move or reconcile those files before retrying. The package is copied into `.pstack/package/`, so the source checkout can move without breaking an installation. Project installations can also move.

## Uninstall

```sh
node pstack/scripts/uninstall.mjs --target all --project /absolute/path/to/your/project
# Or remove a global installation:
node pstack/scripts/uninstall.mjs --target all --global
```

Use the same scope as installation. Select one target to remove only that host. Repeating uninstall succeeds without changing user files. User model preferences and unrelated files remain; empty directories may remain. The compatible `install.mjs --uninstall` form also works.

## Invoke

| Host | Entry point |
| --- | --- |
| Codex | `$pstack:poteto-mode` or the name shown in its skill catalog |
| OpenCode | `/poteto-mode` |
| Claude Code standalone | `/poteto-mode` |
| Claude Code native plugin | `/pstack:poteto-mode` |
| Cursor | `/poteto-mode` |

Claude can load the native plugin without installation: `claude --plugin-dir /absolute/path/to/checkout/pstack`. Alternatively run `/plugin marketplace add /absolute/path/to/checkout` in Claude, then `/plugin install pstack@cursor-plugins`. The repository keeps upstream's marketplace name. If you already added the upstream marketplace, use the direct plugin directory or standalone installer for this fork. Use one installation method per host to avoid duplicate skills.

Use `setup-pstack` for optional model preferences. Each host inherits its current model by default. OpenCode model overrides generate native agents; rerun its installer after changing preferences. See the [runtime contract](../skills/pstack-runtime/SKILL.md).

## Test

```sh
npm --prefix pstack test
# Run every check twice to prove repeatability:
npm --prefix pstack run test:repeat
# Offline unit and package tests only:
npm --prefix pstack run test:unit
```

The full suite requires Node.js 20+, Git, Bash, Bun, Codex, OpenCode, and Claude Code on PATH. It fails with a prerequisite error if a required tool is absent. It runs:

- Installer lifecycle, preservation, upgrade, relocation, model configuration, and transcript regression tests.
- The bundled Bun helper tests and TypeScript checks, using locked dependencies in a temporary copy.
- Native skill and agent discovery in isolated temporary projects.
- Actual skill command expansion through each CLI and a localhost mock API, including both Claude installation methods.
- Shell syntax checks and source-tree integrity checks.

Each run uses fresh temporary directories and removes them afterward. Host settings, caches, credentials, and test dependency installs are isolated. No paid model calls or personal configuration changes are needed. The first dependency install needs registry access; later runs may use the package manager's available cache. Sandboxed environments must allow CLI subprocesses and a loopback listener. Tests fail rather than silently skipping host checks.

The mock API verifies integration, not model reasoning quality. External services, cloud execution, independent model comparisons, and unattended wakeups still require the relevant configured capabilities. Windows junction support is implemented but native CLI tests were verified on macOS. PR CI runs unit checks on Linux and macOS, helper checks on Linux, and native CLI smoke tests on Linux. See [PR verification](ci.md) for tested versions, coverage limits, and failure diagnosis.

## Layout

Inside `pstack/`, `skills/`, `agents/`, and `automations/` contain the workflows. `scripts/` contains installation and validation entry points. `tests/` contains regression tests. The installer copies only this package, not the surrounding plugin repository. [Portability design](portability.md) describes the adapters and ownership model.

MIT. Original copyright retained.

## Inspect planned changes

Add `--dry-run` to the same install or uninstall command to inspect a read-only JSON plan. Each operation includes its path, observed state, intended state, owning host/shared package, action (`create`, `replace`, `remove`, `unchanged`, or `conflict`), and reason. Conflicts are collected together and exit unsuccessfully without changing destination files. Apply checks that the inspected files and receipt have not changed before writing.

The command entry points share `scripts/lib/installation-state.mjs` (validated receipts and destination snapshots), `installation-artifacts.mjs` (package/configuration rendering), and `installation-plan.mjs` (planning and apply). Downstream lifecycle work should consume these interfaces rather than duplicate ownership checks. This planner does not make a multi-file update transactional; recoverable activation remains separate work.

## Ownership conflicts

A file or symlink that exists before installation and is absent from the receipt remains user-owned even when its bytes or destination match pstack. Install reports every conflict before writing, with ownership, attempted operation, path kind, and remedy. Use a separate project installation to keep an existing same-name skill; pstack does not adopt, disable, or remove it.

Recorded files must match their original content before update or removal. Missing managed artifacts are repaired. Executable modes may be restored when the recorded bytes still match: this repairs the managed file's permissions without overwriting an edit. Modified bytes or replaced symlinks require preserving/restoring the affected file before retrying. `.pstack/models.json` and unrelated files remain outside installer ownership.

Legacy receipts cannot establish whether an older installer adopted an identical pre-existing file. They retain their recorded ownership; this change prevents new adoption and does not invent historical provenance.
