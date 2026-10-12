# Evaluations

Datasets, evaluators, and evaluations are how you check a chatflow or an agentflow against example questions. Open them from the sidebar: **Datasets**, **Evaluators**, and **Evaluations**.

These pages do not run the check that happens before Publish. Publishing a flow and running an evaluation are separate.

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

**Run again** stores another version under the same name. It uses the same checks as a new run: a deleted flow, a flow from another team, or a flow this role cannot view is rejected and no new version is saved. Delete removes a run, or every version of that name.

A run calls each selected chatflow or agentflow on this server, the same way a prediction does. The flow has to be one this team can view. An unknown flow, a flow from another team, or a custom assistant is rejected and no evaluation is saved. You do not set a separate address for that call. A flow that requires an API key cannot be replayed from this page, because the key is stored as a hash and the run cannot recover it. A flow with no key can be run. A chatflow or agentflow can use a model credential this team owns or one shared into the team. A model evaluator uses a credential saved in the same team.
