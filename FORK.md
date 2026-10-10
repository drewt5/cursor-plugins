# Maintain the portable pstack fork

This fork extends the `pstack/` plugin in [cursor/plugins](https://github.com/cursor/plugins) to Codex, OpenCode, and Claude Code. Cursor support remains available. Other plugins keep their upstream contents and are not claimed to support these additional hosts.

The fork's default branch, `main`, starts from upstream commit `d73344bee8cf22e53b9d5f4cf5749d38ba38c174`. It keeps upstream's history and directory layout. Portability changes are ordinary commits on `main`. The `upstream/main` remote-tracking branch tracks Cursor's version. Git records the merge base; there is no separate snapshot importer or upstream lock file.

The [fork manifesto](MANIFESTO.md) defines the priorities for design, maintenance, and review.

## Install and verify

From the repository root:

```sh
node pstack/scripts/install.mjs --target all --project /absolute/path/to/project
npm --prefix pstack test
```

See [installation](pstack/docs/install.md) for individual hosts, global installation, removal, and test prerequisites. See [PR verification](pstack/docs/ci.md) for checks, failure artifacts, and agent monitoring. Require `Pstack required` in branch protection after the workflow lands and passes.

Installation copies only `pstack/` into the destination. It does not install the other plugins.

## Keep the changes scoped

Follow [the contribution process](CONTRIBUTING.md) when implementing a fix or feature. Task scope and dependencies remain in GitHub issues.

Maintain the host adapters in `pstack/scripts/`, `pstack/skills/pstack-runtime/`, and the host manifests and metadata. Keep shared workflow edits limited to capability resolution, portable paths, model preferences, and execution fallbacks. Preserve upstream's workflow intent.

The intentional differences are:

- Roles inherit the active model unless the user configures an override. Model preferences live in portable JSON rather than a Cursor rule.
- Skills resolve host tools through the runtime. Delegation, history, scheduling, cloud execution, and integrations require actual host support.
- Codex, Claude Code, and OpenCode receive native discovery metadata and installation adapters. OpenCode also receives command and agent definitions.
- Install, update, and uninstall preserve user files. Regression tests and isolated host checks verify the adapters.

Prefer changes in the runtime or adapters over repeated edits across workflows. Some workflow files already contain necessary adaptations. Review those when upstream changes their behavior. Do not generate separate workflow libraries for each host.

Keep repository-wide changes limited to the fork documentation, pstack's marketplace entry, and its CI workflow. Propose generally useful fixes upstream separately.

## Merge an upstream update

Use `upstream` for `https://github.com/cursor/plugins.git` and `origin` for `https://github.com/drewt5/cursor-plugins.git`. After cloning the fork, add the upstream remote with `git remote add upstream https://github.com/cursor/plugins.git`.

Start with a clean worktree, then create a review branch:

```sh
git fetch upstream
git switch main
git switch -c sync/upstream-YYYY-MM-DD
git log --oneline HEAD..upstream/main -- pstack
git merge upstream/main
```

Resolve conflicts by preserving the upstream behavior and adapting its host assumptions. Review new skills, deletions, model choices, private paths, and newly required services even when the merge is clean. Update `pstack/tests/catalog.json` only after accounting for catalog changes.

Run portable checks for every update:

```sh
node pstack/scripts/test.mjs --portable
```

Run `npm --prefix pstack test` when installation, host metadata, model configuration, or invocation behavior changes, and before a release. Exercise changed workflows on a supported host when prompt behavior changes. Mock API checks verify loading and invocation, not model reasoning.

Open a PR against the fork's `main` branch. Include upstream commits affecting pstack, adaptations, unresolved capability gaps, and test results. Merge the PR with a merge commit so upstream ancestry is retained. Do not squash or rebase upstream-sync PRs. A reverted update needs an explicit follow-up because reverting files does not remove the recorded upstream merge.

## Attribution

Pstack was created by Lauren Tan. Preserve its [MIT license](pstack/LICENSE) and author metadata. Portability tooling does not imply that Cursor maintains or verifies the additional host support.
