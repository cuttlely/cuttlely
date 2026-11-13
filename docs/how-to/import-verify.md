# Import and verify

Import a flow or harness file, then select **Import & verify**. Cuttlely checks the flow on this server and tells you, in plain language, whether it is ready to publish.

You do not type sample parameter values. You do not paste secrets into a chat. Connections are credentials you already saved under **Credentials**.

## What happens

1. Open a canvas and choose **Import & verify** from the gear menu. On a new canvas the same item is in that menu before the first save.
2. Choose the JSON file and select **Import & verify**.
3. Cuttlely keeps the queries and the rest of the configuration. A test stamp from the file is not treated as proof. Every saved query is tested again on this server.
4. A connection that already exists here, with the same name and type, is reused. If none matches, more than one matches, or a required credential is still empty, you get a short list and choose one. Choosing and testing a connection needs permission to view credentials. An optional empty credential slot stays empty. The canvas shows the imported draft only after that draft's status has loaded, so the next Save stays on the draft. If the status cannot be loaded, the canvas is left unchanged. On a canvas that has not been saved yet, including a new agent team, this check creates the flow, saves the imported draft, and the address changes to that flow.
5. Progress reads like **Checking saved queries: 42 of 89.**
6. When it finishes, the result is one of:
    - **Ready to publish.** The checks that apply to this flow passed. Nothing has been published yet.
    - **Needs attention.** Something failed or a choice is still open. Each item names an action, such as **Choose connection** or **Retry**.
    - **Could not fully verify.** A check could not be run, for example because saved queries are turned off. The flow is not marked ready.

**Retry** runs the queries that failed. A query that already passed is not run again only when this draft is still the one that was checked and the statement, its parameters, the connection, and the guard settings are unchanged. A stamp in the file is not that proof. Close stays available while the check runs. You can close the dialog and come back; the progress is saved with the draft, and the canvas shows the imported draft. If the check was still running when the server stopped, **Resume** continues that same draft. An assistant flow uses the assistant update permission. Import & verify is a signed-in action.

## What is checked

-   Saved queries on a Postgres (MCP) node, using the same test this server already uses for **Test & save**. A query that runs and returns no rows is a real run. It is not proof that a report or CSV works. **Retry** runs that query again after the table has rows. A report or CSV is checked against the query on the card connected to it, not another card that happens to use the same name.
-   Required connections on the cards, such as a chat model, embeddings, a tool, or a specialist. A missing required connection keeps the flow at **Needs attention**.
-   Cards, connections between cards, models, embeddings, and tools that are not installed on this server.
-   Verified-output contracts. A contract has to name exactly one connected saved query and the statement hash from the test that just ran. A contract with no query name, two connected queries with the same name, or a contract with no hash has to be reviewed. The contract is not rewritten. Row count alone is not proof.
-   PDF output, when the flow builds a PDF. The check builds a sample in memory. It does not save a file and it does not call another service.

Saved queries have to be turned on (`CUTTLELY_PINNED_QUERIES` set to `1` or `true`) or those queries cannot be tested. See [Pinned queries](./pinned-queries.md).

## Publish

Verification stays on the draft. The Live version that is already published is left as it is. **Publish** is offered after the required checks pass. Importing the file does not publish it. A running or stopped check blocks Publish when its saved result does not match the current draft. An attention result blocks the draft it checked, and a Save keeps that import hold so a no-op Save cannot clear it. A different draft that no longer carries the hold is not blocked by an older attention result. If Import & verify cannot load the draft status, including after Retry, Resume, or choosing a connection, the canvas is left unchanged, Save stays off, and Publish is not offered. Resume continues a passed query only for the draft that was checked, and only when that query's statement, parameters, connection, and guard settings are unchanged. Publish from this dialog sends the hash of the draft that was verified. The first save of an existing flow uses the draft hash this canvas loaded, so it does not replace a newer draft. A new import on the legacy agent canvas is stored as the legacy agent type. A newer save of that draft, including one by the same person, is left in place while the check is running. A flow with no saved queries can still be ready when the other checks pass; the summary does not claim that queries were tested.

If you publish before that, the server refuses and tells you to finish Import & verify. A draft you edit after verification is a different draft; publish follows the usual draft rules for that newer copy.
