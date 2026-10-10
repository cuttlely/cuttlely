# Drafts API

These routes keep a flow's canvas edits in a **draft** and put them **Live** with **Publish**. Live is what the prediction API, embeds, shared links, MCP, schedules and webhooks run. The draft is what the canvas and its test chat show. How drafts look in the app: [Drafts and Publish](../how-to/versioning.md#drafts-and-publish). History of each Publish and Roll back: [History API](./versioning-api.md).

Drafts are on by default. `CUTTLELY_DRAFTS=off` (also `false`, `0`, or `no`) turns them off; any other value, or no value, leaves them on. See [History settings](./versioning-settings.md#cuttlely_drafts). With drafts off, every route below except `GET` refuses with 409 `Drafts are off on this server.`, and the canvas saves straight to Live.

All routes are under `/api/v1/flow-drafts`. A signed-in session works, and so does an API key with the permissions below. The flow must be in the caller's active workspace; any other flow id returns 404. The route lets in chatflow or agentflow users, and then the permission for the flow's own type is checked: `chatflows:*` for a chatflow, `agentflows:*` for an agentflow. Without it the route returns 403.

| Method   | Route                         | Permission                                |
| -------- | ----------------------------- | ----------------------------------------- |
| `GET`    | `/:chatflowId`                | `chatflows:view` or `agentflows:view`     |
| `PUT`    | `/:chatflowId`                | `chatflows:update` or `agentflows:update` |
| `DELETE` | `/:chatflowId`                | `chatflows:update` or `agentflows:update` |
| `PUT`    | `/:chatflowId/settings`       | `chatflows:update` or `agentflows:update` |
| `POST`   | `/:chatflowId/publish`        | `chatflows:update` or `agentflows:update` |
| `POST`   | `/:chatflowId/rollback`       | `chatflows:update` or `agentflows:update` |
| `GET`    | `/:chatflowId/check`          | `chatflows:view` or `agentflows:view`     |
| `POST`   | `/:chatflowId/check`          | `chatflows:update` or `agentflows:update` |
| `GET`    | `/:chatflowId/check/:checkId` | `chatflows:view` or `agentflows:view`     |
| `DELETE` | `/:chatflowId/check/:checkId` | `chatflows:update` or `agentflows:update` |

Which flows have drafts: chatflows and agentflows. Harness, ETL and assistant flows save straight to Live.

A draft holds the canvas only: nodes, connections, prompts and node settings. The flow's name, chatbot and API settings, and starter prompts still save straight to Live through the chatflow routes. `PUT /api/v1/chatflows/:id` also keeps writing Live, so scripts that update flows keep working. One exception: while a flow has unpublished changes, changing its type (through the chatflow API, Restore, or Roll back Live) returns 409 `This flow has unpublished changes. Publish or discard them before changing the flow's type.`, because the draft is a canvas of the current type. That check is the type write itself, so a draft saved after the read and before the write still blocks it. Publish also checks the type the draft was started on, and refuses a draft of another kind of flow with 409, even with `overwriteLiveChanges`; discard it to continue. A draft saved before Cuttlely recorded that type (a draft left from an earlier preview release) is refused the same way.

## Draft status

`GET /api/v1/flow-drafts/:chatflowId`. `PUT`, `DELETE` and `settings` return the same shape; `publish` and `rollback` return it as `status`.

```json
{
    "enabled": true,
    "mode": "draft",
    "reason": null,
    "publishInstantly": false,
    "draft": {
        "flowData": "{\"nodes\":[…],\"edges\":[…]}",
        "updatedDate": "2026-10-08T17:02:11.000Z",
        "updatedBy": "<user id>",
        "stale": false
    },
    "lastPublished": { "sha": "afc07f3…", "date": "2026-10-08T16:40:00.000Z" }
}
```

| Field              | Meaning                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`          | Drafts are on for this server: `CUTTLELY_DRAFTS` is not `off`.                                                                                                                                   |
| `mode`             | `draft`: canvas edits go to the draft. `live`: they go straight to Live.                                                                                                                         |
| `reason`           | Why `mode` is `live`: `off` (drafts are off), `type` (this kind of flow has no drafts), or `publish-instantly`. `null` in draft mode.                                                            |
| `publishInstantly` | The flow's **Publish instantly** setting.                                                                                                                                                        |
| `draft`            | The unpublished changes, or `null` when there are none. `updatedBy` is `null` for an API key. `stale` is `true` when Live changed after the draft started, for example through the chatflow API. |
| `lastPublished`    | The last Publish or Roll back: the history version it recorded (`sha`, `null` when none was recorded) and when. `null` before the first one.                                                     |

## Save the draft

`PUT /api/v1/flow-drafts/:chatflowId` with `{ "flowData": "<canvas JSON string>" }`. Live is not touched. Uploaded files in the draft are stored under their own name (`draft-<random>-<name>`), so a draft never replaces a file Live uses. A canvas identical to Live clears the draft instead.

400 when `flowData` is missing, not JSON, or has no `nodes` and `edges` lists. 409 when drafts are off, the flow's type has no drafts, or Publish instantly is on. 409 when the flow's type changed after this canvas was loaded (`This flow changed to another kind of flow after these edits started, so they can't be saved. Discard them to continue.`): the draft is not stored.

## Discard the draft

`DELETE /api/v1/flow-drafts/:chatflowId`. Throws the draft away. Live is not touched.

## Publish instantly

`PUT /api/v1/flow-drafts/:chatflowId/settings` with `{ "publishInstantly": true }`. With it on, canvas edits go straight to Live, as before drafts. Turning it on while the flow has unpublished changes returns 409; publish or discard them first. 400 when the value is not `true` or `false`.

## Publish

`POST /api/v1/flow-drafts/:chatflowId/publish`, optional body `{ "overwriteLiveChanges": true }`.

Saves the draft as Live through the normal chatflow update, so validation and file handling run as for any save. History gains a version of kind `publish`, titled `Published: <what changed>`, with the caller as its author. The draft is then cleared. If someone saved a newer draft while the publish ran, that draft is kept.

When the draft is `stale` (Live changed after it started), publishing would replace those Live changes, so it is refused with 409 unless the body has `"overwriteLiveChanges": true`. The save itself only goes through while Live is still the canvas and flow type that check was made against; if either changes during the publish, it returns 409 `Live changed while publishing, so nothing was published. Try again.`

```json
{
    "chatflow": { "id": "<flow id>", "name": "Bakery helper", "type": "CHATFLOW", "updatedDate": "2026-10-08T17:05:40.000Z" },
    "version": {
        "sha": "afc07f3…",
        "kind": "publish",
        "published": true,
        "title": "Published: Changed System Message on Conversation Chain",
        "…": "…"
    },
    "unchanged": false,
    "recorded": true,
    "historyError": null,
    "status": { "mode": "draft", "draft": null, "…": "…" }
}
```

| Field          | Meaning                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | The new history entry, in the [History API](./versioning-api.md#list-versions) list format, or `null`.                                                |
| `unchanged`    | `true` when Live already matched the draft. The draft is cleared once the same conditional save confirms Live still matches; history records nothing. |
| `recorded`     | `true` when the publish was added to history. `false` when history is off or the history write failed.                                                |
| `historyError` | Why the history write failed, when known. Otherwise `null`. Live is updated either way.                                                               |
| `status`       | The draft status after publishing.                                                                                                                    |

| Status | When                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 403    | No update permission for this type of flow.                                                                                        |
| 409    | `Drafts are off on this server.`, `There are no unpublished changes to publish.`, or a stale draft without `overwriteLiveChanges`. |

## Roll back Live

`POST /api/v1/flow-drafts/:chatflowId/rollback` with `{ "sha": "<version id>" }`.

Sets Live to that version at once, with its name, type and category, the same way [Restore](./versioning-api.md#restore) does. History gains a version of kind `rollback`, titled `Rolled back Live to: <title> (<short sha>)`. An open draft is kept and is not marked stale, because this Live was chosen. While the flow has unpublished changes, a version of another kind of flow is refused with 409; see below.

The response is the [Restore](./versioning-api.md#restore) response plus `status`, the draft status afterwards. The write lands only while Live is still the canvas that was read; a Live update in between returns 409 `Live changed while this was being saved, so nothing was changed. Try again.` 400 when `sha` is not 7 to 40 lowercase hex characters, 404 when the version is not in this flow's history, 409 when drafts or history are off, 403 without the update permission for the flow's type and the version's type.

## Publish check

Before Publish, the check asks a few recent real questions again, once to Live and once to the draft, and returns both answers side by side with the tokens and time each took. It is optional: Publish never waits for it and never looks at its result. How it looks in the Publish dialog: [Check recent questions before you publish](../how-to/versioning.md#check-recent-questions-before-you-publish).

Each question runs the model twice, so a check costs tokens on the flow's model account. The server caps each check:

| Limit          | Value                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Questions      | At most 10, each at most 2,000 characters.                                                                              |
| Tokens         | `CUTTLELY_CHECK_MAX_TOKENS`, 100,000 by default. See [History settings](./versioning-settings.md#publish-check-limits). |
| Time           | `CUTTLELY_CHECK_MAX_SECONDS`, 180 by default, and at most 60 seconds for any one run.                                   |
| Checks at once | One per flow, three on the server.                                                                                      |

When a limit is reached, the check stops after the run in progress and keeps the answers it has. A question counts only when both Live and the draft answered it.

What a check never does:

-   It never saves Live or the draft. The canvases run in memory.
-   It writes no chat messages, so replays do not show up in chat history, the flow's usage counts or its memory. Each run starts with empty memory.
-   It calls none of the flow's tracing or analytics providers, and adds no follow-up prompts or speech.
-   On an agentflow it writes no execution record, does not resume or read an earlier run, ignores any human input sent with the question, and stores no image or file that a model step generates.
-   It writes the questions, answers and canvases to no log. Results stay in the server's memory for 30 minutes and are lost on restart.

The check works on chatflows and agentflows with unpublished changes. An agentflow must start with a chat message (Start input type **Chat Input**), in Live and in the draft. Legacy multi-agent and sequential-agent flows are not checked. On an agentflow, the tokens counted are the ones each model step reports (LLM and Agent steps); a Condition Agent step reports none.

### Steps that act for real

Some steps do more than answer: they send a request, write to a database or vector store, run custom code or call an assistant that keeps its own threads. Replaying them could repeat that action, so the check refuses to run a flow that has one, in Live or in the draft, unless the request says to run it anyway. Steps counted as risky:

-   Any node outside these groups: Chat Models, LLMs, Embeddings, Prompts, Output Parsers, Text Splitters, Retrievers, Moderation, Document Loaders, Record Manager, Vector Stores, Chains, Agents, Memory, Tools and Utilities. A node the check does not know counts as risky.
-   In those groups: Vectara upsert, POST API chain, OpenAPI chain, SQL database chain, Cypher QA chain, OpenAI Assistant, Custom JS Function and If Else Function.
-   Memory other than Buffer Memory, Buffer Window Memory, Conversation Summary Memory and Conversation Summary Buffer Memory. Those four read Cuttlely's own chat history, which a replay starts empty and never writes; other memory keeps turns in its own store.
-   Tools other than read-only ones such as Calculator, the web search tools, Requests Get, Web Scraper and retriever or chain tools.
-   Utilities other than Set Variable, Get Variable and Sticky Note.
-   The flow's **Post-processing** code.

On an agentflow, the steps counted as risky:

-   Custom Function, HTTP, Execute Flow and Human Input steps, and any agentflow step the check does not know.
-   A Tool step, unless its tool is one of the read-only tools above.
-   An Agent step with a tool that is not read-only, or with a tool that asks a person to approve it. An Agent with no tools, or only read-only ones, is safe. Its built-in provider tools (web search, code run by the model provider) count as read-only.
-   Start, LLM, Agent, Condition, Condition Agent, Retriever, Direct Reply, Loop, Iteration and Sticky Note steps are safe.

### Check setup

`GET /api/v1/flow-drafts/:chatflowId/check`

```json
{
    "unavailable": null,
    "questions": [{ "text": "Do you have gluten-free bread today?", "date": "2026-10-08T16:12:03.000Z" }],
    "riskySteps": [],
    "limits": { "maxQuestions": 10, "maxQuestionChars": 2000, "maxTokens": 100000, "maxSeconds": 180 },
    "liveEmpty": false,
    "check": null
}
```

| Field         | Meaning                                                                                                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unavailable` | Why a check can't run now, or `null`. `code` is `off` (drafts are off), `type` (not a chatflow or an agentflow), `no-draft` (nothing to check) or `start` (an agentflow that does not start with a chat message), with a `message` to show.                                                                                                 |
| `questions`   | Up to 10 recent questions people asked this flow, through the API, embeds and shared links or the canvas test chat, newest first and without repeats. Questions sent with files are left out. Then the flow's starter questions that nobody asked yet, marked `"starter": true` with an empty `date`, so a new flow has questions to check. |
| `riskySteps`  | The steps that act for real, as `{ "id", "label" }`. Empty when there are none.                                                                                                                                                                                                                                                             |
| `limits`      | The limits above, as this server has them.                                                                                                                                                                                                                                                                                                  |
| `liveEmpty`   | `true` when Live has no cards yet, as with a flow saved only as a draft so far. Its check asks only the draft.                                                                                                                                                                                                                              |
| `check`       | The flow's latest check, in the shape below, or `null`.                                                                                                                                                                                                                                                                                     |

### Start a check

`POST /api/v1/flow-drafts/:chatflowId/check` with `{ "questions": ["…"], "includeRiskySteps": false }`. The questions can be any text: the suggested ones, a subset, or your own. Repeats are dropped. Answers 202 with the check, `status` `running`. The runs happen in the background; read progress with the next route.

| Status | When                                                                                                                                                                                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `questions` is not a list of text, is empty, has more than 10 questions or a question longer than 2,000 characters, or `includeRiskySteps` is not `true` or `false`.                                                                                                                     |
| 409    | Drafts are off, the flow is not a chatflow or an agentflow, an agentflow does not start with a chat message, there are no unpublished changes, a check is already running for this flow, or the flow has risky steps and `includeRiskySteps` is not `true`. The message names the steps. |
| 429    | `Too many checks are running on this server. Try again in a minute.`                                                                                                                                                                                                                     |

### Read a check

`GET /api/v1/flow-drafts/:chatflowId/check/:checkId`. 404 `That check was not found. Run it again.` when the id is not this flow's latest check, or it has expired.

```json
{
    "id": "<check id>",
    "status": "done",
    "stopReason": null,
    "error": null,
    "startedDate": "2026-10-08T17:10:00.000Z",
    "finishedDate": "2026-10-08T17:10:05.000Z",
    "total": 1,
    "completed": 1,
    "draftChanged": false,
    "includeRiskySteps": false,
    "limits": { "maxQuestions": 10, "maxQuestionChars": 2000, "maxTokens": 100000, "maxSeconds": 180 },
    "liveEmpty": false,
    "cases": [
        {
            "question": "Do you have gluten-free bread today?",
            "live": { "text": "Yes, we bake it on Tuesdays.", "error": null, "tokens": 44, "ms": 657 },
            "draft": { "text": "Yes, every day.", "error": null, "tokens": 45, "ms": 525 },
            "same": false
        }
    ],
    "summary": {
        "ran": 1,
        "same": 0,
        "changed": 1,
        "errors": 0,
        "liveTokens": 44,
        "draftTokens": 45,
        "liveMedianMs": 657,
        "draftMedianMs": 525
    }
}
```

| Field          | Meaning                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`       | `running`, `done`, `stopped` (a limit or Stop ended it early) or `failed` (it could not run; `error` says so).                                                                                                          |
| `stopReason`   | `tokens`, `time` or `stopped`, when `status` is `stopped`. Otherwise `null`.                                                                                                                                            |
| `completed`    | Questions both sides have answered, out of `total`. With `liveEmpty`, questions the draft has answered.                                                                                                                 |
| `liveEmpty`    | `true` when Live had no cards when the check started. Then only the draft runs: `live` stays `null`, `same` stays `null`, and `summary` counts the draft's answers, with Live tokens 0 and no Live time.                |
| `draftChanged` | `true` when the draft was saved, published or discarded after the check started, so its answers may be out of date.                                                                                                     |
| `cases`        | One per question. `live` and `draft` are `null` until that side has run. `text` is the answer, cut at 4,000 characters, or `null` with an `error` when the run failed. `tokens` is `null` when the model reported none. |
| `same`         | `true` when both answers match, ignoring case and spacing. `false` when they differ or either side failed. `null` until both have run. Answers from a model can vary between runs even with no change.                  |
| `summary`      | Counts over the questions both sides answered: how many `same`, `changed` and with `errors`, total tokens per side, and the middle (median) time per side in milliseconds.                                              |

### Stop a check

`DELETE /api/v1/flow-drafts/:chatflowId/check/:checkId`. Stops the run in progress and keeps the questions already answered. Returns the check, which reads `stopped` once the run has ended. Stopping a finished check changes nothing.
