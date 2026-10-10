# Prepare an issue for implementation

Use this protocol with [CONTRIBUTING.md](../../CONTRIBUTING.md), which covers implementation through PR handoff. It applies to portable pstack work in this fork. Templates provide prompts; they do not enforce scope or replace review.

## Report a problem or idea

Human-created issues can be informal. Describe what you tried, what happened, and what you wanted instead. For an idea, describe the outcome you want and why it helps. Use the short report template or a blank issue. Partial information is welcome.

If readily available, include the host, operating system, pstack revision, tool versions, reproduction steps, or a short error excerpt. These details are optional at intake. Remove credentials and private content. Reporters do not need to propose an architecture, identify files, plan tests, or create dependencies.

Do not reject a useful report because it lacks the implementation template. The maintainer or agent taking it on owns the missing investigation. Ask the reporter only for facts that cannot reasonably be recovered from code, tests, or a local reproduction.

## Triage before promising a fix

Search existing issues and current code for the same problem. Link related work and verify whether the behavior already changed. Preserve the reporter's original observation when adding findings. With issue-edit authorization, add a clearly separated implementation plan; otherwise put the proposed plan in the handoff for the owner to apply.

Record confirmed behavior separately from hypotheses. For a bug, try to reproduce it and identify the expected behavior. If reproduction is unavailable, state what evidence is missing. A report is not an authorization to implement every suggested solution.

If a product decision or unknown technical behavior prevents a bounded task, first define an investigation with a concrete question and expected evidence. Do not invent implementation details to make an uncertain task look ready. An investigation can finish with findings and follow-up tasks rather than a code PR.

## Prepare a task an agent can pick up

Agents creating implementation issues must inspect the relevant current code and supply the following information. Humans can use the same template, or leave this preparation to the contributor who takes the report. Use a few sentences for a small fix; keep detail proportional to risk.

- State the problem, desired observable result, and scope boundaries. Include evidence or reproduction steps and the inspected revision when code-specific claims depend on it.
- Identify relevant existing code and tests. Distinguish confirmed constraints from proposed files, commands, and interfaces. Explain decisions that matter to callers or later tasks; leave routine internals to the implementer.
- Write acceptance criteria as outcomes someone can verify. Include the normal case and relevant failure or preservation behavior. For changes to installed files, address ownership, unrelated user content, interrupted operations, and retries where affected. For host changes, name the supported installation methods affected and any limits.
- Describe how those outcomes will be tested. Identify the existing test entry point and required CI lane that will execute new regression coverage. Use [the CI protocol](ci.md) for commands and evidence rules. Name necessary native or manual checks and their limits. For docs-only work, verify commands, links, and factual claims; do not manufacture behavior tests.
- Name affected user or maintainer documentation, or state why none is needed. If a change adds an interface used downstream, identify the contract and test evidence the PR must hand off.
- List actual blockers and related work separately. State `None` when there are no blockers. Record material open questions and whether they block implementation.

A task is ready when its outcome, boundaries, prerequisites, and verification are clear enough to implement without inventing product requirements. No separate approval, readiness label, or exhaustive file-level design is required. Small authorized fixes can go directly to a PR with the same information; creating an issue solely to satisfy this protocol is unnecessary.

## Split and order larger work

Create one issue per coherent, reviewable result. Keep its tests and required documentation with the behavior change. Avoid separate tickets for writing tests later. Split when scope has independent outcomes or cannot be reviewed reasonably in one PR, not merely because several files change.

Use a tracking issue for a multi-task plan and native sub-issues for its children. Use native blocked-by relationships for prerequisites; also name the required prerequisite behavior in the task. Verify that links point to the intended issues and that the graph has no cycles. If dependency editing is unavailable, record explicit blocked-by links and report that limitation instead of claiming the graph is configured.

Do not infer ordering from issue numbers. A related issue or overlapping file is not automatically a blocker. Identify work that can proceed independently and coordinate shared interfaces before parallel changes. For internal steps, state what remains unavailable publicly and which later task enables it. Each intermediate merge must leave existing public behavior usable.

Keep scope and acceptance criteria in the child issue. The tracker summarizes outcomes, order, and status without copying every child's specification. Change dependencies when the design changes, and check downstream assumptions when prerequisites land. Do not rewrite existing issues merely to match these headings.

## Carry the criteria through review and closure

At implementation start, recheck current code and merged prerequisites. Follow the contribution guide when evidence requires a plan change; do not silently narrow the issue to match the patch.

Acquire [the task claim](task-claims.md) before editing. Use the same issue key when resuming an existing PR; do not create a second task key to bypass an active owner. Read any existing PR and handoff before treating an unclaimed issue as new work.

In the PR, connect acceptance criteria to executed tests, CI evidence, and documentation changes. Reviewers check both that the behavior meets the criteria and that the tests exercise the failure being prevented. Green CI does not establish untested acceptance criteria. Record remaining limitations explicitly.

Close a code-change issue only when its accepted scope has merged and its verification is accounted for. If scope is deliberately reduced, record the agreement and link the remaining work before closure. For duplicates, investigations, or declined requests, state the disposition and supporting links instead of implying a fix shipped. Close a tracker only when its overall outcome is satisfied or its remaining scope is explicitly retired.
