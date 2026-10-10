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

## Internal transaction locking

`withInstallationMutation` in `scripts/lib/installation-lock.mjs` is internal until the migration/recovery cutover. It holds canonical-scope locks around the callback that reads the final snapshot, plans, applies, and publishes the receipt. A caller writing a global OpenCode root must supply that root too; its destination lock coordinates scopes sharing the same output. Independent projects remain independent. The ownership planner still rejects unowned output paths after serialization.

Contention fails promptly and identifies the owner and lock path. Inspection checks machine, platform, PID and process start identity; age alone and PID alone never authorize deletion. Dead-owner recovery also requires the exact recorded token. Missing process-inspection capability, different machines, malformed metadata, or disagreeing probes remain unverifiable and are preserved. These are local filesystem locks, not distributed leases. Callback failure and normal process exit release owned locks; abrupt death retains evidence for recovery. Public install, uninstall and dry-run do not acquire these locks yet. The later recovery command must use this same classification before the public cutover.

## Supported installation methods and discovery

Wrapper-managed standalone installation is the default lifecycle method for Codex, OpenCode, Claude Code, and explicitly selected Cursor. Claude's native plugin is an externally managed alternative: use `claude --plugin-dir /absolute/path/to/pstack`, then `/pstack:poteto-mode`. The wrapper does not update or uninstall that external plugin. Choose one pstack method per scope; do not combine native-plugin pstack and standalone pstack and assume precedence.

The following contract is sampled by `scripts/check-hosts.mjs HOST` at the exact versions in [tested-hosts.json](../tested-hosts.json). Its scope fixtures in [scope-contracts.mjs](../scripts/lib/scope-contracts.mjs) run in temporary homes/projects and produce `installation-contract-HOST.json` inside the corresponding native CI artifact. [check-invocation.mjs](../scripts/check-invocation.mjs) separately proves entry-skill expansion through a local mock API; it is not a standalone catalog or model reasoning test.

| Host/method | Project / global roots | Invocation and agent identity | Discovery/origin evidence | Supported scope combination |
| --- | --- | --- | --- | --- |
| Codex standalone | `.agents/skills` / `~/.agents/skills` | `$pstack:poteto-mode`; bundled agent prompts are supplied to available generic workers | `codex app-server` `skills/list` returns all skill origins and qualified names | Project-only and global-only identify a complete bundle. Both scopes expose duplicate bundles and are ambiguous. |
| OpenCode standalone | `.opencode/skills`, `commands`, `agents` / `$XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`) | `/poteto-mode`; `poteto-agent`, `comment-sicko`, generated model agents | `opencode --pure debug skill` returns origins; `debug agent NAME` returns native registration | Project-only and global-only identify a complete bundle. Both scopes expose ambiguous sources. |
| Claude standalone | `.claude/skills`, `agents` / `~/.claude/skills`, `agents` | `/poteto-mode`; `poteto-agent`, `comment-sicko` | Project/global mock expansion is verified; no standalone catalog/origin interface is exposed by the sampled CLI | One pstack scope at a time. Full standalone bundle precedence is unknown; both scopes are unsupported. Global smoke includes `user,project` setting sources. |
| Claude external native plugin | The selected package via `--plugin-dir`; provider-managed marketplace installation is outside wrapper ownership | `/pstack:poteto-mode`; plugin-qualified agents | `claude --plugin-dir PATH plugin details pstack` inventories plugin skills/agents; qualified mock expansion is verified | Use instead of standalone pstack. A separate independent bare `/poteto-mode` skill can coexist with the qualified plugin entry. |
| Cursor standalone | `.cursor/skills`, `agents` / `~/.cursor/skills`, `agents` | Existing slash/agent names are preserved | Installer, files and manifests only; no supported automated GUI origin probe is used | One scope is the static contract. Cross-scope and same-name GUI resolution remain unverified. |

Restart/reload the host after installing or changing a bundle; an existing session can cache old instructions. A host version or inventory alone does not prove every skill's semantics. Custom Claude configuration roots are not migrated by the wrapper: the sampled standalone global root is `~/.claude`; if `CLAUDE_CONFIG_DIR` points elsewhere, use a project installation or the externally managed native plugin rather than claiming global discovery. OpenCode's global XDG root is recorded in the receipt and respected during removal.

