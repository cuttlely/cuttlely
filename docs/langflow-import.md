# Langflow import

Cuttlely loads a Langflow JSON export only when the graph is a simple chat. Anything else stays on the import screen with "Langflow import is not supported yet." The file is not opened as a partial canvas.

## Accepted format

A Langflow export is a JSON object whose `data.nodes` (or top-level `nodes`) are React Flow nodes. A node that counts has `type` `genericNode` or `data.node.template`. Chat Input, Chat Output, Text Input, Text Output, and notes are ignored. They are the Cuttlely chat box, not canvas nodes.

The graph must contain:

-   exactly one chat model
-   at most one Prompt
-   no other component

An empty Language Model provider is read as OpenAI. The canvas note says so, so you can swap the chat model.

Supported providers: OpenAI, Anthropic, Google, Groq, Ollama, Mistral, Azure OpenAI, and xAI. Component types such as `ChatOpenAI`, `OpenAIModelComponent`, and `LanguageModelComponent` use that list.

## Mapping

| Langflow                               | Cuttlely                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat model                             | The matching chat-model node. `model` or `model_name` becomes Model Name. Temperature and a positive max token count are copied.                  |
| Prompt template                        | Conversation Chain system message. A `{variable}` fed by Chat Input or Text Input is removed, including a line that is only `User:` or `Answer:`. |
| Chat Input and Chat Output             | Dropped. The Conversation Chain is the node you chat with.                                                                                        |
| (added)                                | Buffer Memory, because a Conversation Chain needs one.                                                                                            |
| API keys, passwords, and secret fields | Not copied. Select a credential saved in this app.                                                                                                |

The canvas also gets a sticky note that says the keys were left behind.

## Out of scope

Agents, tools, vector stores, retrievers, file loaders, more than one model, more than one prompt, and any component not listed above. A second model or an unknown provider is the same refusal. Workspace export and import stay off.

## What are you building?

Chatflows, Harnesses, Agentflows, ETL, and Templates open with outcome choices. An empty list keeps that card open. A list that already has items can hide it. **Which should I use?** opens the names:

-   **Agent team** is a harness. The sidebar and the list say **Harness · Agent Team**: Harness Prime and specialists, called by name from a chatflow.
-   **Chat / simple AI app** is a Chatflow: one chatbot or a simple flow you chat with.
-   **Workflow / automation** is an Agentflow.
-   **Knowledge / data pipeline** is ETL.
-   **Import** is a menu in the Chatflows header, and the canvas gear has it too. **Bring flows from another tool** under **What are you building?** links to [Bring your existing flows](./bring-your-flows.md). Flowise JSON opens in the migration wizard (`docs/flowise-migration-wizard.md`). Langflow JSON uses the rule above.
-   **Credentials** stay in this app. Create one, then select it on the chat model.
