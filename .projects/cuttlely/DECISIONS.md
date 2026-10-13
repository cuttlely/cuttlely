# Decisions

Each entry is settled and states the current rule and why. To change one, add a new entry at the end that supersedes it and gives the reason. Do not edit an entry to mean something else.

## D1. Build on a proven canvas and workflow engine

Cuttlely keeps an existing Apache-2.0 visual canvas, node catalog, workflow engine and prediction API instead of writing new ones, and puts agent teams, pipelines, versioning and the admin panel on top. Upstream projects are credited in `CREDITS.md`, `NOTICE` and `LICENSE.md`. Some package, path and environment variable names still carry the engine's name; treat them as literal names, and keep saved flows, imports and existing configurations working when one changes.

## D2. Vendor the agent runtime

The agent runtime lives under `hermes/` at the commit in `hermes/UPSTREAM_COMMIT`. Cuttlely uses its agent loop, memory, skills, MCP client, tool registry, profiles and API server. Paths Cuttlely never loads are listed in `hermes/CUTTLELY_EXCLUDE.txt` and left out; local changes are patch files in `hermes/patches/`. `pnpm hermes:vendor` rebuilds the folder, and the `hermes-vendor` verify step fails on a hand edit, a patch that no longer applies, or an excluded path that comes back. Root ESLint and Prettier ignore `hermes/`, which keeps its own style. Why: a mature agent loop with isolation primitives is worth more than a new one, and a reproducible vendor step keeps upgrades reviewable. Steps are in `docs/reference/hermes-upgrades.md`.

## D3. A harness is a named, isolated team with its own runtime profile

A harness has a unique name, one chief (shown as Harness Prime) and one or more specialists. Each harness compiles to its own agent runtime profile and home, with its own session database, memory and credentials, so harness A cannot read harness B's tokens or transcripts. One runtime process serves many profiles. The session key is `{harness}:{chatId}`, so a chat continues only inside the harness it started in. Cuttlely stores the roster and compiles the profile at run time. Agent-loop specialists get the profile `<harness>--<specialist>`.

## D4. Chatflows call a harness by name

A chatflow does not redraw the team. It uses the `Harness` tool node on a Tool Agent, and the agent's system message decides which tasks call it. A chatflow whose only node is a Harness runs that team for every message. Many chatflows can share one harness. New Harness tool nodes start with Return Direct on, because a second model call to reword the harness reply roughly doubles the turn time.

## D5. Keep every canvas node; classify, don't rewrite

Every node in `packages/components/nodes` stays on the canvas, and saved flows keep their node names and inputs. `packages/components/nodes/module-catalog.json` marks each node `native`, `adapt` or `replaced`. A specialist uses a node through the bridge, which calls the node's own `init` and `invoke`, so vector stores, loaders and HTTP tools are never reimplemented. `adapt` rows are converted when a harness needs them. Specialists are classified by node category and invoke shape, never by node name.

## D6. Prediction payload and partial failure

`POST /api/v1/prediction/:id` is the route for chatflows, agentflows and harnesses. A harness turn returns `{text, harness, agents, sources, artifacts}` plus `report` (tokens, timings, truncated fields) and `trace`, and the same payload is stored on the chat message. If one specialist fails, Prime still answers from the others and `agents` marks the failure. A request fails only when the harness cannot run at all, such as a missing model or credential, and then it returns a clear error, never an invented answer.

## D7. A thin scheduler, not a chief agent loop

For a multi-specialist harness: one short JSON routing call on Prime's model, the selected specialists in parallel, then one short handoff call that combines their results. Prime runs no tools and there is no delegation loop. A harness whose only work is one tool runs that tool in process and fills the tool input from the question with one model call when needed. Why: a chief agent loop with a large tool schema and asynchronous delegation was slow and could return before the specialist ran.

## D8. The agent runtime runs only specialists that need an agent loop

Specialists with Shell, Browser, Code execution, Files or an MCP server run on their own runtime profile with a private workspace and only their toolsets enabled. Everything else (canvas tools, retrievers, vector stores) runs in the Cuttlely process. The runtime binds `127.0.0.1` only; the start script and `scripts/cuttlely-hermes-api.py` refuse any other host. `harness/client.mjs` is the only execution seam into it.

## D9. A harness runs on any attached chat-model node

Prime needs one connected chat-model node of any kind, and a specialist may connect its own; without one, a specialist uses Prime's. Cuttlely initializes that node with real flow options and uses the chat model it returns. There is no provider allowlist. Agent-loop specialists reach the model through a loopback gateway in the Cuttlely process (`CUTTLELY_HARNESS_GATEWAY_PORT`), with a separate bearer token per profile, so provider keys never reach a profile. A model without native tool calling picks tools from a JSON prompt. A node whose definition requires a credential must have one selected. Keys come only from the in-app credential store through the node's own `init`, never from the process environment or the runtime's env files. Why: a new user should never have to guess which model or key a harness uses, and a deleted credential must fail the run instead of falling back to a server key.

