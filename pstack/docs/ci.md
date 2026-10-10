# Verify a pstack pull request

## Monitor the current revision

1. Record the PR's source head and URL. Select the fork that hosts the PR explicitly because GitHub CLI can infer the upstream repository from a fork checkout.

   ```sh
   gh pr view PR_NUMBER --repo drewt5/cursor-plugins --json headRefOid,url
   gh pr checks PR_NUMBER --repo drewt5/cursor-plugins --json name,state,link,description
   gh pr checks PR_NUMBER --repo drewt5/cursor-plugins --watch
   ```

2. Open the failed check's link to identify its workflow run and job. Use the run attached to this PR's checks, not the latest run on a branch.

   ```sh
   gh run view RUN_ID --repo drewt5/cursor-plugins --json headSha,event,status,conclusion,jobs,url
   gh run view RUN_ID --repo drewt5/cursor-plugins --log-failed
   ```

3. Download the artifact from that run and attempt. Artifact names are `pstack-CHECK-ATTEMPT`, such as `pstack-native-codex-1` or `pstack-portable-macos-latest-1`.

   ```sh
   gh run download RUN_ID --repo drewt5/cursor-plugins --name pstack-native-codex-ATTEMPT --dir /tmp/pstack-evidence
   cat /tmp/pstack-evidence/report.json
   ```

4. Check the report's repository, PR number, event, run ID, run attempt, and `sourceHeadSha`. The source head must match the PR head recorded in step 1. Check `testedSha` against the checkout in that run. A pull request normally tests a merge commit, so the tested checkout and source head can differ. Do not substitute the run's `headSha` for either field without checking the event.
5. Read the failed phase's `error`, command, and log. Run its `reproduce` command locally with the reported host version. Setup failures can block discovery and invocation. Missing evidence after a checkout or runner failure requires the native GitHub job logs.
6. Read the PR head again after collecting evidence. If it changed, collect the new revision's checks. A pending, absent, cancelled, or stale check does not verify the current PR.

The existing `watch-pr` helper can monitor named check failures and their links. It does not download evidence or diagnose assertions. Include the failed host, phase, assertion, tested version, and check link when reporting a regression.

## Reproduce a check

Run these commands from the repository root:

```sh
node pstack/scripts/test.mjs --unit
node pstack/scripts/test.mjs --helpers
node pstack/scripts/check-hosts.mjs codex
node pstack/scripts/check-invocation.mjs codex
```

Replace `codex` with `opencode` or `claude-code` for another host. The full suite remains `npm --prefix pstack test`. Install the CLI versions pinned in `.github/workflows/pstack-portability.yml` when reproducing a CI failure. Native jobs use Node 22 because the pinned Claude package requires it. Pstack's portable checks use its minimum supported Node 20.

## Maintain the pipeline

Run the portability workflow for every PR, pushes to `main`, merge queues, and manual dispatches. Its six parallel instances cover:

- Unit, installer lifecycle, package, and shell checks on Linux and macOS with Node 20.
- Bun helper tests and TypeScript checks once on Linux with Bun 1.3.12 and Node 20.
- Native discovery and mock API invocation separately for Codex 0.162.1, OpenCode 1.14.50, and Claude Code 2.1.296 on Linux with Node 22.

Native jobs install pinned npm packages into the runner's temporary directory and verify the CLI's reported version. Discovery failure does not suppress invocation after successful setup. The fixture uses isolated configuration and fake credentials. No paid model requests or repository secrets are required.

Cursor receives installer, manifest, and schema coverage. The workflow does not launch Cursor's GUI. Native smoke tests verify discovery and one `poteto-mode` expansion and response round trip, including both Claude installation methods. They do not prove every workflow's semantics, real-model reasoning, Windows behavior, or compatibility with untested CLI releases.

Each job writes atomic phase records and bounded raw logs outside the package checkout. `report.json` and `summary.md` derive from those records. Reports retain source and tested commit identities, host versions, phase commands, exit status, duration, errors, and reproduction commands. Artifacts expire after seven days. Failed or missing evidence and failed uploads fail the job. Checkout failure or runner loss can prevent artifacts, so the GitHub job result remains authoritative.

`Pstack required` rejects any prerequisite job group that is not successful. After this workflow lands and passes, configure the repository's branch protection or ruleset to require `Pstack required`. The workflow alone does not enforce merge protection. Update action and host pins in reviewed PRs and validate the hosted run before accepting a new baseline.
