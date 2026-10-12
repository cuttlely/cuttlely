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

Leave `CUTTLELY_NODE_PACKS` unset, or blank, to load only the nodes that ship with Cuttlely. It is read at start from the environment. It is not in Admin, Server settings, because it names directories on the host.

## Docker

Set `CUTTLELY_NODE_PACKS` in the environment you pass to Compose. The path has to exist inside the container, so mount the pack directory. A blank value changes nothing.

## A missing node

When a flow contains a node that is not loaded, the canvas shows a placeholder card. The card uses the `nodePack` value saved on that node, which is the package name of the pack that provided it. The rest of the flow stays on the canvas.

Export of that flow keeps the missing node's data as saved, including its inputs. Other nodes are exported as they are today.

`POST /api/v1/prediction/:id` returns 422. The message is plain text, for example: `Sample Pack Node is not installed. Install the sample-pack pack.`
