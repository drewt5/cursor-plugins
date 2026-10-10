# Reserve work for a local coding agent

Local agents must acquire a claim before editing a task. Run the command in a checkout of this fork, using Node 20 or newer and your existing Git push credentials. No cloud agent, Actions job, paid API, or background process is involved. GitHub holds a small reservation branch so agents in separate worktrees, clones, or machines see the same claim.

This protocol coordinates agents that follow `AGENTS.md`. It does not prevent a person or tool with repository write access from ignoring the protocol. Claims reserve tasks, not individual files; different issues touching a shared interface still need coordination.

## Acquire before editing

Read the issue, related work, existing PRs, and any handoff first. If a PR already implements the task, review or resume it instead of starting a duplicate implementation. Independent read-only investigation does not require a claim.

For an existing issue, always use `issue-N`. For authorized work without an issue, agree on one short `task-description` key and reuse it. Do not create alternate keys to bypass an existing claim. Use the child issue for implementation, not its umbrella tracker.

```sh
node pstack/scripts/task-claim.mjs acquire issue-4 "Codex local session: planner refactor"
```

Use an owner description that identifies the local session, not just the GitHub account shared by all your agents. Avoid private paths or secrets; claim metadata is public. Save the printed key and token in your session handoff. The token is a claim identity, not a credential.

Start editing only after `Claim acquired`, or after `verify` confirms your candidate token following a lost network response. The command creates a unique `claims/issue-4` branch atomically. A simultaneous contender cannot replace it. The metadata commit uses the current remote `main` tree and does not change your working branch, index, or files. Create your implementation branch and isolated worktree separately, as described in [CONTRIBUTING.md](../../CONTRIBUTING.md). Do not develop on or open PRs from reservation branches.

If acquisition fails, inspect the claim and choose other work or arrange a handoff. Do not assume a network or permission error means the task is free.

```sh
node pstack/scripts/task-claim.mjs status issue-4
node pstack/scripts/task-claim.mjs verify issue-4 TOKEN
```

Replace `TOKEN` with the exact 40-character value printed during acquisition. `status` identifies the owner and acquisition time; it does not grant ownership. The script accepts only this fork's `origin` push URL and fails closed if GitHub cannot be reached. If your agent cannot push, have an authorized coordinator reserve the task and explicitly hand it off. Do not silently switch to an isolated local lock.

## Keep ownership clear

Keep the claim while editing and fixing checks. Verify it after a session resumes, before pushing, and before changing a shared PR. If verification fails, stop mutations and preserve your work for handoff. Do not reacquire under a new key and continue.

A parent agent can delegate parts of its claimed task without competing claims when it owns integration and gives workers separate write scopes. Independent sessions must not share a token as permission to edit concurrently. For separate issues with overlapping changes, coordinate the interface or serialize the work; two valid task claims do not make shared files safe.

Include the key, owner, and token in the PR handoff so a future local session can find the reservation. Assignment and comments can help discovery, but they do not replace the atomic claim.

## Release or hand off

When you stop active work, preserve the branch and leave a handoff identifying the PR or saved work, checks, and next action. Stop delegated writers too. Then release the claim:

```sh
node pstack/scripts/task-claim.mjs release issue-4 TOKEN
```

A review-ready PR can remain open after release. The next agent must read that PR, acquire a new claim on the same issue, and resume it. Release is not issue completion, PR approval, or permission to merge. A delayed release with an old token cannot delete a replacement claim.

There is no automatic expiry or heartbeat. A quiet local agent may still be editing, so elapsed time alone never authorizes takeover. If the owner disappears, confirm with the user or coordinator that the session and its workers have stopped. Preserve any available work, inspect the current token with `status`, and release that exact claim only after explicit takeover authorization. Then acquire a new claim. Never force-push reservation branches or delete them by name alone.

The helper uses Git's conditional ref creation and deletion with an explicit expected value. These are cooperative ownership checks, not access control against other repository writers. Automatic cleanup must not delete `claims/*` branches.
