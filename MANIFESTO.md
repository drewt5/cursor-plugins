# Pstack fork manifesto

This repository extends pstack to additional coding tools while remaining a maintainable fork of its upstream source. It should make pstack easier to use, keep users in control of their existing environment, and make failures straightforward to understand and recover from.

These principles capture the priorities behind the fork. They guide design and review; they do not claim that every planned capability exists today. Installation defaults, release formats, schedules, and storage layouts are implementation choices. Change those choices when evidence shows a better way to satisfy these principles.

## P1. Remain a proper upstream fork

Keep upstream history, attribution, license, and repository structure. Preserve unrelated plugins. Keep the portability delta small enough to understand and review when upstream changes.

Prefer a shared runtime or a host adapter over separate copies of the workflow library. Preserve workflow intent when translating host capabilities. Account for upstream additions, removals, and behavior changes explicitly; a clean Git merge is not proof of feature parity.

Generally useful fixes should be separable from fork-specific adaptations so they can be proposed upstream. Follow [the fork maintenance guide](FORK.md) for the actual synchronization procedure.

## P2. Make the public fork usable on another machine

A user should be able to clone this public repository and follow its documented setup without relying on the maintainer's checkout layout, private files, credentials, or conversation history.

Make prerequisites explicit. Keep optional services optional. Record enough source and release identity to reproduce an installation or a failure. Do not describe a moving branch or modified checkout as an exact released version.

## P3. Make the ordinary path safe and short

Users should fall into the pit of success. Choose useful defaults, validate predictable failure conditions automatically, and keep ordinary installation and updates short.

Do not require users to understand manifests, select compatibility policies, run a diagnostic ritual, or repair internal files before they can use pstack. When a choice is genuinely necessary, ask for only that choice and explain its consequence. Automation must get a deterministic result rather than a guess or an unanswered prompt.

Error messages must identify what happened, what state remains, and the next supported action. Do not hide preparation steps behind claims of a one-command experience.

## P4. Respect the environment the user already owns

Users may have skills, plugins, configuration, and multiple installation scopes before pstack arrives. They may add or change them later. Coexistence is part of the product, not an unusual edge case.

Make ownership explicit. Matching content does not grant ownership. Preserve unrelated files, user configuration, and user edits through installation, updates, recovery, and removal. Never silently adopt, replace, disable, or delete another installation to make ours work.

Check what the host actually resolves where that information is safely available. Detecting a collision protects data, but rejection alone does not fulfill the coexistence goal. Provide a supported path or make the remaining limitation an explicit product decision.

## P5. Offer control without making users assemble the system

Let users choose the tools, scope, release, and supported preferences they need. A change to the surrounding environment must not silently expand pstack's installation or take over unrelated settings.

Keep the supported configuration coherent. Flexibility does not require every internal component to become an independently versioned or replaceable extension point. Add choices when they solve a real user need and can be explained, tested, and maintained.

Respect a user's explicit choices. Do not quietly replace a requested capability with a different workflow and call it equivalent.

## P6. Contain external change and make recovery practical

Upstream workflows, provider tools, and user installations change independently. Record those identities separately and isolate provider assumptions in the smallest useful host-specific code.

Test the behavior we rely on instead of treating a version string as proof of compatibility. Detect likely provider breakage early without making unrelated development depend on every new vendor release.

Prefer updates that can be validated before activation and recovered after interruption. Recovery must have a runnable path, preserve user-owned state, and avoid leaving a known inconsistent installation marked successful. State clearly what pstack can restore and what remains under the provider's or user's control.

## P7. Keep the wrapper inexpensive to maintain

Every additional layer, configuration switch, compatibility promise, persistent record, or background process needs a concrete benefit that exceeds its upkeep.

Reuse authoritative data and existing execution paths. Keep rules with one clear owner. Prefer bounded support contracts and direct modules to a general package manager, host emulator, or dependency solver built for hypothetical combinations.

Count the ongoing cost of an upstream merge, a provider update, a release, and a user support report. A design that simplifies the first implementation by making all future maintenance harder is a poor trade.

## P8. Verify regressions quickly and meaningfully

PR checks should exercise the supported installation contracts and actual host integrations while keeping feedback fast enough to use on every change.

Use reproducible baselines, isolated fixtures, bounded processes, and parallel execution where it helps. Test user-visible behavior and realistic failure paths. Keep new tests on an executed CI path; a test file that never runs provides no protection.

Do not trade away required coverage for a green result. Separate reproducible regression checks from discovery of new external breakage. Avoid redundant suites, timing-based tests, and exhaustive combinations that add cost without useful evidence.

## P9. Make evidence useful to people and agents

An agent monitoring a PR must be able to identify the current revision, the exact tools tested, the failing operation, its diagnostics, and a reproduction path. People should get the same facts in readable form.

Tie evidence to the relevant source commit, tested checkout, run, and attempt. Missing, stale, skipped, or unavailable evidence is not a verified pass. Preserve release evidence for the lifetime of the claim it supports, without retaining every transient log indefinitely.

## P10. State capabilities and limits honestly

Distinguish installed files, host discovery, invocation, and workflow behavior. Success at one does not prove all the others. A mock API round trip does not establish model reasoning; static checks do not establish GUI behavior.

Do not infer another host's capabilities from a model name or a familiar directory. Report uncertainty and unsupported combinations plainly. Diagnosis must not silently run unrelated hooks, mutate user settings, or make paid requests to obtain a reassuring result.

## Review a change against the manifesto

For a nontrivial change, identify the principles it advances and any tension it creates. Keep the review proportional to the change; do not turn these questions into a new user-facing approval ceremony.

- What becomes easier or more reliable for the user?
- What existing user state and upstream behavior must remain intact?
- What new responsibility or recurring cost does the fork take on?
- What evidence will prove the behavior and its failure paths?
- What limitation remains, and is the claim narrower than the evidence?

When principles conflict, describe the concrete tradeoff and choose the smallest supported design that meets the user's need. Do not silently weaken ownership, fidelity, or verification to close a task. Audit plans against these principles before implementation and verify outcomes afterward.
