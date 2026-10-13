# Evaluations

Datasets, evaluators, and evaluations are how you check a chatflow or an agentflow against example questions. Open them from the sidebar: **Datasets**, **Evaluators**, and **Evaluations**.

Publishing a flow and running an evaluation are separate. The evaluation pages do not start the check in the Publish dialog. A saved dataset can, and the evaluators you tick there score both answers. See [Check a dataset before you publish](#check-a-dataset-before-you-publish).

The organization owner can open all three. Anyone else needs the matching permission on their role: `datasets:view`, `evaluators:view`, or `evaluations:view`, and the create, update, delete, or run permission for the button they use.

## Datasets

A dataset is a named list of rows. Each row is an input and the output you expect.

1. Select **Datasets**.
2. Select **Add**. Give it a name and a description.
3. Open the dataset to add rows, edit them, change their order, or delete them.

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

Each row runs in the order saved on the dataset. The row input is the question and the row output is the expected answer, shown under the question. At most 100 rows are asked, and a row with an empty question or a question longer than 2,000 characters is skipped. Each side shows Pass, Fail or Error for every evaluator, and a pass rate. An answer that failed to run scores Error. A model grade that is only a number stays Error, because this check does not turn that number into Pass or Fail. A yes or no in the grade is Pass or Fail. A numeric evaluator uses the tokens and the time the check already records. A numeric check of prompt tokens, completion tokens, or a token total the run did not report scores Error, not Fail. A model evaluator uses the model credential saved on the flow, and only a credential this workspace can use. If that model cannot be started, the text, JSON and numeric scores stay, and each model score is Error. A provider that reports grading usage nowhere does not move the token cap, so that check is bounded only by the time limit. A dataset check reports passed or failed for the draft against a pass mark. The mark is 100 unless the request sends `threshold`, a whole number from 0 to 100. Errored scores count as not passed. A check that is not using a dataset has no verdict. The pass rate does not block Publish unless the flow requires a passing test set. A check with no evaluators still shows the expected answer and compares the two answers as before, and its verdict is failed because nothing was scored.

The answers stay in memory for 30 minutes and are not written down. When the flow requires a passing test set and this check used that dataset, those evaluators, and that pass mark, the server stores the verdict (pass rate, counts, and time) and a hash of the rows it asked and of each evaluator's type and settings. It does not store the rows or the answers. If that write fails, the check ends `failed` with the error `The test set result could not be saved.` The stored result is cleared, and Publish is refused. If that clear also fails, the check still ends `failed` with that same error, the older pass stays stored, and Publish is refused with `Publish needs a passing test set at <threshold>%. The test set result could not be saved.` because that pass is not from this check. That refusal lasts for this server process. A restart drops it, and the older pass can publish again if it still matches the draft and the test set. Editing a row, adding a row the check would ask, changing an evaluator's check, deleting the dataset or an evaluator, or editing the flow's answer post-processing makes that pass out of date. A flow that starts with a form, a webhook or a schedule cannot use a dataset. The steps are in [Check recent questions before you publish](./versioning.md#check-recent-questions-before-you-publish) and [Require a passing test set before you publish](./versioning.md#require-a-passing-test-set-before-you-publish). The request fields are in [Start a check](../reference/drafts-api.md#start-a-check).

## What a run calls

A run calls each selected chatflow or agentflow on this server, the same way a prediction does. The flow has to be one this team can view. An unknown flow, a flow from another team, a custom assistant, or a run with no chatflow or agentflow is rejected and no evaluation is saved. You do not set a separate address for that call. A flow that requires an API key cannot be replayed from this page, because the key is stored as a hash and the run cannot recover it. A flow with no key can be run. A chatflow or agentflow can use a model credential this team owns or one shared into the team. Loading earlier messages and clearing a session follow that same rule. A model evaluator uses a credential saved in the same team.