## D10. Unattended approvals for Code execution and Shell specialists

The API server has nobody to answer an approval prompt, so profiles for Code execution or Shell specialists set `approvals.unattended_mode: approve`. The smart-approval guardian and the deny list still apply, Browser-only and Files-only profiles keep the default deny, and the canvas toggle (off by default) is the opt-in.

## D11. The SSRF guard stays on

The HTTP security guard in `packages/components/src/httpSecurity.ts` blocks loopback, private addresses, cloud metadata hosts and the carrier-grade NAT range `100.64.0.0/10` by default, and re-checks redirects. Samples use public endpoints. A model on a loopback or private address fails with a message that explains the block. Trade-off: hosts reached over CGNAT addresses are blocked too; `HTTP_SECURITY_CHECK=false` drops the whole default list and is not recommended.

## D12. Load on first use; keep the runtime warm

The nodes pool serves node descriptors from `packages/components/dist/nodes-manifest.json` and loads a node class the first time it is used. Optional provider SDKs load when their feature runs. `CUTTLELY_EAGER_NODES=true` loads everything at boot. After the server listens, and after each harness save, every agent-loop specialist profile gets one short warm-up turn so the first chat does not pay the runtime's cold start (`CUTTLELY_WARM_HERMES=false` turns it off). Why: first-chat latency matters more than boot time for a long-running server.

## D13. Fast serving first: streaming, a turn budget and a fallback model

The priority is a serving API that returns harness results as soon as they exist. Harness turns stream typed SSE events (`harness.route`, `harness.specialist`, `harness.tool`, `harness.partial`, `harness.handoff`, `harness.final`) when `streaming` is `true` or `"true"`. A client disconnect stops the turn, in-flight runtime runs and gateway model calls. Each turn has a wall-clock budget (`CUTTLELY_HARNESS_TURN_BUDGET_MS`, default 45 s); a specialist still running at the deadline fails and the turn returns from the others. Prime and each specialist have an optional Fallback Chat Model. After `CUTTLELY_HARNESS_MODEL_FALLBACK_MS` (default 8 s) or on a 502, 503 or 504, the fallback starts while the primary keeps running, and the first success wins. With no fallback connected the call fails closed. A 400 is not a fallback trigger.

## D14. Context token budgets, a compacted handoff and a bounded session

Each specialist prompt is capped at `CUTTLELY_HARNESS_SPECIALIST_CONTEXT_TOKENS` (default 4000) and the handoff at `CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS` (default 6000), estimated as `ceil(chars / 4)`; `0` turns a cap off. Overflow is cut and marked `[truncated]`. Each specialist's answer in the handoff is cut at its handoff limit, 4,000 characters by default (`SPECIALIST_HANDOFF_CHARS`; a specialist can set 160 to 20,000). When the handoff is still over the chief budget, those limits shrink in steps, and 480 characters is one of those steps, not the default. Each source is a 200-character snippet, at most 8. A page of analyst rows keeps a wider handoff so the list is not dropped; that wider room is for the answer, not a token saving. The next turn sees a rolling summary of older turns, up to 8 pins and the last 2 raw turns. Full documents stay on the response `sources`, never in prompts. The user-facing account is [Context and tokens](../../docs/how-to/context-and-tokens.md).

## D15. Harness turns go through a SQLite queue

The Harness node enqueues each turn in `$CUTTLELY_DATA_DIR/harness-queue.sqlite`. The default `CUTTLELY_HARNESS_QUEUE=inline` runs it in the web process; `external` leaves it to `harness/worker.mjs` processes, which boot the same node pool; `off` calls the runner directly. One turn per `harnessName:chatId` is in flight; a second overlapping request fails with `busy` and different chats run in parallel. The lock row expires at the turn budget plus 5 seconds so a dead worker does not pin a chat. Trade-off: SQLite is one machine and one data directory, not a multi-host lock, so a deploy stays one instance.

## D16. ETL pipelines sit beside Document Stores

An ETL pipeline is its own canvas and run history. It reuses document loaders, text splitters, embeddings and vector store nodes through their own `init`, and leaves Document Stores and the vector upsert route as they are. Chunk ids hash the pipeline, source, document key, text, stable metadata and embeddings fingerprint. A run skips unchanged sources, embeds only new chunks, writes before it deletes, and deletes missing chunks only after every source finishes. Runs execute in the server process through `etl/runner.mjs`, the one seam a later queue would replace. Interval and cron schedules run in the same process and resume after a restart. Embeddings and vector store credentials come only from the node. Why: wrapping Document Stores would keep their storage and resume problems.

## D17. Every vector store, splitter and embeddings node in ETL

