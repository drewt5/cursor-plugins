# Benny

Benny triages Slack issue reports and reproduces confirmed bugs, with optional bounded draft fixes. It is an optional integration pack, not a background service installed by pstack.

1. Point your agent at [FOR_AGENTS.md](./FOR_AGENTS.md) and name the target repository.
2. Copy the pack to `.pstack/automations/benny/`, preserving local changes and destination-only files.
3. Install pstack for the host used by the runner. Keep user configuration in `.pstack/benny/`, outside the pack. Adapt the [configuration example](./templates/configuration.example.yaml).
4. Configure Slack, the issue tracker, the app control adapter, the feature map, and a supported scheduler. Without a scheduler, run the operational files explicitly in a foreground session against a supplied report.
5. Review the proposed configuration and test thread safety before enabling event-driven runs. No scheduler or messaging account is created by installing pstack.

The operational `SKILL.md` files are read directly, not registered as slash skills. Remote runners need a committed copy of the pack and the shared pstack skills in their checkout. Never put secrets in either location.
