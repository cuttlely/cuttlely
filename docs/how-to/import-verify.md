# Import and verify

Import a flow or harness file, then select **Import & verify**. Cuttlely checks the flow on this server and tells you, in plain language, whether it is ready to publish.

You do not type sample parameter values. You do not paste secrets into a chat. Connections are credentials you already saved under **Credentials**.

## What happens

1. Open a canvas and choose **Import & verify** from the gear menu. On a new canvas the same item is in that menu before the first save.
2. Choose the JSON file and select **Import & verify**.
3. Cuttlely keeps the queries and the rest of the configuration. A test stamp from the file is not treated as proof. Every saved query is tested again on this server.
4. A connection that already exists here, with the same name and type, is reused. If none matches, more than one matches, or a required credential is still empty, you get a short list and choose one. Choosing and testing a connection needs permission to view credentials. An optional empty credential slot stays empty. The canvas shows the imported draft and records that draft, so the next Save stays on the draft. On a canvas that has not been saved yet, this check creates the flow and the address changes to that flow, so Save and Publish use the same one.
5. Progress reads like **Checking saved queries: 42 of 89.**
6. When it finishes, the result is one of:
    - **Ready to publish.** The checks that apply to this flow passed. Nothing has been published yet.
    - **Needs attention.** Something failed or a choice is still open. Each item names an action, such as **Choose connection** or **Retry**.
    - **Could not fully verify.** A check could not be run, for example because saved queries are turned off. The flow is not marked ready.

**Retry** runs the queries that failed. Queries that already passed on this server are not run again. Close stays available while the check runs. You can close the dialog and come back; the progress is saved with the draft, and the canvas shows the imported draft. If the check was still running when the server stopped, **Resume** continues that same draft.

## What is checked

-   Saved queries on a Postgres (MCP) node, using the same test this server already uses for **Test & save**. A query that runs and returns no rows is a real run. It is not proof that a report or CSV works. **Retry** runs that query again after the table has rows. A report or CSV is checked against the query on the card connected to it, not another card that happens to use the same name.
-   Required connections on the cards, such as a chat model, embeddings, a tool, or a specialist. A missing required connection keeps the flow at **Needs attention**.
-   Cards, connections between cards, models, embeddings, and tools that are not installed on this server.
-   Verified-output contracts. A contract has to name one connected saved query and the statement hash from the test that just ran. Two connected queries with the same name, or a contract with no hash, have to be reviewed. The contract is not rewritten. Row count alone is not proof.
-   PDF output, when the flow builds a PDF. The check builds a sample in memory. It does not save a file and it does not call another service.

Saved queries have to be turned on (`CUTTLELY_PINNED_QUERIES` set to `1` or `true`) or those queries cannot be tested. See [Pinned queries](./pinned-queries.md).

## Publish

Verification stays on the draft. The Live version that is already published is left as it is. **Publish** is offered after the required checks pass. Importing the file does not publish it. If the check stops before it finishes, Publish stays off until you resume it. A flow with no saved queries can still be ready when the other checks pass; the summary does not claim that queries were tested.

If you publish before that, the server refuses and tells you to finish Import & verify. A draft you edit after verification is a different draft; publish follows the usual draft rules for that newer copy.