Every vector store node is an ETL target except Vectara Upload File, which sends whole files and has no chunk id. `etl/store-adapter.mjs` remembers the provider id for each chunk id, so append-only stores do not duplicate. Stores that cannot delete keep an id-keyed shadow copy. All text splitters and embeddings nodes are offered; Local Hash Embeddings and Local Vector Store need no key. A Pinecone target can name a namespace, and the ETL Retriever searches whichever store and namespace the pipeline's served version wrote. Pipelines are scoped to a workspace, and sources may read only the workspace's uploads, `samples/etl` and the folders in `CUTTLELY_ETL_ROOTS`.

## D18. Prediction uploads

`POST /api/v1/prediction/:id` accepts documents with the question (multipart `files` or a `data:` URI). A small document is extracted and prepended, cut at 400,000 characters and then to `CUTTLELY_UPLOAD_PREPEND_TOKENS` (default 8000). A file over 1 MB, or a spreadsheet over 1000 data rows, becomes a path stub that agent-loop specialists can open from a copy in their workspace. A document over 25 MB is refused. Files are stored as `<chatId>--<nonce>--<name>` in the chatflow directory. A client-sent value for a file input in `overrideConfig` never applies; only the file the server stored from the same request can fill an allowlisted file input. `docs/reference/override-config.md` lists what a request may override.

## D19. Identity: AuthKit, one local account, teams in our database

Ordinary sign-in is WorkOS AuthKit (hosted login, password reset and MFA, sealed session cookie). One local account, the Super User, is available when `CUTTLELY_LOCAL_ADMIN=true` and is created with `pnpm user` or the one-time setup link. Teams (stored as workspaces), roles, permissions, workspace scoping and API keys are Apache-2.0 code in `packages/server/src/identity/`. Routes use `requirePermission` and `requireAnyPermission`, which read the active team's role from the database on each request. Add User takes a name and an email; the first verified AuthKit sign-in links the row. On an empty database, the first verified AuthKit user (or `CUTTLELY_BOOTSTRAP_EMAIL`) becomes Super User. Ten failed local sign-ins lock that account or IP for 15 minutes. `scripts/proprietary-paths.mjs` keeps commercially licensed paths out of the tree. Trade-off: the sidebar shows the permissions stored at sign-in until the next sign-in, while the API follows a role change at once.

## D20. Trusted proxies and rate limit keys

`TRUST_PROXY` unset or blank trusts no proxies, so `X-Forwarded-For` is ignored. An install behind a proxy sets the real hop count; `render.yaml` sets `1`. Rate limit keys use the client address Express reports after that setting, with a port and an IPv4-mapped prefix stripped; a value that is not an IP counts against the socket peer. Why: trusting a forged header on a directly exposed server is worse than hiding the client IP on a proxied install that forgot the variable.

## D21. A prediction session belongs to the caller

