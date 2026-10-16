# Changelog

This file records every notable change to Cuttlely. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Cuttlely uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). [Releases and support](./docs/releases.md) explains what counts as a breaking change and which versions get fixes.

## [Unreleased]

### Added

-   `pnpm verify` ends with a timing table of the steps that ran, slowest first, with each step's time and share of the total. It prints on a pass and on a failure, and pass or fail is unchanged.
-   A media size check (`scripts/media-size.mjs`) fails when a tracked or staged image or video file is over 5 MB and is not listed in `scripts/media-size.allowlist`. The allowlist holds the large website videos already committed. It runs as a `pnpm verify` step, including `--fast` and the pre-push hook, and in the required `lint` CI job.

### Changed

-   The proprietary path check runs once, in the required `lint` CI job. The `proprietary-paths` step of `pnpm verify` and the separate Proprietary Path Guard workflow are removed. `node scripts/proprietary-paths.mjs` still runs the same check locally.
-   The Admin menu lists Users and Teams first, then Roles, Server Settings, Logs, Audit log, and Version History. The page you are on is still marked, including a team's members page under Teams. After sign-in, someone who is not the organization owner and has none of the earlier pages now lands on Users, then Teams, before Roles, in the same order as the menu.

### Fixed

-   Try the demo no longer asks for the saved credential list when the role lacks `credentials:view`, so a role with only `chatflows:view` sees no 403 in the browser console. The card still offers Add a model key, and owners and roles with `credentials:view` still see their keys.

## [1.2.0] - 2026-10-15

### Added

-   An audit log for sign-in success and failure, lockout, invite, reset, role change, user disable, and settings changes. `GET /api/v1/audit` is for the organization owner or `audit:view`. Passwords, tokens, secret values, and question text are not stored. Rows older than `CUTTLELY_AUDIT_RETENTION_DAYS` (90, from 1 to 3650) are left out. Settings changes are the existing settings history. Login activity stays closed. [Audit log](./docs/how-to/audit-log.md), [Audit API](./docs/reference/audit-api.md).
-   **Save as dataset** in Choose questions stores the ticked questions as a dataset with empty expected answers. The route is `POST /api/v1/datasets/from-questions`. A hand-picked check does not unblock Publish. Only a dataset can be the passing test set. Text, JSON, and numeric evaluators can score that blank answer. A model evaluator scores Error until the expected answer is filled in. [Datasets API](./docs/reference/datasets-api.md).
-   Turning AuthKit on links a verified email to one existing local user when the mailbox matches exactly, ends the local sessions that already exist, and leaves password sign-in off except the owner break-glass account. `GET /api/v1/auth/options` reports that status. [Users without AuthKit](./docs/how-to/users-without-authkit.md), [Auth API](./docs/reference/auth-api.md).
-   **Testing and Limits** on Server settings, and `CUTTLELY_PUBLISH_CHECK` (on by default). Turning it off stops the publish check on the next request and does not change Publish. A host value of `true` or `false` wins. [Server settings API](./docs/reference/server-settings-api.md), [Startup options](./docs/reference/startup-options.md).
-   Local password sign-in for every active user who already has a password, when `CUTTLELY_LOCAL_USERS=true` and AuthKit is not configured. The owner break-glass route is unchanged. Invited users still have no password until a sign-in link exists. [Users without AuthKit](./docs/how-to/users-without-authkit.md), [Auth API](./docs/reference/auth-api.md).
-   With that same mode on, the API can list people in the active team, assign a fixed or custom role, disable or enable a user, and list or end sessions. Owner, Admin, Builder, and Viewer are seeded permission sets and cannot be edited. The last enabled owner cannot be removed. [Local users, roles, and sessions](./docs/reference/local-directory-api.md).
-   Four server limits apply without a restart: `CUTTLELY_LOGIN_FAILURE_LIMIT` (10, from 3 to 50), `CUTTLELY_SESSION_IDLE_MINUTES` (720, from 15 to 1440), `CUTTLELY_SESSION_ABSOLUTE_HOURS` (168, from 1 to 720), and `CUTTLELY_DRAIN_TIMEOUT_MS` (25000, from 0 to 300000; 0 does not wait). A shorter session lifetime ends sessions that are already signed in, including an AuthKit session. An authenticated request records activity at most once a minute and sends the local session cookie again. An AuthKit session that has expired stays expired. `GET /api/v1/server-settings/history` pages the change history for the organization owner. A secret is recorded only as changed. The history keeps the newest `CUTTLELY_HISTORY_KEEP` rows (1000, from 100 to 10000). A value saved in Server settings wins over that environment variable. [Server settings API](./docs/reference/server-settings-api.md).

### Changed

-   The Publish check picker uses the question cap. Check setup sends `limits.counts`: 4, 10, 25, 50, and 100 when the cap is 100. A lower cap drops choices above it and adds the cap. A higher cap keeps those and adds the cap. Choosing questions by hand uses that same cap, and a refusal names the number in effect. [Drafts API](./docs/reference/drafts-api.md).
-   `CUTTLELY_DRAIN_TIMEOUT_MS` accepts 0 through 300000 milliseconds. 0 does not wait. A value outside that range is ignored, and the saved value or the default is used. The default is still 25 seconds. A wait that was already shorter than 5 seconds still applies.
-   Docs name the Run the test set button and the gate's scope.
-   Docs: the CI gate guide now covers harness checks and a test set changed during `--gate`.
-   Guides name the Build with AI control **Show all … models** (select **Only models for your keys** to return to the shorter list), the **Admin** menu item **Server Settings**, and 1.1.0 in the Docker image examples.
-   Docs: fresh screenshots for server settings, sign-in, roles, a first run from source, and imports.
-   Fresh screenshots for the knowledge pipeline guide and the Usage page.
-   Docs: fresh pictures of version history, the Publish check, and evaluations.
-   The README and homepage lead with testing before Publish, with a narrated video.
-   README and homepage follow one order: team, testing, API, tools, start; homepage adds three start steps.
-   The homepage start step says the first-account link is on the `No account yet` log line, from `docker compose logs cuttlely` or `npx cuttlely logs`.
-   The testing section says the gate covers Publish of the current draft only, and names Roll back, Promote from Dev, and `PUT /api/v1/chatflows/:id`. The homepage shows the Publish check screenshot at the width of the testing copy, with the Saturday and gluten-free rows in frame.