For an ambiguous global/project combination, keep one complete pstack bundle. For example, from the selected release checkout, remove only the unwanted global host and retain its project installation:

```sh
node pstack/scripts/uninstall.mjs --global --target codex
node pstack/scripts/install.mjs --project /path/to/project --target codex
```

Replace `codex` with the affected host. The wrapper preserves user model configuration and other targets. Do not disable another skill/plugin to make pstack win. The scope evidence defines what later diagnostics/preflight must permit or reject; the public preflight integration is a separate roadmap task, so existing CLI success alone does not establish a supported topology.

For an independent same-name skill, the fixture establishes these concrete paths:

- Codex keeps `$pstack:poteto-mode` separate from the independent bare `$poteto-mode` identity in the same project catalog. Use the qualified pstack name shown by the host.
- OpenCode project pstack shadows an independent global bare `poteto-mode` skill in that project. The independent skill remains discoverable in another project without project pstack. Keep pstack project-scoped and use that independent project; same-project bare-name coexistence is an explicit unsupported scope. The smallest future adapter would add a qualified pstack channel; no alias or namespace rewrite ships in this investigation.
- Claude can load externally managed native pstack through `--plugin-dir` and expand `/pstack:poteto-mode` while a project-authored `/poteto-mode` expands its own content. This alternative is tested independently of standalone discovery.
- Cursor can preserve the independent skill in another project, but GUI invocation remains unverified. The explicit product limit is static installation/preservation, not certified same-name GUI coexistence. The final lifecycle review must retain this limitation or supply real GUI evidence.

These bounded scope decisions avoid automatic prefixes/aliases or arbitrary per-skill removal. Core skills, helpers, agents, playbooks and references remain one coherent package. Configuration and user-authored skills stay separate. Existing generated commands and agent/runtime guidance reference `.pstack/package`; future storage migration must preserve that stable resolution path, including project relocation. This investigation does not migrate native plugins or redesign public invocation identities.

## Shared read-only diagnostics

`inspectInstallation` in `scripts/lib/installation-diagnostics.mjs` returns schema version 1 with the scope, installed/selected targets, receipt validity, selected owned-file integrity, configured and recorded roots, bounded executable/version observations, and findings. Each finding has a stable code, severity, subject, structured evidence, verification status and safe next action. Consumers use codes rather than display text. The doctor command is separate work.

A missing receipt means uninstalled. Invalid/future receipts, denied access, missing or changed artifacts and wrong path kinds remain distinct failures. Unknown versions, unavailable discovery and recorded scope overlap cannot be serialized as verified active compatibility. A recorded duplicate scope is only a potential duplicate registration until a native origin probe confirms it. Diagnostics read no credentials, transcripts or unowned skill bodies, run only selected bounded `--version` observations without a shell, and never repair files or start model requests. Shared path validation also refuses a changed or symlinked recorded OpenCode root before reads or writes. The inspection API remains internal until the doctor/preflight tasks.

### Existing-installation discovery safety

The shared `inspectExistingInstallation(options)` API combines static receipt/integrity inspection with explicit native visibility limits. It does not create a new installation or launch provider startup. Codex app-server and OpenCode `--pure debug skill` can touch state/cache or load extensions; automatic read-only safety is not established for user environments. A tested version alone is insufficient. Claude has no safe standalone skills/agents origin inventory, and Cursor GUI discovery remains unverified. These results are unavailable evidence, not failed installation integrity.

`inspectNativeDiscovery` takes an explicit executable, project, scope, environment, expected identities/bundles, version, and bounded timeout. Only caller-owned `isolated-test` environments permit native startup. CI uses that same runner against its supplied temporary project, retains origin paths and source classifications, permits unrelated catalog entries, and checks relevant OpenCode agents. Native Claude plugin inventory uses a separate API and never substitutes for standalone discovery. Exact inventory checks remain isolated-fixture checks.

CI scope artifacts include `existing-environment-safety`: a snapshot of temporary configuration/cache/state around startup and sentinel MCP/plugin checks. Automatic existing-scope calls must leave snapshots unchanged and sentinels unexecuted. Isolated startup records writes and sentinel outcomes; it establishes only that temporary view. Unknown provider versions remain unavailable for automatic existing-scope diagnosis. Explicit isolated CI candidate runs may collect unverified catalog evidence for advisory version testing. No discovery probe invokes the installer, runs a model request, disables plugins, or chooses a source by directory order.