The server issues the session id. A client `chatId` or `overrideConfig.sessionId` is kept only when this caller owns it; otherwise the request gets a new id and still runs. Ownership is an HMAC `sessionToken` over the caller (the flow's API key, or the public flow), the chatflow and the session id, sent back as a field, a header or an httpOnly `SameSite=Lax` cookie. The memory key, the agentflow run id, attachment uploads, `get-upload-file` and webhook resume all use the owned id. Trade-off: a flow that shared one hard-coded session across callers now keeps one session per caller, and a cross-origin embed must send `sessionToken` itself.

## D22. API keys are stored as a hash

Chatflow API keys are stored as a `sha256:` lookup plus an scrypt check, and the token is shown once at creation. `GET /api/v1/chatflows/apikey/:apikey` lists only the chatflows bound to that key (`id`, `name`, `deployed`, `category`, `type`), never the canvas. OAuth credential refresh needs a session or key with credential permission in the owning workspace, and provider errors never echo the provider body. Trade-off: a lost key cannot be shown again, and evaluations cannot replay a key-protected chatflow.

## D23. Analyst storage is isolated from the application database

The analyst never uses the application database. A selected Postgres URL credential wins, then `CUTTLELY_POSTGRES_URL`, then `CUTTLELY_ANALYST=auto`. A URL that points at the application database is refused. On Postgres, auto storage creates a schema and a login that cannot read application tables, with a statement timeout and a 100-row cap; its password is encrypted with the credential key, never put in the environment. If the app user cannot create roles, analyst mode stops and says so. On SQLite, auto storage uses a separate `analyst.db`, and an authorizer denies `ATTACH`, `VACUUM INTO`, `DETACH`, extension loading and file-writing pragmas. Hosted Postgres needs `sslmode` on the URL; Cuttlely does not rewrite it.

## D24. Analyst results page with a cursor

A SELECT that does not fit in the row cap returns that page, a page line and a short opaque cursor scoped to the chat for 15 minutes. "show more", "next page" and "page N" call the analyst with that cursor. Keyset paging is used only for a single-table SELECT with one row per base row; aggregates, DISTINCT, GROUP BY, HAVING and window functions page with LIMIT/OFFSET over the statement. A paging phrase with no live cursor is answered directly and does not call the analyst. The analyst hands Prime up to 12000 characters of rows (`ANALYST_ROW_HANDOFF_CHARS`), because a shorter handoff dropped rows from list answers without saving tokens.

## D25. Easy versioning, Git under the hood

Every canvas autosaves to a draft; Publish makes it Live, and Roll back and restore are one click. History is a local Git repository in the data folder (`CUTTLELY_VERSIONS_DIR`) that needs no setup. The file format is canonical JSON plus Markdown for long prompts, one folder per flow, and never holds password, file or folder inputs, server paths, secret-shaped values or credential ids; credentials are written by name and type and mapped back by name. Drafts are on by default (`CUTTLELY_DRAFTS=off` turns them off); `PUT /api/v1/chatflows/:id` keeps writing Live so scripts keep working. Before Publish, an optional check replays up to 10 recent real questions against Live and the draft, in memory, with token and time caps, and never blocks Publish. Steps that could act for real make the check ask first. The UI uses no Git words.

## D26. A copy in GitHub and Dev to Prod

The organization owner can connect one GitHub repository; each new version is pushed in the background and never slows or fails a save. The token is a GitHub credential in the app's credential store, reaches git only through the child process environment, and is never written to a remote URL or config. There is never a force push: when GitHub has commits the server lacks, pushing stops and says so. Pushed commits are re-scanned for secrets. Dev and Prod are separate servers connected to the same repository. Prod only reads it, and a person promotes each flow after seeing what changes, which credentials it needs, and the replay check. Promote maps credentials by name and blocks when one is missing. First-run setup goes straight into the app; the GitHub card lives in Admin > Version History.

## D27. Local `pnpm verify` is the merge gate

A pull request merges only when `pnpm verify` is green on Node 24 on that pull request's exact head. A change that touches only docs or markdown can use `pnpm verify --fast`; anything that changes server or package code, tests, `scripts/verify.mjs`, hooks, package manifests or `render.yaml` needs the full run. When in doubt, run the full one. A head that moves needs the check again. Pull requests are squash-merged. The pre-push hook runs the handoff check, `pnpm verify --fast` and the secret scan. A code change must also update `.projects/cuttlely/`; docs-only and tests-only pushes need not. `CUTTLELY_SKIP_VERIFY=1` and `CUTTLELY_SKIP_HANDOFF_CHECK=1` bypass the hook steps and never waive the gate. Why: a local gate on the exact head is reproducible on any contributor's machine.

## D28. Build and test settings for large trees

The components package coverage tests run Jest under a 4 GB heap because the default heap runs out on small machines. The unit verify step caps Jest workers at 50% (`CUTTLELY_VERIFY_JEST_WORKERS`) so timing-sensitive prediction tests are not starved. A root `pnpm.overrides` entry pins one `sqlite3` version for every package, and `scripts/check-sqlite-driver.mjs` checks the copy TypeORM loads.

## D29. The Render Blueprint is one container, one Postgres, one disk

`render.yaml` describes one Docker web service built from the root `Dockerfile`, a Postgres 16 database and one disk at `/var/cuttlely`, with `numInstances: 1` because the disk and the harness lock cannot be shared. The web plan is `pro plus` (8 GB, 4 CPU) with a 4096 MB runtime heap, because the agent runtime, a browser and Node share one instance; `pro` is the documented minimum. The health check is `GET /api/v1/ping`. The Blueprint declares no provider API keys, does not set the analyst variables, and never holds a secret value; `FLOWISE_SECRETKEY_OVERWRITE` is generated by Render. It is applied from the Render Dashboard, never from CI, and the `render-blueprint` verify step checks it. No live hostname goes in this repository.

## D30. Releases

Releases follow semantic versioning from 1.0.0 and a Keep a Changelog `CHANGELOG.md`; only the latest minor gets fixes. A breaking change means a major version. `pnpm release` runs from a clean, up-to-date `main` on a maintainer's machine. It runs the full verify, bumps, tags, builds the image and drafts the GitHub release. Pushing the image (`--push`) and publishing the release (`--publish`) are separate flags and never the default; `--dry-run` changes nothing. The release commit goes straight to `main`, so branch protection must let the releasing maintainer bypass it. Compose defaults to the published image (`CUTTLELY_IMAGE`) and builds the root `Dockerfile` when the pull fails, so the same command works before and after an image exists. Policy: `docs/releases.md`.

## D31. Upgrades are tested from a fixture of an older release

The full `pnpm verify` runs an `upgrade` step: it unpacks `scripts/fixtures/upgrade/baseline.tar.gz` (data from an older release, made-up demo data, placeholder credential values) and checks that flows, versions, credential names, harness specialists and an answer survive, and that a second start works. After each release the fixture is refreshed from that release's tag with `scripts/upgrade-fixture.mjs`. Migrations are forward-only; rolling back is a restored backup plus the previous image (`docs/upgrading.md`).

## D32. No call home

A default install makes no outbound request that nobody configured: no tracker, no upstream model list, no upstream release check, and the agent runtime's catalog refresh and models.dev lookup stay off unless `CUTTLELY_MODELS_DEV=1`. Fonts and icons are served by the server. Calls that an operator or a flow sets up (model providers, vector stores, MCP servers, the GitHub copy) work as configured. The chat-model list is kept by hand in `packages/components/models.json`; servers fetch it from this repository's `main` once a day with a timeout, a size cap and a shape check, and fall back to the bundled copy. `MODEL_LIST_CONFIG_JSON=bundled` turns the fetch off. `scripts/outbound-guard.test.mjs` fails if an unasked call appears, and `SECURITY.md` lists every outbound host.

## D33. Our own chat widget for share links and embeds

`packages/chat-widget` (`@cuttlely/chat`) is a framework-free, shadow-DOM widget written for this server's own protocol. The server serves the build at `/embed/chat.js`, pinned to the server version, so nothing loads from a CDN. Model output is always escaped, URLs go through an allowlist, and rendered markdown is scrubbed in the DOM. A cross-site embed can read chart files when the chatflow lists that site in its allowed domains; the session-ownership check still decides which chat's files a caller gets. Publishing the widget is D40.

## D34. The first ten minutes

A novice gets a working result within ten minutes of the server being up. Try the demo (`POST /api/v1/demo`) builds a made-up customer care team on the person's own model key and opens its chat: three specialists, each with its own data and Python tools, and an outcome that turns on what they find. The bakery knowledge pipeline and team stay as the quickstart (`{"demo": "bakery"}`). A saved model key is picked by default on Build with AI, model cards and harness templates (`packages/ui/src/utils/yourKey.js`); keys are referenced by id only. After Sign Up the owner goes straight into the app. While the server boots, a small page holds the port and names the current step, and `/api` answers `503 {"status":"starting"}` so health checks keep waiting for `pong` (`CUTTLELY_STARTING_PAGE=off` skips it). The runtime's warnings about a login Cuttlely never uses stay quiet (`CUTTLELY_HERMES_NOUS_WARNINGS=show` shows them).

## D35. Server settings in the admin panel

Admin > Server settings is owner-only. One registry (`packages/server/src/settings/registry.ts`) lists every setting with label, help, type, default and risk, and a kept-out list for variables that must never change from a browser: the encryption key and auth secrets, paths and ports, code-execution and safety switches, queue topology and test variables. The host environment wins, then the admin settings file in the data folder, then the default; a blank value is not set, and host-set values show as Locked. Every change applies at restart. Secrets are write-only and encrypted with the credential key. A setting that stops start-up rolls back to the last good file; `CUTTLELY_IGNORE_ADMIN_SETTINGS=1` and `pnpm settings` are the manual way back. An install with no sign-in method prints a one-time setup link that opens only the sign-in section. A test fails when an example file, Compose or `render.yaml` names a variable the registry does not know.

## D36. Older V1 agentflows run but are not offered

Agentflows V2 and harnesses cover what V1 agentflows did, so the UI offers no way to create, duplicate or save a template from a V1 flow. Existing V1 flows keep running through the API, embeds and shares, open from a direct link, and are listed behind a Legacy agentflows link that appears only when a workspace has one. Nothing is deleted.

## D37. Bringing flows from other tools

Import is a supported path, not a headline. The chatflow JSON import on the Import menu opens a wizard that scans one chatflow, strips credential ids and password, file and folder inputs, lists deprecated nodes, and opens a canvas or refuses with a reason; it never half-converts a graph. A Langflow export opens only when it is one chat model and at most one prompt; anything else is refused with a clear message. The user selects credentials saved in this app. Workspace bundle export and import are not offered. Details: `docs/bring-your-flows.md` and the import guides it links.

## D38. Product copy and naming

Tagline: "The open-source agent platform for applications." Headline: "Your applications deserve agents." The story leads with agent teams: a lead agent (Harness Prime) that splits the question, specialists that do the work, and an analyst that returns real numbers; "harness" is the product word, paired with "agent team" where a reader first meets it. Apps call teams through the API, and people chat with them on share links and embeds. Pipelines, chatflows, agentflows and Build with AI are the tools the teams use; drafts, compare, publish and roll back are the trust layer. User-facing copy compares Cuttlely with no other product and names no other product, except in credits, `LICENSE.md`, `NOTICE`, the import guides and literal names (packages, paths, variables, UI labels). User guides call the bundled runtime "the agent runtime". API examples in the docs are run against a real server and the output is pasted as returned. Brand: the C-wave icon is the default everywhere, the mascot appears only in large spots, and the theme primary is #6A3DF2 in light mode (hover #4C26CE) and #A78BFA for text and links in dark mode (#8B5CF6 as a hover fill only). The one-line repository description is in `.github/repo-description.txt`.

## D39. The project notes are public

`.projects/cuttlely/` ships in the repository so anyone can run the `take-over` skill and continue from the current state. The notes describe the code, decisions, open work and how to ship. They hold no secrets, personal names or accounts, private hosts, internal links, machine paths, customer data or business notes, and link issues instead of restating their status. A code change updates them in the same pull request (D27). `pnpm check:clean-export` allows the Markdown notes directly in `.projects/cuttlely/` in a source export and refuses every other path under `.projects/`, including subfolders of the notes.

## D40. npm publishes the launcher and the chat widget

The server is not an npm package: a full install needs the Python agent runtime, which the Docker image carries. The published `cuttlely` package is `packages/cli`. `npx cuttlely` and a global install pull `ghcr.io/cuttlely/cuttlely`, tagged with that package's version unless `--tag` is set, and run it. `@cuttlely/chat` (`packages/chat-widget`) is the embeddable chat widget. The server still serves that build at `/embed/chat.js` (D33). The root package is named `cuttlely-workspace` and stays private, because pnpm allows one workspace project per package name and the published name is `cuttlely`. `NPM_TOKEN` is an environment variable on that machine and is never stored in the repository. Publishing from the tag is D42. This supersedes the last sentence of D33.

## D41. LICENSE.md is the unmodified Apache 2.0 text

`LICENSE.md` holds the Apache License 2.0 text exactly as published at https://www.apache.org/licenses/LICENSE-2.0.txt, appendix included, with nothing added above or below it. Copyright lines and upstream attribution live in `NOTICE` and `CREDITS.md`, not in `LICENSE.md`. `.prettierignore` lists `LICENSE.md` so the formatter cannot reflow it. Why: GitHub and other license detectors recognize only the unmodified text, and an edited file shows as an unidentified license. This supersedes the mention of `LICENSE.md` as a place for credits in D1.

## D42. npm publishes only from the release tag

`pnpm release X.Y.Z --npm` is the publish path for `cuttlely` and `@cuttlely/chat`. It runs after `pnpm release` has tagged the version, the image `ghcr.io/cuttlely/cuttlely:X.Y.Z` is in the registry, and the GitHub release is published. It refuses unless `HEAD` is that annotated tag, the tree is clean, the version files match `X.Y.Z`, an anonymous manifest check sees the image, the GitHub release is not a draft, and `NPM_TOKEN` is set. The token is never printed. This supersedes the publish sentence of D40.

## D43. The components package name is @cuttlely/components

`packages/components` is the package `@cuttlely/components`. Package names follow `ARCHITECTURE.md`. Path names, environment variable names, and data names stay stable. Saved custom functions and custom tools may still require the earlier specifier when an operator has allowed it through `TOOL_FUNCTION_EXTERNAL_DEP`. A compatibility alias on the workspace root keeps that require working. This narrows D1 for this package. Other packages may still use the engine's package name.

## D44. The server, UI and API docs packages have their own names

`packages/server` is `@cuttlely/server`. `packages/ui` is `@cuttlely/ui`. `packages/api-documentation` is `@cuttlely/api-docs`. These packages stay private. Commands, repository paths, and the server CLI keep working. The server CLI keeps its existing bin entry and adds `cuttlely-server` on the same script. The CLI config, data, and cache directories stay on the existing directory name, so a theme file or a CLI plugin already on disk is still read. Application code does not read those directories. The server finds the UI build through the UI package name. This supersedes the last sentence of D43.

## D45. The shared server error class is AppError

The shared server error class is `AppError` in `packages/server/src/errors/appError`. Server code imports that class. The earlier module path and class name stay as a compatibility alias for one release. The alias is the same constructor, so `instanceof` checks work with either name. The class does not set `name`, so HTTP status codes, JSON bodies, headers and the error name on a response or a log line stay as they are. This narrows D1 for this class.

## D46. The harness and pipeline engines are workspace packages

The harness runtime is `@cuttlely/harness` in `packages/harness`. The pipeline runtime is `@cuttlely/etl` in `packages/etl`, and it depends on `@cuttlely/harness`. Both packages are private. `harness/*.mjs` and `etl/*.mjs`, including `harness/runtime/` and `etl/check/`, re-export those modules for one release. `scripts/analyst-*.mjs` and `scripts/hermes-stream.mjs` re-export `packages/harness/runtime/` until the release after 1.0.2. The server and the canvas nodes load the packages by path with a real dynamic import. `packages/harness/client.mjs` is the execution seam into the agent runtime. `packages/harness/worker.mjs` is the external queue worker. This supersedes the paths named in D8 and D15.

## D47. The server serves the built UI as static files

The running server serves the UI from files. It does not load the UI package's libraries. The server build copies `packages/ui/build` to `packages/server/dist/ui`. At startup the server serves the newest `index.html` among that copy, `packages/ui/build`, and the `build` directory of a linked `@cuttlely/ui` when a full install has linked it. `@cuttlely/ui` is a devDependency of `@cuttlely/server`. The libraries the UI build uses are devDependencies of `@cuttlely/ui`. A production install of this workspace installs every workspace package's production dependencies, so those libraries stay out of the production install only when they are devDependencies. The running server does not load them. The chat widget stays a production dependency of the server and is still served at `/embed/chat.js`. `/`, `/index.html`, and other client routes are limited to 3000 requests a minute per client IP. The static handler does not serve a directory index and does not redirect directories, and those two paths fall through to that limit. Hashed files from the UI build, and `/embed/chat.js`, are not counted. A response under that limit has the same headers as before. The API docs package is unchanged. `pnpm dev` still serves the UI from the UI dev server. `pnpm start` from source serves the built files. This supersedes the last sentence of D44.

## D48. Vendor the measured agent-runtime subset

`hermes/CUTTLELY_LOADED.txt` is the list of agent runtime files a harness run loads. `pnpm hermes:vendor` still applies `hermes/CUTTLELY_EXCLUDE.txt` first, then keeps only the listed files plus package `__init__` files, license and attribution files, data files a kept module names, files a local patch edits, and the build and lock metadata in D49. `node scripts/measure-runtime-loads.mjs` rewrites the list; `--check` fails when a measured module is missing. Re-measure after an upstream bump and vendor that same pin. Why: messaging platforms, the plugin catalog, optional MCP descriptors and unused locale catalogs are not part of a harness run, and a measured list keeps that cut reviewable. This adds to D2; the pin, the patches and the exclude list stay.

## D49. The vendor step keeps the runtime install metadata

`pnpm hermes:vendor` always keeps `.python-version`, `pyproject.toml`, `uv.lock` and `pm/lock.json` when upstream has them, including when `CUTTLELY_LOADED.txt` does not name them. `scripts/setup-hermes.sh` reads `.python-version` and, on Python 3.14, installs from `uv.lock`. A later patch may continue a file an earlier patch already edits. Further edits go to the last patch; the earlier patch stays as it was. The security pins stay in patch 0006. The unused core dependencies (tenacity, jinja2, watchfiles, resvg-py) stay in the following patch. This adds to D48.

## D50. Vector store nodes ship in an optional pack

Vector store nodes, the credentials only they use, and the dependencies only they import live in `@cuttlely/node-pack-vector-stores` (`packages/node-pack-vector-stores`). Shipped packs always load. `CUTTLELY_NODE_PACKS` adds packs after that list, and a repeated name is loaded once. A blank value adds nothing and removes nothing. `INCLUDE_NODE_PACKS=0` writes `/etc/cuttlely/no-node-packs` and skips the shipped packs. Extra packs named in `CUTTLELY_NODE_PACKS` still load in that image. Node names and inputs stay the same. The default image and a from-source install include the vector store pack. The published image keeps the default. This narrows D5 for these nodes: they stay on the canvas in the default install, and they are loaded through the pack loader. The layout the next pack copies is in [Optional node packs](../../docs/how-to/node-packs.md).

## D51. Tool and MCP server nodes ship in an optional pack

Tool nodes that call an outside service, the prebuilt MCP server nodes for those services, the credentials only those nodes use, and the dependencies only those nodes import live in `@cuttlely/node-pack-tools-mcp` (`packages/node-pack-tools-mcp`). Custom Tool, Custom MCP, chatflow and agentflow tools, Retriever Tool, Calculator, Request tools, the ETL Retriever, and the PostgreSQL MCP node the analyst uses stay in `packages/components`. AWS DynamoDB KV Storage stays there with the memory and cache nodes. A credential or dependency another node still imports stays on `@cuttlely/components`. The E2B client stays there because code execution in `packages/components/src/utils.ts` loads it. Brave Search, GitHub, Google Drive, Google Sheets, Jira, SearchApi and Serp API credentials stay because a document loader still uses them. Shipped packs always load, including this pack and the vector store pack. `INCLUDE_NODE_PACKS=0` skips every shipped pack. Node names and inputs stay the same. The default image and a from-source install include this pack. The published image keeps the default. This narrows D5 for these nodes: they stay on the canvas in the default install, and they are loaded through the pack loader.

## D52. Cache and memory backend nodes ship in an optional pack

Cache nodes and memory backends that use an outside service, the credentials only they use, and the dependencies only they import live in `@cuttlely/node-pack-caches-memory` (`packages/node-pack-caches-memory`). Memory that does not need an outside service stays in `packages/components`: Buffer Memory, Buffer Window Memory, Conversation Summary Memory, Conversation Summary Buffer Memory, and the agent memory nodes. AWS DynamoDB KV Storage stays in `packages/components`. A credential a vector store node still uses stays in `packages/components`. Shipped packs always load, in the order in `SHIPPED_NODE_PACKS`. `INCLUDE_NODE_PACKS=0` skips every shipped pack. Node names and inputs stay the same. The default image and a from-source install include this pack. The published image keeps the default. This narrows D5 for these nodes, the same way D50 does for vector stores, and it narrows the sentence in D51 that groups memory and cache nodes with AWS DynamoDB KV Storage.

## D53. Legacy completion model and chain nodes ship in an optional pack

Completion model nodes (the LLMs category), the chain nodes that carry the DEPRECATING badge, the credential only those nodes use, and the dependencies only they import live in `@cuttlely/node-pack-legacy-chains` (`packages/node-pack-legacy-chains`). Chat model nodes stay in `@cuttlely/components`. A chain a bundled template or the flagship demo uses stays there too, which today is the same set as the chains without that badge. A credential a node that stays still uses stays in `packages/components/credentials`. `@langchain/cohere` and `@langchain/baidu-qianfan` stay on `@cuttlely/components` because chat model and embeddings nodes import them. The `replicate` package is on this pack because only the Replicate completion node imports it. Shipped packs always load, in the order in `SHIPPED_NODE_PACKS`: the vector store pack, the tools and MCP pack, the caches and memory pack, and this pack. `INCLUDE_NODE_PACKS=0` skips every shipped pack. Node names and inputs stay the same. The default image and a from-source install include this pack. The published image keeps the default. This narrows D5 for these nodes: they stay on the canvas in the default install, and they are loaded through the pack loader. The layout is the one in D50.

## D54. A node pack index names the pack when a saved node does not

`packages/server/src/utils/node-pack-index.json` maps each node `name` and label under `packages/node-pack-*/nodes` to that pack's package name. `scripts/build-node-pack-index.mjs` writes it. The server build and the image build, before `scripts/omit-node-packs.mjs`, run that script with `--check` and copy the committed file into `dist`. They do not rewrite it. A stale file fails those builds. The server reads the file in every image, including one built with `INCLUDE_NODE_PACKS=0`. When a saved node is not loaded and has no `nodePack`, the prediction error and the placeholder card use this index. A save or an import writes `nodePack` from the index when the field is absent. The default image still loads the same nodes, credentials and templates. A check fails when the committed file does not match the pack folders. Why: flows and bundled templates saved before a node lived in a pack have no `nodePack`, and the slim image cannot ask the missing package which pack it was.

## D55. Server logs are visible in the app to an admin

`GET /api/v1/logs` reads the server log files in `LOG_PATH` (the directory the server logger writes). The organization owner can open them, and so can a role that holds `logs:view`. An API key cannot. The reader stays inside that directory: a date that is not `YYYY-MM-DD-HH` is refused, a symlink is not followed, and a path that resolves outside the directory is not read. Presets send a range token (`1h`, `4h`, `24h`, `2d`, `7d`, `14d`, `1m`, `2m`, `3m`) that the server expands on its own clock. Custom sends the browser's `YYYY-MM-DD-HH` stamps, which the server reads as its own local hours. The response is one contiguous recent section, capped at one megabyte and 2,000 lines. A newer file that was read in full can be followed by the next older file. Once a file is tailed, older files are not added. Redaction runs on the joined text, so a secret that spans lines becomes `[secret hidden]`. A capped tail keeps lines only from the first log record (`YYYY-MM-DD HH:mm:ss [LEVEL]:`, and an error record is a record start). Lines before that record are replaced with `[earlier output cut]`. A window with no record start, including one long line with no newline, returns only that marker. Login activity stays closed. Why: operators were limited to the container log and the files on disk, and a log line can contain a key if something logged one.

## D56. Analyst row cap and query timeout are server settings

The analyst still returns at most 100 rows and stops a statement after 15 seconds when the settings are unset. **Admin** > **Server settings** > **Analyst** sets `CUTTLELY_ANALYST_ROW_CAP` (1 to 1000) and `CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS` (1 to 120 seconds). The running server clamps both, including a value the host set above the maximum. A query timeout below 1 second is raised to 1 second. Zero, a negative number, or a non-numeric value uses the default, and the server logs that once. A PostgreSQL MCP node may set a lower cap or a shorter timeout under Additional Parameters. It cannot raise either above the server value. A lower row cap puts fewer rows into the specialist prompt and the handoff. A legacy `analyst.db` is claimed by linking a file that already holds the workspace tag, so concurrent first calls cannot both read it. This narrows the fixed 100-row cap and the fixed statement timeout in D23 and D24. Why: some tables need a different page size or a longer query, and an unbounded page would paste a whole table into the prompt. A keyset or offset page count is stated only when a length pass shows that the handoff walk is one full cap per page. That pass uses a lower bound on the JavaScript line, not the SQL character length. Text uses its UTF-8 byte length, which is at least the UTF-16 length the handoff counts, so a character outside the basic multilingual plane cannot make the bound too small. date, timestamp, and timestamptz use a floor of 128 characters, which covers Date.toString() in the server timezone. json and jsonb use the greater of the text length and 15 for a scalar or a plain object, which covers an object printed as [object Object]. A JSON array has no bound: an array of objects stringifies with a comma between elements, and that line can be longer than the JSON text. A column type outside that set, including a JSON array, leaves the walk unknown: the line names the rows and says show more, and only the next page or page 1 is accepted.
