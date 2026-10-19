# Architecture

Cuttlely is three zones of code that share one process. **Core** is written for this product. **Inherited** is the canvas, the node catalog, the workflow engine, and the prediction API, kept from release 3.1.4 of that engine (credited in [CREDITS.md](./CREDITS.md)). **Vendored** is the agent runtime under `hermes/`. Package, path, and environment names that still carry the engine's own name are literal names. Saved flows, imports, and existing configuration keep working.

The machine-readable form of this page is [architecture/boundaries.json](./architecture/boundaries.json). `pnpm verify` runs `scripts/architecture-map.test.mjs`, which checks that every glob matches a tracked file and that every tracked core file belongs to exactly one subsystem.

## Zones

| Zone      | What it is                                                                                 | Where it lives                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Core      | Harnesses, pipelines, versioning, identity, the admin panel, the widget, the CLI, and docs | The subsystem paths in the map, plus the `core-shared` bucket                                                                        |
| Inherited | The canvas engine at baseline release 3.1.4. No automatic sync                             | `packages/server`, `packages/ui`, `packages/components`, `packages/api-documentation`, and the root files the map lists as inherited |
| Vendored  | The agent runtime, pinned, with a lock, a fingerprint, and patches                         | `hermes/**`                                                                                                                          |

A tracked file is vendored, or it belongs to one subsystem, or it is inherited. When several path globs match, the most specific glob wins (the most literal characters). That is why `packages/components/nodes/harness/**` is part of harnesses while the rest of `packages/components/**` is inherited. A tie is a broken map.

A new file inside an inherited package stays in that package until its path is added to a subsystem. Add the path in the same change.

## What was measured

Figures in this section are from the Oct 11, 2026 audit baseline. They predate the removal of the two unused UI packages.

Outside the vendored runtime, the JavaScript, TypeScript, Python, CSS, HTML, SQL, and shell in this tree is 390,852 non-blank lines. Against release 3.1.4:

| Share | Lines   | What it is                                                          |
| ----- | ------- | ------------------------------------------------------------------- |
| 41.0% | 160,170 | Byte-identical to the baseline                                      |
| 1.3%  | 5,213   | Differs only in product-name strings                                |
| 17.2% | 67,094  | Small edits (line similarity at least 0.95 after that substitution) |
| 9.4%  | 36,733  | Heavily modified                                                    |
| 31.1% | 121,642 | New                                                                 |

Core code adds 10,395 lines inside files that also exist in that release. 142 inherited files import a core module.

That release also contains a commercially licensed identity tree (`packages/server/src/enterprise`, `IdentityManager.ts`, and `StripeManager.ts`: 127 files, 30,185 non-blank lines). This repository does not include it. `scripts/proprietary-paths.mjs` keeps those paths out. The core identity and RBAC module replaces it. The license is Apache-2.0 plus the MIT license of the vendored agent runtime.

That count includes the harness runtime (34 modules plus `check.mjs`) and the pipeline runtime. Those modules now live in the workspace packages `@cuttlely/harness` (`packages/harness`) and `@cuttlely/etl` (`packages/etl`). `@cuttlely/etl` depends on `@cuttlely/harness`. The harness modules use Node builtins, `@langchain/core`, `zod-to-json-schema`, `dotenv`, and `xlsx`. The analyst store, page planner, database check, SQLite worker, tool status, and stream lease live in `packages/harness/runtime/`. `harness/` and `etl/` re-export the packages for one release. `packages/harness/runtime/analyst-store.mjs` also loads `pg` and `crypto-js`. The pipeline package uses Node builtins and imports helpers from `@cuttlely/harness`.

## Boundary map

The first count is inherited files (the same path as release 3.1.4, tests left out) that import the subsystem. The second count is import statements in the subsystem, tests left out, whose target is an inherited file. The grade reads that coupling: **A** is an isolated package, **B** is a limited seam, **C** is cross-cutting.

