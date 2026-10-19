# Cuttlely FAQ (1.3.0)

**The visual agent builder, ready for production.** Drag-and-drop agents with real governance and lean context. Open source, Apache-2.0.

Try it in a few minutes:

```
git clone https://github.com/cuttlely/cuttlely && cd cuttlely && docker compose up -d
```

Or, with Node 20+ and Docker: `npx cuttlely start`. Open http://localhost:43117, add one model key, and pick **Try the demo** (all the data is made up). If it's useful, a star on [GitHub](https://github.com/cuttlely/cuttlely) helps other builders find it.

## The basics

### What is Cuttlely?

A visual agent builder you run yourself, built around three things:

-   **Governance.** Safe drafts and replay. Edits to flows and agent teams go to a draft. Compare it with Live, gate Publish on a test set, and roll Live back at once. Roles, an audit log, and API keys that only run the harnesses you tick.
-   **Lean context.** Lower token cost. A team splits each question so every specialist gets a self-contained task, not the whole chat. The analyst sees only the tables you tick. Every run shows its tokens.
-   **Build agent teams.** Harness Prime routes each question to specialists, each with its own instructions and tools. Every specialist gets a task that stands on its own.

### How do I install it?

`git clone https://github.com/cuttlely/cuttlely && cd cuttlely && docker compose up -d` runs one container on SQLite. `npx cuttlely start` (Node 20+ and Docker) pulls the same image. There's also a Render Blueprint. Then open http://localhost:43117.

### Is it really open source?

Cuttlely is open source under Apache-2.0. The bundled agent runtime is Hermes (MIT). Other packages keep the licenses their owners gave them. See [CREDITS.md](CREDITS.md).

### Does it send telemetry?

Nothing by default, and no key ships in the repo. If you set your own `POSTHOG_PUBLIC_API_KEY`, usage events go to your PostHog project, and `DISABLE_CUTTLELY_TELEMETRY=true` turns that off.

### What's new in 1.3.0?

-   Run a harness (an agent team) from your app with an API key, synchronously or async with a run id.
-   Cron schedules with time zones.
-   New audit log types for harness runs, key access and schedules.
-   The analyst's **Tables and views** picker, a `describe` tool and a **Rules** box.
-   Several analysts in one team.
-   A security pass.

Full notes: [v1.3.0 release](https://github.com/cuttlely/cuttlely/releases/tag/v1.3.0).

## Coming from Flowise

### Where does the code come from?

Cuttlely includes Apache-2.0 licensed code from FlowiseAI/Flowise, credited in [CREDITS.md](CREDITS.md), and isn't affiliated with FlowiseAI. Flowise names and trademarks remain with their owners.

### Can I bring my Flowise flows?

Yes. Go to **Chatflows** → **Import** → **Import Flowise JSON**. It opens a chatflow or agentflow node for node; about 300 nodes open with their settings. A chatflow's prediction API takes the same request body. API keys, passwords and credential ids are removed from the file, so you pick a credential on each card.

Key limits:

-   Old embed scripts. Copy the new snippet.
-   Whole-workspace exports. Import one flow at a time.
-   LlamaIndex nodes.

The Arize, LangFuse, LangSmith, LangWatch, Lunary, Opik, Phoenix and AssemblyAI configuration cards are dropped with a note, and the file still opens. The full list of limits is in [Bring your flows](docs/bring-your-flows.md).

### What about the Flowise security advisories?

We read the code at v1.3.0 against the six advisories on Flowise 3.1.4 that list no patched release:

-   Five don't apply. The chat-message ([GHSA-ppmg-4cx6-95hh](https://github.com/FlowiseAI/Flowise/security/advisories/GHSA-ppmg-4cx6-95hh)), upsert-history ([GHSA-jvx3-mjpw-r4gh](https://github.com/FlowiseAI/Flowise/security/advisories/GHSA-jvx3-mjpw-r4gh)) and credential ([GHSA-27w2-26m5-x82c](https://github.com/FlowiseAI/Flowise/security/advisories/GHSA-27w2-26m5-x82c)) routes check permissions and team. The BullMQ dashboard isn't mounted ([GHSA-rpcc-gw54-mfgx](https://github.com/FlowiseAI/Flowise/security/advisories/GHSA-rpcc-gw54-mfgx)). There's no multi-provider SSO ([GHSA-cffm-583c-vffr](https://github.com/FlowiseAI/Flowise/security/advisories/GHSA-cffm-583c-vffr)).
-   The sixth, invites activated by an email match ([GHSA-vf3j-89vf-r697](https://github.com/FlowiseAI/Flowise/security/advisories/GHSA-vf3j-89vf-r697)), is fixed in 1.3.0. A pending invite needs its one-time link. One caveat: someone added with **Add User** before 1.3.0 was stored as active and can still join by email match, so remove and re-invite them to require the link.

We also checked an older file-write advisory, [GHSA-8vvx-qvq9-5948](https://github.com/FlowiseAI/Flowise/security/advisories/GHSA-8vvx-qvq9-5948), for Flowise 2.2.7 and earlier. The storage helpers it names sanitize the file name in every storage provider.

This is a code read, not a pen test. If you find something, please report it privately through [SECURITY.md](SECURITY.md).

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
