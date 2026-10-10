# Verify a pstack pull request

## Keep the PR branch current

Before declaring work complete, verify both branch freshness and checks. Start in the PR's clean worktree with the task claim held. Confirm the PR's base and source head:

```sh
gh pr view PR_NUMBER --repo drewt5/cursor-plugins --json baseRefName,headRefOid,url
git rev-parse HEAD
```

The local `HEAD` must match the PR's `headRefOid` before using local ancestry as evidence for that PR. For a PR targeting `main`, run:

```sh
git fetch origin main
git rev-parse origin/main
git merge-base --is-ancestor origin/main HEAD
```

An ancestry exit code of 0 means the fetched base is included; 1 means the branch needs updating. Other errors are not proof of freshness. For a stacked PR, substitute its actual base branch. After its prerequisite merges, retarget to `main` and repeat verification.

If the branch is behind, merge the fetched base into the owned PR branch, resolve conflicts, run the checks relevant to the resolution, and push. For a normal PR:

```sh
git merge origin/main
git push
```

Do not reset or overwrite another agent's work. If you use a rebase on your own branch, preserve the upstream-sync ancestry requirements in `FORK.md` and use an explicit lease for any rewritten push. Wait for checks on the new PR head using the protocol below. A conflict-free merge or an earlier green run is not verification of the updated branch.

Immediately before handoff, fetch the base again, repeat the ancestry check, and read the PR head again. If the head changed or the base is no longer included, repeat the update and verification cycle. Record the verified base SHA, PR head SHA, and check run in the handoff. If updates or checks cannot finish, report the work as pending rather than complete. This establishes freshness at handoff; a later base change requires a new check before merge.

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

Replace `codex` with `opencode` or `claude-code` for another host. The full suite remains `npm --prefix pstack test`. Install the CLI versions recorded in `pstack/tested-hosts.json` when reproducing a CI failure. Native jobs use the Node runtime recorded for each host in that metadata (currently Node 22). Pstack's portable checks use its minimum supported Node 20.

## Maintain the pipeline

Run the portability workflow for every PR, pushes to `main`, merge queues, and manual dispatches. Its six parallel instances cover:

- Unit, installer lifecycle, package, and shell checks on Linux and macOS with Node 20.
- Bun helper tests and TypeScript checks once on Linux with Bun 1.3.12 and Node 20.
- Native discovery and mock API invocation separately for the three exact host versions and Node runtimes in [tested-hosts.json](../tested-hosts.json) on Linux.

The `Pstack host matrix` preparation job validates exactly one row for Codex, OpenCode, and Claude Code and emits the native matrix. It runs alongside portable and helper checks; only native checks wait for it. A short preparation job is retained so invalid or incomplete metadata fails before any host installation. It adds checkout/runtime setup to the native critical path, rather than a second suite. Compare hosted job/phase timings when changing this pipeline; queue time varies between runs.

The metadata is a tested baseline for the recorded capabilities, not a supported semver range. Package engines and a successful version probe do not establish discovery or invocation behavior. Capabilities describe these fixtures only: Claude plugin inventory is not standalone discovery, and mock invocation is not model reasoning. Portable Node and Bun pins remain in the workflow because they are not shared native-host inputs.

To propose a new baseline, edit the host's single version field, keep package/executable mappings fixed, and run:

```sh
node pstack/scripts/host-matrix.mjs
npm --prefix pstack test
```

The matrix validator is exercised by `test.mjs --unit` in both required portable lanes. Native checks probe the installed executable before discovery/invocation. They default to the metadata version; `PSTACK_HOST_VERSION=EXACT_VERSION` explicitly selects an expected candidate version for local reproduction or future advisory checks. CI supplies this value from the validated matrix. Reports retain the tested baseline, expected and actual versions, package, executable, required Node runtime, and fixture capabilities. Updating a version requires reviewed passing native checks; the version probe alone is insufficient.

Native jobs install pinned npm packages into the runner's temporary directory and verify the CLI's reported version. Discovery failure does not suppress invocation after successful setup. The fixture uses isolated configuration and fake credentials. No paid model requests or repository secrets are required.

Cursor receives installer, manifest, and schema coverage. The workflow does not launch Cursor's GUI. Native smoke tests verify discovery and one `poteto-mode` expansion and response round trip, including both Claude installation methods. They do not prove every workflow's semantics, real-model reasoning, Windows behavior, or compatibility with untested CLI releases.

Each job writes atomic phase records and bounded raw logs outside the package checkout. `report.json` and `summary.md` derive from those records. Reports retain source and tested commit identities, host versions, phase commands, exit status, duration, errors, and reproduction commands. Artifacts expire after seven days. Failed or missing evidence and failed uploads fail the job. Checkout failure or runner loss can prevent artifacts, so the GitHub job result remains authoritative.

`Pstack required` requires exactly the preparation, portable, helpers, and native groups, rejects every unsuccessful result, and revalidates the prepared matrix against the complete checked-in baseline. Missing preparation output or a partial matrix cannot pass. After this workflow lands and passes, configure the repository's branch protection or ruleset to require `Pstack required`. The workflow alone does not enforce merge protection. Update action and host pins in reviewed PRs and validate the hosted run before accepting a new baseline.

## Latest-provider advisory checks

`Pstack provider canary` runs on Monday at 13:17 UTC and supports a manual run against the fork default branch. It resolves each package's npm `latest` tag once, rejects prerelease/malformed results, saves exact versions and engine requirements, and installs those exact versions with `npm --engine-strict`. A new unsupported Node runtime is a red setup failure (`EBADENGINE`), not an omitted host. It uses the same discovery, mock invocation, installation helper and evidence reporter as the pinned baseline. It does not change `Pstack required` or update any user's providers.

Maintainers responsible for drift triage must subscribe to GitHub Actions workflow notifications for this repository (GitHub notification settings, Actions, including failed workflows). Check the Actions tab's **Pstack provider canary** runs and job summaries; download `pstack-canary-resolution-ATTEMPT` and the three `pstack-canary-HOST-ATTEMPT` artifacts promptly because retention is seven days. GitHub can delay scheduled jobs and disables schedules after 60 days of inactivity in public repositories. A schedule file is not evidence that a particular weekly run executed. No unattended response or support SLA is promised.

```sh
gh workflow run pstack-canary.yml --repo drewt5/cursor-plugins --ref main
gh run list --repo drewt5/cursor-plugins --workflow pstack-canary.yml --limit 5
gh run view RUN_ID --repo drewt5/cursor-plugins --json headSha,event,status,conclusion,jobs,url
gh run download RUN_ID --repo drewt5/cursor-plugins --dir /tmp/pstack-canary-RUN_ID
```

Select the exact run created by the dispatch and compare its source commit, tested checkout, run ID/attempt and resolved versions before attribution. `resolution.json` retains every host's registry outcome; `report.json` retains setup/discovery/invocation commands, assertions, versions and reproduction paths. Infrastructure or checkout failure may prevent artifacts, so read native job logs too. Registry failures are resolution failures; runtime/download/install failures are setup failures; discovery and protocol failures have separate phases. Genuine failures remain red and are advisory: pinned PR checks remain the reproducible gate. No auto-created issues, external messages, provider updates, releases or protection changes occur.

A safe failure demonstration is available through `--field fixture=probe-failure`. It intentionally fails Codex's advisory invocation phase after setup/discovery; other hosts still run. The default `none` executes real mock invocation for every host. This fixture never changes the required PR workflow and is not a provider regression.
