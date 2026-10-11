# Status

Last refreshed 2026-10-11. Check `git log origin/main` for anything newer.

## What works on `main`

Cuttlely 1.0.0. The product version is the root `package.json`, `packages/server/package.json`, `packages/cli/package.json` and `packages/chat-widget/package.json`. The About dialog reads the server one. The root package name is `cuttlely-workspace` so the published launcher can be named `cuttlely`.

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
-   **Install and deploy.** Docker Compose (SQLite, one container), `npx cuttlely` (the same image, through the `cuttlely` launcher), from source, and a Render Blueprint (Docker web service, Postgres, disk). `docs/how-to/from-source.md` covers the dev server, the tests and `pnpm verify`. `@cuttlely/chat` is the embeddable chat widget, also served by the server at `/embed/chat.js`.
-   **Releases.** `pnpm release` cuts a release from a clean `main`, drafts by default, and pushes the image or publishes only on a flag. The full `pnpm verify` tests upgrades from a fixture of an older release.
-   **Graceful shutdown.** On SIGTERM or SIGINT the server stops taking new requests (`503` with `Retry-After`) and lets running answers and streams finish for up to 25 seconds (`CUTTLELY_DRAIN_TIMEOUT_MS`). The Compose files give the container 35 seconds to stop.
-   **File links in Agent answers.** A file an Agent card links in its answer opens for 15 minutes without the flow's API key: the link carries an expiry and an HMAC over the organization, flow, chat and file name, keyed from the server's own secret. A changed or expired link falls back to the key or session checks.
-   **Provider rate limits.** Chat models and LLMs make at most 3 tries and start no new try after 20 seconds. A provider that keeps answering 429 is reported as `429` with `Retry-After` (the provider's wait, else 30 seconds), and a stream ends with an `error` event carrying `status`, `code` `RATE_LIMITED` and `retryAfter`. An out-of-credit 429 still fails as `500`.
-   **No call home.** A default install reaches only services an operator or a flow set up. `SECURITY.md` lists every outbound host and how to turn it off.
-   **Website screenshots.** On the project site, a content screenshot opens full screen. Visitors can zoom and pan it, and close it from the button, the Escape key, the backdrop or the browser back button. Logos, icons and the mascot stay as they are.

## How it is checked

-   `pnpm verify` on Node 24 is the merge gate (DECISIONS D27). The full run has 22 steps. `pnpm verify --help` lists every step and the `--fast` set. A docs-only change uses `--fast`. The typecheck step runs in both modes: components and the server, plus `tsc --noEmit` for `packages/agentflow`, `packages/observe`, and `packages/api-documentation`.
-   `node harness/check.mjs` and `node etl/check.mjs` are offline checks with no model key and no network.
-   The `smoke` step boots the built server; the `upgrade` step starts it on data from an older release; the `safeboot` step checks the settings rollback.
-   The daily scheduled CI run on `main` also runs `pnpm test:queue-abort`, an end-to-end queue-mode abort test against a Redis service.
-   Workflows in `.github/workflows/` are the CI definition, but they are not the merge gate. See [OPEN.md](./OPEN.md). Their `pnpm/action-setup` steps take the pnpm version from `packageManager` in `package.json`; a separate `version` input stops the step when the two disagree.
-   `pnpm audit --prod` and `pnpm audit` report no critical advisory. Three high ones are left, and none has a fixed release. `extract-zip` (two advisories) is in Puppeteer's browser download, which Cuttlely skips (`PUPPETEER_SKIP_DOWNLOAD`), so that code does not run. `braces` 3.0.3 is the latest release and is still in the vulnerable range; it arrives through the command-line file matcher and through dev tooling, and request handling does not pass input to it. `expr-eval` is not installed: the older community package that depended on it is gone, and that package has no fixed release.
-   A green `pnpm verify` is not a real-model run. Harness and analyst behaviour that depends on a model needs a live run with a real credential before it is called done (MEMORY).

## Not done

-   The first release, v1.0.0, is not cut. No tag exists, no image is published, the npm packages are not published, and `CHANGELOG.md` is still `## [1.0.0] - Unreleased`. The release steps, including dating that heading and `npm publish` after the image is pushed, are in [PLAN.md](./PLAN.md).
-   The questions and known gaps in [OPEN.md](./OPEN.md). Repository settings for the release are one of those rows.
