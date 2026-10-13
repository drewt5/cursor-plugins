# Pstack logging policy

This policy governs output from pstack commands. It applies to new output and changes to existing output. User commands explain the result, remaining risks, and the next supported action. Maintainer commands retain the evidence needed to reproduce a failure.

The policy implements the ordinary-path, recovery, maintenance, evidence, and honesty priorities in [the manifesto](../../MANIFESTO.md). [Installation documentation](install.md) describes available commands. [The CI protocol](ci.md) defines maintainer verification.

## Audiences and detail

Human output defaults to a concise result. `--verbose` adds diagnostic detail without changing the operation, probes, exit status, or safety decisions. No additional debug flag, log-level environment variable, logging dependency, persistent log, or telemetry service is required.

| Kind | Meaning | Default presentation |
| --- | --- | --- |
| Result | The operation completed, made no changes, or produced a requested report. | Scope, affected hosts, and outcome. Include a next step when one is needed. |
| Note | A relevant limit that does not require immediate action. | One short explanation. Combine repeated discovery limitations. |
| Warning | A remaining risk, degraded capability, or unfinished cleanup. | What is affected, the consequence, and a supported response. Always visible. |
| Error | The requested operation failed. | What failed, the state left behind, and the next supported action. Always visible. |
| Detail | Internal facts useful during diagnosis. | Available through `--verbose` or an existing machine-readable report. |

A warning does not imply a failed command. An unavailable check does not imply a broken installation. Finding severity and verification remain separate facts. Formatting never changes either fact to make an operation appear successful.

Normal output omits diagnostic codes, classification names, raw JSON, routine probe traces, and maintainer verification instructions. Unknown warning or error codes remain visible with their subject and supported action. Their code can appear as a fallback identifier until a specific explanation exists.

## Message content

Each message identifies a concrete condition and its effect on the user. A supported action names a usable command or a specific task. Generic advice such as "collect native compatibility evidence" does not belong in ordinary installation output.

| Condition | Required message |
| --- | --- |
| Native discovery unavailable | Installed files and host loading are separate checks. State that host loading was not checked, once. Do not imply a failed installation. |
| Untested host version | Show the observed version and the recorded tested version. Explain that compatibility is unverified. Installation can proceed if structural checks pass. A provider version change remains the user's choice. |
| Duplicate scopes | Identify the host and relevant scopes. Explain that the active source is unknown. Give the supported scoped removal or inspection action. |
| Missing managed file repaired | Report the successful result or repair. Do not continue asking the user to repair the resolved condition. |
| Modified or conflicting path | List each affected path, explain that user content was preserved, and give the supported way forward. |
| Cleanup pending | Identify the remaining cleanup and recovery action. Do not describe the entire operation as fully complete. |
| Interrupted operation | Show the retained recovery command when available. Preserve distinctions between active, dead, and unverifiable locks. |

Paths and host versions belong in normal output when they help the user act. Exact wording is not a machine interface. Diagnostic codes and JSON schemas are machine interfaces.

## Operation state

Successful install and update output uses the final report. Earlier findings that the operation resolved are not current warnings or errors. An unchanged operation uses its current available report. Verbose history, if included, is explicitly labeled as an earlier observation.

A failed preflight prints its reasons once. The message distinguishes rejection before any changes from rejection after automatic recovery. A `preflight-failed` result alone does not prove that no files changed during the whole command.

Failed verification identifies the attempted installation and whether the prior installation was restored. Restoration does not establish that the prior installation passed a new verification. A failed or incomplete restoration retains its recovery action and unsuccessful exit status.

Partial uninstall names removed hosts and remaining hosts. It never describes the operation as an installation because some hosts remain. A no-op says that nothing needed removal or installation. These distinctions come from existing operation results and plans.

Normal success does not claim host discovery, invocation, model reasoning, or GUI behavior beyond the available evidence. Restart advice is appropriate after installed instructions change. Uninstall does not claim to verify provider startup.

## Streams and machine compatibility

| Command mode | stdout | stderr |
| --- | --- | --- |
| Human install, update, uninstall | Scope, result, and relevant notes. | Warnings, errors, and the early recovery instruction. |
| Human doctor | The requested diagnostic report, including its findings. | Usage or diagnostic execution errors. |
| Install `--dry-run` | The existing JSON plan. | Execution or usage errors. |
| Doctor `--json` | The existing JSON report. | Execution or usage errors. |
| Recovery and rollback | Their existing JSON results. | Recovery notices and human failure diagnostics. |
| Maintainer checks | Existing test output and evidence contracts. | Existing failure diagnostics. |

Doctor's human report stays together because the user requested a report. Its exit code communicates actionable failure. Other human commands send warnings and errors to stderr. Receiving stderr is not itself evidence of a nonzero exit.

Existing JSON keys, schema versions, verification states, and exit codes remain unchanged by this migration. When a command emits a machine result, stdout contains a single JSON value and no prose. Existing failure paths may emit only stderr, including rollback preflight rejection. `--verbose` never adds text or changes the payload in `--json` or `--dry-run` mode. Machine mode takes precedence. Recovery and rollback retain their current default JSON results rather than switching silently to human defaults.

