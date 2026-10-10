# Codex

Discover local skills in `.agents/skills/` or `~/.agents/skills/`. Use the name shown in the skill catalog. This package is discovered as `$pstack:poteto-mode` and `$pstack:setup-pstack` by current Codex; hosts that omit namespaces may show `$poteto-mode` and `$setup-pstack`. A plugin distribution includes `.codex-plugin/plugin.json` and the portable root manifest.

Use delegation only when the current session exposes it. Tool names vary between CLI, app, and API sessions. Read the exposed schema; use a generic worker with the poteto-agent prompt when no custom role is registered. Model and reasoning overrides are optional. Do not write `config.toml` or enable experimental flags to make a workflow run.

Use the session's plan, question, shell, and wait tools where present, with the runtime's sequential and chat fallbacks. `agents/openai.yaml` preserves explicit-only invocation for skills that request it. A saved handoff is the fallback for unavailable session history or scheduling.
