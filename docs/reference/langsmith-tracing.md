# LangSmith tracing: which account gets a flow's traces

Design note for 1.4.3.

A flow with LangSmith tracing on names a LangSmith credential and a project. The tracer is built with that credential's API key and endpoint.

**A credential with no API key value falls back to the server.** When the selected credential has no key (it was saved empty, or the value was cleared), the LangSmith client is created without one and reads the server's own environment settings (`LANGSMITH_API_KEY`, or `LANGCHAIN_API_KEY`). That flow's traces then go to the **server owner's LangSmith account**, under the flow's project name. The workspace that owns the flow does not see them in its own LangSmith account, and the server owner can read them.

What this means:

-   On a shared server, give every flow that traces a credential with a key. Leave the server's LangSmith settings unset if workspaces must not trace into the server owner's account.
-   A failed upload logs the flow id and the credential id, its field names and the key length (0 for an empty credential), so an empty credential shows up in the server log. The key value, and anything derived from it, is never logged.

See also [Startup options](./startup-options.md) for `LANGSMITH_API_KEY`, `LANGCHAIN_API_KEY` and `LANGSMITH_PROJECT`.
