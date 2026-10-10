# Cursor

The existing `.cursor-plugin/plugin.json` remains supported. Invoke `/poteto-mode` and `/setup-pstack` from the skill menu. Use the current Task schema for local or cloud agents only when those capabilities exist. Never assume that another host accepts Cursor's Task parameters.

Pstack now reads `.pstack/models.json` and the user config path documented in the runtime. Legacy `~/.cursor/rules/pstack-models.mdc` is not the shared configuration. If the user requests migration, read its role choices, validate them against current available models, and write the portable JSON. Remove an obsolete rule only with authorization.

Use a transcript path supplied for the active workspace, without searching unrelated projects. Cursor's loop command and cloud automations are optional host integrations; the portable workflows also work within an ordinary foreground session.
