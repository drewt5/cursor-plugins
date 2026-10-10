# Set up pstack

Follow the [installation instructions](../../README.md#install) for Codex, OpenCode, Claude Code, or Cursor. Restart the host after installation. No model setup is required.

## Run your first task

Invoke `poteto-mode` with the syntax for your host in the README and a concrete task:

```text
Use the poteto-mode skill to add a --json flag to this command. Keep text output byte-identical and verify both.
```

The skill reads the runtime contract, selects a playbook, and records its steps in a plan or Markdown checklist. Each skipped step keeps a reason.

## Configure models only if needed

Invoke [setup-pstack](../../skills/setup-pstack/SKILL.md) to choose optional model roles. All roles inherit your current model by default. Review panels use two seats with distinct lenses. Additional model choices depend on the host's delegation capabilities and your account access.

Project choices live in `.pstack/models.json`. User choices live in `$XDG_CONFIG_HOME/pstack/models.json` or `~/.config/pstack/models.json`. Project roles override user roles. Delete a role to restore inheritance. Workflows read configuration when invoked; no always-applied rule is needed. Reasoning effort is a separate optional preference, not part of a model identifier.

## Give the agent a verification path

If the project lacks a way to drive its real behavior, invoke `create-verification-skill`. It uses available terminal or browser tools and writes a project skill in the active host's supported location. Existing test and verification harnesses can be reused.

## Keep the cost in check

Use smaller panels, supported cheaper models, or sequential review passes. A same-model review is not independent multi-model evidence. Reserve the full workflow for tasks that need it.

Invoke `poteto-mode` at the start of each new task. Persistent modes are host-specific. Long runs use available scheduling or stay within the active session and save a handoff.

Next: [Route work through poteto-mode](./02-poteto-mode.md).
