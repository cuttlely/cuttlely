# Flowise migration wizard

Import Flowise JSON, in the **Import** menu on Chatflows and on the canvas gear, opens this wizard. A second JSON import item in the same menu follows a different guide.

## Steps

1. **Upload.** One Flowise chatflow JSON file. That is a canvas (`nodes` and `edges`) or a saved flow whose `flowData` holds that canvas.
2. **Scan.** How many nodes import as they are, and which fixes the wizard applied.
3. **Credentials.** Each credential slot and each password input that had a value. The report names the node and the slot. It does not include the value.
4. **Nodes.** Deprecated nodes Cuttlely still draws, and nodes it will not draw.
5. **Result.** Green when the file is ready to open. Amber when the canvas can open and something still needs a person. The button opens the migrated canvas.

## What the scan does

-   A node name in `packages/components/nodes/module-catalog.json` is kept.
-   A catalog row marked `replaced` (deprecated completion models and the older agents) is kept and listed. It is not rewritten into a chat model.
-   A node name Cuttlely does not have is a refusal. The 22 removed LlamaIndex nodes are named as removed. The canvas does not open.
-   A node missing `inputParams`, `inputAnchors`, or `outputAnchors` is a refusal. The canvas cannot draw that node.
-   Credential ids, `FLOWISE_CREDENTIAL_ID`, and password, file, and folder inputs are removed before the canvas opens.
-   An edge whose source or target is missing is dropped.
-   A chatflow with no Chain, Agent, or Engine still opens. The result says it cannot chat yet.
-   A workspace bundle (`ChatFlow`, `AgentFlow`, and the other export tables) is refused. Import one chatflow.
-   A file meant for that other import item is refused here. It is not converted.

The canvas route follows the graph: a Harness Prime or specialist node opens the harness canvas, an Agent Flows node opens agentflow v2, a sequential or multi-agent graph opens the legacy agentflow canvas (it still runs and saves, but the app no longer offers it for new work), `type: ETL` opens the ETL canvas, and everything else opens the chatflow canvas.

Every save of the migrated flow is kept in [Version history](./how-to/versioning.md).

## Not in this version

-   Creating or matching credentials inside the wizard. After the canvas opens, select a credential saved in this app.
-   Rewriting a deprecated LLM into the chat-model node of the same provider.
-   Syncing outdated node versions. The canvas sync control still does that.
-   Restoring the export viewport.
-   Importing more than one chatflow at a time.
