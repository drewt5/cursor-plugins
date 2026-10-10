# Pstack changes

Read [the manifesto](MANIFESTO.md) before nontrivial design or plan work. Treat it as durable priorities, not a claim that planned features have shipped.

Keep portability changes inside `pstack/` and its CI and fork documentation. Preserve other plugins.

For PR verification, follow [the CI protocol](pstack/docs/ci.md). Monitor the checks for the current PR head, inspect failed job logs, and download that run's evidence artifacts. Compare the report's source head, tested checkout, run ID, and attempt before attributing a failure. Recheck the PR head after collecting evidence. Missing or pending checks are not verification.

Run the existing test commands for local reproduction. Do not treat mock API success as proof of model reasoning or Cursor GUI behavior. Do not change repository protection rules without authorization.
