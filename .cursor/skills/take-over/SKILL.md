---
name: take-over
description: >-
    Continues Cuttlely work for someone new to the checkout. Use when a new
    person opens the repo, asks to take over, or runs /take-over.
disable-model-invocation: true
---

Continue the existing work. Do not restart the project.

1. Read root `AGENTS.md`, `README.md`, and `CONTRIBUTING.md`.
2. Read the project notes in `.projects/cuttlely/`, in this order: `README.md` (how to resume and the code map), `STATUS.md`, `OPEN.md`, `PLAN.md`, `DECISIONS.md`, `RUNBOOK.md`, and `MEMORY.md`. `ARTIFACTS.md` says where docs, samples, fixtures, and reports live.
3. Check the live state the notes link to instead of trusting a status line: `git log --oneline -10 origin/dev` (the integration branch, set as `INTEGRATION_BRANCH` in `scripts/handoff-paths.mjs`), `gh issue list -R cuttlely/cuttlely`, and `gh pr list -R cuttlely/cuttlely`. An issue the notes list may already be closed, and an open pull request may already cover the task you were about to start.
4. Check that `dev` has everything on `main` before you start: run `git fetch origin`, then `git rev-list --count origin/dev..origin/main`. If the count is not `0`, `dev` is missing commits from `main`, and work branched from it starts stale and conflicts later. Sync `main` into `dev` first: reuse an open sync pull request (`gh pr list -R cuttlely/cuttlely --base dev --head main`) or open one (`gh pr create -R cuttlely/cuttlely --base dev --head main --title "Sync main into dev"`). It merges with a merge commit, never a squash or a rebase; do not merge it yourself unless asked. Start the task from `dev` after it lands. `docs/releases.md` has the branch rules.
5. Pick the next task that is not blocked: from PLAN's next tasks, an open issue, or the request in front of you. Skip anything OPEN marks as waiting on a maintainer decision. Do not invent an approval, a database URL, an embeddings provider, or a credential.
6. Confirm the goal, the branch, and the first task, then start that task.
7. Put code on a new branch from `dev`, and open the pull request against `dev`. Do not commit application code straight to `dev` or `main`. Follow RUNBOOK for the merge gate, and update `.projects/cuttlely/` in the same change when project state changes.
8. Never print secrets, tokens, or `.env` contents. Do not edit `hermes/AGENTS.md`; change `hermes/` only through `pnpm hermes:vendor`.

If `.projects/cuttlely/` is missing (for example in a stripped source export), do not create it from memory. Take the task from the request in front of you or from an open issue, and follow `AGENTS.md`, `README.md`, and `CONTRIBUTING.md`.
