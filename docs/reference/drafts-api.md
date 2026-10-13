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

| Limit          | Value                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Questions      | `count` from 1 to 100, 4 in the dialog. A list sent without `count` is still at most 10. Each question is at most 2,000 characters. |
| Tokens         | `CUTTLELY_CHECK_MAX_TOKENS`, 100,000 by default. See [History settings](./versioning-settings.md#publish-check-limits).             |
| Time           | `CUTTLELY_CHECK_MAX_SECONDS`, 180 by default, and at most 60 seconds for any one run.                                               |
| At a time      | `CUTTLELY_CHECK_CONCURRENCY`, 2 by default, from 1 to 8. Live and the draft for one question still run one after the other.         |
| Checks at once | One per flow, three on the server.                                                                                                  |

When a token or time limit is reached, the check stops starting new questions. Questions already started finish, so the token total can go a little past the cap. A question counts only when both Live and the draft answered it. One question failing does not stop the others: that row has an error, and the rest continue. **Stop** keeps the questions that already finished.

Which questions run when you send `count`: the most recent ones people asked this flow, newest first. Message time decides the order, and the message id breaks a tie, newest id first. The same wording counts once. Capitals and extra spaces are ignored, and the newest copy is kept. The same count on the same history returns the same questions. It is not a random sample. Questions sent with files are left out. The server reads the newest messages, 200 at a time, until it has 100 different questions or it has read 2,000 messages or the history ends. If it stops at 2,000 messages before it has 100 different questions, `pastTruncated` is true: there may be older questions it did not reach. If fewer different questions exist than `count`, it compares every one it found.

What a check never does:

-   It never saves Live or the draft. The canvases run in memory.
-   It writes no chat messages, so replays do not show up in chat history, the flow's usage counts or its memory. Each run starts with empty memory.
-   It calls none of the flow's tracing or analytics providers, and adds no follow-up prompts or speech.
-   On an agentflow it writes no execution record. The replay does not resume a previous run and does not load one for state. It ignores any human input sent with the question, and stores no image or file that a model step generates. Choosing the inputs to replay does read execution records (up to 2,000), newest update first with the id breaking a tie.
-   It writes the questions, answers and canvases to no log. Results stay in the server's memory for 30 minutes and are lost on restart.

The check works on chatflows and agentflows with unpublished changes. A chat-started agentflow must start with a chat message (Start input type **Chat Input**) in Live and in the draft, and the check replays questions. An agentflow whose start is a form, a webhook or a schedule is checked too, when Live and the draft use that same start: the check replays recorded inputs from recent executions instead of questions. A canvas with no Start node does not block the other side, so a flow that was never published can still be checked. Mixed starts, or a Start node with no input type, are refused. Legacy multi-agent and sequential-agent flows are not checked; that refusal stays `The check works on chatflows and agentflows.` On an agentflow, the tokens counted are the ones each model step reports (LLM and Agent steps); a Condition Agent step reports none.

For a form, webhook or schedule start, `count` selects the newest distinct recorded inputs, up to 100, from this flow's execution records (newest update first). A form input is the submitted form. A real run stores it as lines of `name: value` on the Start step (for example `loaf: rye` then `count: 2`). Each line is split on the first `: `, so a value may contain a colon, and the value comes back as a string. A schedule that sends a form is stored and read the same way. A form already stored as an object is used as stored. A webhook input is the body, the query and the headers that change what the flow does. A schedule input is the form that was sent, read the same way as a form start, or the trigger text when the schedule did not send a form, including the single-space text used when the schedule sends no input. Webhook headers that change on every delivery do not count as a different input and are left out of the stored payload: `date`, `user-agent`, `content-length`, `forwarded`, `x-forwarded-*`, and any header whose name contains `request-id`, `requestid`, `trace`, `signature` or `timestamp`. Key order is ignored. The server reads executions 50 at a time, newest `updatedDate` first and `id` descending when the time ties, until it has 100 different inputs or it has read 2,000 executions or the history ends. `pastTruncated` is true when it stops at 2,000 before it has 100. There are no starter questions on this path, and extra `questions` sent with `count` are not added. When `count` is sent and there are no executions to replay, the response is 400 `No past runs to replay yet. Run this flow once, then check again.` That is not a refusal: the setup still returns `unavailable: null` and `replayInputs: true`. Each stored question is canonical JSON (`{"form":...}`, `{"webhook":...}` or `{"question":...}`). Header and query names that are `authorization` or `cookie`, or that contain `token`, `secret`, `key`, `password` or `signature`, have the value `[REDACTED]` in that JSON, in `preview`, and in the check cases, including when the name is nested (`user[password]` stored as `{ "user": { "password" } }`, or the same shape inside a header). Arrays are walked the same way. The raw value is not returned. `preview` is the short line the dialog shows. For a webhook it is the body. When another kept row has the same body, `preview` also includes the query or the differing header names (sensitive values still `[REDACTED]`). The replay sends the masked input with the same no-persistence behavior as a chat question: a form without a question, a webhook as a webhook call, a schedule as a scheduled call. It writes no chat message and no execution record. A risky step is not run unless `includeRiskySteps` is true, so the replay makes no outbound call from that step.

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
    "pastCount": 1,
    "pastTruncated": false,
    "riskySteps": [],
    "limits": {
        "maxQuestions": 100,
        "defaultQuestions": 4,
        "maxQuestionChars": 2000,
        "maxTokens": 100000,
        "maxSeconds": 180,
        "concurrency": 2
    },
    "liveEmpty": false,
    "replayInputs": false,
    "check": null
}
```

| Field           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unavailable`   | Why a check can't run now, or `null`. `code` is `off` (drafts are off), `type` (not a chatflow or an agentflow; legacy multi-agent flows stay here, with `The check works on chatflows and agentflows.`), `no-draft` (nothing to check) or `start` (the two versions do not start the same way, or there is no Start input to replay), with a `message` to show. A form, webhook or schedule start with no past runs is not `unavailable`.                                   |
| `questions`     | Up to 100 recent questions people asked this flow, through the API, embeds and shared links or the canvas test chat, newest first and without repeats. Questions sent with files are left out. Then up to 10 of the flow's starter questions that nobody asked yet, marked `"starter": true` with an empty `date`, so a new flow has questions to check. When `replayInputs` is true, these are recorded inputs instead: canonical JSON, newest first, with no starter rows. |
| `replayInputs`  | `true` when the check replays recorded form, webhook or schedule inputs. `false` for chatflows and chat-started agentflows.                                                                                                                                                                                                                                                                                                                                                  |
| `pastCount`     | How many of `questions` are past questions, not starter questions. At most 100. When `replayInputs` is true, how many distinct recorded inputs were found.                                                                                                                                                                                                                                                                                                                   |
| `pastTruncated` | `true` when the scan stopped at 2,000 messages (or 2,000 executions, for a form, webhook or schedule start) before it found 100 different past questions or inputs.                                                                                                                                                                                                                                                                                                          |
| `riskySteps`    | The steps that act for real, as `{ "id", "label" }`. Empty when there are none.                                                                                                                                                                                                                                                                                                                                                                                              |
| `limits`        | The limits above, as this server has them. `maxQuestions` is 100. `defaultQuestions` is 4, which the dialog selects first. `concurrency` is how many questions run at once.                                                                                                                                                                                                                                                                                                  |
| `liveEmpty`     | `true` when Live has no cards yet, as with a flow saved only as a draft so far. Its check asks only the draft.                                                                                                                                                                                                                                                                                                                                                               |
| `check`         | The flow's latest check, in the shape below, or `null`.                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Start a check

