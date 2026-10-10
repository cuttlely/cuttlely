---
name: refresh-project-handoff
description: >-
    Refresh local Cuttlely handoff notes so they match git. Use when asked to
    update project files, agent files, handoff files, STATUS, PLAN, OPEN, or
    to run the handoff refresh. Does nothing when .projects/cuttlely is absent.
disable-model-invocation: true
---

# Refresh the Cuttlely handoff

If `.projects/cuttlely/` does not exist, stop. Say that the handoff notes are not in this checkout and that there is nothing to refresh. Do not create the directory. Do not commit a placeholder.

If the directory exists, bring the handoff and agent files in line with the repository. Change only claims that are now wrong. Leave settled decisions and open questions alone.

Work from the Cuttlely repo root. Do not edit `hermes/AGENTS.md`. That file belongs to vendored Hermes. A new person resumes with `/take-over`, not this skill.

## Files

| File                                | Keep true                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `.projects/cuttlely/STATUS.md`      | Where `main` is, what works, live results, what is not done                                                          |
| `.projects/cuttlely/PLAN.md`        | Milestone states and the next tasks. Mark a task done when its remaining work is gone                                |
| `.projects/cuttlely/OPEN.md`        | Only real blockers. Mark a row done when the work landed; do not delete the history                                  |
| `.projects/cuttlely/DECISIONS.md`   | Settled. Fix a stale status word when a pull request merged. Add an entry only for a decision that was actually made |
| `.projects/cuttlely/ARTIFACTS.md`   | Pull requests, merge commits, branches, and where plans and reports live                                             |
| `.projects/cuttlely/RUNBOOK.md`     | Commands, defaults, and gotchas that match the scripts on `main`                                                     |
| `.projects/cuttlely/MEMORY.md`      | A lesson only when one was learned since the last refresh                                                            |
| `.projects/cuttlely/README.md`      | The resume steps and the code map, when a path was added or renamed                                                  |
| `AGENTS.md`                         | The same resume rules as the public README and CONTRIBUTING                                                          |
| `.cursor/rules/project-handoff.mdc` | The same pointers, in short                                                                                          |

## 1. Collect facts

From the repo root:

```bash
bash .cursor/skills/refresh-project-handoff/scripts/handoff-facts.sh
```

Read the script output, including `dirty` and `recent-ci`. Then read every file in the table. Do not print secrets, tokens, or `.env` contents. A pass/fail claim about `pnpm lint`, `pnpm build`, or `pnpm test` has to match `recent-ci` or a log you opened. Do not copy a conclusion from an older sentence in these files.

## 2. Edit

For each file, fix statements the facts contradict:

-   A pull request recorded as open, in review, or draft when it is merged: name the merge commit and date.
-   `main` described at an older commit than `origin/main`.
-   A check count, port, start command, or "fails on main" line that the code no longer supports. Read the script or the log before changing a pass/fail claim.
-   A task whose remaining work is done.

Do not invent live timings, credentials, or customer data. If a fact is not in git, CI, or a file you read, leave the old sentence or write that it was not re-checked.

Do not put personal names, private service URLs, or machine paths into `AGENTS.md` or `.cursor/rules/`. Those files are in the public tree. The notes under `.projects/cuttlely/` stay local.

If nothing is stale, stop and say so. Do not commit an empty refresh. Before you commit, list the claims you changed.

## 3. Commit

Stage only the files in the table, plus this skill if you changed it. Leave every other dirty file unstaged. `.projects/cuttlely/` is part of this repository.

```bash
git commit -m "Refresh the project handoff"
```

The pre-commit hook runs prettier and eslint and can take a few minutes. If it fails once with no clear file error, run the commit again. If it fails again, stop and report the error.

Do not push to `main` from this skill. Do not open a pull request unless asked. Do not merge another branch.
