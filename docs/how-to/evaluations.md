# Evaluations

Datasets, evaluators, and evaluations are how you check a chatflow or an agentflow against example questions. Open them from the sidebar: **Datasets**, **Evaluators**, and **Evaluations**.

Publishing a flow and running an evaluation are separate. The evaluation pages do not start the check in the Publish dialog. A saved dataset can, and the evaluators you tick there score both answers. See [Check a dataset before you publish](#check-a-dataset-before-you-publish).

The organization owner can open all three. Anyone else needs the matching permission on their role: `datasets:view`, `evaluators:view`, or `evaluations:view`, and the create, update, delete, or run permission for the button they use.

## Datasets

A dataset is a named list of rows. Each row is an input and the output you expect.

1. Select **Datasets**.
2. Select **Add**. Give it a name and a description.
3. Open the dataset to add rows, edit them, change their order, or delete them. A row saved from a chat answer says where it came from. See [Add a real answer to a test set](#add-a-real-answer-to-a-test-set).

A CSV upload uses the first two columns as the input and the expected output. The first row can be a header.

## Evaluators

An evaluator is a check you can attach to a run.

-   **Text.** The answer contains, or starts with, a value you type.
-   **Numeric.** A metric compared with an operator, such as greater than a number.
-   **JSON.** The answer matches a JSON check.
-   **Model.** A prompt and an output shape, graded by a model.

Select **Evaluators** to create one, change it, or delete it. Creating an evaluation does not require an evaluator. You can run with none and add checks later.

## Evaluations

An evaluation runs one dataset against one or more chatflows or agentflows and stores what came back.

1. Select **Evaluations**.
2. Select **Add** and name the run.
3. Choose the dataset and the chatflows or agentflows. Custom assistants are not listed: a run calls the prediction route, which only runs chatflows and agentflows.
4. Optionally choose evaluators. A model evaluator also needs a credential.
5. Start the run. The list shows it as pending, then completed or error. Open a row to see each example.

**Run again** stores another version under the same name. It uses the same checks as a new run: a deleted flow, a flow from another team, or a flow this role cannot view is rejected and no new version is saved. A missing evaluation, or one from another team, is rejected the same way. Delete removes a run, or every version of that name.

## Check a dataset before you publish

On a chatflow, an agentflow that starts with a chat message, or a harness, the Publish dialog can ask a dataset instead of recent questions, and score each answer with the evaluators you select. A pipeline has no question check.

1. Select **Publish**. Under **Check recent questions**, set **Questions from** to **A dataset** and choose the dataset. **Questions from** is hidden when your role cannot view datasets.
2. Tick the evaluators to score with. That list is hidden when your role cannot view evaluators.
3. Select **Run check**.

Each row runs in the order saved on the dataset. The row input is the question and the row output is the expected answer, shown under the question. At most 100 rows are asked, and a row with an empty question or a question longer than 2,000 characters is skipped. Each side shows Pass, Fail or Error for every evaluator, and a pass rate. An answer that failed to run scores Error. A model grade that is only a number stays Error, because this check does not turn that number into Pass or Fail. A yes or no in the grade is Pass or Fail. A numeric evaluator uses the tokens and the time the check already records. A numeric check of prompt tokens, completion tokens, or a token total the run did not report scores Error, not Fail. A model evaluator uses the model credential saved on the flow, and only a credential this workspace can use. If that model cannot be started, the text, JSON and numeric scores stay, and each model score is Error. A provider that reports grading usage nowhere does not move the token cap, so that check is bounded only by the time limit. The pass rate does not block Publish. A check with no evaluators still shows the expected answer and compares the two answers as before.

The same rules as the recent-question check apply: nothing is written down, results stay in memory for 30 minutes, and a flow that starts with a form, a webhook or a schedule cannot use a dataset. The steps are in [Check recent questions before you publish](./versioning.md#check-recent-questions-before-you-publish). The request fields are in [Start a check](../reference/drafts-api.md#start-a-check).

## Add a real answer to a test set

There is a path from an answer someone already received back to a dataset. On an answer in the message viewer, **Add to test set** saves that question and answer as one row.

1. Open the message viewer for the flow.
2. On an answer, select **Add to test set**. The button is shown when the role can create a dataset, or when it can update a dataset and view datasets. A role that can only update datasets does not see it, because the list of datasets needs `datasets:view`.
3. Read the question. It is the message immediately before that answer in the same chat session. A question from another session, or another memory in that session, is not used. A second answer in a row has no question, and saving it is refused. The expected answer starts as the real answer. Edit it when the check should expect something else.
4. Choose a dataset when the role can view datasets, or select **New dataset**, name it, and create it. Creating a dataset needs `datasets:create`. A role that can create a dataset but cannot view datasets still gets **New dataset**, and does not get the existing list. If the list cannot be loaded, the dialog shows the error.
5. The dialog warns that a real message can contain personal data. Check the question and the expected answer, then save.

The row records where it came from: source `chat_message`, the message id, the flow id, and the date of the answer. Saving that same answer into the same dataset again returns the row already stored and does not add a second one. The flow and the dataset both have to belong to the current team. A flow or a dataset from another team is not found. The role also needs permission to view that kind of flow: `chatflows:view` for a chatflow, a harness, or a pipeline, `agentflows:view` for an agentflow, and `assistants:view` for an assistant.

That dataset can be the one the Publish dialog checks. See [Check a dataset before you publish](#check-a-dataset-before-you-publish).

## What a run calls

A run calls each selected chatflow or agentflow on this server, the same way a prediction does. The flow has to be one this team can view. An unknown flow, a flow from another team, a custom assistant, or a run with no chatflow or agentflow is rejected and no evaluation is saved. You do not set a separate address for that call. A flow that requires an API key cannot be replayed from this page, because the key is stored as a hash and the run cannot recover it. A flow with no key can be run. A chatflow or agentflow can use a model credential this team owns or one shared into the team. Loading earlier messages and clearing a session follow that same rule. A model evaluator uses a credential saved in the same team.
