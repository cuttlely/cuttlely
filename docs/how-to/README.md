# How-to guides

Step-by-step guides for building, installing, signing in and running Cuttlely. Each guide covers one task. The full docs index, with the reference pages, is the [Docs overview](../README.md).

## New in 1.7.3

-   A request that gets no answer no longer replaces the page with **Something went wrong**. The page says the server could not be reached. Reload after a failed page load or read; for a failed save or settings update, use Save or Retry so unsaved edits are not discarded. See [What does "The server could not be reached" mean?](../faq.md#what-does-the-server-could-not-be-reached-mean). Importing a chatflow keeps a connection when only the handle type name changed.
-   Brief connection drops while you edit are retried quietly for reads and option loads. A save no longer marks later edits as saved. A canvas whose draft status cannot be loaded stays closed with Retry. [Canvas cards](./canvas.md).
-   Self-hosted installs behind a reverse proxy keep idle connections open for 65 seconds by default. See the [reverse proxy guide](./reverse-proxy.md). [Install with Docker](./docker.md).
-   Draft and Live saves of an existing flow, without new file data, are kept and retried quietly when a request gets no answer. If that still fails, the canvas keeps the edits and offers Retry. A save with new file data is attempted once per Save and is not resent automatically. After an unanswered create, check your flows in another tab before trying again.

## New in 1.7.2

-   [Choose what chat shows](./share-and-embed.md#what-the-chat-shows) with **Show tool events**. Chatflows start with it Off; Harness run cards stay visible. The shared link and website embed show answers, sources, attachments and Harness run cards, without other live tool or step status cards.
-   Access-key and Publish dialogs have clearer labels and controls. Calls between flows and agent teams keep the caller's access permissions, including calls from an external worker. [Access keys](./access-keys.md).
-   The [first-account setup steps](../../README.md#your-first-10-minutes) explain that the setup code needs local sign-in already enabled at the host, and that [claiming the instance operator](./instance-operator.md) is a separate step. [Upgrade notes](../upgrading.md).

## New in 1.7.1

-   [Create a working access key](./access-keys.md) with flow-first presets, automatic Harness prerequisites, a server check and copyable examples. Private copies and saved API access fail closed. [Upgrade notes](../upgrading.md).

## New in 1.7.0

-   [Designate the instance operator](./instance-operator.md). Only actual host bindings grandfather; legacy installs claim in the panel with one host-log code. Routine lifecycle is in the panel; the CLI is emergency recovery. Overrides, revocation and recovery. Read the [1.7.0 upgrade warnings](../upgrading.md) before deployment.

-   [Create and manage access keys](./access-keys.md). Create a scoped key, restrict callers, call a private flow, rotate and revoke it. Enforcement defaults to `off`; follow operator rollout first. [Policy and route reference](../reference/access-keys.md).
-   [Pending owner invitations](./users-without-authkit.md). An active owner or an Admin (`users:manage`) can cancel a pending invitation, including another pending owner invite, and revoke its links. Removing an active or disabled person from every team stays owner-only. Active owners remain read-only in the Users UI.

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
-   [Tune and publish an agent team](./tune-agent-team.md). Choose how a team reads data and answers, then check a draft before Publish.
-   [Analyst mode](./analyst.md). A specialist with its own database that creates tables and answers from them.
-   [Pinned queries](./pinned-queries.md). Saved, tested SQL with typed parameters on the Postgres (MCP) node.
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
