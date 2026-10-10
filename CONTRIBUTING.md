# Contribute to portable pstack

This process applies to people and agents working on the portability fork. It covers future fixes and features as well as the current roadmap. Keep the process proportional: a small fix needs a clear scope and verification, not a design document.

## Turn a report into verified work

Use [the issue protocol](pstack/docs/issues.md) to report a problem, prepare a task, or split a plan. Human reports can start with a few sentences. The contributor taking on the work supplies implementation detail; the reporter does not need to understand the codebase.

The workflow is report, triage, ready task, implementation, verified PR, and closure. These are working stages, not required labels or a new approval system. Before implementation, establish observable acceptance criteria and a verification plan. At handoff, show the evidence for those same criteria and update the relevant documentation. A filled template alone proves neither readiness nor completion.

## Start with the right context

1. Read [AGENTS.md](AGENTS.md). For nontrivial design or scope decisions, read [MANIFESTO.md](MANIFESTO.md), which records durable priorities rather than shipped features.
2. Read the assigned issue, its blockers, and the relevant prerequisite PRs. Use [FORK.md](FORK.md) for upstream boundaries and synchronization, and [the CI protocol](pstack/docs/ci.md) for verification.
3. Inspect current code and tests before choosing an implementation. Issue paths, signatures, and commands may describe deliverables that do not exist yet. Verify that prerequisite behavior has landed; a closed issue alone is not proof.

Use GitHub issues for a task's scope, acceptance criteria, dependencies, and status. A tracking issue organizes a particular program of work; it is not the permanent contribution guide. Code and tests define implemented contracts. Documentation explains their use and limits.

Select the fork explicitly in GitHub CLI commands, since a fork checkout can otherwise select upstream:

```sh
gh issue view ISSUE_NUMBER --repo drewt5/cursor-plugins
```

## Isolate the work

Fetch current `origin/main` and start a dedicated branch and worktree for the assigned task. Do not assume a local `main` is current. For example, replace `123` and the description with your task:

```sh
git fetch origin main
git worktree add -b fix/123-description ../pstack-123 origin/main
cd ../pstack-123
```

Check existing changes before editing. Preserve work owned by the user or another agent; do not reset a shared checkout or force-push someone else's branch. Keep one coherent task per PR. Coordinate overlapping files and shared interfaces before parallel implementation, even when the issues have no formal dependency. Prefer landing prerequisites before starting dependent work; if a stack is necessary, identify its base PR and verify again after rebasing onto the merged result.

Keep changes inside pstack and its fork documentation and CI unless the task explicitly calls for more. Preserve other plugins and upstream workflow intent. Run installation and recovery tests in temporary homes and projects, with fake credentials. Tests must not modify the contributor's installed skills, configuration, or repository protection rules.

## Resolve gaps without inventing a second plan

Make routine implementation choices within the issue's scope. Do not ask for approval for every file name or internal function. If code or experiments contradict the plan, record the concrete evidence, the proposed adjustment, and its effect on acceptance criteria or downstream tasks in the PR or issue. Update affected documentation and dependencies when authorized; otherwise include the exact proposed changes in the handoff.

Do not silently weaken acceptance criteria, expose an unfinished feature, or add a compatibility layer just to satisfy contradictory tickets. Continue independent work while a material product or contract decision needs clarification. Raise that specific decision with the task owner; unrelated implementation choices can proceed.

Keep each fact in its natural home:

- Durable priorities belong in `MANIFESTO.md`.
- Reusable contribution rules belong here, with a short entry point in `AGENTS.md`.
- Task scope and ordering belong in issues and their native dependency links.
- Implemented interfaces and invariants belong beside their code and regression tests.
- User-facing behavior belongs in the relevant installation or usage documentation.
- Verification commands and evidence interpretation belong in `pstack/docs/ci.md`.

Avoid a separate contract registry or copied checklists in every issue. Add an architecture note only when a cross-module decision cannot be understood reasonably from the implementation and its existing documentation.

## Verify the behavior

Run checks appropriate to the change using [the CI protocol](pstack/docs/ci.md). Add regression tests that demonstrate changed behavior and discover them through the existing required test entry points. A test that is never executed by CI provides no PR protection. Exercise host behavior in the matching native lane; keep fixtures isolated and the matrix bounded.

For documentation-only changes, check actual commands, links, and consistency instead of adding tests that merely assert prose. Record checks that could not run and why. Mock invocation proves loading and a protocol round trip, not model reasoning or Cursor GUI behavior.

Open a PR against the fork's `main` branch and monitor its current head through completion. Follow the CI protocol to inspect failed logs and artifacts, compare source and tested commits and run attempts, and recheck the PR head after collecting evidence. Missing, pending, cancelled, or stale checks are not verification. Fix failures caused by the change; identify infrastructure failures with evidence rather than treating them as a pass.

## Leave a usable handoff

The PR should let someone with no conversation history review and continue the work. Include:

- The problem, resulting behavior, and issue resolved. Use closing keywords only for the individual issue fully resolved by the PR; do not close an umbrella tracker from a child task.
- Acceptance evidence: commands and results, relevant hosted checks, and material limits or untested behavior.
- A result for each acceptance criterion, grouped when one test covers several. Link to regression tests and updated user or maintainer documentation, or explain why documentation is unaffected. Distinguish checks actually run from planned checks.
- For shared foundations, the actual modules and public interfaces, ownership and state invariants, and representative tests downstream work should reuse. Link to these artifacts rather than copying a second specification.
- Any departure from the issue, remaining work, and affected downstream tasks. Distinguish implemented behavior from internal scaffolding and future public activation.

Use a concise conventional commit title such as `fix(pstack): preserve unrelated skills`. Keep PR detail proportional to the change. Follow the upstream-sync merge instructions in `FORK.md` for ancestry-preserving updates.

An agent's default finish is a reviewable PR with current verification and a clear handoff. Merge only when the user or task explicitly authorizes it. After an authorized merge, verify the merge result, ensure the resolved issue's status is accurate, and update affected downstream issues when the landed contract differs from their assumptions. Do not mark a dependent task complete merely because its prerequisite merged.
