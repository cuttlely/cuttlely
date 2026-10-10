# Override configuration

A prediction request can change some of a flow's settings for that one request, with `overrideConfig`. Nothing changes unless the flow's owner turns this on and picks what may change. This page covers what a request can change, what it never can, and how request variables reach a flow.

```http
POST /api/v1/prediction/<flow id>
Content-Type: application/json

{
    "question": "What is our refund window?",
    "overrideConfig": {
        "temperature": 0.2,
        "vars": { "region": "eu" }
    }
}
```

## Turn it on

On the canvas, open the settings menu, then **Configuration**, **Advanced**, **Override Config**, and turn on **Enable Override Configuration**. Then choose:

-   **Nodes**: which settings of which cards a request may change. The list is kept per card, by the card's label. An empty list changes nothing.
-   **Variables**: which variables a request may set. Only a variable switched on here is taken from a request.

A key the request sends that is not on the list is ignored. The server logs a warning with the key names that were ignored, never their values.

## What a request can never change

Some settings are never taken from a request, even when they are on the list. These are settings that hold a credential, decide where the server sends traffic, run as code, name a file or folder on the server, or pick another server resource:

-   Credentials and keys: `credential`, `apiKey`, any name ending in `secret`, `password` or `token`, and every input a credential declares.
-   Base URLs, hosts and endpoints: any name ending in `url`, `uri`, `host`, `endpoint` or `basePath`, plus links, paths and headers.
-   Ports: `port`, any name ending in `_port` (`db_port`), and any camel-case name ending in `Port` (`redisCachePort`).
-   Code inputs: Custom Function code, If/Else and condition functions, state update code, message history code and JSON schemas.
-   File and folder inputs, and pickers that choose a tool, store, flow, harness or pipeline.
-   The Agent card's knowledge lists (`agentKnowledgeDocumentStores` and `agentKnowledgeVSEmbeddings`), and any other list whose items choose an embeddings, vector store or model card. A request cannot add, replace or edit these items. An item built from a request has no saved credential, and some providers then use a key from the server's environment instead.
-   Pickers that choose which model, embeddings or vector store card a step uses: `agentModel`, `llmModel`, `conditionAgentModel`, `humanInputModel`, `embeddingModel`, `vectorStore`, and any picker that loads a card's settings. A request cannot switch the card the owner picked. Settings on that card still follow the list, for example `modelName` or `temperature` inside `agentModelConfig` or `llmModelConfig`, and a classic chat model card's `modelName`.

The same rules apply to keys inside an allowed object or list, down to 8 levels. A match anywhere inside drops the whole value.

### Remove port entries

Ports are on this list because a request that changes a port can point the server, and the credential it sends, at another service. If a flow's override list still names a port, the entry does nothing. Remove it.

For example, a flow whose list allows `port` on its Redis cache card ignores this request, and the card keeps the port saved on the canvas:

```json
{ "question": "Hello", "overrideConfig": { "port": 6380 } }
```

## Request variables and `{{$vars}}`

A request sends variables in `overrideConfig.vars`. Each variable is checked on its own: it is used only when overrides are on and that variable is switched on under **Variables**. A variable whose name matches the never-change rules above (for example `apiUrl` or `port`) is ignored even when switched on.

Where an accepted variable shows up depends on the kind of flow:

| Flow                                     | `{{$vars.name}}` in a card's text         | Code that reads variables (`getVars`) |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------- |
| Multi-Agent and Sequential Agent flows   | The request value                         | The request value                     |
| Chatflows and agentflows (the V2 canvas) | The saved value. The request is not used. | The request value                     |

In chatflows and agentflows, a request variable reaches only the cards that read variables in code, such as Custom Function, Custom Tool, If/Else and Chat Prompt Template. It never replaces `{{$vars.name}}` written in a card's text.

For example, an agentflow has a variable `region` saved as `us`, switched on under **Variables**, and an LLM card whose prompt says `Answer for {{$vars.region}}`. A request with `"vars": { "region": "eu" }` still sends the model `Answer for us`. The same request to a Sequential Agent flow sends `Answer for eu`.

## Never reference an allowlisted variable or state key inside a code input

> **Warning.** Allowlisted variables and start-state values are inserted as text wherever they are referenced, including code inputs. Never reference an allowlisted variable or state key inside a code input.

A request cannot change a code input itself. But `{{$vars.name}}` and `{{$flow.state.key}}` are replaced with their text before the card runs, and that includes code. If a variable is switched on under **Variables**, or a start-state key is declared on the Start card and allowed, and that value appears inside a Custom Function, an If/Else function or state update code, whoever sends the request can put their own code there.

Keep request values in text inputs such as prompts. In code, read a value the flow owner controls, or check and clean the value before code uses it. Escaping request values in code inputs is planned.

## Related

-   [Drafts API](./drafts-api.md): Live is what the prediction API runs.
-   [Version history](../how-to/versioning.md): the flow settings, including the override list, save straight to Live.
