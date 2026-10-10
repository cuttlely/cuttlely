# Status

Last refreshed 2026-10-10. Check `git log origin/main` for anything newer.

## What works on `main`

Cuttlely 1.0.0. The product version is the root `package.json` and `packages/server/package.json`; the About dialog reads the server one.

-   **Agent teams (harnesses).** A harness is a named team: Harness Prime routes each question, specialists do the work in parallel, and Prime writes one answer. Specialists use canvas tools, retrievers, vector stores and MCP servers in process, and the agent runtime for Shell, Browser, Code execution, Files and MCP work. Any chat-model node can drive Prime or a specialist, with an optional fallback model. Turns stream over the prediction API, have a wall-clock budget, cap their context tokens, and report tokens and timings. Each harness has a run history page with a playground.
-   **Analyst.** A specialist with its own isolated database (`CUTTLELY_ANALYST=auto`, or a separate Postgres URL) that creates tables, answers from real rows and pages long results.
-   **Knowledge pipelines (ETL).** A pipeline canvas with streaming sources, incremental upsert into any vector store, every text splitter and embeddings node, schedules, run history, and the ETL Retriever for chatflows and harnesses.
-   **Chatflows and agentflows.** The visual canvas and node catalog, with Build with AI on every canvas. Older V1 agentflows still run but are not offered for new work.
-   **Drafts and version history.** Every canvas autosaves to a draft; Publish, Roll back, restore, a check that replays recent real questions before Publish, an optional copy in GitHub, and Dev to Prod promotion.
-   **Share and embed.** The `@cuttlely/chat` widget, served by the server at `/embed/chat.js`, for share links and website embeds, including charts on cross-site embeds that the chatflow allows.
-   **API.** Chatflows, agentflows and harnesses through `POST /api/v1/prediction/:id`, with document uploads, streaming, caller-owned sessions and hashed API keys. `docs/api.md` and `examples/web-app/` show a real app.
-   **Sign-in and teams.** WorkOS AuthKit sign-in or one local account, teams, users and roles in the app database, and workspace scoping on every route.
-   **Admin panel.** Admin > Server settings holds every server setting with help text, a review step, restart to apply, safe boot back to the last good settings, History, and a guided sign-in setup.
-   **First ten minutes.** Install, first account, and Try the demo, which opens a made-up bakery team on the person's own model key with its chat open. The README section "Your first 10 minutes" walks through it.
-   **Install and deploy.** Docker Compose (SQLite, one container), from source, and a Render Blueprint (Docker web service, Postgres, disk).
-   **Releases.** `pnpm release` cuts a release from a clean `main`, drafts by default, and pushes the image or publishes only on a flag. The full `pnpm verify` tests upgrades from a fixture of an older release.
-   **No call home.** A default install reaches only services an operator or a flow set up. `SECURITY.md` lists every outbound host and how to turn it off.

## How it is checked

-   `pnpm verify` on Node 24 is the merge gate (DECISIONS D27). The full run has 21 steps; `pnpm verify --help` lists them. `--fast` is the docs-only subset.
-   `node harness/check.mjs` and `node etl/check.mjs` are offline checks with no model key and no network.
-   The `smoke` step boots the built server; the `upgrade` step starts it on data from an older release; the `safeboot` step checks the settings rollback.
-   The daily scheduled CI run on `main` also runs `pnpm test:queue-abort`, an end-to-end queue-mode abort test against a Redis service.
-   Workflows in `.github/workflows/` are the CI definition, but they are not the merge gate. See [OPEN.md](./OPEN.md).
-   A green `pnpm verify` is not a real-model run. Harness and analyst behaviour that depends on a model needs a live run with a real credential before it is called done (MEMORY).

## Not done

-   The open issues: [#2](https://github.com/cuttlely/cuttlely/issues/2), [#5](https://github.com/cuttlely/cuttlely/issues/5), [#6](https://github.com/cuttlely/cuttlely/issues/6) and [#10](https://github.com/cuttlely/cuttlely/issues/10). Check each one's state on GitHub; some may be closed by the time you read this.
-   No release is tagged yet, and no image is published. The first release is v1.0.0 (PLAN).
-   The questions and known gaps in [OPEN.md](./OPEN.md).
