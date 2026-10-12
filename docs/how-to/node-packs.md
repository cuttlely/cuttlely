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

Leave `CUTTLELY_NODE_PACKS` unset to load the packs that ship with the install. Today that list is `@cuttlely/node-pack-vector-stores`. A blank value loads none. Setting `CUTTLELY_NODE_PACKS` replaces that shipped list. It does not append to it. To keep the vector store nodes, set `CUTTLELY_NODE_PACKS=@cuttlely/node-pack-vector-stores`. Any other pack name or directory goes after a comma in that same value. It is read at start from the environment. It is not in Admin, Server settings, because it names directories on the host.

## Packs that ship with Cuttlely

`@cuttlely/node-pack-vector-stores` holds the vector store nodes, the credentials only those nodes use, and the dependencies only those nodes import. Node names and inputs are unchanged. A from-source install (`pnpm install` at the repository root) includes the package. The default image includes it too.

A credential that another node still uses stays in `packages/components/credentials`. Postgres, Zep, Redis, MongoDB and AWS credentials are in that set.

## Layout for the next pack

A shipped pack is a private workspace package at `packages/node-pack-<name>`, named `@cuttlely/node-pack-<name>`.

-   `nodes/` holds the node classes, one folder per node, the same shape as `packages/components/nodes`.
-   `credentials/` holds credential classes used only by those nodes.
-   `package.json` sets `cuttlely.nodePack` to `dist/nodes` and `dist/credentials`.
-   `tsconfig.json` compiles `nodes` and `credentials` into `dist` as CommonJS. It resolves `@cuttlely/components` and the subpaths in that package's `exports` (`interface`, `utils`, `indexing`, `validator`, `sanitizeDataSourceOptions`, `awsToolsUtils`, `modelLoader`, `etl-engine`) to the built declarations, so the components package builds first. The workspace build already does that.
-   Dependencies that only these nodes import are listed on this package and taken off `@cuttlely/components`. Dependencies other nodes still import stay on `@cuttlely/components`. The pack also lists the shared packages it imports.
-   The build script is `tsc` followed by a copy of the icons into `dist/nodes`.
-   Add the package name to `SHIPPED_NODE_PACKS` in `packages/server/src/utils/nodePacks.ts`.
-   Add a dependency on the package in `@cuttlely/server`.
-   `scripts/build-module-catalog.mjs` and the node load test already read `packages/node-pack-*/nodes` and `packages/node-pack-*/credentials`.

`INCLUDE_NODE_PACKS=0` builds an image without those packages. The default is `1`. See [Docker](./docker.md#leave-out-optional-node-packs).

## Docker

Set `CUTTLELY_NODE_PACKS` in the environment you pass to Compose when you want a list other than the shipped packs. That value replaces the shipped list. It does not append. To keep the vector store nodes, set `CUTTLELY_NODE_PACKS=@cuttlely/node-pack-vector-stores`. A directory has to exist inside the container, so mount that pack. A blank value loads no optional packs. Unset inside the default image loads the shipped packs, unless the image was built with `INCLUDE_NODE_PACKS=0`, which writes `/etc/cuttlely/no-node-packs` and loads none.

## A missing node

When a flow contains a node that is not loaded, the canvas shows a placeholder card. The card uses the `nodePack` value saved on that node, which is the package name of the pack that provided it. Lines into and out of that card stay attached, including after you change another card and save, or save a draft. The rest of the flow stays on the canvas. Loading the pack later shows the node again, with those lines still connected.

Export of that flow keeps the missing node's data as saved, including its inputs. Other nodes are exported as they are today.

`POST /api/v1/prediction/:id` returns 422. The message is plain text, for example: `Sample Pack Node is not installed. Install the sample-pack pack.`
