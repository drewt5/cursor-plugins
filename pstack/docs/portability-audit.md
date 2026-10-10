# Portability audit

The fork layout was verified locally on macOS with Codex CLI 0.162.1, OpenCode 1.14.50, and Claude Code 2.1.296. The full suite passed, including native discovery and mock API invocation in all three hosts.

## Corrections made

- Global installation supports an XDG config directory outside the home directory, including macOS paths reached through `/var` symlinks.
- Installing another host preserves existing targets. Targeted removal preserves remaining hosts and user configuration. Dry runs make no changes.
- Project installations survive relocation. Agent instructions and project ownership records do not embed the old project path.
- OpenCode receives native skills, slash commands, and agents. Its native skill directory prevents unrelated global shared skills from shadowing project pstack skills.
- Model preferences have validated scope and host precedence. Explicit OpenCode models receive native worker definitions and a model-to-agent mapping.
- Playbooks no longer require a Cursor scheduler, cloud worker, or agent store. Image teaching has a diagram fallback. Webhook UI setup uses the selected service and operating system.
- Transcript activity checks support filenames with spaces and portable timestamps. Closed, unmerged PRs remain review candidates.
- The original 51 skills, 23 playbooks, two agent roles, helper tools, and optional Benny pack remain. A shared runtime skill brings the installed catalog to 52 skills. Cursor mode metadata remains available.

## Verification

- 37 Node tests: repeat install/uninstall across every target and scope, lifecycle, conflict protection, external XDG paths, relocation, model validation and precedence, generated workers, transcript activity, and package contracts.
- 52 existing Bun helper tests and TypeScript checks.
- Native discovery: all 52 skills in Codex and OpenCode; Claude plugin validation and both agents; OpenCode model-specific agent parsing.
- Actual CLI invocation: `poteto-mode` expands into model requests and receives a response in each host installed separately. Claude is tested both standalone and as a native plugin after removing the standalone copy.
- Shell syntax and whitespace checks.

Run the commands in the README to reproduce these checks. Invocation tests use a localhost mock API and fake credentials, with no paid model calls. They prove host integration, not the quality of an LLM's execution of every playbook. External integrations, unattended scheduling, and diverse-model execution require the corresponding configured capabilities. Windows junction support is implemented but was not exercised locally; Linux/macOS unit checks are configured in CI, whose remote result is not claimed here.


## Fork layout

The package lives under `pstack/` in Cursor's repository layout. Run `node pstack/scripts/test.mjs --repeat 2` from the repository root. Host homes and configuration are isolated. Helper dependencies are installed from the lockfile in temporary copies, and each pass asserts that the source package is unchanged. `pstack/tests/catalog.json` protects the shipped workflow inventory. Claude discovery uses `plugin details` to inspect skills and roles; `agents` now lists running sessions. Installation copies only pstack, and the root Claude marketplace resolves to that package.

Migration checks also verified an upgrade from the prior standalone installation, followed by uninstall with model preferences preserved. Upstream's plugin schema validator passed. The original skill/playbook/role inventory and Benny files were preserved; shared instructions include intentional portability adaptations, reviewed against the incorporated upstream commit in [upstream-review.json](upstream-review.json). No unrelated upstream plugin was changed.
