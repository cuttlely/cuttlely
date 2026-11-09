# Cuttlely FAQ (1.7.1)

**The visual agent builder, ready for production.** Drag-and-drop agents with real governance and lean context. Open source, Apache-2.0.

Try it in a few minutes:

```
git clone https://github.com/cuttlely/cuttlely && cd cuttlely && docker compose up -d
```

Or, with Node 20+ and Docker: `npx cuttlely start`. Open http://localhost:43117, add one model key, and pick **Try the demo** (all the data is made up). If it's useful, a star on [GitHub](https://github.com/cuttlely/cuttlely) helps other builders find it.

## The basics

### How do you say Cuttlely?

Like "cuddly".

### What is Cuttlely?

A visual agent builder you run yourself, built around three things:

-   **Governance.** Every edit waits in a draft while Live keeps serving. Before you publish, replay recent real questions on Live and the draft, side by side. Gate Publish on a test set and roll Live back in one step. Roles, an audit log, and access keys with explicit resource grants when [enforcement is enabled](docs/reference/access-keys.md).
-   **Lean context.** Each specialist gets a self-contained task, not the whole chat, and the analyst sees only the tables you tick. Fewer tokens in our internal benchmarks, and every run shows what it used.
-   **Build agent teams.** Describe a team and Build with AI puts a first version on the canvas, with every part and connection checked. Call it from your app with a scoped API key, or put it on a schedule.

Try it: `git clone https://github.com/cuttlely/cuttlely && cd cuttlely && docker compose up -d`, then open http://localhost:43117 and select **Try the demo**.

### How do I install it?

`git clone https://github.com/cuttlely/cuttlely && cd cuttlely && docker compose up -d` runs one container on SQLite. `npx cuttlely start` (Node 20+ and Docker) pulls the same image. There's also a Render Blueprint. Then open http://localhost:43117.

### Is it really open source?

Cuttlely is open source under Apache-2.0. The bundled agent runtime is Hermes (MIT). Other packages keep the licenses their owners gave them. See [CREDITS.md](CREDITS.md).

### Does it send telemetry?

Nothing by default, and no key ships in the repo. If you set your own `POSTHOG_PUBLIC_API_KEY`, usage events go to your PostHog project, and `DISABLE_CUTTLELY_TELEMETRY=true` turns that off.

### What's new in 1.7.1?

Flow-first access-key presets, automatic prediction prerequisites, a server check with one-click fixes, copyable examples, correct saved Private access and private copies. PostgreSQL flow deletion removes grants and private bindings atomically. See [Access keys](./docs/how-to/access-keys.md). Use matching 1.7.1 server and widget packages.

### What changed in 1.7.0?

Scoped access keys and host-backed service administration. This security-exception release requires upgrade action: back up the database, encryption key and settings, then arrange [operator onboarding and recovery](./docs/how-to/instance-operator.md) before deployment. Only verified host CLI bindings grandfather; legacy installs without one claim in Server settings with a code from the hosting dashboard or Docker/Compose logs. Only the designated operator can change service-wide settings. Routine lifecycle is in the panel; the CLI is emergency recovery. Enforcement stays Off by default. Read the [upgrade warnings](./docs/upgrading.md) and [changelog](./CHANGELOG.md). To select 1.7.0, pin image `ghcr.io/cuttlely/cuttlely:1.7.0` or install `cuttlely@1.7.0`.

### What changed in 1.6.1?

