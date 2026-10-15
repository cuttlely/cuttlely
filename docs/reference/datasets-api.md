# Datasets API

A dataset is a named list of question-and-answer rows in one workspace. The Publish check can ask those rows and, when the flow requires it, block Publish until that dataset passes. Creating a dataset by hand, from a CSV, from one answer, or from rated answers is in [Evaluations](../how-to/evaluations.md) and [Turn real answers into tests](../how-to/tests-from-answers.md).

This page is `POST /api/v1/datasets/from-questions`, the route behind **Save as dataset** in the Publish dialog's question picker.

## Save picked questions

`POST /api/v1/datasets/from-questions`

```json
{
    "flowId": "11111111-1111-4111-8111-111111111111",
    "questionIds": ["chat:22222222-2222-4222-8222-222222222222"],
    "name": "Saturday questions"
}
```

| Field         | Meaning                                                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flowId`      | A chatflow or a chat-started agentflow in the caller's workspace.                                                                                                                                                                                   |
| `questionIds` | 1 to the question cap (`CUTTLELY_CHECK_COUNT_MAX`, 100 by default) unique ids, in the order the rows should be stored. Each id is `chat:` and the stored user-message id, the same id [Question history](./drafts-api.md#question-history) returns. |
| `name`        | The dataset name. A blank name is refused. Leading and trailing spaces are removed.                                                                                                                                                                 |

The caller needs `datasets:create`. `datasets:update` is not enough. The caller also needs the view key for the flow, the same check as question history: `chatflows:view` for a chatflow, a harness, or a pipeline, `agentflows:view` for an agentflow, and `assistants:view` for an assistant. A missing key is 403 and nothing is stored. The organization owner is allowed.

The flow has to belong to the caller's workspace. A missing flow, or a flow in another workspace, is 404 and nothing is stored. A question id from another flow, or from another workspace, is `not-found`. The response does not include the question text or the id.

Each saved row uses the question as `input` and an empty `output`. `needsExpectedAnswer` is true. Fill in the expected answer on the dataset before a model evaluator can score the row, and before this dataset can be a passing test set. A hand-picked check never unblocks Publish. Only a dataset check can.

A harness, and an agentflow that starts with a form, a webhook, or a schedule, is 409. Question history for that flow is not on this route. An assistant is 409 with `The check works on chatflows and agentflows.`

A question sent with a file, or a question that is empty or longer than 2,000 characters, is refused. The body is the same shape as a refused `questionIds` check:

```json
{
    "code": "CHECK_BAD_QUESTION_IDS",
    "message": "Position 1 was sent with a file.",
    "badCount": 1,
    "errors": [{ "index": 0, "reason": "files" }]
}
```

`reason` is `invalid`, `not-found`, `files`, or `length`. The message names the position. It does not repeat the id or the question.

| Status | When                                                                                                                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | The dataset and its rows. `rows` follows `questionIds`. Each `output` is `""` and `needsExpectedAnswer` is true. `Cache-Control` is `no-store`.                                                                                                       |
| 400    | The name is blank (`Dataset name is required`), `flowId` is missing, or `questionIds` is not a list of 1 to the cap unique ids (`CHECK_QUESTION_IDS_SHAPE`, `CHECK_QUESTION_IDS_RANGE`, `CHECK_QUESTION_IDS_DUPLICATE`, or `CHECK_BAD_QUESTION_IDS`). |
| 403    | The caller cannot create a dataset, or cannot view this flow. Nothing is stored.                                                                                                                                                                      |
| 404    | The flow is missing or is in another workspace. Nothing is stored.                                                                                                                                                                                    |
| 409    | This flow does not list chat questions on the history route. Nothing is stored.                                                                                                                                                                       |

A successful body looks like this:

```json
{
    "id": "33333333-3333-4333-8333-333333333333",
    "name": "Saturday questions",
    "description": "",
    "workspaceId": "44444444-4444-4444-8444-444444444444",
    "rows": [
        {
            "input": "Do you have rye loaves today?",
            "output": "",
            "sequenceNo": 0,
            "needsExpectedAnswer": true,
            "sourceType": "chat_question",
            "sourceMessageId": "22222222-2222-4222-8222-222222222222",
            "sourceFlowId": "11111111-1111-4111-8111-111111111111"
        }
    ]
}
```

The other dataset routes (`/api/v1/datasets`, `/api/v1/datasets/set`, `/api/v1/datasets/rows`, and the two routes that copy an answer) are listed with the permission that checks them in [Roles and permissions](../how-to/roles-and-permissions.md).