`POST /api/v1/flow-drafts/:chatflowId/check` with `{ "count": 4, "questions": ["…"], "includeRiskySteps": false }`.

`count` is optional. When it is sent, it must be a whole number. A number below 1 counts as 1, and above 100 as 100. The server then chooses that many past questions by the rule above. For a chatflow or a chat-started agentflow, `questions`, if also sent, are extra questions added after those, still within 100 altogether, with repeats dropped. For a form, webhook or schedule start, send `count` on its own. Sending `questions` as well is refused: the server does not add them and does not return 202. When `count` is omitted, the request is the older one: `questions` is required, at most 10, and the server runs that list. That default is unchanged. Answers 202 with the check, `status` `running`. The runs happen in the background, a few questions at a time; read progress with the next route. `completed` is how many questions both sides have answered, out of `total`.

| Status | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `count` is not a whole number, `questions` is not a list of text, a question is empty or longer than 2,000 characters, the list is empty when `count` is omitted, the list has more than 10 questions when `count` is omitted (or more than 100 when `count` is sent for a chatflow or a chat-started agentflow), there are no past questions for `count` and no extra questions, there are no past runs to replay for a form, webhook or schedule start (`No past runs to replay yet. Run this flow once, then check again.`), a form, webhook or schedule start sends `questions` together with `count` (`Questions are not used for a form, webhook or schedule start. Send count on its own.`), or `includeRiskySteps` is not `true` or `false`. |
| 409    | Drafts are off, the flow is not a chatflow or an agentflow (legacy multi-agent flows included), the two versions do not start the same way, there are no unpublished changes, a check is already running for this flow, or the flow has risky steps and `includeRiskySteps` is not `true`. The message names the steps. The risky-step rule is the same for a chat start and for a form, webhook or schedule start.                                                                                                                                                                                                                                                                                                                                  |
| 429    | `Too many checks are running on this server. Try again in a minute.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

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
    "limits": {
        "maxQuestions": 100,
        "defaultQuestions": 4,
        "maxQuestionChars": 2000,
        "maxTokens": 100000,
        "maxSeconds": 180,
        "concurrency": 2
    },
    "liveEmpty": false,
    "selection": { "requested": 4, "available": 1, "used": 1, "truncated": false },
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

| Field          | Meaning                                                                                                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`       | `running`, `done`, `stopped` (a limit or Stop ended it early) or `failed` (it could not run; `error` says so).                                                                                                                                                                                                                               |
| `stopReason`   | `tokens`, `time` or `stopped`, when `status` is `stopped`. Otherwise `null`.                                                                                                                                                                                                                                                                 |
| `completed`    | Questions both sides have answered, out of `total`. With `liveEmpty`, questions the draft has answered.                                                                                                                                                                                                                                      |
| `liveEmpty`    | `true` when Live had no cards when the check started. Then only the draft runs: `live` stays `null`, `same` stays `null`, and `summary` counts the draft's answers, with Live tokens 0 and no Live time.                                                                                                                                     |
| `draftChanged` | `true` when the draft was saved, published or discarded after the check started, so its answers may be out of date.                                                                                                                                                                                                                          |
| `cases`        | One per question. `live` and `draft` are `null` until that side has run. `text` is the answer, cut at 4,000 characters, or `null` with an `error` when the run failed. `tokens` is `null` when the model reported none.                                                                                                                      |
| `same`         | `true` when both answers match, ignoring case and spacing. `false` when they differ or either side failed. `null` until both have run. Answers from a model can vary between runs even with no change.                                                                                                                                       |
| `selection`    | Set when the request sent `count`. `requested` is the count after clamping, `available` is how many distinct past questions were found (at most 100), `used` is how many of those were included, and `truncated` means the scan stopped early. `null` when the request sent a question list and no count.                                    |
| `summary`      | Counts over the questions both sides answered: how many `same`, `changed` and with `errors`, total tokens per side, and the middle (median) time per side in milliseconds. The dialog also shows the token and time difference between the sides. There is no better or worse score, and no price, because the check does not record a cost. |

### Stop a check

`DELETE /api/v1/flow-drafts/:chatflowId/check/:checkId`. Stops the run in progress and keeps the questions already answered. Returns the check, which reads `stopped` once the run has ended. Stopping a finished check changes nothing.