-   **Dashflows BETA** evidence inspection now leads with account names, executive hover summaries, and searchable risk-filtered source lists (up to 100 records). Pipeline period and region changes automatically save and refresh, with a six-hour workspace-scoped durable cache for date-range presets. Optional public snapshot links expose frozen published data and account-scoped health reports; team-only remains the default. Still Experimental and off by default. See [Dashflows BETA](./docs/how-to/dashflows.md).
-   No breaking changes; read the [1.6.1 changelog](./CHANGELOG.md#161---2026-11-06). That release used image `ghcr.io/cuttlely/cuttlely:1.6.1` and package `cuttlely@1.6.1`.

Full notes: [v1.6.1 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.6.1).

### What's new in 1.6.0?

-   **Dashflows BETA** is an Experimental, default-off dashboard builder backed by tested PostgreSQL queries and saved typed snapshots. Draft refreshes run weekly or on demand. See [Dashflows BETA](./docs/how-to/dashflows.md).
-   **Experimental restart** confirms and applies startup-setting changes through the existing in-place restart or manual steps path. Agent runtime warm-up now offers Off, Probe periodically (the default), and Timed full warmup. See [Runtime warm-up](./docs/how-to/harnesses.md#runtime-warm-up).
-   **Version History** connects to a GitHub Enterprise host. **Back** from an open version returns to history or the page that opened it. See [Keep a copy in GitHub](./docs/how-to/versioning.md#keep-a-copy-in-github).
-   Shared and embedded chats show the paperclip when File Upload is on. Public PDF downloads work in a signed-in browser session that also holds the public chat token. See [Share and embed](./docs/how-to/share-and-embed.md).
-   File-capable specialists receive complete recent answers within the documented limit for follow-up report exports, including long tables and final sections.
-   No breaking changes; read the [1.6.0 changelog](./CHANGELOG.md#160---2026-11-06). To upgrade, pull image `ghcr.io/cuttlely/cuttlely:1.6.0`, or run `npm i cuttlely@1.6.0`.

Full notes: [v1.6.0 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.6.0).

### What's new in 1.5.2?

-   While a harness run works, the run card in the app chat and the embedded widget shows what it is doing right now, a status on each running specialist and a ticking timer. Optional playful lines fill long steps; turn them off per chatflow under **Configuration** > **Chat** > **Enhanced Status Messages**. See [Read the run card](./docs/how-to/harnesses.md#read-the-run-card).
-   Tables in chat answers sort by column: click a header to sort ascending, then descending. See [Sort answer tables](./docs/how-to/answer-tables.md).
-   Agentflow template variables insert values exactly, including text with `$` characters.
-   No breaking changes; read the [1.5.2 changelog](./CHANGELOG.md#152---2026-11-03). To upgrade, pull image `ghcr.io/cuttlely/cuttlely:1.5.2`, or run `npm i cuttlely@1.5.2`.

Full notes: [v1.5.2 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.5.2).

### What's new in 1.5.0?

-   **SCIM v2 provisioning.** Identity providers such as Okta and Entra ID can create, update and deactivate Cuttlely users and push groups. On **Admin** > **Auth / SSO**, create the SCIM credential, map a provider group to a Cuttlely team, optionally with a role, after previewing exactly what will change, and watch request counts and recent errors in Operations. Deactivating a SCIM-provisioned person in the identity provider ends their Cuttlely sessions and disables the API credentials and personal tokens they own; API credentials created before 1.4.9 have no recorded owner and stay usable. See [Choose the sign-in method](./docs/how-to/auth-sso.md#scim-provisioning) and the [SCIM API](./docs/reference/scim-api.md).
-   **Tidy layout** on the harness canvas lines the cards up: Harness Prime and its chat model first, then one row per Harness Specialist. Save to keep the new layout, or **Undo** to put the cards back. See [Tidy the layout](./docs/how-to/harnesses.md#tidy-the-layout).
-   Trusted-output CSV reports have an opt-in `escapeFormulas` setting that keeps spreadsheet apps from treating a cell as a formula. It is off by default, so files are unchanged until you turn it on. See [Trusted outputs](./docs/reference/trusted-outputs.md).
-   Agent teams keep more source-backed evidence across follow-ups and repairs, keep citation links intact, and no longer drop a completed report after a refused retry. When Harness Prime routes a turn, it can ask a specialist that interprets protected evidence for a short self-contained summary. The [changelog](./CHANGELOG.md#150---2026-11-01) lists every fix.
-   Read the upgrade notes in the [1.5.0 changelog](./CHANGELOG.md#150---2026-11-01) before you upgrade. Back up first. For SCIM-provisioned users, the identity provider decides who is active; other accounts stay managed in Cuttlely. Coming from 1.4.8, also read the [1.4.9 upgrade notes](./CHANGELOG.md#149---2026-10-31).
-   To upgrade, pull image `ghcr.io/cuttlely/cuttlely:1.5.0`, or run `npm i cuttlely@1.5.0`.

Full notes: [v1.5.0 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.5.0).

### What's new in 1.4.10?

-   If you're on 1.4.9, upgrade. A JSON setting on a node, credential or document store whose saved value is blank or cut off partway no longer crashes the page. The JSON editor opens it as `{}` and writes nothing back until you edit it; valid values open as before.
-   If a page still fails to load or render, Cuttlely shows a short error page with **Reload**, **Go home** and collapsible error details instead of the default router error screen.
-   Trusted-output CSV reports are delivered with their source tables: complete rows, up to the contract limit.
-   The **Postgres (MCP)** node's settings panel is redesigned, with clearer labels and a panel you can resize or expand. When the server's analyst settings turn it on (off by default), its pinned query list can be searched.
-   This release has no upgrade notes of its own. Coming from 1.4.8, read the [1.4.9 upgrade notes](./CHANGELOG.md#149---2026-10-31) first.
-   The [changelog](./CHANGELOG.md#1410---2026-11-01) lists every change.
-   To upgrade, pull image `ghcr.io/cuttlely/cuttlely:1.4.10`, or run `npm i cuttlely@1.4.10`.

Full notes: [v1.4.10 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.4.10).

### What's new in 1.4.9?

-   If you're on 1.4.8, upgrade. **Admin** > **Auth / SSO** shows the sign-in method and adds **Generic OIDC** sign-in, which you configure, test and activate there. **Owner recovery** on the sign-in page lets an active owner with a local password sign in whatever method is selected. All sign-in methods share one Cuttlely session, and disabling a user refuses their next request.
-   Chatflow import, including the migration wizard, keeps edge references in node inputs, fills missing defaults and refreshes older nodes. If you imported flows with the migration wizard in 1.4.8, open each one. If **Sync Nodes** is shown, click it. If it is not, select **Export Chatflow** in the canvas settings menu, then choose the import item in the same menu and select the exported file, or the original file you imported in 1.4.8; the migration wizard rebuilds each connection's reference from its edge on the same canvas, and you select credentials and fill password, file and folder fields again. Then select **Save** and **Publish**. See the [1.4.9 upgrade notes](./CHANGELOG.md#149---2026-10-31).
-   On a WorkOS install, give the earliest active owner a local password: from source, run `pnpm user --email <owner email>` in the repository root; with Docker Compose, run `docker compose exec -u node -it cuttlely pnpm user --email <owner email>`. For another existing owner, add `CUTTLELY_LOCAL_ADMIN=true` (with Docker Compose, `-e CUTTLELY_LOCAL_ADMIN=true` after `exec`). See [In a terminal](./docs/how-to/sign-in.md#in-a-terminal). Until then, administrators see a banner that owner recovery is not ready. WorkOS users sign in again once after the upgrade.
-   Chat model nodes no longer pass `NaN` as the temperature when the field is empty; the model library's default applies.
-   The [changelog](./CHANGELOG.md#149---2026-10-31) lists every change and the upgrade notes.
-   To upgrade, pull image `ghcr.io/cuttlely/cuttlely:1.4.9`, or run `npm i cuttlely@1.4.9`.

Full notes: [v1.4.9 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.4.9).

### What's new in 1.4.8?

-   If you're on 1.4.7, upgrade: **Admin** > **Server Settings** has two new owner settings. **Allow HTTP building blocks to call localhost** is off by default and marked high risk; when it is on, any flow author can reach any service on the server's own localhost, and entries in `HTTP_DENY_LIST` stay blocked. **Maximum concurrent agent runs** defaults to 10, accepts 1 to 50 or 0 for unlimited, and applies after a restart.
-   Pinned and SQL fast-path answers no longer fall back to the slower handoff on long results that contain URLs or ellipses.
-   HTTP building blocks that call a host name, such as **HTTP** and **Execute Flow**, connect again on Node 20 and later; before, they failed with `Invalid IP address: undefined`.
-   Publishing a specialist again with changed pinned-query parameters gives the agent the new tool schema on its next start.
-   The UI HTML sanitizer uses dompurify 3.4.17.
-   1.4.8 also adds Harness Specialist **Trusted outputs**, **Pin first** and **Answer direct**, and an **Agent run time** setting in Admin. The [changelog](./CHANGELOG.md#148---2026-10-30) lists every change.
-   To upgrade, pull image `ghcr.io/cuttlely/cuttlely:1.4.8`, or run `npm i cuttlely@1.4.8`.

Full notes: [v1.4.8 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.4.8).

### What's new in 1.4.7?

-   If you're on 1.4.6, upgrade: Add User now lets you pick an existing user, or enter their email, and adds that account to the team with the chosen role instead of failing with "A user with this email already exists". Their other teams are kept and no second account is created. Adding someone who is already on the team says so, and new users are still created as before.
-   The Harness Specialist **Handoff limit** accepts `-1` for no limit: Harness Prime reads the specialist's whole answer, and a full context still shortens it.
-   To upgrade, pull image `ghcr.io/cuttlely/cuttlely:1.4.7`, or run `npm i cuttlely@1.4.7`.

Full notes: [v1.4.7 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.4.7).

### What's new in 1.4.6?

-   If you're on 1.4.5, upgrade: with **Return Source Documents** on, the Retriever Tool now puts a numbered `[n]` line before each chunk it shows the model, with the chunk's title and its http(s) URL when the metadata has them (`[n] title - url`), so a harness specialist can cite the page it read. An absolute file path in the metadata shows as the file name only. Harness Prime's `Sources:` list also adds a source's http(s) URL next to its name when the name is not already that URL. With the option off, the tool's output is unchanged.
-   **Start a new session** (formerly Clear chat history) now clears the chat on screen and starts a new session; past messages are kept.
-   To upgrade, pull image `ghcr.io/cuttlely/cuttlely:1.4.6`, or run `npm i cuttlely@1.4.6`.

Full notes: [v1.4.6 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.4.6).

### What's new in 1.4.5?

-   If you're on 1.4.4, upgrade: the PostgreSQL MCP node's read-only check now accepts read-only helper functions written as string-body SQL or PL/pgSQL (for example date, number and timestamp parsing helpers used in views) without adding them to **Allowed functions**; functions that write are still refused. Only helpers that pass every condition of the [user function rule](./docs/how-to/analyst.md#user-functions) qualify; for example a `VOLATILE` helper, or one that reads a table or view, still needs an entry, and a function you add to Allowed functions runs without this check, as before.
-   To upgrade, pull image `ghcr.io/cuttlely/cuttlely:1.4.5`, or run `npm i cuttlely@1.4.5`.

Full notes: [v1.4.5 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.4.5).

### What's new in 1.4.4?

-   If you're on 1.4.3, upgrade: changing a model could make MCP calls fail with Unauthorized until a restart. Harness tool calls now pick up the refreshed gateway token after a profile recompile.

Full notes: [v1.4.4 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.4.4).

### What's new in 1.4.3?

-   **Allowed functions** on the PostgreSQL MCP node lists your own SQL helpers, one `schema.fn(argtypes)` or `schema.fn(*)` per line. Since 1.4.5, string-body SQL and PL/pgSQL helpers that pass the [user function rule](./docs/how-to/analyst.md#user-functions) run without an entry. While a table selection is set, text search types `regconfig` and `regdictionary` are refused unless they are passed directly as constants to the built-in text-search functions, such as `to_tsvector`. Other object-identifier types, such as `regclass`, are refused only while a table selection is set.
-   At startup, harness profiles compiled by an older version are compiled again. The harness gateway health check and `GET /api/v1/ping` return 503 during that wait. Once the wait cap passes, ping can return 200 while the compile is still running; chat and prediction stay at 503 until it finishes. `CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS` defaults to 180 seconds and is capped at 300.
-   Chat answers keep a slash between words, including a fraction or a date, and still hide server paths, except in a short JSON answer, which is returned unchanged.
-   A lone Harness card on an agent keeps `harness`, so existing flows that call `tool:harness` still run. When two or more Harness cards are on one agent, each gets its own tool name with a unique suffix.
-   The Current Date Time tool formats the local date and time in an IANA timezone. Set **Timezone** on the node, or `CUTTLELY_DEFAULT_TIMEZONE` when that field is empty; a call can pass `timezone`, which wins.
-   A LangSmith credential with no key does not use the server's key. Tracing for that flow stays off. A failed upload log records the credential id and the key length.
-   Deleting a harness removes its agent runtime profile and its specialists' profiles after their gateway tokens are revoked.
-   The assets preset downloads a file only from public addresses, with a browser-like user agent, and a failed tool call shows as failed.

Full notes: [v1.4.3 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.4.3).

### What's new in 1.4.2?

-   LangSmith traces from flow runs upload with the LangSmith credential and project set in the flow's Analytics settings, instead of no credential and the `default` project.
-   Model calls a harness makes in process during a harness tool run show as child runs of that tool run in LangSmith. Agent-loop specialist calls through the harness gateway and jobs run by another worker are not attached.
-   A failed LangSmith upload is logged with its status, path and flow id.
-   Editing a credential keeps its saved values instead of replacing them with the placeholders the dialog shows.

Full notes: [v1.4.2 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.4.2).

### What's new in 1.4.1?

-   A harness called as an agent tool runs one default specialist when Harness Prime's routing reply cannot be read, instead of the whole roster. Set it in **Default Specialist** on Harness Prime.
-   The Harness node's **Tool Input** chooses whether Harness Prime routes the person's message (the default) or the agent's task.
-   Images and files a run stored reach watsonx Orchestrate and A2A answers as signed links. `EXTERNAL_FILE_LINK_TTL_SECONDS` sets their lifetime (default 3600, from 60 to 86400).

Full notes: [v1.4.1 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.4.1).

### What's new in 1.4.0?

-   Harness specialists can send PPTX presentations as chat downloads.
-   Harness answers show file names only, never folder paths, and Harness Prime attaches files once.
-   ChatOpenAI and Azure ChatOpenAI honor the **Reasoning** toggle, and **Reasoning Effort** has a **None** option.
-   PNG and JPEG images in the chat can be downloaded.

Full notes: [v1.4.0 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.4.0).

### What's new in 1.3.1?

-   Every flow an MCP server: turn on **MCP Server** for a flow and other agents call its Live version over MCP. The flow's Rate Limit applies, and request bodies over 1 MB are refused.
-   Published chatflows answer watsonx Orchestrate native agents. In 1.3.1 this required a bound API key; the current setup is described under Access keys and owner invitations below.
-   A new install opens one `/setup` page. The server log prints the link and a setup code that lasts 60 minutes and works once.
-   `npx cuttlely start` on Node 20 waits until the health check answers.
-   Two security fixes for versions up to and including 1.3.0: [GHSA-2v98-33pc-jj6f](https://github.com/cuttlely/cuttlely/security/advisories/GHSA-2v98-33pc-jj6f) (setup code) and [GHSA-4p9j-8j59-gwr7](https://github.com/cuttlely/cuttlely/security/advisories/GHSA-4p9j-8j59-gwr7) (public config endpoints).

Full notes: [v1.3.1 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.3.1).

### What's new in 1.3.0?

-   Run a harness (an agent team) from your app with an API key, synchronously or async with a run id.
-   Cron schedules with time zones.
-   New audit log types for harness runs, key access and schedules.
-   The analyst's **Tables and views** picker, a `describe` tool and a **Rules** box.
-   Several analysts in one team.
-   A security pass.

Full notes: [v1.3.0 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.3.0).

## Bringing your flows

### Where does the code come from?

Cuttlely is its own project, open source under Apache-2.0. Like most open-source software it includes code from other projects: the chatflow canvas, node catalog and prediction API include Apache-2.0 code from other open-source projects, credited in [NOTICE](https://github.com/cuttlely/cuttlely/blob/main/NOTICE), the agent runtime is Hermes from Nous Research, and the canvas UI uses React Flow. Each is credited in [NOTICE](./NOTICE) and [CREDITS.md](./CREDITS.md). Cuttlely is built around governance (drafts, side-by-side replay, gates, rollback, roles, audit, scoped keys), lean context and agent teams.

### Can I bring flows I already built?

Yes, and you're welcome here. On **Chatflows**, the **Import** menu checks an exported chatflow or agentflow and opens it on the right canvas, node for node; about 300 nodes open with their settings. A chatflow's prediction API takes the same request body, so your app changes only the host and the flow id. API keys, passwords and credential ids are removed from the file, so you pick a credential on each card.

Key limits:

-   Old embed scripts. Copy the new snippet.
-   Whole-workspace exports. Import one flow at a time.
-   LlamaIndex nodes.

The Arize, LangFuse, LangSmith, LangWatch, Lunary, Opik, Phoenix and AssemblyAI configuration cards are dropped with a note, and the file still opens. The full list of limits is in [Bring your flows](docs/bring-your-flows.md). The import page, linked from the home page, also covers the security advisories we checked against the code that Cuttlely includes. If a flow doesn't open the way you expect, [open an issue](https://github.com/cuttlely/cuttlely/issues/new?template=bug_report.yml) with a made-up export.

## The analyst

### Does the analyst stop a model from reading data it shouldn't?

With tables or views ticked, the server refuses a query that:

-   reads anything else,
-   calls a function, operator or type outside `pg_catalog`,
-   calls a denied built-in,
-   or isn't a read.

Accepted statements run read-only with a timeout. A database with a risky domain check refuses every scoped query and names the domain. Rules can't widen any of that. It doesn't replace a least-privilege database login, so still use one. Tested on Postgres 14 to 18; the credential needs `TEMP`. With nothing ticked, the analyst works as before.

### Which databases does the analyst support?

Postgres databases you connect, plus Cuttlely's own isolated SQLite analyst store (`CUTTLELY_ANALYST=auto`). No MySQL yet, and no connecting an outside SQLite file.

### How many tokens does it save?

On a made-up bakery database, ticking 6 of 20 relations took the analyst's prompt from 2,562 to 663 tokens. You can rerun it with [`scripts/analyst-schema-tokens.mjs`](scripts/analyst-schema-tokens.mjs). More broadly, lean context means fewer tokens in our [internal benchmarks](docs/how-to/analyst.md#how-many-tokens-it-saves).

## Upgrading to 1.3.0

### After upgrading, my API key gets `403 This API key may not run harness "…"`. Why?

That message describes the legacy Harness-name list. With `INBOUND_ACCESS_V2=off` (the default), existing keys retain legacy authorization. Migration preserves existing bindings and resolves Harness names to stable canvas IDs; it does not force rotation or grant every Harness.

With enforcement `on`, open **Access Keys** and grant the Harness resource plus `harness:run` (and `harness:read` for polling), with the corresponding workspace permissions. A flow that calls a Harness needs both resources. New keys start with no scopes or resources. The `harnesses` name array is migration input, not the new management body. [Access keys](docs/reference/access-keys.md) covers rollout and API fields.

### I'm behind nginx, Caddy, Traefik or a load balancer. What do I need to do?

Set `TRUST_PROXY` before you upgrade. 1.3.0 rate-limits sign-in and a few other routes per client address. Without `TRUST_PROXY`, every request looks like it comes from the proxy, so all clients share one count and sign-in can be blocked for everyone.

Check `/api/v1/ip` to see the address Cuttlely sees. The Render Blueprint already sets `TRUST_PROXY=1`. The budget is **Page loads a minute** (`CUTTLELY_UI_PAGE_LIMIT_MAX`, 3000 by default).

### My script passed the API key in the URL and now gets 400.

1.3.0 no longer accepts keys in URL paths, because proxies and logs keep URLs. Send `Authorization: Bearer <key>` to `GET /api/v1/chatflows/apikey` or `GET /api/v1/verify/apikey`. Then consider rotating any key that was sent in a URL.

### A raw MCP server on a specialist stopped starting.

Raw entries in a specialist's `mcpServers` now pass the same checks as the Custom MCP node. Set `CUSTOM_MCP_ALLOWED_COMMANDS` and `CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS`, plus `CUSTOM_MCP_ALLOWED_ENV_VARS` for any `env`. Both lists are empty by default. `CUSTOM_MCP_SECURITY_CHECK=false` keeps the old behavior. The server log names each refused server.

### Anything else that changed for API callers?

`GET /api/v1/flow-config/:id` now needs `chatflows:view`, `chatflows:update`, `agentflows:view` or `agentflows:update`. `POST /api/v1/internal-prediction`, the in-app draft chat, answers `401` to every API key; apps use `POST /api/v1/prediction/:id`.

### How do invites work now?

A pending invite joins only through its own one-time link: single use, 72 hours by default, tied to that person and email. An email match alone never activates it.

Links issued before the upgrade keep working until they expire. With AuthKit on, they go through **Accept invite with WorkOS**, not a password. Someone added with **Add User** before 1.3.0 was stored as active and can still join by email match. To require the link, remove them and invite them again.

## Access keys and owner invitations

### Are SDK keys different from flow keys?

No. **Access Keys** is one list of inbound keys per workspace. You can create many keys, each with expiry, a per-key RPM limit, daily and monthly UTC quotas, exact-origin and IP/CIDR allowlists, and explicit Chatflow, Agentflow, Harness and Dashflows grants plus API operation scopes. New keys grant nothing. New secrets have `ctu_live_` or `ctu_test_` prefixes, are shown once, and can be rotated with a grace period of 0 to 24 hours (one hour by default). Revoke a whole key or one credential. The list shows usage counters; lifecycle and aggregate usage events appear in the audit log. Provider credentials and public share/embed links stay separate.

### Is enforcement enabled automatically when I upgrade?

No. `INBOUND_ACCESS_V2=off` is the default. On a restored backup, validate the migration with `node scripts/access-keys-migration-report.cjs` using the built server and normal database configuration. Then use `shadow` to compare legacy and scoped flow decisions before setting `on`. Shadow does not charge quotas or simulate all route and limit decisions. Existing bearer values keep working without rotation. [Rollout and migration](docs/reference/access-keys.md#rollout-and-migration).

### Which access-key features are still missing?

Redis/multi-instance limiting, browser delegation, usage exports/alerts, asynchronous telemetry batching, legacy-adapter removal, and termination of already-admitted runs are not implemented. Minute counters are per process and reset on restart; accepted streams and background runs may finish. Daily/monthly counters persist in SQL. Admission requires one API instance.

### Can I cancel a pending owner invitation?

In **Admin > Users** (`/users`), an active organization owner can use the trash action on another pending owner invitation. Confirmation names the email; cancellation revokes invite links across the organization's teams. An accepted invitation, self-removal, or removal of the last active owner is refused. Active owners remain **Super User, read-only** in this UI. [Users guide](docs/how-to/users-without-authkit.md).

## Running harnesses from your app

### What are the run limits on the API?

The Harness API has process-local caps of 60 starts and 600 reads a minute per caller. With access-key enforcement on, the key’s configured RPM and daily/monthly UTC quotas also apply, including polling. Rotation shares the same counters. A key only sees the runs it started. [Current limits](docs/reference/access-keys.md#caller-policies-and-counters).

### Can an API key change a schedule?

No. New scoped keys use only the Harness runs API and cannot read schedules either. Legacy keys retain schedule reads for a Harness on their list, with the owner's name only and the question redacted. Saving, pausing, resuming and deleting need a signed-in person. The schedule runs Live with the permissions of whoever last saved or resumed it, checked again at every due time.

Time zones are IANA place names such as `Europe/Paris`, or `UTC`. Offsets and abbreviations are refused.

### Who can run a harness that isn't on any key's list?

There are two known limits:

-   An explicitly public flow can run its referenced Harnesses in its team without a caller key. For private API access with enforcement on, set **API Endpoint** to **Private (selected access keys)** and grant both the flow and its referenced Harnesses. A resource grant alone does not make a flow private.
-   Execute Flow, Chatflow Tool and Agent as Tool send the API key stored in their credential. Treat that as delegated server access: keep privileged keys out of shared credentials. Public share/embed access remains a separate transport.

---

Questions, bugs or an import that didn't work? Open an issue on [GitHub](https://github.com/cuttlely/cuttlely/issues). And if Cuttlely is useful to you, a star helps.
