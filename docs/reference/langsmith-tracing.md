# LangSmith tracing: which account gets a flow's traces

Design note for 1.4.3.

A flow with LangSmith tracing on names a LangSmith credential and a project. The tracer is built with that credential's API key and endpoint.

**A credential with no API key value does not fall back to the server.** The LangSmith SDK reads the server's environment key (`LANGSMITH_API_KEY`, or `LANGCHAIN_API_KEY`) when it is given no key at all. A flow's credential also sets the endpoint, so that fallback would send the server's key to whatever endpoint the credential names, and put the flow's traces in the server owner's account. From 1.4.3 the client for a flow is always built with the credential's key, an empty one when the credential has none, so the environment key is never used for a flow's traces. Uploads with an empty key are refused by LangSmith and logged.

What this means:

-   Give every flow that traces a credential with a key. The server's LangSmith settings are not a default for flows.
-   A failed upload logs the flow id and the credential id, its field names, the key length (0 for an empty credential), the endpoint origin and a fixed operation name (such as `/runs/multipart`). The key value, anything derived from it, and the endpoint path, query and user info are never logged.

See also [Startup options](./startup-options.md) for `LANGSMITH_API_KEY`, `LANGCHAIN_API_KEY` and `LANGSMITH_PROJECT`.
