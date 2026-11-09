# Agent instructions for Cuttlely

Cuttlely 1.7.0 gives applications agent teams (harnesses) that apps call through the API and people chat with, plus the ETL pipelines, chatflows, and agentflows those teams use. Dashflows is an Experimental, default-off BETA. Public docs lead with agent teams and Cuttlely's own features and call the bundled runtime "the agent runtime". The visual canvas editor and workflow engine build on an Apache-2.0 project credited in [CREDITS.md](./CREDITS.md), and the agent runtime is Hermes, vendored under `hermes/` (MIT). Package names follow [ARCHITECTURE.md](./ARCHITECTURE.md). Path, environment variable, and data names stay stable. Credits are in [CREDITS.md](./CREDITS.md) and attribution is in [NOTICE](./NOTICE). The license text is in [LICENSE.md](./LICENSE.md).

## Before any work

1. Read [README.md](./README.md), [CONTRIBUTING.md](./CONTRIBUTING.md), and [SECURITY.md](./SECURITY.md).
2. Read [`.projects/cuttlely/README.md`](./.projects/cuttlely/README.md) and [`.projects/cuttlely/STATUS.md`](./.projects/cuttlely/STATUS.md). Those are the project notes: where the work stands, the plan, open questions, settled decisions, and the runbook. A new person runs the `take-over` skill to continue from them. If a checkout is missing the directory, follow this file, the README, and CONTRIBUTING.md, and do not invent a replacement.
3. Run `pnpm install` once. For harness changes, run `pnpm harness:check` before and after.

The 1.7.0 security-exception upgrade requires [upgrade warnings](./docs/upgrading.md), backups and [operator onboarding/recovery](./docs/how-to/instance-operator.md). Only the designated operator changes service settings; proof comes from the hosting dashboard or Docker/Compose logs. Enforcement remains default Off. Release preparation is separate from publication and activation.

## While working

-   Inbound API/SDK authorization changes follow [Access keys](./docs/reference/access-keys.md). Keep provider credentials and public share transports separate. New principals grant nothing; run the access-key execution fixtures and route tests alongside the full verification gate. Rollout defaults to `INBOUND_ACCESS_V2=off`.

-   Before a push or a pull request, run `pnpm verify` on Node 24. A change that is only docs or markdown can use `pnpm verify --fast`.
-   When project state changes, update `.projects/cuttlely/` in the same change. Before a push or a pull request, run the `refresh-project-handoff` skill once. Read all ten required files completely in contiguous pages before editing handoff files; retain observed page text and coverage evidence. The notes are public: no secrets, personal names, private hosts, machine paths, customer data, or business notes.
-   Never commit or print secrets: model keys, tokens, `.cuttlely/`, or any `.env` file.
-   `hermes/AGENTS.md` belongs to the vendored Hermes upstream and applies only to work inside `hermes/`.
-   Change files under `hermes/` only through `pnpm hermes:vendor` (`--save-patches` for an edit). [Hermes upgrades](./docs/reference/hermes-upgrades.md) has the steps.