### Fixed

-   Dollar amounts in chat replies show as text. A reply with two amounts, such as `a store credit of $10 ... shipping ($5.99)`, no longer loses the text between them. In the app's chat a single `$` is never math. Math is `$$...$$` (inline or on its own lines), `\(...\)` or `\[...\]`. The embed widget and the shared chat page do not render math: `$$...$$` shows as written, and `\(...\)` and `\[...\]` lose their backslashes.

### Security

-   The agent runtime's MCP Python SDK is 2.2.0, which fixes unbounded session accumulation in the StreamableHTTP transport (GHSA-84m7-p3x7-pcfv).

### Upgrade notes / breaking changes

-   The old Analyst import paths are gone. Import the modules in `packages/harness/runtime/` instead of `scripts/analyst-store.mjs`, `scripts/analyst-postgres.mjs`, `scripts/analyst-page.mjs`, `scripts/analyst-sqlite-worker.mjs`, `scripts/analyst-mcp-status.mjs`, `scripts/hermes-stream.mjs`, and `harness/runtime/`.
-   Out-of-range host values for the publish check are no longer pulled into range. This applies to `CUTTLELY_CHECK_MAX_TOKENS`, `CUTTLELY_CHECK_MAX_SECONDS`, and `CUTTLELY_CHECK_CONCURRENCY`. A number outside the range used to be moved to the nearest bound. It is now ignored. A saved value inside the range is used, otherwise the default. `CUTTLELY_CHECK_MAX_SECONDS=5` now uses 180, not 10. The log line is `[server]: CUTTLELY_CHECK_MAX_SECONDS is not a usable runtime limit, so another value is used`. The same line names whichever of those variables was ignored. See [Upgrading](./docs/upgrading.md#publish-check-limits-set-outside-their-range).

### Docs

-   The testing guides link the narrated testing run.
-   Fresh screenshots for the canvas, share and embed, the API and Try the demo.
-   Fresh screenshots for the harness guide and Analyst mode, shot from the current app with synthetic bakery data.

## [1.1.0] - 2026-10-14

### Added

-   Scored mode for `cuttlely check`. `--dataset <id>` runs the dataset check on the flow's draft and exits on the server verdict: 0 when it passed, 1 when it failed, and 2 on a timeout, a server error or a usage error. `--evaluator <id>` repeats for each evaluator, and `--threshold` sets the pass mark from 0 to 100 (100 when omitted). `--gate` uses the dataset, evaluators and pass mark saved on the flow, and exits 0 only when a second read of the flow still stores that check as passed. Diff mode stays the default. Scored mode and `--gate` are in 1.1.0 and later. The 1.0.3 package has no `--gate`. [Fail a build when answers change](./docs/how-to/ci-gate.md).
-   Example GitHub Actions workflows for both check modes. `examples/ci/cuttlely-check.yml` replays recent questions with `--fail-on-changed`, and `examples/ci/cuttlely-check-gate.yml` installs `cuttlely@^1.1.0` and runs `--gate`. Both set `permissions: {}` and cancel an older run of the same workflow.
-   **Passing test set.** A chatflow or an agentflow can require a passing dataset check before Publish. The setting is off until it is turned on, and stores a dataset, its evaluators and a pass mark from 0 to 100. With it on, Publish returns 409 unless the latest stored result passed for the current draft, the same settings, the same test set and the same answer post-processing. Errored scores count as not passed. A harness cannot use the setting, and an agentflow that starts with a form, a webhook or a schedule cannot turn it on. A direct chatflow update, Restore straight to Live, Roll back and Promote from Dev still change Live. See [Evaluations](./docs/how-to/evaluations.md#set-the-pass-mark-and-turn-on-the-gate).
-   **Add to test set** on an answer in the message viewer saves that question and answer as a dataset row, with an editable expected answer. The row records the message, the flow and the date it came from. Saving the same answer into the same dataset again returns the existing row. The route is `POST /api/v1/datasets/rows/from-message`.
-   **Add rated answers to test set** in the message viewer copies thumbs-up or thumbs-down answers for a flow from the last 1 to 90 days into a dataset. A dry run shows how many rows would be added before anything is written. A thumbs-up row uses the answer as the expected output. A thumbs-down row leaves the expected answer empty and marks it as needing one. A message already in the dataset is skipped, and one add writes at most 500 new rows. The route is `POST /api/v1/datasets/rows/from-ratings`. Both routes need `datasets:create` or `datasets:update`, plus view permission for the flow's type.
-   Harness runs can send OpenTelemetry traces, with the same switch and attribute names as chatflow and agentflow runs. `harness.run` is the root, with a span for the route, each specialist, the handoff, each in-process model call and each tool call. A harness run from a chatflow Harness node is nested under that chatflow's trace. A canvas draft try and a Publish check replay send nothing. See [Run traces](./docs/how-to/observability.md#harness-runs).
-   An analyst query step on the run card shows how many rows the query returned and a short table preview, which starts closed. The preview is saved with the run trace and keeps only the first few rows and columns, with each value cut short. It does not store the SQL. `CUTTLELY_ANALYST_TRACE_PREVIEW=false` leaves the cell values out of new traces.
-   New guides. [Evaluations](./docs/how-to/evaluations.md) walks from a test set to a gated Publish. [Run traces](./docs/how-to/observability.md) sends chatflow, agentflow and harness traces to a collector you run, with `examples/otel/collector.yaml`. [Usage over time](./docs/how-to/context-and-tokens.md#usage-over-time) and the [Usage API](./docs/reference/usage-api.md) explain the Usage page, model prices and the check cost lines.

### Changed

-   Chatflow, harness, pipeline, marketplace and version cards take a colour accent: a tint, a border in the card's colour and a coloured ring around the icon, as workflow cards already had. Neighbouring categories use different hues, and title and summary text meet WCAG AA in the light and dark themes. Card size, layout, connection handles and saved flow data are unchanged.
-   The Docker Compose files pass `CUTTLELY_OTEL_TRACES`, `CUTTLELY_OTEL_TRACES_ENDPOINT`, `CUTTLELY_OTEL_TRACES_PROTOCOL`, `CUTTLELY_OTEL_TRACES_CONTENT` and `METRICS_SERVICE_NAME` from `.env`, on the server and on the queue worker. A blank value is unset.

### Fixed

-   The Flow and Model filter labels on the Usage page no longer cover the selected value.

### Upgrade notes / breaking changes

-   **Database changes.** Three migrations run at startup. They add columns to `flow_version_state` for the passing test set setting and its last result, and nullable source and rating columns to `dataset_row`. Existing rows are unchanged. Back up first, as [Upgrading Cuttlely](./docs/upgrading.md) describes.

## [1.0.3] - 2026-10-13

### Added

-   Drafts and Publish for harness canvases. After the first save, **Save Harness** writes a draft, and the canvas chat and **Try it** run that draft. Chatflows and `POST /api/v1/harnesses/:name/runs` keep using the Live team until you select **Publish**. An existing harness stays Live until its next edit on the canvas.
-   Drafts and Publish for pipeline canvases. Scheduled runs, a run you start and a full rebuild keep reading the published pipeline until Publish or Roll back. Preview runs the canvas, including edits not saved yet, and writes nothing to the store. The Publish dialog lists what changed in the same words as version history. An existing pipeline stays Live until its first canvas edit.
-   The Publish check runs on harness drafts. It asks recent prompts from that harness's saved chats on the Live team and on the draft team, and shows the answers, tokens and time side by side.
-   The Publish check can ask the rows of a saved dataset instead of recent questions, and score each answer with the evaluators you pick. Each side gets Pass, Fail or Error per answer and a pass rate.
-   The Publish check replays recorded inputs for agentflows that start from a form, a webhook or a schedule. The dialog calls this **Check recent runs**, shows a short preview of each input, and writes sensitive header and query values as `[REDACTED]`.
-   `cuttlely check --flow <id>` runs the Publish check on a flow's draft from a terminal or a CI job. `--fail-on-changed` exits 1 when any answer changed. The API key is read from `CUTTLELY_API_KEY`. See [Check answers in CI](./docs/how-to/ci-gate.md).
-   Datasets, Evaluators and Evaluations are in the sidebar for the organization owner and for roles that hold their permissions.
-   **Admin** > **Logs** shows recent server logs in the app, with a level filter and time ranges. The organization owner can open it, and so can a role with the new `logs:view` permission. An API key cannot hold that permission.
-   Token usage is recorded per flow, model and day for chatflows, agentflows, Multi Agents, Sequential Agents and harnesses. `GET /api/v1/stats/usage` returns the daily totals, plus totals per flow and per model, for 7, 30 or 90 days or a custom range.
-   Usage totals and the Publish check include an estimated cost. Defaults come from the model list. An organization owner can set or clear a model's price, in US dollars per million tokens. A model with no price is shown as no price, not as zero. The check total for a side prices each model once across that side's answers. A harness check prices the route, specialist, and handoff lines stored under the harness name. A line stored as the node label and a catalog id uses an override on that full string, or the catalog price. On MySQL and MariaDB the daily usage model name keeps case, so two names that differ only by case stay separate and are priced apart. The figure under one answer can differ from that total by one hundred-millionth of a dollar. The figures are estimates.
-   A **Usage** page in the sidebar shows daily input and output tokens and an estimated cost per flow, for 7, 30 or 90 days or a custom range, with flow and model filters. Models with no price are marked, and the organization owner can set or clear a model's price on the same page. People need `chatflows:view` or `agentflows:view` to see it.
-   Named environments for promotion. Version history can list more than two environments in promotion order, for example dev, staging and prod. A version moves one step at a time, the behavior check and the credential check run on each step, and the promote page shows the chain. An existing Dev and Prod setup keeps working as it is. [Versioning](./docs/how-to/versioning.md) has the setup guide.
-   Optional OpenTelemetry traces for chatflow, agentflow, Multi Agents and Sequential Agents runs, with a span for each step, model call and tool call, including token counts. Traces are off until `CUTTLELY_OTEL_TRACES=true` and `CUTTLELY_OTEL_TRACES_ENDPOINT` are set. Questions and answers stay out of traces unless `CUTTLELY_OTEL_TRACES_CONTENT=true`. See [Run traces](./docs/how-to/observability.md).
-   The analyst's row cap and query timeout can be changed in **Admin** > **Server settings** > **Analyst** (`CUTTLELY_ANALYST_ROW_CAP`, 1 to 1000 rows, and `CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS`, up to 120 seconds). The defaults stay 100 rows and 15 seconds. A PostgreSQL MCP card can set lower values for itself.
-   Optional node packs. Vector stores, outside-service tools and MCP servers, caches and memory backends, and the older completion model and chain cards now ship as node packs. Every install still loads them, so the card list is the same. `CUTTLELY_NODE_PACKS` loads more packs. A saved flow that uses a card that is not installed opens with a placeholder card that names its pack, keeps its lines, and answers 422 with a plain message if it is run. See [Node packs](./docs/how-to/node-packs.md).
-   Smaller Docker builds. `INCLUDE_BROWSER=0` builds an image without Chromium, `INCLUDE_NODE_PACKS=0` leaves the shipped node packs out, and `CUTTLELY_OMIT_GEOIP=true` leaves out the IP location database, so audit events have no country or region. The published image still includes all of them. In an image without Chromium, the Puppeteer and Playwright document loaders fail with `this image has no browser`, and the agent runtime's browser tool returns success: false while the server keeps running.
-   Product-named settings next to the existing ones: `CUTTLELY_SECRETKEY_OVERWRITE`, `CUTTLELY_FILE_SIZE_LIMIT` and `DISABLE_CUTTLELY_TELEMETRY`. If both encryption key variables are set to different values, Cuttlely refuses to start instead of picking one. Webhook callbacks also send an `X-Cuttlely-Signature` header with the same signature, and `METRICS_PREFIX` can prefix metric names.
-   [Roles and permissions](./docs/how-to/roles-and-permissions.md) explains teams, the built-in roles, and every permission key with the pages and API routes it opens.

### Changed

-   The image installs less. The server serves the prebuilt web app without installing the web app's libraries, the server drops dependencies it never loads, and the bundled agent runtime keeps only the code Cuttlely runs.

### Fixed

-   Cards on the chatflow, agentflow, harness and pipeline canvases show Duplicate and Delete on hover and while the card is selected, also while its settings panel is open. The card settings and edit panel has a Close button that stays visible in light and dark mode. Deleting a card or a line clears references to it on other cards, so nothing in the saved flow still points at it.
-   A model grade keeps text, JSON and numeric scores when the grading model cannot be started. Each model score is Error. Grading tokens count when a provider reports them only as an estimate. A provider that reports usage nowhere leaves the check bounded by the time limit. A model grade that is aborted still counts tokens already reported, and does not start another model evaluator.
-   A second row added to a dataset gets the next sequence number instead of repeating the first.
-   In the role dialog, Delete Chunk and Edit Chunk check the same permissions as the API routes they call, and checking Users or Roles no longer adds a view permission you did not pick.

### Security

-   Harness routes are scoped to the caller's workspace. Another team's harness, its runs and its run previews answer 404, the same as a missing name, and cannot be run or overwritten: saving a name that belongs to another team returns 409 and changes nothing. An API key is limited to the workspace bound to that key.
-   The agent runtime's automatic git calls no longer run commands that a repository's own git config names, such as an fsmonitor command, filters or hooks.
-   Reading a publish check no longer includes dataset row inputs, expected outputs, or evaluator ids and names unless the caller can view datasets and evaluators.
-   The usage and flow stats routes need `chatflows:view` or `agentflows:view`, and the evaluation outdated check needs `evaluations:view`.

### Upgrade notes / breaking changes

-   **Harness and pipeline drafts.** After the upgrade, the next edit to an existing harness or pipeline canvas saves a draft. Runs, schedules and the API keep using the published version until you select **Publish**. `CUTTLELY_DRAFTS=off` still turns drafts off for the whole server.
-   **Harness teams.** At startup, a harness saved before harnesses stored a team takes its canvas chat flow's team, otherwise the team named by `CUTTLELY_ETL_DEFAULT_WORKSPACE_ID`, otherwise the only team. A single-team install needs no action. On an install with several teams, a harness that still has no team is not run by a chatflow, webhook, schedule or embed. Set `CUTTLELY_ETL_DEFAULT_WORKSPACE_ID` to the team that should own such harnesses and restart.

## [1.0.2] - 2026-10-11

### Changed

-   The web app runs on React Router 7. Pages, links, sign-in and the unsaved-changes prompt on the canvas work as before.
-   The Word and PowerPoint loaders say so plainly when a file is not a .docx or .pptx. Older .doc and .ppt files were never supported.

### Security

-   Every open dependency security alert is fixed or reviewed. 1.0.1 had 120 open: 1 critical, 28 high, 76 medium and 15 low.
-   The agent runtime moves to PyJWT 2.15.1, which fixes the critical one. It also takes urllib3 2.8, httpx2 and httpcore2 2.13.1, tornado 6.5.9, oauthlib 4 and multidict 6.9.1.
-   The server and web app move to patched releases, among them express 4.22 (with body-parser, cookie, send and serve-static), qs, protobufjs, fast-xml-parser, prismjs, KaTeX, yaml, the MCP SDK 1.32, Google Cloud Storage 7.22, mammoth 1.11 and uuid 11.
-   Azure Blob uploads use the Azure Storage SDK directly. The upload package they used before is unmaintained, and it brought in the retired azure-storage SDK and the `request` library.
-   The canvas renders Markdown with marked, still sanitized, instead of showdown.
-   The Word and PowerPoint loaders refuse anything that is not a ZIP-based Office file before parsing it, so a crafted file can no longer hang the parser.
-   The example apps and the website use patched build tools.
-   The few alerts still open have no fix yet, or are in code Cuttlely never runs. Each one is dismissed on GitHub with the reason.

## [1.0.1] - 2026-10-11

### Added

-   The npm packages ship properly for the first time in 1.0.1, built and published from the v1.0.1 tag after the image and this release are public. `cuttlely` is the launcher: `npx cuttlely start` needs Docker, and it pulls and starts `ghcr.io/cuttlely/cuttlely` at the same version as the package. `@cuttlely/chat` is the embeddable chat widget.
-   `pnpm release X.Y.Z --npm` is how maintainers publish those packages. It runs only from the annotated tag, once the image and the GitHub release for that version are public, and `--dry-run` shows the checks without publishing. [Releases and support](./docs/releases.md#publish-the-npm-packages) lists every check.
-   The Publish check can replay 4, 10, 25, 50, or 100 past questions. 4 is the default. The server takes the most recent distinct questions, runs a few at a time, and the dialog shows progress, Stop, and the totals above the rows.
-   [How the customer care demo works](./docs/how-to/customer-care-demo.md) walks through the new demo team card by card, so you can build the same kind of team on your own systems.

### Changed

-   `LICENSE.md` is the standard Apache License 2.0 text, so GitHub and other license tools identify it. Copyright and attribution are in `NOTICE`.
-   **Try the demo** now opens a customer care team first. A late-order complaint comes in: a customer specialist reads the account from a support desk database, an operations specialist traces the parcel through warehouse and carrier scans, and a policy specialist decides whose fault the delay is from a written service policy once operations has found the cause, with the remedy for every tier. Harness Prime picks the remedy for the customer's tier and history and writes the decision, the reply to the customer, the actions and the evidence. Each specialist has its own made-up data and Python tools in its own folder. The bakery team stays as the quickstart, one click away on the same card.

### Deprecated

-   `cuttlely@1.0.0` and `@cuttlely/chat@1.0.0` on npm. They were built from a commit after the v1.0.0 tag, so they do not match it. Use 1.0.1 or later. They stay installable and are marked deprecated on npm.

### Security

-   Dependencies on patched releases: DOMPurify 3.4.16, sanitize-html 2.17.7, moment 2.31.0, `@langchain/mongodb` 1.3.1 and `@langchain/redis` 1.1.1.

## [1.0.0] - 2026-10-10

The first Cuttlely release. It covers everything on `main` up to the release tag.

Cuttlely is the open-source agent platform for applications: build an agent team on a canvas or from a description, chat with it in minutes, and call it from your app through the API. The README and docs lead with that, with a real API call to a small team and the chat-first path for newcomers.

### Harnesses

-   Build agent teams on the harness canvas. Harness Prime reads the question, routes each part to a specialist using a short summary of each one, and writes one answer. A chatflow calls the whole team by name.
-   Specialists run in the agent runtime that ships with Cuttlely and starts with it on the same server. Each turn starts a fresh session, and follow-up questions still work. Specialists get their tools directly, load playbooks only when needed, and their instructions name each playbook.
-   Harness Prime reads up to 4,000 characters of each specialist answer, and it sees images attached to the turn. Images a specialist writes during a turn show up in the chat.
-   A step can wait for an earlier step and use its result.
-   The run card shows the route, each specialist, and the tokens in and out. Specialist tokens count toward the turn total, and cached prompt tokens are shown separately.
-   Build with AI on the harness canvas: describe your team and a first version lands on the canvas.
-   **Try the demo** on a new install: pick or add one model key, and a ready-made bakery team (made-up sales data and a made-up handbook) opens with its chat open and three starter questions. The first one answers with a chart.
-   Charts and other images a team makes also show up in the harness canvas chat.
-   A question asked while the agent runtime is still starting waits for it, up to a minute (`CUTTLELY_HERMES_START_WAIT_MS`), instead of failing with "Hermes did not accept POST /v1/runs".
-   Harness templates open on your own model key: the sample xAI Grok card becomes the chat model you have a key for, or keeps xAI with your key filled in. A model card with no key picked picks your key when exactly one fits.

### Analyst

-   A specialist with its own database. It creates tables, adds rows and answers questions about them, and it never reads Cuttlely's own tables. Turn it on with `CUTTLELY_ANALYST=auto`. The analyst database is kept apart from the application database, including on Render.
-   Long results come back in pages ("show more"). The run card keeps every row a query returned, behind the query chip.
-   A read-only analyst fixes a failed SQL statement once by itself. The SQL dialect follows the PostgreSQL credential on its card.
-   A 15-second statement timeout applies to every analyst call, on Postgres and on SQLite.

### ETL pipelines

-   Pipelines load files, a CSV or a code repository, then clean, split, embed and store the data for search. A run embeds only what changed and can run on a schedule. Local embeddings need no provider key.
-   Harnesses and chatflows search a pipeline's output with the **ETL Retriever**.
-   Deleting a pipeline also deletes the vectors it wrote.
-   Build with AI on the ETL canvas: describe your data and a first pipeline lands on the canvas.

### Chatflows and agentflows

-   The new card look is the default: compact cards, with settings in a side panel. People can choose **Classic cards** for themselves, and `CANVAS_CARD_LOOK=classic` sets classic as the server default.
-   Typing in a card field or a document loader field keeps your cursor where it was.
-   Every bundled template opens cleanly. Nine templates whose cards overlapped were respaced.
-   Opening a canvas fits every card in view.
-   Older V1 agentflows are hidden from the app and keep running. New agentflows use the current workflow canvas.
-   The xAI Grok card's **Model** field is a list of current Grok models, starting at `grok-4.7`. Any other model name your xAI account offers can also be typed in, and model fields that allow typing keep what you typed.
-   Model lists are current as of October 9, 2026, for every chat model, LLM and embedding card that has one: new models and prices, models the provider has shut down removed, and current defaults on new cards (for example `gpt-5.6-luna` on OpenAI, `claude-haiku-5-5` on Anthropic, `gemini-3.8-flash` on Google Gemini and Vertex AI, `deepseek-flash` on DeepSeek, `mistral-small-latest` on Mistral, `voyage-4` on Voyage AI and `text-embedding-3-small` on OpenAI embeddings).
-   OpenRouter, Fireworks, Together AI, SambaNova, NVIDIA NIM, IBM watsonx, Alibaba Tongyi and CometAPI cards offer a **Model** list of popular current models. Every model list also takes a typed model name, so a flow saved with a model that has left the list still opens and runs with it. Cards for servers you run yourself, such as Ollama, LocalAI, LiteLLM and OpenAI Custom, keep a plain text field.
-   Claude Sonnet, Haiku, Fable and Mythos 5 and later get no temperature, top P or top K, which those models refuse, and the Anthropic card offers adaptive thinking and effort on the Claude 5 models. GPT-6 models are treated as reasoning models on the OpenAI and Azure OpenAI cards.
-   Bring flows from other tools with a checked import wizard, from the **Import** menu on Chatflows. See [Bring your existing flows](./docs/bring-your-flows.md).
-   **Deprecated:** the OpenAI, Azure OpenAI and Cohere LLM (text completion) cards no longer appear in the node list for new flows, not even when searched by name, because those providers no longer offer a completion model. Flows that already use one still open and run as before. For new flows, use the chat model card of the same provider. Other deprecated cards show again when you search their exact name.

### Build with AI

-   On the chatflow, harness, ETL and workflow canvases, describe what you want and a first version lands on the canvas. Every part and connection is checked first, problems get one repair round, and credentials are matched by name. The building model is one of your own credentials.
-   Build with AI starts on a model you have a key for, with your key picked when only one fits. The list shows models for your keys first, and advanced settings wait under **More settings**.

### Versioning, Publish and Dev to Prod

-   Version history is on by default. Each save records what changed and who changed it, with diff colors and secret-looking text hidden. Restore a version, or open it as your draft. `CUTTLELY_VERSIONS=off` turns history off.
-   Drafts are on by default for chatflows and agentflows. The canvas saves to a draft. The API, embeds, shared links, schedules and webhooks keep serving Live until you publish. History shows Published markers and offers **Roll back Live**. `CUTTLELY_DRAFTS=off` turns drafts off.
-   The Publish check runs up to 10 recent questions on Live and on the draft and shows the answers side by side, with the tokens and time each took. It works on chatflows and on agentflows that start with a chat message.
-   Keep a copy of every version in a GitHub repository, from Admin, Version History. First-run setup goes straight into the app; it does not stop at a GitHub page.
-   Dev to Prod: Prod reads what Dev published, shows what would change and which credentials it needs, can run the same check, and goes Live only when its owner selects **Promote to Live**.

### Install and operations

-   A published Docker image, `ghcr.io/cuttlely/cuttlely:X.Y.Z` and `:latest`. Compose pulls it by default and builds your checkout when it cannot pull. The image reports its health from `/api/v1/ping`.
-   `npx cuttlely` starts that image. The `cuttlely` package is a Docker launcher, and `@cuttlely/chat` is the embeddable chat widget. The server stays in the image.
-   The Docker image runs on Debian trixie with Node 24. It runs as the `node` user and keeps its data in `/var/cuttlely`. Compose passes `CUTTLELY_VERSIONS`, `CUTTLELY_DRAFTS` and `CUTTLELY_ANALYST` from `.env`.
-   A Render Blueprint runs one container with Postgres.
-   From source on Node 24 with pnpm.
-   Sign in with a local account, or with WorkOS AuthKit for a team. On a fresh install the server log prints a one-time setup link, so the first account can be created in the browser, including through Docker's published port.
-   One process and SQLite by default. Harness turns use a SQLite queue in the web process.
-   **Server settings, Restart**: a full-screen view follows the restart (saved, runs finishing, stopping, each start-up step, back). When chats or agent team runs are in progress, Restart asks whether to let them finish (up to the turn time limit) or restart now; new runs wait meanwhile. The manual restart steps have a copy button.
-   **Server settings, safe boot**: a start that can't open the database after a settings change stops (exit 76) instead of running half-started, the start script starts it again, and its settings never become the last good copy, so the third start puts back the settings that worked. The restart screen shows that outcome as **The new settings did not start**. `pnpm verify` checks it on the real server (`pnpm safeboot:check`). When the start script (Docker, Render, a source install) does the rollback, it now tells the server, so the safe boot banner and that restart screen outcome show there too.
-   **Server settings guide** ([docs/how-to/server-settings.md](./docs/how-to/server-settings.md)) with real screenshots. Polish: high-risk changes need RESTART typed in the review; the safe boot banner has See what changed and Try it again; All settings has Copy as .env (secrets left out); queue mode reminds you to restart the workers; Switch database warns about the encryption key for a database that already holds Cuttlely data. On a phone the sections sit in one sideways row and the save bar fits; dialog buttons are in sentence case; setting names and the search field read clearly in dark mode. The page always keeps room for the save bar: it scrolls fully clear of it, and a field you move to never ends up under it. The sidebar marks the page you are on, also when you open it from an address, a link or the back button, including the pages under Admin.
-   **A one-time setup link when nobody can sign in**: a server with no account, the password sign-in off and no AuthKit (for example Render without the WorkOS values) prints a link in its log that opens only Sign-in & identity. Create the owner with a password, or set up AuthKit after a test sign-in with the owner email. The link works once and stops working once the first account exists. When accounts exist but no sign-in method is on, the browser shows the Sign In page with Sign-in is not configured instead of an empty page, and the log says how to turn one back on.
-   **Health check knows about the database**: while Cuttlely can't reach its database, at startup or later, `GET /api/v1/ping` answers `503` with a plain reason (for example `database unreachable: connection refused`), so Docker shows the container unhealthy and Render keeps a deploy without its database from going live. The log has one line naming the host and port, never the password, and Cuttlely never says it is ready without its database. Ping answers `pong` again once the database does.
-   **Server settings, Set up your server**: three optional first steps at the top of Server settings (sign-in for your team, the analyst, a model key), each opening the same section. Skip for now hides them.
-   **Server settings, Switch database**: SQLite or Postgres from the Database section. The new database is always tested first (sign-in, can create tables, empty or Cuttlely data already, other tables refused), the dialog says how the owner gets back in afterwards, the switch needs RESTART typed, and the previous database is kept for Switch back. Data is not copied.
-   **Server settings, Set up AuthKit**: a four-step guide in Sign-in (WorkOS key and Client ID with Staging or Production detected from the key, redirect addresses filled in with copy buttons, Generate seal, first owner email), then a real test sign-in with the values on screen, bound to the owner's browser session, before anything is saved. Password sign-in cannot be turned off until a test sign-in with the exact AuthKit values passes.
-   **Server settings, Test connection**: Analyst, File storage and Models each have a Test connection card that tries the values on the page before you save (Postgres sign-in and read-only check; S3, Google Cloud or Azure find, write and remove a small test file; the model list is fetched and checked). Errors come back in plain words, never with a secret in them.
-   **Admin, Server settings** (owner only): sign-in, database, agent runtime, analyst, models, storage, security, integrations and advanced settings in one page, with search, plain-language help, a review step before saving, Locked for values set where Cuttlely is installed, All settings, and History. Secrets are write-only. Changes apply at the next restart.
-   `scripts/start-cuttlely.sh` restarts the server in place when it exits with code 75, which is how Server settings applies a change. Safe boot puts back the last settings that started after two starts in a row that did not finish, and `pnpm settings list|unset NAME|restore` is the way back in from a terminal. [Upgrading Cuttlely](./docs/upgrading.md) has the details.
-   `pnpm verify` is the local merge gate.
-   Upgrades are tested. The full `pnpm verify` starts the current server on data written by an older Cuttlely and checks that flows, version history, credentials and harnesses survive (`pnpm upgrade:check`). [Upgrading Cuttlely](./docs/upgrading.md) covers backup, upgrade and roll back.
-   Model dropdowns and prices come from a model list the Cuttlely maintainers keep in this repository. A server fetches it from `main` at most once a day (5 second timeout) and uses the copy bundled with its build when that fails. `MODEL_LIST_CONFIG_JSON=bundled` turns the fetch off; a file path or URL replaces the list.
-   A quieter first start: the agent runtime skips about ten "Nous Portal not configured (run: hermes auth)" warnings, since Cuttlely never uses Nous Portal. Set `CUTTLELY_HERMES_NOUS_WARNINGS=show` to see them.
-   Start-up never looks stuck: the image build names each long step (1 of 4 to 4 of 4), the start script and server log each boot step, the log ends with `✅ Cuttlely is ready. Open http://localhost:43117`, and a browser opened during boot gets a **Cuttlely is starting** page that opens Cuttlely when it is ready. Ping answers `503` with `"status":"starting"` until then, so the Compose health check reads `health: starting`, then `healthy`. `CUTTLELY_STARTING_PAGE=off` turns the page off.
-   **Graceful shutdown**: on SIGTERM or SIGINT (what Docker and Render send on every stop and deploy), Cuttlely stops taking new requests, which get `503` with `Retry-After` (ping too), and lets running answers and streams finish for up to 25 seconds (`CUTTLELY_DRAIN_TIMEOUT_MS`). A run still going after that gets a `503`, or an `error` event with status `503` and code `UNAVAILABLE` on a stream, instead of a cut connection. A second signal stops at once. The Compose files give the container 35 seconds to stop.

### Security and API

-   The agent runtime makes no request to models.dev unless `CUTTLELY_MODELS_DEV=1` is set. `SECURITY.md` lists every host Cuttlely connects to and how to turn each off.
-   The API-key chatflow list returns only the flows bound to that key, and only their `id`, `name`, `deployed`, `category` and `type`.
-   Refreshing an OAuth credential needs a session or an API key with credential permissions.
-   Server settings (`/api/v1/server-settings`) are for the owner's signed-in session only. API keys are refused, secret values are accepted but never returned or logged (request bodies stay out of debug logs), and every save, discard and restart goes into the settings history.
-   Prediction errors keep their real status. A streamed `error` event carries `status` and `code`.
-   A model provider that keeps answering 429 is reported as `429` with `Retry-After` (the provider's wait when it sends one, otherwise 30 seconds), not as `500`, and within about 20 seconds instead of about 95: chat models and LLMs make at most 3 tries and start no new try after 20 seconds. A one-off 429 still recovers on the next try. A streamed `error` event also carries `retryAfter`.
-   A prediction with `Origin: null`, or an Origin that is not a URL, is refused.
-   Override configuration never takes a port from a request.
-   A request value never runs as code. In Multi-Agent and Sequential Agent flows, an allowlisted variable referenced in a code input is inserted as escaped text, so it reads as the same text inside quotes and cannot become code anywhere else (covered by tests, including an injection attempt).
-   Dependencies are on patched releases: `pnpm audit` reports no critical advisory and three high ones, none with a fixed release (two in Puppeteer's browser download, which Cuttlely skips, and `braces` in the command-line file matcher and in dev tooling). `expr-eval` is not installed: the older community package that depended on it is gone, and that package has no fixed release. The UI no longer installs Create React App (every UI script already runs Vite), and the server no longer installs a mail library it never used. Excel files are read with SheetJS 0.20.3, the fixed release SheetJS publishes on its own download site. The UI, agentflow and observe builds run on Vite 6.
-   The Docker image is built in two stages: the image you run has production packages only and no compilers.
-   Prediction uploads stay per chat. An image, audio or other file sent again with the same name, in the same chat or another one, is stored under a new name and never replaces an earlier file. Deleting a chat also removes the documents it sent, not only its folder.
-   Deleting a flow also deletes its leads (the name, email and phone people left in its chat), in the same step as the flow, its messages, feedback and upsert history. If any part fails, nothing is deleted.
-   Override configuration never takes the Agent card's knowledge lists (`agentKnowledgeDocumentStores`, `agentKnowledgeVSEmbeddings`) from a request, nor any list whose items choose an embeddings, vector store or model card. A request could otherwise add a knowledge item with no saved credential, which some providers run on a key from the server's environment.
-   Override configuration never switches the model, embeddings or vector store card a step uses (`agentModel`, `llmModel`, `conditionAgentModel`, `humanInputModel`, `embeddingModel`, `vectorStore`, and any picker that loads a card's settings). The saved credential belongs to the owner's card, and another provider could fall back to a key in the server's environment. Settings on the owner's card, such as `modelName` and `temperature` in `agentModelConfig`, still apply when allowlisted.
-   File names stored with a flow can never read outside that flow's folder (covered by tests).
-   Prediction uploads follow the flow's upload settings on the server, not only in the chat. An image, recording, document or chat file the flow does not accept is refused before anything is stored: 403 when that kind of upload is off, 400 for a file type the flow does not take. The chat, the shared chat and the embed upload as before when uploads are on.
-   A file link in an Agent's answer is signed and opens for 15 minutes without the flow's API key, for that one file in that conversation of that flow. Before, a browser user of a key-protected flow got 401 from the link. A changed or expired link is refused, and the key and session checks are unchanged.

### Good to know

Back up your data directory, including its encryption key, before any upgrade. [Upgrading Cuttlely](./docs/upgrading.md) has the steps and how to roll back.

-   **Status codes.**
    -   A prediction with `Origin: null` (sandboxed iframes, `file://` pages) or an Origin that is not a URL gets 403. Server-to-server calls without an Origin are accepted.
    -   Uploading an attachment when uploads are off for the flow returns 403. A file type the flow does not allow returns 400.
    -   A harness that cannot run returns 422 `CANNOT_RUN`. Other 4xx errors keep their status: 402 `QUOTA_EXCEEDED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 429 `RATE_LIMITED`. Anything else is 500 `INTERNAL_ERROR`.
    -   An OAuth credential refresh that the provider rejects with 401 returns 502.
-   **Streaming rule.** `/api/v1/prediction` and the canvas test chat route (`/api/v1/internal-prediction`) stream only for `streaming: true` or `streaming: "true"`. Values like `1`, `"1"` or `"TRUE"` get a JSON answer.
-   **Port overrides.** `port`, `*_port` and `*Port` settings are never taken from a request, even when allowlisted. Leave port entries out of your override configuration, and remove any that are already there. See [Override configuration](./docs/reference/override-config.md).
-   **Stream error events.** A streamed `error` event keeps the message in `data` and adds `status` and `code`.
-   **Image path.** The image's working directory is `/usr/src/cuttlely` (was `/usr/src/flowise`). Update any volume, script or shell command that used the old path. The data volume (`/var/cuttlely`) is not affected.
-   **Prediction uploads.** `POST /api/v1/prediction/:id` takes only the uploads the flow accepts. Documents sent in `files` or as uploads need file uploads on (**Configuration**, **File Upload**, **Enable Full File Upload**), images need a card with image uploads on, and audio needs Speech to Text. Others get 403 when that kind is off, or 400 for a type the flow does not take, and nothing is stored. A file for a document loader input allowed in Override Config is still taken. See [Send a file with the question](./docs/api.md#send-a-file-with-the-question).
-   **Knowledge list overrides.** `agentKnowledgeDocumentStores` and `agentKnowledgeVSEmbeddings` are never taken from a request, even when allowlisted. Remove them from your override configuration; the knowledge saved on the Agent card is used. See [Override configuration](./docs/reference/override-config.md).
-   **Card picker overrides.** `agentModel`, `llmModel`, `conditionAgentModel`, `humanInputModel`, `embeddingModel` and `vectorStore` are never taken from a request, even when allowlisted. Allowlist settings on the card instead (for example `modelName` in `agentModelConfig`). See [Override configuration](./docs/reference/override-config.md).
-   **Request variables.** Request `vars` reach `{{$vars}}` only in Multi-Agent and Sequential Agent flows. In chatflows and agentflows they reach code that reads variables, not `{{$vars}}` in a card's text. In Multi-Agent and Sequential Agent code inputs, a request value written as `{{$vars.name}}` is now inserted as escaped text: inside quotes it reads as before, outside quotes anything but a number stops that card's code with a syntax error. Read `$vars.name` in code instead. See [Request values in code inputs](./docs/reference/override-config.md#request-values-in-code-inputs).
-   **API-key chatflow list.** `GET /api/v1/chatflows/apikey/:apikey` lists only flows bound to that key, with five fields. An unknown key gets 401.
-   **OAuth refresh.** `POST /api/v1/oauth2-credential/refresh/:credentialId` needs a session or an API key with `credentials:create` or `credentials:update`. A credential in another workspace gets 404.
-   **Drafts on by default.** A canvas save starts a draft, and **Publish** makes it Live. Scripts that call `PUT /api/v1/chatflows/:id` write Live. `CUTTLELY_DRAFTS=off` makes the canvas save straight to Live.
-   **Version history on by default.** It needs `git` on `PATH`; the image includes it. `CUTTLELY_VERSIONS=off` turns it off.
-   **Model lists.** Models their providers have shut down, or shut down before November 2026, are not offered, among them `gpt-3.5-turbo`, `gpt-4`, `o1`, Claude 3 models, Gemini 1.5 and 2.0, `deepseek-chat`, `mistral-tiny` and Cohere v2 embeddings. A flow saved with one keeps that model name and still sends it, so it works for as long as the provider accepts it; pick a current model on the card to move off it.
-   **Card look.** The new card look is the default. `CANVAS_CARD_LOOK=classic` sets classic cards for everyone who has not chosen.
-   **V1 agentflows.** Existing V1 agentflows run and open from a direct link. You can't create, duplicate or save one as a template.
-   **Local account on by default.** `scripts/start-cuttlely.sh` turns the local password account on (`CUTTLELY_LOCAL_ADMIN=true`) unless you set it; a blank value counts as unset. In Docker it stays on even with WorkOS keys (Compose sets `CUTTLELY_INSTALL=docker`). From source, the start script leaves it off when `WORKOS_API_KEY` is set or `packages/server/.env` sets it. On Render it is left off. Set `CUTTLELY_LOCAL_ADMIN=false` in `.env` to keep it off.
-   **Node 24.** Running from source needs Node 24 (`.nvmrc`).
-   **Data directory.** Data lives in `~/.cuttlely`, or `/var/cuttlely/data` in Docker and on Render. Keep the encryption key with the database.

[Unreleased]: https://github.com/cuttlely/cuttlely/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/cuttlely/cuttlely/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/cuttlely/cuttlely/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/cuttlely/cuttlely/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/cuttlely/cuttlely/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/cuttlely/cuttlely/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/cuttlely/cuttlely/releases/tag/v1.0.0
