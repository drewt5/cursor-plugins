---
name: setup-pstack
description: Configure optional pstack model roles and reasoning preferences for the current host. Use for setup-pstack, configure pstack models, or changing pstack's model choices.
metadata:
  opencode/slash: "true"
---

Before starting, read the **pstack-runtime** skill at `../pstack-runtime/SKILL.md`.

# Setup pstack

Pstack works without configuration. Every role inherits the current model, and review panels use two distinct lenses on that model by default.

1. Inspect the session's delegation capabilities and available model identifiers. Do not invent identifiers or require model enumeration when the host does not expose it.
2. Read the project `.pstack/models.json` and user `$XDG_CONFIG_HOME/pstack/models.json` or `~/.config/pstack/models.json` if present. Project roles override user roles. Optional `hosts` entries keyed by `codex`, `opencode`, `claude-code`, or `cursor` contain host-specific `roles` and `reasoning`; each host layer overrides its scope’s base layer. Use host-specific entries for provider-specific model IDs. Preserve unrelated role entries and settings.
3. Ask only for preferences the user has not supplied: project or user scope, model overrides, and optional reasoning effort. Offer inheritance as the default. Explain when the host cannot change models per worker. Reasoning is a separate optional preference, never a model-name suffix.
4. Show the resulting choices. Validate explicit models against the current host's supported choices. `auto` and `inherit-parent` mean no override. Panels are nonempty arrays, one seat per entry. Keep two inherited seats unless the user chooses a different count.
5. Write the selected JSON file, preserving other configuration. Do not write Cursor rules or host configuration. Re-running with the same choices leaves the same state.
6. Run the runtime model resolver for the current host to validate the result. For an installer-managed OpenCode installation, rerun `node <package-root>/scripts/install.mjs --target opencode --project <project-root>` (or `--global` for a user installation), then reload OpenCode. This generates native model agents without changing `opencode.json`.
7. Report the file and any unsupported preferences. Each workflow reads this file when invoked. Offer a project verification skill only if the user needs one and the project lacks a harness.

Example configuration:

```json
{
  "version": 1,
  "roles": {
    "feature, refactoring": "inherit-parent",
    "bug-fix": "inherit-parent",
    "perf-issue": "inherit-parent",
    "hillclimb": "inherit-parent",
    "judgment and prose": "inherit-parent",
    "hardest tasks": "inherit-parent",
    "how explorer": "inherit-parent",
    "how explainer": "inherit-parent",
    "why investigators": "inherit-parent",
    "why synthesizer": "inherit-parent",
    "reflect tooling": "inherit-parent",
    "reflect judgment, divergent, synthesizer": "inherit-parent",
    "arena runners": ["inherit-parent", "inherit-parent"],
    "arena cross-judge pool": ["inherit-parent"],
    "swarm workers": "inherit-parent",
    "architect runners": ["inherit-parent", "inherit-parent"],
    "interrogate reviewers": ["inherit-parent", "inherit-parent"]
  }
}
```

Optional `reasoning` is a string preference supported by the active host. Omit it to inherit. An unavailable reasoning setting is reported and left to the host default. Invalid JSON or invalid role types must be reported, not silently treated as a valid configuration.
