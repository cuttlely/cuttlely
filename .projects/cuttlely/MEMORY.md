# Memory

Conventions, do and don't, and lessons a newcomer would otherwise relearn. Add a lesson only when one was actually learned.

## Conventions

-   Harness runtime code is plain Node ESM in `harness/*.mjs`; ETL runtime code is plain Node ESM in `etl/*.mjs`, loaded from the CommonJS server with a real dynamic import. Canvas nodes are TypeScript under `packages/components/nodes/`. Bump a node's `version` when its inputs change.
-   The canvas label is Harness Prime; the saved node name stays `harnessChief`, type `HarnessChief`. Template card titles are Title Case, but harness record names and a chatflow's `harnessName` stay the runtime id (`upload`, `field-team`, `calculator`).
-   Runtime profile names: harness `<harness>`, agent-loop specialist `<harness>--<specialist>`. Session key `{harness}:{chatId}`. A specialist's runtime toolset for an MCP server is the server name (`analyst`), not `mcp-<name>`.
-   Every harness behaviour change gets a case in `harness/check.mjs` with mocked runtime and model calls, runnable without a build, a key or the network. The same goes for ETL and `etl/check.mjs`.
-   A harness card opens `/harnesses/:name` (runs and a prompt box); the canvas is `/harnesscanvas/:id`. The harness canvas chat posts to `POST /api/v1/harnesses/:slug/runs`, not through `internal-prediction`.
-   Run history stores the same `trace` object the chat renders (`harness/trace.mjs`), and every view uses `HarnessRunTrace`. A specialist model label is the node label and model name, never a credential id.
-   Workspace queries use `getWorkspaceSearchOptions` from `packages/server/src/identity/workspaceScope.ts`; a missing workspace id is a 400, never "list everything".
-   A shipped migration is never edited. New tables go in a later migration whose down drops them. MySQL and MariaDB need unique foreign-key names (`fk_<table>_<column>`) and matching column types and collations.
-   Code comments explain the reason in words. They do not cite issue or pull request numbers.
-   User-facing text has no git words (Draft, Publish, Roll back, Keep a copy in GitHub). The promote and GitHub card messages are tested for this.
-   The publish check's `count` selects the newest distinct past questions (case and spacing ignored, newest copy kept). It is not a random sample. Omitting `count` still runs the caller's question list, capped at 10.
-   User guides say "the agent runtime". Upstream names appear only in credits, license files, the import guides and literal names (D38).
-   Guides use real screenshots taken from a running server, with made-up data.
-   Formatting follows the root Prettier config (4 spaces, single quotes, no semicolons, print width 140). Do not reformat `hermes/`.
-   The website home closing section uses the laptop mascot (`website/src/assets/cuttlely-mascot-laptop-512.webp`). The 404 page keeps the neutral pose.
-   The published npm package named `cuttlely` is `packages/cli`. The root `package.json` name is `cuttlely-workspace` and stays private. pnpm rejects two workspace projects with the same name.
-   npm publishes only from the release tag.

## Do

-   Run `pnpm install && node harness/check.mjs` before and after harness changes.
-   Keep the agent runtime on `127.0.0.1`.
-   Keep model keys in in-app credentials selected on chat-model nodes (D9). When debugging, read key names, never values.
-   Build a fresh node instance per run and pass the run's real flow options to `init`. Never special-case a chat model by provider.
-   Keep partial-failure semantics: a failed specialist is reported in `agents` and Prime still answers.
-   Return a clear error when a harness has no usable model. Never invent an answer.
-   Leave a person's existing flows untouched; make a copy to demonstrate.
-   Change files under `hermes/` only through `pnpm hermes:vendor`, saving an edit as a patch (`--save-patches`). Read `hermes/` to confirm how the runtime behaves.
-   Update `.projects/cuttlely/` in the same pull request when state changes.

## Don't

-   Don't route every chat message through a harness. The Tool Agent's system message decides.
-   Don't add a chief agent loop or delegation to the scheduler path (D7).
-   Don't put a model dropdown on Prime or specialist nodes; the connected chat-model node is the control.
-   Don't turn the SSRF guard off to make a sample work (D11).
-   Don't read provider keys from the environment for harnesses, ETL embeddings or vector stores.
-   Don't store a chatflow API key in plain text or return the key columns from a list (D22).
-   Don't return a canvas from the public chatbot config of a key-protected chatflow; it keeps only the Start form fields the embed renders.
-   Don't let the analyst touch the application database (D23).
-   Don't write a live hostname, a database URL or a secret into this repository.

## Lessons

