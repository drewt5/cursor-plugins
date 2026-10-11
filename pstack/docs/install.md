# Install pstack for your coding host

This fork extends Cursor's pstack workflows to Codex, OpenCode, and Claude Code. It keeps the original skills, playbooks, agent roles, helper tools, and optional Benny pack. A shared runtime skill adapts capabilities and model preferences to the active host. See the [workflow guide](guide/README.md) and [fork maintenance](../../FORK.md).

## Install

Requires Node.js 20 or newer and an installed coding host. Run these commands from the repository root:

```sh
node pstack/scripts/install.mjs --target all --project /absolute/path/to/your/project
```

For all your projects, use `--global` instead of `--project PATH`. Select `codex`, `opencode`, or `claude-code` instead of `all` to install one host. Cursor is available separately with `--target cursor`. Without `--target`, a fresh install selects the only usable CLI host. If none or several are found, it exits before writing and prints explicit choices and a copyable command. Cursor always requires `--target cursor`. The current directory is the default project; user scope requires `--global`. Explicit CLI targets must have a usable executable. Untested versions produce a warning and do not establish native compatibility.

Updates without `--target` retain the recorded targets even if PATH changes. Explicit additions are additive. Uninstall without `--target` removes the recorded targets, requires no host executable, and is a no-op when nothing is installed. To remove one target, specify it explicitly.

Restart the coding host after installation. No model configuration is required.

Re-running installation updates owned files and restores missing links. Targets are additive. `--dry-run` previews changes without writing. Existing conflicting skills and modified package files are preserved and reported; move or reconcile those files before retrying. The verified package is retained under `.pstack/releases/<digest>` and activated through the relative `.pstack/package` link, so the source checkout can move without breaking an installation. One previous successful installation is retained for rollback. Project installations can also move.

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

The command entry points share `scripts/lib/installation-state.mjs` (validated receipts and destination snapshots), `installation-artifacts.mjs` (package/configuration rendering), and `installation-plan.mjs` (planning and apply). Downstream lifecycle work should consume these interfaces rather than duplicate ownership checks. Public install and uninstall use this ownership planner inside the scoped lock and recoverable activation journal. Preview does not stage packages, acquire locks, recover operations, or write to the selected scope.

## Ownership conflicts

A file or symlink that exists before installation and is absent from the receipt remains user-owned even when its bytes or destination match pstack. Install reports every conflict before writing, with ownership, attempted operation, path kind, and remedy. Use a separate project installation to keep an existing same-name skill; pstack does not adopt, disable, or remove it.

Recorded files must match their original content before update or removal. Missing managed artifacts are repaired. Generated host-artifact modes may be restored when the recorded bytes still match: this repairs the managed file's permissions without overwriting an edit. Retained package byte/executable-mode changes are refused and preserved; restore their recorded permissions/content before applying. Modified bytes or replaced symlinks require preserving/restoring the affected file before retrying. `.pstack/models.json` and unrelated files remain outside installer ownership.

Legacy receipts cannot establish whether an older installer adopted an identical pre-existing file. They retain their recorded ownership; this change prevents new adoption and does not invent historical provenance.

## Recovery, rollback and locking

From an already-selected checkout, one install command applies the release, retains recorded targets, and migrates supported legacy schemas 1/2/3 automatically when their owned bytes and directory contents are unchanged. A preview is optional. Legacy edits, unowned additions and host conflicts are listed before staging or activation. Legacy receipts retain their recorded ownership; captured original source/tag/upstream identity remains unknown when the old receipt did not record it. Initial legacy packages without a renderer can roll back unchanged adapters; changed model inputs require a compatible previous renderer or a no-write refusal with a supported next action.

```sh
node pstack/scripts/install.mjs --project /absolute/path/to/project
node pstack/scripts/rollback.mjs --project /absolute/path/to/project
```

