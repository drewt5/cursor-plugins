# Claude Code

Load the native plugin with `claude --plugin-dir /absolute/path/to/pstack`, or install it through this repository's Claude marketplace. Plugin skills use `/pstack:poteto-mode` and `/pstack:setup-pstack`. The portable installer instead writes standalone skills under `.claude/skills/`, invoked as `/poteto-mode` and `/setup-pstack`. Choose one installation method to avoid duplicates.

The native plugin discovers `agents/*.md`. Use the registered names shown by `/agents`; plugin agents can be namespaced. Use the current Agent/task tool schema for delegation, permissions, and supported model aliases. Inherit the current model by default. Cursor model identifiers, cloud environments, and reasoning suffixes are not Claude model configuration.

`disable-model-invocation: true` keeps an explicitly invoked skill out of automatic selection. When a workflow needs such a skill, read its bundled file. Use native scheduling only if exposed in this session; otherwise save a handoff. History is scoped to the active project and accessed through supported session facilities or an explicitly supplied transcript.