-   **A green `pnpm verify` is not a real-model run.** Model-dependent behaviour (routing, analyst answers, row grounding) has passed every check and still failed with a real model. Run the guide prompts against a real model before calling such a change done.
-   **LangChain chat models read provider keys from the environment.** A node with a deleted credential still answered from a server env key. The harness checks that a required credential exists before calling `init`.
-   **OpenAI-compatible servers treat a missing `tool_choice` as `auto`.** The runtime omits it on its final turn; defaulting to `required` made the model loop on tool calls. The gateway maps a missing value to `auto`.
-   **The runtime sends `OPENAI_API_KEY` only to the base URL it was paired with.** The gateway token works because the profile sets `OPENAI_API_KEY` and `OPENAI_BASE_URL` together and the config uses provider `custom` with the same `base_url`.
-   **MCP stdio is newline-delimited JSON, and request ids start at 0.** Tool arguments stay an object. When the schema has one string field and the model used another name (`query` for `sql`), retry under the schema name, and only for a schema-shape error; a database refusal is the message the chat shows.
-   **An API-server specialist must wait for MCP discovery** before its agent is built, or the first turn starts with no tools.
-   **Never delete before writing to a remote vector store.** A failed write after a delete loses vectors that ETL still lists as synced. Write first, delete only ids the write did not replace, and trust the store's own count.
-   **Do not init the shared node registry object from ETL.** A registry entry with `filePath` is a class to construct per run; a stub without one is an offline double.
-   **`scripts/start-cuttlely.sh` must not read the node picker with `$(...)`.** Command substitution drops an empty trailing line, so the node path is passed as the flag. Read the two lines from a file.
-   **A sample with raw canvas JSON** lacks `inputParams`, `inputAnchors` and `outputAnchors`. The canvas fills them on load (`normalizeCanvasFlow.js`) and the Templates API fills them before preview.
-   **Two cards dropped on the same point** can look like "needs exactly one chief". Fix drop placement; do not loosen the chief check.
-   **MUI dropdowns:** `<OutlinedInput select>` rendered a blank box; use `<Select input={<OutlinedInput />}>`.
-   **Runner images do not always have `rg`.** Source-scan checks use a pure Node file walk.
-   **A workflow run with no steps** is a runner or account problem, not a lint or build result. A draft pull request's green check may be lint only; read the job list.
-   **When `main` and a branch both add to `DECISIONS.md`,** an automatic merge can keep both copies. After resolving a notes conflict, check for a repeated heading or number.
-   **Merge `main` into your branch right before the gate,** not earlier. On a busy day a gate that passed on a stale base cannot ship.
-   **`pnpm verify`'s build step is not `pnpm build`.** CI builds every workspace package. The verify build step compiles the chat widget, components, the server, and the UI. A package outside that filter needs `tsc --noEmit` in `scripts/typecheck.mjs`, or a type error passes `pnpm verify --fast` and the pre-push hook.
-   **Tests never pin the product version.** `pnpm release` runs the full verify before it bumps the version files, so a test that expects `1.0.0` passes the release and then fails on `main`. Read the version from the package's own `package.json`.
-   **Background test servers can outlive their job** and hold ports or locks. Start them so they die with the job, and kill by port when done.
-   **Keep `.turbo` out of the image context.** A cache hit restores only the outputs in `turbo.json`, and the UI writes `build/`, so a copied cache ships an image with no UI.
-   **sanitize-html 2.17 loads ESM-only htmlparser2 12.** The server Jest config compiles `htmlparser2`, `domelementtype`, `domhandler`, `domutils`, `entities` and `dom-serializer`. Another ESM-only parser dependency needs the same exception, or the server unit tests fail while loading `sanitize-html`.
-   **A pnpm override selector such as `yaml@2` does not match a prerelease** (`swagger-jsdoc` pins `yaml` 2.0.0-1). Add a `parent>child` override for that path, and read the lockfile after `pnpm install` to confirm the old version is gone.
-   **`marked` ships ESM only.** The UI Jest config maps it to `marked/lib/marked.umd.js`, because Babel config in `packages/ui/package.json` does not apply to files under `node_modules`.
-   **One `uuid` major for the whole tree.** The root `pnpm.overrides` and `resolutions` hold every package on `uuid` 11, which ships its own types, so no package needs `@types/uuid`. Raise all of them together.
-   **The UI runs on a React Router data router** (`createBrowserRouter` in `packages/ui/src/index.jsx`). The app providers live in its root route because `ErrorProvider` navigates, and the canvas unsaved-changes prompt uses `useBlocker`, which only works under a data router. A component test that renders the canvas needs `createMemoryRouter`, not `MemoryRouter`.
-   **`npm publish` treats a bare path as GitHub shorthand.** `packages/cli` is read as owner/repo, and npm runs `git ls-remote` for it. Publish with `./packages/cli` and `./packages/chat-widget`.