Use `--global` for a user scope. Rollback restores the whole previous target/root/package installation, preserves current user model settings and providers, and uses the verified previous renderer when effective OpenCode models changed. It refuses unsupported current settings before activation. No arbitrary version history or provider downgrade is provided. See [release selection](releases.md#select-and-install-a-published-portable-release) for the complete Git clone/fetch/tag/detached-checkout sequence; the installer does not download latest releases.

Public mutations hold the canonical scope lock and every recorded/intended external OpenCode-root lock. A changed XDG root in a current-format apply moves only recorded owned outputs under both locks. Legacy migration preserves its recorded OpenCode root, and uninstall always uses recorded roots. Independent projects remain independent. Contention fails promptly with the owner/path. Process identity uses the system `ps` executable independently of PATH. Machine, platform, PID and start identity must agree; age or PID alone never authorize removal. Live/unknown owners are preserved.

Before activation, the installer prints and persists `.pstack/recovery.txt` with an exact command such as `node '<scope>/.pstack/releases/<digest>/scripts/recover.mjs' --project '<scope>'`. Run that exact command after interruption; it works without the original checkout or active package link. If doctor reports a demonstrably dead lock, add `--recover-dead-locks`. The public installer also accepts that flag. A pre-journal stale lock can use `node pstack/scripts/recover.mjs --project PATH --recover-dead-locks` from the selected checkout. Recovery classifies all involved owners before removing any dead token-matched lock; live/unknown owners remain protected. It never asks you to edit receipts or delete `.pstack` wholesale.

A mutating apply resolves an unambiguous unfinished journal before preparing its new plan; doctor and preview remain read-only. Mandatory post-activation failure restores the previous installation using the same recovery engine. A third-party edit matching neither recorded before/after image survives with a named conflict and the exact recovery command. Committed operations finish cleanup, rather than rolling back. Only verified owned obsolete packages are deleted; active/previous/journal references and modified or unknown content remain protected. Full uninstall removes unchanged managed executable storage and reports any preserved paths. User model configuration and unrelated plugins remain.

Restart/reload the host after successful installation, update or rollback. Already-running sessions can cache old instructions. The transaction handles process interruptions; it does not promise power-loss durability, live-session consistency, GUI discovery or model reasoning. [Storage details](installation-storage.md) describe the bounded retained-renderer/recovery contracts and evidence limits.

## Supported installation methods and discovery

Wrapper-managed standalone installation is the default lifecycle method for Codex, OpenCode, Claude Code, and explicitly selected Cursor. Claude's native plugin is an externally managed alternative: use `claude --plugin-dir /absolute/path/to/pstack`, then `/pstack:poteto-mode`. The wrapper does not update or uninstall that external plugin. Choose one pstack method per scope; do not combine native-plugin pstack and standalone pstack and assume precedence.

The following contract is sampled by `scripts/check-hosts.mjs HOST` at the exact versions in [tested-hosts.json](../tested-hosts.json). Its scope fixtures in [scope-contracts.mjs](../scripts/lib/scope-contracts.mjs) run in temporary homes/projects and produce `installation-contract-HOST.json` inside the corresponding native CI artifact. [check-invocation.mjs](../scripts/check-invocation.mjs) separately proves project and global entry-skill expansion through a local mock API for Codex, OpenCode and Claude; it is not a standalone catalog or model reasoning test.

| Host/method | Project / global roots | Invocation and agent identity | Discovery/origin evidence | Supported scope combination |
| --- | --- | --- | --- | --- |
| Codex standalone | `.agents/skills` / `~/.agents/skills` | `$pstack:poteto-mode`; bundled agent prompts are supplied to available generic workers | `codex app-server` `skills/list` returns all skill origins and qualified names | Project-only and global-only identify a complete bundle. Both scopes expose duplicate bundles and are ambiguous. |
| OpenCode standalone | `.opencode/skills`, `commands`, `agents` / `$XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`) | `/poteto-mode`; `poteto-agent`, `comment-sicko`, generated model agents | `opencode --pure debug skill` returns origins; `debug agent NAME` returns native registration | Project-only and global-only identify a complete bundle. Both scopes have produced all-project or mixed project/global origins; precedence is not stable. Use one scope. |
| Claude standalone | `.claude/skills`, `agents` / `~/.claude/skills`, `agents` | `/poteto-mode`; `poteto-agent`, `comment-sicko` | Project/global mock expansion is verified; no standalone catalog/origin interface is exposed by the sampled CLI | One pstack scope at a time. Full standalone bundle precedence is unknown; both scopes are unsupported. Global smoke includes `user,project` setting sources. |
| Claude external native plugin | The selected package via `--plugin-dir`; provider-managed marketplace installation is outside wrapper ownership | `/pstack:poteto-mode`; plugin-qualified agents | `claude --plugin-dir PATH plugin details pstack` inventories plugin skills/agents; qualified mock expansion is verified | Use instead of standalone pstack. A separate independent bare `/poteto-mode` skill can coexist with the qualified plugin entry. |
| Cursor standalone | `.cursor/skills`, `agents` / `~/.cursor/skills`, `agents` | Existing slash/agent names are preserved | Installer, files and manifests only; no supported automated GUI origin probe is used | One scope is the static contract. Cross-scope and same-name GUI resolution remain unverified. |

Restart/reload the host after installing or changing a bundle; an existing session can cache old instructions. A host version or inventory alone does not prove every skill's semantics. Custom Claude configuration roots are not migrated by the wrapper: the sampled standalone global root is `~/.claude`; if `CLAUDE_CONFIG_DIR` points elsewhere, use a project installation or the externally managed native plugin rather than claiming global discovery. OpenCode's global XDG root is recorded in the receipt and respected during removal.

