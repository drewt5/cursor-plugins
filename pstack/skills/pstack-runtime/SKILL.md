---
name: pstack-runtime
description: Resolve pstack host capabilities, model roles, delegation, skill paths, history, and optional integrations. Read before any pstack workflow.
metadata:
  opencode/slash: "true"
---

# Pstack runtime

Pstack shares the same workflows across Codex, OpenCode, Claude Code, and Cursor. Resolve capabilities from the actual session tools. Read the matching host note in `references/` once per session. Never infer a capability from a model name.

## Defaults and configuration

No setup is required. All roles use the current model. Panels have two seats with distinct review lenses; label them as same-model reviews unless different models actually ran. Prefer diverse models only when the host supports them and the user has configured them.

Resolve configuration with `node <installed-pstack-runtime>/scripts/models.mjs --host <codex|opencode|claude-code|cursor> --project <project-root>`. It validates configuration and merges defaults, user settings, user host settings, project settings, then project host settings. User settings live at `$XDG_CONFIG_HOME/pstack/models.json` or `~/.config/pstack/models.json`; project settings at `.pstack/models.json`. Read the normalized result before choosing workers. If Node is unavailable, apply the same precedence explicitly and report that validation was manual. `setup-pstack` documents the JSON shape. Never edit the host's model settings to honor a pstack preference.

`inherit-parent` and `auto` both mean omit a model override. Pass an explicit model only if the current delegation tool supports it and the model is available. Model identifiers are opaque: never construct one by appending reasoning or speed tokens. Use a separate reasoning parameter only when the tool exposes it. If a configured model is unsupported, disclose the limitation and inherit. If the user explicitly requires a particular model or a multi-model comparison, report the missing capability instead of substituting results.

## Delegation contract

Workflows describe roles and desired execution, not literal tool arguments. Map them to the host tool schema. Do not pass Cursor-only arguments to other hosts. Respect user instructions about delegation, the host's concurrency limits, permissions, and budgets.

For `poteto-agent`, use the registered agent if available. Otherwise use a general worker with an explicit instruction to read the installed `poteto-mode/SKILL.md` and this runtime before starting. For Comment Sicko, read the bundled role at `../../agents/comment-sicko.md` and include its instructions in the worker brief if the host has no registered agent. Reviewers must not edit the target. Read-only is an intent and a permission constraint, not a reason to remove available read-only connectors.

Use native parallel workers when supported. Batch at the actual concurrency limit and wait for terminal results. Without delegation, run each required slice and review lens sequentially in the current session, preserving artifacts and verification. State that these are sequential passes, not independent agents. Never claim independent or multi-model verification when it did not occur. A requirement for genuinely independent execution remains unmet until that capability is available.

Cloud execution, background workers, messaging, resume IDs, and persistent scheduling are optional capabilities. Default to local execution. Isolate concurrent writes in distinct worktrees or output directories. Resolve branch and commit inputs with git before starting a worker. Do not assume a cloud worker shares local files or installed skills: provide the needed instructions and accessible artifacts in its brief.

## Tools and lifecycle

Use the host's question tool, or ask in chat when none exists. Use its plan tool, or a Markdown checklist. Use the available shell, browser, UI driver, and connectors. A missing sibling plugin is not a prerequisite for the core workflow:

- `deslop`: inspect the diff for redundant checks, unnecessary abstractions, type escapes, and unrelated edits; apply the bundled principles and no-comments review.
- `control-cli` / `control-ui`: drive the real program with available terminal or browser tooling. If no driver exists, report the specific verification gap.
- `create-skill` / `skill-creator`: follow the authoring procedure below.
- Origin, Grok Bot, Slack, issue trackers, and cloud automations: use only explicitly configured integrations. These optional workflows need their own credentials and services; installation does not supply them.

For a long run, use a native scheduler only when available and authorized. Otherwise continue within the active session, use bounded checks, and save a handoff before the session ends. A shell sleep cannot wake a finished agent session. Do not promise unattended resumption without a working scheduler. Never disable permission gates, change account settings, or install a separate service just to emulate a missing host feature.

## History and state

Use current conversation context first. For earlier work, use the host's session search/export or an explicitly identified transcript for the active project. Verify project identity before reading a file. Never derive another host's transcript location from Cursor's path scheme or scan all projects in a home directory. If history is inaccessible, use the supplied handoff, git history, and current artifacts and state the history gap. Do not fabricate transcript UUIDs or links.

Use `.pstack/` in the project for durable run state and host-neutral configuration. New project skills belong in `.agents/skills/<name>/SKILL.md` for Codex/OpenCode, `.claude/skills/<name>/SKILL.md` for Claude Code, or `.cursor/skills/<name>/SKILL.md` for Cursor. Preserve an existing skill's location. Refer to installed skills by their catalog name or actual path. When an installation uses symlinks, resolve the skill directory with `realpath` before resolving relative paths to package-level agents, docs, or scripts. Slash examples in the guides are shorthand: Codex uses `$skill-name`, Claude plugins use `/pstack:skill-name`, and OpenCode supports natural-language skill requests plus slash commands when exposed.

## Authoring procedure

Create one directory per lowercase hyphenated skill name, with matching `name` and a concrete `description` in YAML frontmatter. Keep scripts and references with that skill. Discover available tools instead of assuming host-specific tools exist. Test the instructions on a representative task and a missing-capability case. Preserve explicit-only invocation policy where supported. Reload the host after adding or changing installed skills.

## Scope and permission

A workflow never grants permission by itself. Follow the user's authorized scope and the host's security rules. Sending messages, publishing, merging, deploying, deleting data, or changing external systems requires authorization for that action. Preserve explicit review and approval gates. Optional integrations and unrelated fixes do not expand the task.
