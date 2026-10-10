# Changelog

This file records every notable change to Cuttlely. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Cuttlely uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). [Releases and support](./docs/releases.md) explains what counts as a breaking change and which versions get fixes.

## [1.0.0] - Unreleased

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
-   **Port overrides.** `port`, `*_port` and `*Port` settings are never taken from a request, even when allowlisted. Leave port entries out of your override configuration. See [Override configuration](./docs/reference/override-config.md).
-   **Streaming rule.** The canvas test chat route (`/api/v1/internal-prediction`) streams only for `streaming: true` or `streaming: "true"`, the same rule as `/api/v1/prediction`. Values like `1`, `"1"` or `"TRUE"` now get a JSON answer.
-   **Stream error events.** A streamed `error` event keeps the message in `data` and adds `status` and `code`.
-   **Image path.** The image's working directory is `/usr/src/cuttlely` (was `/usr/src/flowise`). Update any volume, script or shell command that used the old path. The data volume (`/var/cuttlely`) is not affected.
-   **Prediction uploads.** `POST /api/v1/prediction/:id` takes only the uploads the flow accepts. Documents sent in `files` or as uploads need file uploads on (**Configuration**, **File Upload**, **Enable Full File Upload**), images need a card with image uploads on, and audio needs Speech to Text. Others get 403 when that kind is off, or 400 for a type the flow does not take, and nothing is stored. A file for a document loader input allowed in Override Config is still taken. See [Send a file with the question](./docs/api.md#send-a-file-with-the-question).
-   **Knowledge list overrides.** `agentKnowledgeDocumentStores` and `agentKnowledgeVSEmbeddings` are never taken from a request, even when allowlisted. Remove them from your override configuration; the knowledge saved on the Agent card is used. See [Override configuration](./docs/reference/override-config.md).
-   **Card picker overrides.** `agentModel`, `llmModel`, `conditionAgentModel`, `humanInputModel`, `embeddingModel` and `vectorStore` are never taken from a request, even when allowlisted. Allowlist settings on the card instead (for example `modelName` in `agentModelConfig`). See [Override configuration](./docs/reference/override-config.md).
-   **Port overrides.** `port`, `*_port` and `*Port` settings are never taken from a request, even when allowlisted. Remove port entries from your override configuration. See [Override configuration](./docs/reference/override-config.md).
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

[1.0.0]: https://github.com/cuttlely/cuttlely/commits/main
