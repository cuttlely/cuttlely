# Optional node packs

Cuttlely loads the nodes and credentials that ship with it. You can also load more from a pack: a directory, or a package the server can require.

A saved flow that uses a node you do not have still opens. That card is a placeholder that names the pack. Export leaves that node's data as it was saved. A prediction does not run the flow. The API returns status 422 and a short message that names the pack.

## Point the server at a pack

Set `CUTTLELY_NODE_PACKS` to a comma-separated list of directories or package names, then restart.

```bash
CUTTLELY_NODE_PACKS=/opt/packs/sample,@example/sample-pack
```

A token that is a directory is that pack. Any other token is a package name. Each pack has a `package.json`:

```json
{
    "name": "@example/sample-pack",
    "cuttlely": {
        "nodePack": {
            "nodes": "dist/nodes",
            "credentials": "dist/credentials"
        }
    }
}
```

`nodes` is the directory of node classes, the same shape as the built-in nodes: files that export `nodeClass`. `credentials` is optional. Both paths stay inside the pack. The server writes `nodes-manifest.json` beside the nodes directory and reuses it on the next start, the same way it caches the nodes that ship with Cuttlely.

If a pack defines a node or credential name that is already loaded, the existing one stays and the server logs a warning.

The packs that ship with the install always load. Today that is `@cuttlely/node-pack-vector-stores` and `@cuttlely/node-pack-tools-mcp`. `CUTTLELY_NODE_PACKS` adds packs after that list. A repeated name is loaded once. A blank value adds nothing and removes nothing. Leave the variable unset for the same result. An image built with `INCLUDE_NODE_PACKS=0` writes `/etc/cuttlely/no-node-packs` and skips the shipped packs. Packs named in `CUTTLELY_NODE_PACKS` still load in that image. The variable is read at start from the environment. It is not in Admin, Server settings, because it names directories on the host.

## Packs that ship with Cuttlely

`@cuttlely/node-pack-vector-stores` holds the vector store nodes, the credentials only those nodes use, and the dependencies only those nodes import. Node names and inputs are unchanged. A from-source install (`pnpm install` at the repository root) includes the package. The default image includes it too.

`@cuttlely/node-pack-tools-mcp` holds tool nodes that call an outside service and the prebuilt MCP server nodes for those services, plus the credentials and dependencies only those nodes use. Custom Tool, Custom MCP, chatflow and agentflow tools, Retriever Tool, Calculator, Request tools, the ETL Retriever, and the PostgreSQL MCP node the analyst uses stay in `packages/components`. Node names and inputs are unchanged. A from-source install and the default image include this pack too.

A credential that another node still uses stays in `packages/components/credentials`. Postgres, Zep, Redis, MongoDB and AWS credentials are in that set. Brave Search, GitHub, Google Drive, Google Sheets, Jira, SearchApi and Serp API credentials stay there because a document loader still uses them. The E2B client stays on `@cuttlely/components` because in-process code execution loads it.

## Layout for the next pack

A shipped pack is a private workspace package at `packages/node-pack-<name>`, named `@cuttlely/node-pack-<name>`.

-   `nodes/` holds the node classes, one folder per node, the same shape as `packages/components/nodes`.
-   `credentials/` holds credential classes used only by those nodes.
-   `package.json` sets `cuttlely.nodePack` to `dist/nodes` and `dist/credentials`.
-   `tsconfig.json` compiles `nodes` and `credentials` into `dist` as CommonJS. It resolves `@cuttlely/components` and the subpaths in that package's `exports` (`interface`, `utils`, `indexing`, `validator`, `sanitizeDataSourceOptions`, `awsToolsUtils`, `modelLoader`, `etl-engine`) to the built declarations, so the components package builds first. The workspace build already does that.
-   Dependencies that only these nodes import are listed on this package and taken off `@cuttlely/components`. Dependencies other nodes still import stay on `@cuttlely/components`. The Zep client libraries stay there: the Zep memory nodes are not in this pack, and they import those libraries. The pack also lists the shared packages it imports.
-   The build script is `tsc` followed by a copy of the icons into `dist/nodes`.
-   Add the package name to `SHIPPED_NODE_PACKS` in `packages/server/src/utils/nodePacks.ts`.
-   Add a dependency on the package in `@cuttlely/server`.
-   `scripts/build-module-catalog.mjs` and the node load test already read `packages/node-pack-*/nodes` and `packages/node-pack-*/credentials`.
-   `node scripts/build-node-pack-index.mjs` rewrites `packages/server/src/utils/node-pack-index.json` from every `packages/node-pack-*/nodes` folder. The server build runs that script. A future pack is included without a second list.

`INCLUDE_NODE_PACKS=0` builds an image without those packages. The default is `1`. See [Docker](./docker.md#leave-out-optional-node-packs).

## Docker

Set `CUTTLELY_NODE_PACKS` in the environment you pass to Compose to add packs. That value is added to the shipped packs. A blank value adds nothing. A directory has to exist inside the container, so mount that pack. The default image loads the shipped packs. An image built with `INCLUDE_NODE_PACKS=0` writes `/etc/cuttlely/no-node-packs` and skips them. Packs named in `CUTTLELY_NODE_PACKS` still load there.

## A missing node

When a flow contains a node that is not loaded, the canvas shows a placeholder card. The card uses the `nodePack` value saved on that node, which is the package name of the pack that provided it. A flow saved before that field existed, or a bundled template, has no `nodePack`. The card and the prediction error then use the node pack index: each node name and label under `packages/node-pack-*/nodes`, mapped to the pack's package name. The index is `packages/server/src/utils/node-pack-index.json`. The server reads it in every image, including one built with `INCLUDE_NODE_PACKS=0`. `GET /api/v1/nodes/pack-index` returns the same list for the canvas. Saving or importing a flow writes `nodePack` from the index when the field is absent. Lines into and out of that card stay attached, including after you change another card and save, or save a draft. The rest of the flow stays on the canvas. Loading the pack later shows the node again, with those lines still connected.

Export of that flow keeps the missing node's data as saved, including its inputs. Other nodes are exported as they are today.

`POST /api/v1/prediction/:id` returns 422. The message is plain text, for example: `Sample Pack Node is not installed. Install the sample-pack pack.`