For an ambiguous global/project combination, keep one complete pstack bundle. For example, from the selected release checkout, remove only the unwanted global host and retain its project installation:

```sh
node pstack/scripts/uninstall.mjs --global --target codex
node pstack/scripts/install.mjs --project /path/to/project --target codex
```

Replace `codex` with the affected host. The wrapper preserves user model configuration and other targets. Do not disable another skill/plugin to make pstack win. Public preflight checks ownership and reports discovery limits. Successful installation alone does not establish a supported topology when active resolution is unavailable.

For an independent same-name skill, the fixture establishes these concrete paths:

- Codex keeps `$pstack:poteto-mode` separate from the independent bare `$poteto-mode` identity in the same project catalog. Use the qualified pstack name shown by the host.
- OpenCode's sampled catalog identifies the project pstack bundle and resolves its `poteto-mode` origin, shadowing an independent global bare skill in that project. The report preserves that observed classification separately from the unsupported coexistence policy. The independent skill remains discoverable in another project without project pstack. Keep pstack project-scoped and use that independent project; same-project bare-name coexistence is an explicit unsupported scope. The smallest future adapter would add a qualified pstack channel; no alias or namespace rewrite ships in this investigation.
- Claude can load externally managed native pstack through `--plugin-dir` and expand `/pstack:poteto-mode` while a project-authored `/poteto-mode` expands its own content. This alternative is tested independently of standalone discovery.
- Cursor can preserve the independent skill in another project, but GUI invocation remains unverified. The explicit product limit is static installation/preservation, not certified same-name GUI coexistence. The final lifecycle review must retain this limitation or supply real GUI evidence.

These bounded scope decisions avoid automatic prefixes/aliases or arbitrary per-skill removal. Core skills, helpers, agents, playbooks and references remain one coherent package. Configuration and user-authored skills stay separate. Generated commands and agent/runtime guidance reference `.pstack/package`, a stable link to the retained generation that survives project relocation. The wrapper does not migrate native plugins or change public invocation identities.

## Shared read-only diagnostics

`inspectInstallation` in `scripts/lib/installation-diagnostics.mjs` returns schema version 1 with the scope, installed/selected targets, receipt validity, selected owned-file integrity, configured and recorded roots, bounded executable/version observations, and findings. Each finding has a stable code, severity, subject, structured evidence, verification status and safe next action. Consumers use codes rather than display text. Doctor and installation preflight use these shared diagnostics.

A missing receipt means uninstalled. Invalid/future receipts, denied access, missing or changed artifacts and wrong path kinds remain distinct failures. Unknown versions, unavailable discovery and recorded scope overlap cannot be serialized as verified active compatibility. A recorded duplicate scope is only a potential duplicate registration until a native origin probe confirms it. Diagnostics read no credentials, transcripts or unowned skill bodies, run only selected bounded `--version` observations without a shell, and never repair files or start model requests. Shared path validation also refuses a changed or symlinked recorded OpenCode root before reads or writes.

### Existing-installation discovery safety

The shared `inspectExistingInstallation(options)` API combines static receipt/integrity inspection with explicit native visibility limits. It does not create a new installation or launch provider startup. Codex app-server and OpenCode `--pure debug skill` can touch state/cache or load extensions; automatic read-only safety is not established for user environments. A tested version alone is insufficient. Claude has no safe standalone skills/agents origin inventory, and Cursor GUI discovery remains unverified. These results are unavailable evidence, not failed installation integrity.

`inspectNativeDiscovery` takes an explicit executable, project, scope, environment, expected identities/bundles, version, and bounded timeout. Only caller-owned `isolated-test` environments permit native startup. CI uses that same runner against its supplied temporary project, retains origin paths and source classifications, permits unrelated catalog entries, and checks relevant OpenCode agents. Native Claude plugin inventory uses a separate API and never substitutes for standalone discovery. Exact inventory checks remain isolated-fixture checks.

CI scope artifacts include `existing-environment-safety`: a snapshot of temporary configuration/cache/state around startup and sentinel MCP/plugin checks. Automatic existing-scope calls must leave snapshots unchanged and sentinels unexecuted. Isolated startup records writes and sentinel outcomes; it establishes only that temporary view. Unknown provider versions remain unavailable for automatic existing-scope diagnosis. Explicit isolated CI candidate runs may collect unverified catalog evidence for advisory version testing. No discovery probe invokes the installer, runs a model request, disables plugins, or chooses a source by directory order.

### Diagnose an installation

Run doctor from a checkout or the installed package; it needs Node.js 20+, no Bun, authentication, or model request:

