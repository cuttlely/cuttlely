# Cuttlely FAQ (1.4.3)

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

-   **Governance.** Every edit waits in a draft while Live keeps serving. Before you publish, replay recent real questions on Live and the draft, side by side. Gate Publish on a test set and roll Live back in one step. Roles, an audit log, and API keys that only run the teams you tick.
-   **Lean context.** Each specialist gets a self-contained task, not the whole chat, and the analyst sees only the tables you tick. Fewer tokens in our internal benchmarks, and every run shows what it used.
-   **Build agent teams.** Describe a team and Build with AI puts a first version on the canvas, with every part and connection checked. Call it from your app with a scoped API key, or put it on a schedule.

Try it: `git clone https://github.com/cuttlely/cuttlely && cd cuttlely && docker compose up -d`, then open http://localhost:43117 and select **Try the demo**.

### How do I install it?

`git clone https://github.com/cuttlely/cuttlely && cd cuttlely && docker compose up -d` runs one container on SQLite. `npx cuttlely start` (Node 20+ and Docker) pulls the same image. There's also a Render Blueprint. Then open http://localhost:43117.

### Is it really open source?

Cuttlely is open source under Apache-2.0. The bundled agent runtime is Hermes (MIT). Other packages keep the licenses their owners gave them. See [CREDITS.md](CREDITS.md).

### Does it send telemetry?

Nothing by default, and no key ships in the repo. If you set your own `POSTHOG_PUBLIC_API_KEY`, usage events go to your PostHog project, and `DISABLE_CUTTLELY_TELEMETRY=true` turns that off.

### What's new in 1.4.3?

-   **Allowed functions** on the PostgreSQL MCP node lists your own SQL helpers, one `schema.fn(argtypes)` or `schema.fn(*)` per line. While a table selection is set, text search types `regconfig` and `regdictionary` are refused unless they are passed directly to the built-in text-search functions, such as `to_tsvector`. Other object-identifier types, such as `regclass`, are refused only while a table selection is set.
-   At startup, harness profiles compiled by an older version are compiled again. The harness gateway health check and `GET /api/v1/ping` return 503 during that wait. `CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS` defaults to 180 seconds and is capped at 300.
-   Chat answers keep a slash between words, including a fraction or a date, and still hide server paths.
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
-   Published chatflows answer IBM watsonx Orchestrate native agents. The flow needs a bound API key.
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

Each API key now has **Harnesses this key may run**, and the list starts empty on every key, including keys made before 1.3.0. To fix it, open **API Keys**, edit the key, tick the harnesses it should run, and save.

This also applies to a chatflow or agentflow bound to that key whose Harness card or Agent harness tool names a harness. At startup the server logs each bound key that's missing a harness. Over the API, send `harnesses` (an array of names) on `POST /api/v1/apikey` or `PUT /api/v1/apikey/<id>`.

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

## Running harnesses from your app

### What are the run limits on the API?

Each API key or signed-in person gets 60 run starts a minute (sync and async together) and 600 reads, counted in each server process. A key only sees the runs it started.

### Can an API key change a schedule?

No. A key can read the schedule for a harness on its list, with the owner's name only and the question redacted. Saving, pausing, resuming and deleting need a signed-in person. The schedule runs Live with the permissions of whoever last saved or resumed it, checked again at every due time.

Time zones are IANA place names such as `Europe/Paris`, or `UTC`. Offsets and abbreviations are refused.

### Who can run a harness that isn't on any key's list?

There are two known limits:

-   A chatflow or agentflow with no API key runs every harness its Harness cards and Agent harness tools name, in its team, for anyone who has its id. Bind a key to any flow that names a harness you don't want public.
-   Execute Flow, Chatflow Tool and Agent as Tool send the API key stored in their credential, so the flow they call runs under that key's list, whoever uses the credential. Keep keys that list harnesses out of shared credentials.

---

Questions, bugs or an import that didn't work? Open an issue on [GitHub](https://github.com/cuttlely/cuttlely/issues). And if Cuttlely is useful to you, a star helps.
