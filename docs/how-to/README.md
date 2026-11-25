# How-to guides

Step-by-step guides for building, installing, signing in and running Cuttlely. Each guide covers one task. The full docs index, with the reference pages, is the [Docs overview](../README.md).

## New in 1.7.15

-   Install on ephemeral disks, update an existing PostgreSQL service, or migrate a SQLite installation. Compare PostgreSQL-only with an optional S3-compatible bucket. [Upgrade and rollback](./postgres-side-stores.md).

## New in 1.7.14

-   Keep operator authority and saved settings when an ephemeral container is replaced. [Operator storage](./instance-operator.md#keep-authority-and-settings-when-a-container-is-replaced).
-   Stage a replacement encryption key on an isolated restore, then verify it before reopening traffic. [Key rotation](./server-settings.md#rotate-the-installation-encryption-key).
-   Configure the SQL attempt allowance for each specialist turn. [Server settings](./server-settings.md).

## New in 1.7.13

-   Run a chief directly and inspect its specialist steps. [Agent mode](./harness-agent-mode.md).
-   Manage agent time limits and review when a saved change takes effect. [Server settings](./server-settings.md#long-running-queries-and-tasks).
-   Review the one-time Analyst password migration before upgrading. [Upgrade guide](../upgrading.md#upgrading-to-1713).

## New in 1.7.12

-   **Connect roster over the runtime's stdio framing.** Roster now connects over the stdio framing the agent runtime uses; it had never connected since 1.0. Boot is about 60 seconds faster per mixed-model harness (about 2 minutes with two), and the chief's `run_specialist` tool now registers. Router traffic is unchanged. [Upgrade guide](../upgrading.md#upgrading-to-1712).
-   **Keep concurrent ETL controls consistent.** Starting, resuming, pausing and cancelling ETL runs at the same moment no longer leaves a cancelled or paused run running or starts a second run for one pipeline. [ETL](./etl.md).

## New in 1.7.11

-   **Let the agent runtime finish a cold start.** The startup tool list is no longer refused while the runtime status is `restarting`, so the runtime can answer health and come up. Tool calls and chat completions are still refused until then. [Upgrade guide](../upgrading.md#upgrading-to-1711).

## New in 1.7.10

-   **Point health checks at liveness.** The image, Compose and Render probe `/api/v1/ping/live`; keep strict `/api/v1/ping` for readiness. [Health checks](./reverse-proxy.md#health-checks).
-   **Recover the agent runtime in place.** Backoff, cooldown and in-place stack restart, with `503 RUNTIME_UNAVAILABLE` and `Retry-After` while it is down. [Agent runtime recovery](./server-settings.md#agent-runtime-recovery).
-   **Store Dash Flows on Postgres (preview).** Default-off `CUTTLELY_APP_DATABASE_STORES` switch. [Storage on Postgres](./dashflows.md#storage-on-postgres-preview).

## New in 1.7.9

-   **Trace a single Harness node.** Use LangSmith Analytics without a Tool Agent wrapper. [LangSmith tracing](../reference/langsmith-tracing.md#harness-chatflows).
-   **Resume ETL work.** Scans yield to requests, interrupted repository files resume correctly and error-limit failures retain their first cause. [ETL](./etl.md).
-   **Create the first owner from host configuration.** Bootstrap an empty local-password installation without the setup link. Existing accounts are preserved. [Sign in](./sign-in.md#from-host-configuration).
-   **Review dropped import edges.** Missing source outputs and target inputs are reported instead of reassigned. [Bring your flows](../bring-your-flows.md).
-   **Read operator request errors.** Active-code guidance and neutral limit messages appear as errors when a request is refused. [Instance operator](./instance-operator.md).

## New in 1.7.8

-   **Choose a GitHub branch for version history.** Select a repository, then a branch. Existing connections keep working, and named environment chains retain their mappings. [Version History](./versioning.md).

## New in 1.7.7

-   **Cancellation stays within one chat.** Stopping an agent-team chat leaves other chats using the same specialist running. [Harnesses](./harnesses.md).

## New in 1.7.6

-   **Import and verify with automatic inputs.** Required dates, calendar periods and numeric inputs are selected from defaults, the query and bounded samples of selected tables. Optional filters without defaults stay unset. A query that cannot be tested safely stays unverified. [Import and verify](./import-verify.md).
-   **Try an imported team before Publish.** Signed-in canvas chat can run an unpublished harness. Its draft conversation state stays separate from runnable profiles, so a preview does not block the first Publish. External runs still need a published team. [Harnesses](./harnesses.md).
-   **Reset local passwords.** Generate a one-time reset link in User Management, copy it privately, or have configured mail deliver it. The server still checks team, permission, identity-provider and owner restrictions. [Users without AuthKit](./users-without-authkit.md#reset-a-local-users-password).
-   **Manage people across teams.** View each person's teams, roles, status and last login; disable or reactivate a local account; and change or cancel a pending invitation. Role assignments are preserved, and disabled sessions, links and keys are not restored on reactivation. [Manage users and teams](./users-without-authkit.md).

## New in 1.7.5

-   Version History can connect a GitHub repository that already has files or commits. The first copy adds its versions on top of the existing history, and a GitHub change to a path this server copied stops the copy instead of overwriting it. [Version History](./versioning.md).
-   Import & verify reports skipped or untested output contracts as not tested, tests every saved query in a large flow, and checks each output contract against its own fresh result. PDF checks use the bundled agent runtime's Python libraries. A PostgreSQL card whose saved queries need a retest returns that error instead of an empty success.
-   Follow-up prompts omit blank or invalid temperature values and omit temperature for OpenAI reasoning models that do not accept one.

## New in 1.7.4

-   An analyst specialist stays ready after another specialist lists tools. Unset Analyst storage is Auto. [Analyst mode](./analyst.md).
-   Importing a harness attaches a credential that already exists here with the same name and type, including a nested credential id next to an empty credential slot. [Bring your existing flows](../bring-your-flows.md).
-   **Import & verify** retests saved queries on this server before Publish. A stamp in the file is not trusted. Live stays as it is until the checks pass.
-   Try the demo on a fresh install saves the staged team. [Try the demo](./try-the-demo.md).

## New in 1.7.3

-   A request that gets no answer no longer replaces the page with **Something went wrong**. The page says the server could not be reached. Reload after a failed page load or read; for a failed save or settings update, use Save or Retry so unsaved edits are not discarded. See [What does "The server could not be reached" mean?](../faq.md#what-does-the-server-could-not-be-reached-mean). Importing a chatflow keeps a connection when only the handle type name changed.
-   Brief connection drops while you edit are retried quietly for reads and option loads. A save no longer marks later edits as saved. A canvas whose draft status cannot be loaded stays closed with Retry. [Canvas cards](./canvas.md).
-   Self-hosted installs behind a reverse proxy keep idle connections open for 65 seconds by default. See the [reverse proxy guide](./reverse-proxy.md). [Install with Docker](./docker.md).
-   Draft and Live saves of an existing flow, without new file data, are kept and retried quietly when a request gets no answer. If that still fails, the canvas keeps the edits and offers Retry. A save with new file data is attempted once per Save and is not resent automatically. After an unanswered create, check your flows in another tab before trying again.
-   [Pending invitations](./users-without-authkit.md). An active owner or an Admin (`users:manage`) can cancel a pending invitation from User Management, including another pending owner invite, and revoke its links. Removing an active or disabled person from every team stays limited to an active owner.

## New in 1.7.2

-   [Choose what chat shows](./share-and-embed.md#what-the-chat-shows) with **Show tool events**. Chatflows start with it Off; Harness run cards stay visible. The shared link and website embed show answers, sources, attachments and Harness run cards, without other live tool or step status cards.
-   Access-key and Publish dialogs have clearer labels and controls. Calls between flows and agent teams keep the caller's access permissions, including calls from an external worker. [Access keys](./access-keys.md).
-   The [first-account setup steps](../../README.md#your-first-10-minutes) explain that the setup code needs local sign-in already enabled at the host, and that [claiming the instance operator](./instance-operator.md) is a separate step. [Upgrade notes](../upgrading.md).

## New in 1.7.1

-   [Create a working access key](./access-keys.md) with flow-first presets, automatic Harness prerequisites, a server check and copyable examples. Private copies and saved API access fail closed. [Upgrade notes](../upgrading.md).

## New in 1.7.0

-   [Designate the instance operator](./instance-operator.md). Only actual host bindings grandfather; legacy installs claim in the panel with one host-log code. Routine lifecycle is in the panel; the CLI is emergency recovery. Overrides, revocation and recovery. Read the [1.7.0 upgrade warnings](../upgrading.md) before deployment.

-   [Create and manage access keys](./access-keys.md). Create a scoped key, restrict callers, call a private flow, rotate and revoke it. Enforcement defaults to `off`; follow operator rollout first. [Policy and route reference](../reference/access-keys.md).
-   [Pending owner invitations](./users-without-authkit.md). An active owner can cancel another pending owner invite and revoke its links; active owners remain read-only in the Users UI.

## New in 1.6.1

-   **Updated:** [Dashflows BETA](./dashflows.md). Evidence inspection with searchable account lists and executive hover summaries, a six-hour durable cache for pipeline date-range presets, and optional public snapshot links with account-scoped health reports. Still Experimental and off by default.

## New in 1.6.0

-   **New:** [Dashflows BETA](./dashflows.md). Turn on the Experimental, default-off BETA to build dashboards from tested PostgreSQL queries, with weekly or on-demand draft refreshes.
-   **Updated:** [Runtime warm-up](./harnesses.md#runtime-warm-up). Choose Off, Probe periodically (the default), or Timed full warmup, then save and restart.
-   **Updated:** [Version history](./versioning.md#keep-a-copy-in-github). Connect a GitHub Enterprise host, and use **Back** from an open version without returning to it again.
-   **Updated:** [Share and embed](./share-and-embed.md). Public chat and embedded chat show the paperclip for File Upload, and public PDF downloads work in a signed-in browser session.
-   **Updated:** [Context and tokens](./context-and-tokens.md). File-capable specialists receive complete recent answers within the documented limit for follow-up report exports.

## New in 1.5.2

-   **New:** [Sort answer tables](./answer-tables.md). Click a column header in a chat answer's table to sort it, in the app chat and the embedded widget.
-   **Updated:** [While a run works](./harnesses.md#while-a-run-works). A running harness card shows a live status line, a status per specialist and a timer, with optional playful lines you can turn off per chatflow.
-   **Updated:** [Template variables insert values exactly](./canvas.md#template-variables-insert-values-exactly). Agentflow variables keep `$` characters as written.

## New in 1.5.1

-   **New:** [Set the evidence budget](./evidence-budget.md). **Evidence budget (bytes)** in **Admin** sets how much protected source detail specialists get for analysis, with an optional value per specialist.

## New in 1.5.0

-   **New:** [SCIM provisioning](./auth-sso.md#scim-provisioning). Okta or Entra ID creates, updates and deactivates Cuttlely users, and group mappings give them a team and a role, with a preview first.
-   **New:** [Tidy the layout](./harnesses.md#tidy-the-layout). **Tidy layout** on the harness canvas puts Harness Prime first and one row per specialist; **Undo** puts the cards back.
-   **New:** [Read web pages as source text](./harnesses.md#read-web-pages-as-source-text). The Web Browser card can return bounded excerpts of the real page and record the exact address it read.
-   **New:** [Trusted outputs](../reference/trusted-outputs.md). The CSV contract's opt-in `escapeFormulas` setting, and `renderWhen` with `otherwisePath` for lookups that end unresolved.
-   **Updated:** [Set up generic OIDC](./auth-sso.md#set-up-generic-oidc) and [Set up local login](./auth-sso.md#set-up-local-login). The sign-in methods added in 1.4.9, now on one page with SCIM and [WorkOS](./auth-sso.md#set-up-workos).
-   **Updated:** [Analyst mode](./analyst.md#recent-changes). The regrouped Postgres (MCP) panel, and the **Not connected.** note a harness shows when this server has no database for its analyst.

## Build agent teams

-   [Harnesses](./harnesses.md). Build an agent team, connect a chat model, try it, publish it and call it from your app.
-   [Run a harness in agent mode](./harness-agent-mode.md). Call the chief on the agent runtime and let it delegate through `run_specialist`.
-   [Tune and publish an agent team](./tune-agent-team.md). Choose how a team reads data and answers, then check a draft before Publish.
-   [Analyst mode](./analyst.md). A specialist with its own database that creates tables and answers from them.
-   [Pinned queries](./pinned-queries.md). Saved, tested SQL with typed parameters on the Postgres (MCP) node.
-   [Import and verify](./import-verify.md). Import a flow or harness file, retest its saved queries on this server, and publish only after the checks pass.
-   [Set the evidence budget](./evidence-budget.md). How much protected source detail a specialist gets for analysis, for the server or one specialist.
-   [Context and tokens](./context-and-tokens.md). How a team keeps each prompt short, and where a run shows the tokens it used.
-   [How the customer care demo works](./customer-care-demo.md). The specialists, data and rules behind the demo team.
-   [Try the demo](./try-the-demo.md). Watch a customer care team resolve a late-order complaint in about a minute.

## Build flows and pipelines

-   [Canvas cards](./canvas.md). Chatflows, agentflows and the cards on the canvas, compact or classic.
-   [ETL](./etl.md). Pipelines that load, clean, split, embed and store your data for search.
-   [Optional node packs](./node-packs.md). Load more nodes and credentials from a directory or a package.
-   [Share and embed a chat](./share-and-embed.md). A public link for a chatflow, or a chat on your website.
-   [Sort answer tables](./answer-tables.md). Sort the rows of a table in a chat answer by any column.

## Test and ship changes

-   [Version history](./versioning.md). Drafts and Publish, compare and restore versions, and move a flow from Dev to Prod.
-   [A/B test a change with Compare](./ab-testing.md). Ask the same questions of Live and your draft and see what changed.
-   [Evaluations](./evaluations.md). Datasets and checks that score answers, and a Publish that waits for them.
-   [Turn real answers into tests](./tests-from-answers.md). Make a test row from a rated answer in the message viewer.
-   [Fail a build when answers change](./ci-gate.md). Run the Publish check from CI with `cuttlely check`.
-   [Run traces](./observability.md). Optional OpenTelemetry traces for predictions, agentflow runs and harness runs.

## Install and run

-   [Docker](./docker.md). The install most people want: SQLite, one container.
-   [Render](./render.md). A hosted install with Postgres, from the Blueprint in the repository.
-   [Build from source and run the dev server](./from-source.md). Build Cuttlely yourself and change it with live reload.
-   [Run behind a reverse proxy](./reverse-proxy.md). Keep reused upstream connections and streaming chats reliable.
-   [Server settings](./server-settings.md). Change how the server runs from **Admin** > **Server Settings**.

## Sign in and manage people

-   [Choose the sign-in method](./auth-sso.md). Local login, generic OIDC or WorkOS, owner recovery, and SCIM provisioning.
-   [Sign in](./sign-in.md). Create the first account, sign in and invite people.
-   [Users without AuthKit](./users-without-authkit.md). Email and password accounts, with one-time invite and reset links.
-   [Roles and permissions](./roles-and-permissions.md). Teams, built-in and custom roles, and what each permission allows.
-   [Audit log](./audit-log.md). Who signed in, changed a role or a setting, and when.

## Connect other platforms

-   [Call a chatflow from Orchestrate](./orchestrate.md). Register a published chatflow as an external agent that a native agent calls.
-   [Use a chatflow as an Orchestrate toolkit](./orchestrate-mcp.md). Import a flow's MCP endpoint as a remote toolkit.
-   [Record the Orchestrate demo](./orchestrate-demo.md). The runbook for the Larkfield Home orders demo.