```sh
node pstack/scripts/doctor.mjs --project /absolute/path/to/project
node pstack/scripts/doctor.mjs --global --target codex --json
npm --prefix pstack run pstack:doctor -- --project /absolute/path/to/project --json
```

The default scope is the current project. Targets come from a valid receipt; `--target` narrows the inspection (`all` selects the three CLI hosts). An uninstalled scope without an explicit target reports detected CLI versions as information. Human output includes scope, release identity (unknown for older receipts), file integrity, executable/version, discovery limits, findings, and safe next actions. JSON has schema version 1, structured findings, observed versions, and explicit verification states; stdout contains only JSON and execution/usage diagnostics go to stderr.

Exit 0 means no actionable failure, including clearly marked advisory unknowns. Exit 1 means an actionable installation or selected-host failure. Exit 2 means usage or internal diagnostic execution failed. A JSON consumer must inspect `integrity`, `discovery`, and finding `verification`; exit 0 does not prove complete native verification. Recorded scope overlap remains advisory when active resolution is unavailable. Unrelated plugins may change runtime resolution beyond the safe static view; doctor reports that visibility limit instead of launching them.

Preserve local edits or replacements before repairing the managed path. Install or repair a missing provider using its supported tooling. For an untested provider version, collect isolated compatibility evidence or manually return to the reported tested version; doctor does not update/downgrade providers or disable plugins. Existing running sessions may retain old skills until restart. Doctor has no repair mode and never changes the installation.

### Automatic installation preflight

Install and update now show the selected scope/targets, shared diagnostic finding codes, and all ownership conflicts before writing. Missing managed files are repairable when the concrete plan restores or safely removes them; modified/replaced user content remains a conflict. `--dry-run` reports the complete plan, findings, and discovery visibility without mutation. Unknown valid provider versions warn and can proceed when structural checks pass. Uninstall uses the same ownership checks without requiring any provider executable.

After apply, the installer runs shared static and safe discovery inspection. Verified coherent origins may proceed; actual observed ambiguity/conflicting registration or mandatory discovery failure fails. Recorded overlap alone stays advisory when active discovery is unavailable, so a second receipt is not automatically treated as a proven conflict. Existing-environment native startup remains unavailable under the safety decisions above; this is not proof that every runtime extension is compatible. No model invocation or hooks are added, and doctor is optional.

After activation, mandatory verification failure restores the prior installation and exits unsuccessfully with diagnostics. Conflicting external edits are preserved with the retained recovery command. A preflight failure changes no selected-scope files. Successful static checks with unavailable production native startup remain limited evidence, not proof of all runtime behavior.


### Installed provenance

New installations use schema 4 receipts. They record the retained generation, rendering fingerprint, portable version, source commit when available, explicit incorporated upstream commit, deterministic package digest, release/development classification, targets, ownership entries, and host versions labeled as observations. Updates retain one previous installation for rollback. No timestamps churn on repeated installation. Schemas 1, 2, and 3 remain readable without modification. Schema 1/2 historical release identity remains unknown until a successful supported installer operation writes the new receipt. Future schemas fail before mutation.

The digest uses sorted relative paths, file kind, SHA-256 of file bytes, and executable mode bits. Installation rendering and staging share the package enumeration. Git metadata, dependency/cache directories, `.pstack` receipt/journal state, `.DS_Store`, log files, and root `pstack-provenance.json` are excluded. Source symlinks remain unsupported. Generated detached provenance is excluded to avoid hashing its own digest. Retained generation verification checks stored provenance against the receipt's generation descriptor.

A clean package at its matching `pstack-vVERSION` tag with incorporated upstream ancestry is classified as a release. Untagged or relevant tracked/untracked/ignored payload changes are development content; unrelated monorepo edits do not change this classification or digest. Git-less content records no invented source SHA. Supplied `pstack-provenance.json` is checked against actual archive bytes/version/upstream metadata and labeled untrusted supplied evidence: a matching local digest does not prove publisher authenticity.

Doctor reads the installed receipt and owned payload, so the original checkout may move or disappear. Changed bytes, missing files, or executable modes are shown as modified payload rather than an official release. It does not read unrelated user skill bodies to compute that identity. The installer repairs missing managed paths only when its ownership plan permits. Modified managed content or modes remain conflicts; preserve those changes before restoring the owned version and retrying.

Version observations also run in disposable homes/projects/config/cache/state, because even Codex and OpenCode `--version` can create host state. The bounded probe preserves the selected executable/PATH and required platform environment, strips credentials and user configuration/extension roots, and cleans up its own scratch paths. It reports the executable version, not user-scope catalog resolution. Doctor, automatic target detection, and dry-run therefore do not give version commands access to the requested user installation.