| Subsystem                       | Where it lives                                                                                                                                                                                                           | Inherited files that import it | Import edges into inherited code | Grade |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | -------------------------------- | ----- |
| Chat widget                     | `packages/chat-widget` (own package, zero runtime dependencies) and `packages/server/src/utils/chatWidget.ts`, which serves the built script                                                                             | 3                              | 1                                | A     |
| CLI                             | `packages/cli` (own package, zero runtime dependencies)                                                                                                                                                                  | 0                              | 0                                | A     |
| Agent runtime                   | `hermes/`, vendored. The only execution seam is `POST /v1/runs` from `packages/harness/client.mjs`                                                                                                                       | HTTP only                      | HTTP only                        | A-    |
| Harnesses and the Analyst       | `packages/harness` including `packages/harness/runtime/`, compatibility shims `harness/`, `packages/server/src/services/harnesses` and its route, `packages/components/nodes/harness`, `packages/ui/src/views/harnesses` | 11                             | 22                               | B     |
| Knowledge pipelines             | `packages/etl`, compatibility shims `etl/`, `packages/server/src/services/etl` and its route, `packages/components/nodes/etl`, the ETL Retriever, EtlLocal, Local Hash Embeddings, `packages/ui/src/views/etl`           | 5                              | 21                               | B     |
| Versioning                      | `packages/versioning` (`@cuttlely/versioning`), plus `flow-versions` adapters, `flow-drafts`, `flow-check`, their controllers and routes, `views/versions`, `VersionHistoryDrawer`, `PublishCheck`, `PublishDialog`      | 16                             | 39                               | C+    |
| Lifecycle and GitHub promote    | `services/flow-promote`, `views/promote`, `views/versionsettings`, `views/setup`                                                                                                                                         | 4                              | 16                               | B     |
| Build with AI                   | `services/builder` (recipes for chat, ETL, harness, workflow) and `BuildWithAIDialog`                                                                                                                                    | 5                              | 13                               | B     |
| Identity and RBAC               | `packages/server/src/identity`, `database/identitySchema.ts`, `entities/identity`                                                                                                                                        | 65                             | 20                               | C     |
| Admin panel and server settings | `packages/server/src/settings`, `routes/server-settings`, `routes/server-setup`, `views/serversettings`, `views/serversetup`                                                                                             | 9                              | 10                               | B     |
| Request security hardening      | `authorize*`, `externalAgentAuth`, `externalThread`, `sessionOwnership`, `fileLinkSignature`, `upload*`, `predictionUploads`, `replaceInputsWithConfig`                                                                  | 16                             | 23                               | C     |
| Orchestrate                     | `packages/server/src/routes/orchestrate`, `controllers/orchestrate`, `services/orchestrate`                                                                                                                              | 2                              | 12                               | B     |
| Templates and demo              | `sampleTemplates`, `templateCheck`, `templateLayout`, `services/demo`                                                                                                                                                    | 3                              | 13                               | B     |
| Flow import                     | The helpers under `packages/ui/src/utils` that load an export from another tool, including `langflowImport.mjs`                                                                                                          | 3                              | 0                                | B+    |
| Usage                           | `packages/server/src/services/usage`, the `token_usage_day` entity, and its migration                                                                                                                                    | 10                             | 0                                | A     |

`core-shared` is every other core file: docs, the website, samples, most of `scripts/`, startup, and the shared UI helpers that are not one of the rows above. `entryPoints` in the JSON are the files inherited code imports today. The CLI and the agent runtime have none: nothing in inherited code imports them.

The agent runtime is 3,026 tracked files, with 6 patch files (1,494 lines) under `hermes/patches/`.

## How a request moves

The UI (`packages/ui`) calls the server (`packages/server`). The server runs canvas nodes from `packages/components`. A harness turn goes through the harness engine (`packages/harness`). A specialist that needs an agent loop calls the agent runtime over HTTP, `POST /v1/runs`, from `packages/harness/client.mjs`. The runtime listens on `127.0.0.1`. An ETL run stays in the server process and goes through `packages/etl/runner.mjs`.

## Inherited code

The inherited baseline is release 3.1.4. There is no automatic sync. Security advisories for the inherited engine are reviewed weekly, and fixes are ported by hand into patch releases. Do not edit a shipped database migration. Add a new migration instead.

## The agent runtime

Do not edit files under `hermes/` by hand. Rebuild that tree with `pnpm hermes:vendor` (`--save-patches` when the edit should stick). The steps, the lock, and the patch list are in [docs/reference/hermes-upgrades.md](./docs/reference/hermes-upgrades.md).

## Enforced boundaries

`pnpm verify` and CI run `scripts/check-boundaries.mjs`. It reads [architecture/boundaries.json](./architecture/boundaries.json). A new import that crosses a zone fails, and the message names the file pair and how to fix it. Crossings that already exist are in [architecture/boundary-baseline.json](./architecture/boundary-baseline.json). `node scripts/check-boundaries.mjs --update` only shrinks that file. Recording a new crossing takes `--allow-new` and a reason, stored next to the edge.

A file added under an inherited path fails unless it is listed in [architecture/inherited-files.txt](./architecture/inherited-files.txt) or its path is assigned to a subsystem. Add the path to a subsystem, or to `core-shared`, in the map.

## Roadmap

The separation work after this map:

-   Own package names. `packages/components` is `@cuttlely/components`. `packages/server` is `@cuttlely/server`. `packages/ui` is `@cuttlely/ui`. `packages/api-documentation` is `@cuttlely/api-docs`. A compatibility alias keeps saved custom functions and custom tools working. The server CLI keeps its existing bin and adds `cuttlely-server`. Path, environment variable, and data names stay stable.
-   Optional integration packs, so a deploy can omit node families it does not run.
-   A smaller image.
