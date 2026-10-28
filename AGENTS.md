# Agent instructions for Cuttlely

Cuttlely 1.4.7 gives applications agent teams (harnesses) that apps call through the API and people chat with, plus the ETL pipelines, chatflows, and agentflows those teams use. Public docs lead with agent teams and Cuttlely's own features and call the bundled runtime "the agent runtime". The visual canvas editor and workflow engine come from Flowise (Apache-2.0), and the agent runtime is Hermes, vendored under `hermes/` (MIT). Package names follow [ARCHITECTURE.md](./ARCHITECTURE.md). Path, environment variable, and data names stay stable. Credits are in [CREDITS.md](./CREDITS.md) and attribution is in [NOTICE](./NOTICE). The license text is in [LICENSE.md](./LICENSE.md).

## Before any work

1. Read [README.md](./README.md), [CONTRIBUTING.md](./CONTRIBUTING.md), and [SECURITY.md](./SECURITY.md).
2. Read [`.projects/cuttlely/README.md`](./.projects/cuttlely/README.md) and [`.projects/cuttlely/STATUS.md`](./.projects/cuttlely/STATUS.md). Those are the project notes: where the work stands, the plan, open questions, settled decisions, and the runbook. A new person runs the `take-over` skill to continue from them. If a checkout is missing the directory, follow this file, the README, and CONTRIBUTING.md, and do not invent a replacement.
3. Run `pnpm install` once. For harness changes, run `pnpm harness:check` before and after.

## While working

-   Before a push or a pull request, run `pnpm verify` on Node 24. A change that is only docs or markdown can use `pnpm verify --fast`.
-   When project state changes, update `.projects/cuttlely/` in the same change. Before a push or a pull request, run the `refresh-project-handoff` skill once. The notes are public: no secrets, personal names, private hosts, machine paths, customer data, or business notes.
-   Never commit or print secrets: model keys, tokens, `.cuttlely/`, or any `.env` file.
-   `hermes/AGENTS.md` belongs to the vendored Hermes upstream and applies only to work inside `hermes/`.
-   Change files under `hermes/` only through `pnpm hermes:vendor` (`--save-patches` for an edit). [Hermes upgrades](./docs/reference/hermes-upgrades.md) has the steps.