Plain text works through SSH, pipes, and redirected files. Default output has no timestamps, ANSI color, spinner, or cursor movement. Output is deterministic except for facts from the operation.

## Recovery instructions survive interruption

The exact retained recovery command is an intentional exception to terse default output. The command is emitted after its journal and recovery instruction file are durable, before the first activation mutation. It is never deferred until the final summary or hidden behind `--verbose`.

The activation library exposes one optional recovery-ready callback through the existing controls argument. The CLI supplies the writer. The callback receives the authoritative command built by the existing recovery code. The activation library awaits the callback before the existing `prepared` test boundary. The CLI callback resolves after its stream write completes, so activation does not race delivery of the command. Normal direct library use has no presentation side effect from activation.

CLI recovery instructions go to stderr, including during rollback, so JSON stdout remains parseable. Interruption fixtures explicitly supply a notification callback and verify its timing. Preserve the existing command quoting, retained executable identity, and recovery file. Do not reconstruct commands from guessed release paths.

## Code ownership

Existing operation outcomes, plans, and diagnostic findings remain authoritative. A finding has a code, severity, subject, evidence, action, and verification state. The presentation code consumes these values without running probes or changing installation state.

A shared presentation module owns human explanations, visibility, deduplication, and safe detail selection. A map keyed by finding code supplies wording. Install and doctor reuse that map. Conflicts and discovery failures use their existing structured shapes. Unknown warnings and errors have a visible fallback.

Pure renderers accept existing outcomes or reports and explicit CLI context. A human operation renderer returns `{ stdout, stderr }` text. Doctor can return one report string. CLI entrypoints own argument parsing, stream writes, machine serialization, and exit status. Renderers do not inspect process arguments, environment settings, or filesystem state.

There is no general event bus, second diagnostic schema, logger singleton, or severity remapping layer. The recovery callback handles the one message that must be delivered before an operation returns. Remove replaced human-formatting paths and migrate every caller in the same change.

Supported action text stays with the existing finding producer when it already explains a user action. Rewrite maintainer-only actions at that source when the user-facing meaning applies to all consumers. Action strings in JSON may change with wording improvements. Their fields, diagnostic codes, and supported meaning remain compatible. Presentation may compose a copyable scoped command from explicit CLI context. It never suggests deleting a receipt, lock, or user file to silence a finding.

## Sensitive data and unexpected failures

Normal and verbose human renderers select known diagnostic fields. Useful detail includes finding codes, verification states, host versions, configured paths, release identity, and probe status. Renderers never serialize an entire report, journal, receipt, error object, or arbitrary evidence object into human output.

Credentials, environment dumps, model configuration contents, file contents, prompts, raw provider stdout or stderr, and stack traces do not belong in human diagnostic detail. Escape terminal control characters in displayed untrusted fields. Recovery commands retain executable quoting.

Keep required filesystem paths and supported recovery instructions in failures. Existing transaction exceptions can contain recovery state and commands, so a generic "something went wrong" replacement is not acceptable. This migration does not redesign all transaction exceptions or promise comprehensive redaction of legacy exception strings.

Existing JSON evidence can contain bounded provider output and error text. Its schema is preserved here. This policy does not claim those legacy machine reports are fully redacted or safe to publish without inspection. New output must not expand that exposure.

## Adoption and verification

The first implementation covers human installation, repeated installation for updates, uninstall, doctor, shared rollback preflight diagnostics, and activation recovery notices. It adds `--verbose` to install, uninstall, and doctor. Recovery and rollback retain their default JSON results. Existing maintainer check logs, CI artifacts, provider behavior, installation ownership, and transaction algorithms remain outside this presentation change.

Future changes to CLI messages follow this policy and add behavioral coverage through the existing test entrypoints. The first migration must demonstrate these outcomes:

1. A fresh install identifies scope and hosts, reports success honestly, and gives one discovery limitation and a restart step.
2. A conflicting install reports each affected path without duplicate diagnostics, preserves files, exits unsuccessfully, and prints no success summary.
3. A successful repair does not present resolved preflight findings as current failures.
4. Untested versions, duplicate scopes, unknown warning or error codes, and unfinished cleanup remain visible in normal output.
5. Failed verification names restoration accurately. Preflight rejection after automatic recovery does not claim that the entire command changed nothing.
6. Partial uninstall and no-op removal describe the actual operation and remaining hosts.
7. Verbose output adds useful identifiers and safe detail without new probes, state changes, or exit-code changes.
8. Doctor JSON and dry-run JSON keep their existing shapes. Recovery and rollback stdout remain parseable JSON. Verbose does not contaminate machine output.
9. An interrupted operation captures the exact recovery command before mutation. That command still works after the source checkout is removed.
10. Sentinel secrets in environment values and arbitrary diagnostic evidence are absent from new normal and verbose human output. Direct activation calls are silent unless a callback is supplied.

Use spawned CLI tests for argument handling, streams, and exit status. Use pure renderer tests for rare outcomes and unknown findings. Reuse the existing isolated homes, projects, fake host versions, and interruption fixtures. The required unit entrypoint is `node pstack/scripts/test.mjs --unit`. Hosted verification follows [the CI protocol](ci.md).

[The contribution guide](../../CONTRIBUTING.md) links this policy so future contributors can find it before changing output.
