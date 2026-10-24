# LangSmith tracing: which account gets a flow's traces

Design note for 1.4.3.

A flow with LangSmith tracing on names a LangSmith credential and a project. The tracer is built with that credential's API key and endpoint.

**A credential with no API key value does not fall back to the server.** The LangSmith SDK fills a missing or empty key from the server: its environment key (`LANGSMITH_API_KEY`, or `LANGCHAIN_API_KEY`) or a LangSmith profile on the server (an API key or OAuth sign-in). A flow's credential also sets the endpoint, so that fallback would send the server's credentials to whatever endpoint the credential names, and put the flow's traces in the server owner's account. From 1.4.3 a flow whose LangSmith credential has no key, or one that is blank once spaces and surrounding quotes are removed, gets no LangSmith client: its LangSmith tracing is off, nothing is sent, and a `[langsmith] tracing off` warning is logged with the flow id and the credential shape below.

What this means:

-   A flow that turns LangSmith on in its own Analytics settings needs a credential with a key. The server's key or profile is never used in place of that credential's key.
-   Server-wide tracing set by the host (`LANGSMITH_TRACING` with `LANGSMITH_API_KEY`, see Startup options) still applies to flows that do not turn LangSmith on themselves. Those traces go to the server's own endpoint with the server's key.
-   A failed upload, or tracing turned off for a credential with no key, logs the flow id and the credential id, its field names, the key length, the endpoint origin and the project; a failed upload also logs a fixed operation name (such as `/runs/multipart`). The key value, anything derived from it, and the endpoint path, query and user info are never logged.

See also [Startup options](./startup-options.md) for `LANGSMITH_API_KEY`, `LANGCHAIN_API_KEY` and `LANGSMITH_PROJECT`.
