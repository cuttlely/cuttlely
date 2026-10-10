---
name: refresh-project-handoff
description: >-
    Refresh the Cuttlely project notes in .projects/cuttlely so they match git.
    Use when asked to update project files, agent files, handoff files, STATUS,
    PLAN, OPEN, or to run the handoff refresh, and once before a push or a PR.
disable-model-invocation: true
---

# Refresh the Cuttlely handoff

The project notes in `.projects/cuttlely/` ship with the repository. Bring them and the agent files in line with the repository. Change only claims that are now wrong. Leave settled decisions and open questions alone.

If `.projects/cuttlely/` is missing from this checkout (for example a stripped source export), stop and say so. Do not recreate the notes from memory.

Work from the Cuttlely repo root. Do not edit `hermes/AGENTS.md`. That file belongs to the vendored agent runtime. A new person resumes with `/take-over`, not this skill.

## Files

| File                                | Keep true                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `.projects/cuttlely/STATUS.md`      | Where `main` is, what works, live results, what is not done                                                          |
| `.projects/cuttlely/PLAN.md`        | Milestone states and the next tasks. Mark a task done when its remaining work is gone                                |
| `.projects/cuttlely/OPEN.md`        | Real blockers and the open issues they map to. Link issues; mark a row done when the work landed                     |
| `.projects/cuttlely/DECISIONS.md`   | Settled. Fix a stale status word when a pull request merged. Add an entry only for a decision that was actually made |
| `.projects/cuttlely/ARTIFACTS.md`   | Where docs, samples, fixtures, generated reports, and release notes live                                             |
| `.projects/cuttlely/RUNBOOK.md`     | Commands, defaults, and gotchas that match the scripts on `main`                                                     |
| `.projects/cuttlely/MEMORY.md`      | A lesson only when one was learned since the last refresh                                                            |
| `.projects/cuttlely/README.md`      | The resume steps and the code map, when a path was added or moved                                                    |
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

-   A feature, path, command, or default described differently from `main`.
-   An issue row whose issue is closed: mark it done and link the issue. Do not restate an issue's status in prose.
-   A check count, port, start command, or "fails on main" line that the code no longer supports. Read the script or the log before changing a pass/fail claim.
-   A task whose remaining work is done.

Do not invent live timings, credentials, or customer data. If a fact is not in git, CI, or a file you read, leave the old sentence or write that it was not re-checked.

Everything you edit is public: `.projects/cuttlely/`, `AGENTS.md`, and `.cursor/rules/`. Do not write secrets or `.env` values, personal names or accounts, private service URLs or internal links, machine-specific paths, customer data, or business notes. Write paths relative to the repository root. Describe the code as it is now; do not narrate how it got there.

If nothing is stale, stop and say so. Do not commit an empty refresh. Before you commit, list the claims you changed.

## 3. Commit

Stage only the files in the table, plus this skill if you changed it. Leave every other dirty file unstaged. `.projects/cuttlely/` is part of this repository.

```bash
git commit -m "Refresh the project handoff"
```

The pre-commit hook runs prettier and eslint and can take a few minutes. If it fails once with no clear file error, run the commit again. If it fails again, stop and report the error.

Do not push to `main` from this skill. Do not open a pull request unless asked. Do not merge another branch.
