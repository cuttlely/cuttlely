---
name: take-over
description: >-
    Continues Cuttlely work for someone new to the checkout. Use when a new
    person opens the repo, asks to take over, or runs /take-over.
disable-model-invocation: true
---

Continue the existing work. Do not restart the project.

1. Read root `AGENTS.md`, `README.md`, and `CONTRIBUTING.md`.
2. If `.projects/cuttlely/` exists, also read README, STATUS, PLAN, DECISIONS, RUNBOOK, MEMORY, and OPEN there. Resume the next task that is not blocked. Do not invent an approval, a database URL, an embeddings provider, or a credential.
3. If `.projects/cuttlely/` is absent, stop looking for it. Do not create it. Take the task from the request in front of you, or from an open issue.
4. Confirm the goal, the branch, and the first task, then start that task.
5. Put code on a new branch. Do not commit application code straight to `main`.
6. Never print secrets, tokens, or `.env` contents. Do not edit `hermes/AGENTS.md`.
