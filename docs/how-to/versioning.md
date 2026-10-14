# Version history

Cuttlely keeps every saved version of a flow. You can see what changed in each save, compare an old version with the flow as it is now, see who made each change, and put an old version back.

History covers every canvas: chatflows, agentflows, harnesses, and ETL pipelines. It is on by default. It needs no setup and no network. Versions are kept in a Git repo on the server, next to the rest of Cuttlely's data. The owner can also [keep a copy in GitHub](#keep-a-copy-in-github), and use it to [move a flow from Dev to Prod](#move-a-flow-from-dev-to-prod). Credentials are kept by name only, and password and other known secret fields are never written to history. Secret-looking text you type into a prompt or another text field, such as an API key or a Bearer token, is hidden from history. Keep keys in credentials anyway.

Install first: [Docker](./docker.md), [From source](./from-source.md), or [Render](./render.md). What a harness is: [Harnesses](./harnesses.md). Pipelines: [ETL](./etl.md). The routes, settings, and file format are in the reference pages: [History API](../reference/versioning-api.md), [Drafts API](../reference/drafts-api.md), [History settings](../reference/versioning-settings.md), and [Version files](../reference/version-files.md).

## The lifecycle at a glance

Each step links to its section below.

1. **Edit a draft.** The canvas saves to a draft, and Live keeps serving until you publish. See [Drafts and Publish](#drafts-and-publish).
2. **Check before you publish.** A chatflow and a harness replay recent questions on Live and on the draft. An agentflow replays recent questions, or the recorded inputs of a form, webhook, or schedule start. A pipeline lists what changed and does not replay. A dataset, the scores, and a Publish that waits for a passing test set are in [Evaluations](./evaluations.md). To build that set from rated answers, see [Turn real answers into tests](./tests-from-answers.md). See [Which canvases get a check](#which-canvases-get-a-check) and [Check recent questions before you publish](#check-recent-questions-before-you-publish). To run that check from continuous integration, see [Fail a build when answers change](./ci-gate.md).
3. **Publish.** Your draft goes Live, and history marks the version **Published**. See [Drafts and Publish](#drafts-and-publish).
4. **Look back.** Every version says what changed and who changed it. See [Open version history](#open-version-history), [See what changed](#see-what-changed), [Compare with now](#compare-with-now) and [Who changed it](#who-changed-it).
5. **Undo.** Open an old version as your draft, or roll Live back in one step. See [Restore a version](#restore-a-version).
6. **Keep a copy in GitHub (optional).** Any time in **Version History**, once you have flows worth keeping. See [Keep a copy in GitHub](#keep-a-copy-in-github).
7. **Move a flow from Dev to Prod (optional).** Prod reviews, checks and promotes what Dev published, with its own credentials. See [Move a flow from Dev to Prod](#move-a-flow-from-dev-to-prod).

## Open version history

Open a saved flow. Under its name, the canvas header says who saved it last, for example `Last edited by Rosa Diaz, 5 minutes ago`. Hold the pointer over that line for the exact time.

![Chatflow canvas for Bakery helper. Next to the flow name is a green Live chip. Under the name the header reads Last edited by Rosa Diaz, just now. The Version history button is the first icon at the top right.](../images/versioning/canvas-last-edited.png)

Select **Version history**, the clock icon at the top right of the canvas. The panel lists the flow's versions, newest first. **Live** marks the version people are served now, and **Published** marks each version that was put Live. On a flow with drafts off or **Publish instantly** on, **Current** marks the version the flow is on now.

![The Version history panel on the Bakery helper canvas. Four versions, newest first: Changed System Message on Conversation Chain, marked Live; Moved nodes; Changed credential, Temperature on ChatOpenAI, edited by Cuttlely (API key or system); and Created Bakery helper. Each row says who edited it, when, and its short version id, and has a Roll Back Live To This Version button.](../images/versioning/history-drawer.png)

Each row has:

-   A name that says what changed, written by Cuttlely from the change itself: `Changed System Message on Conversation Chain`, `Moved nodes`, `Changed credential, Temperature on ChatOpenAI`, `Created Bakery helper`. Field names are the labels you see on the node.
-   **Edited by** and the person who saved it.
-   What happened (`Created`, `Saved`, `Restored`, `Published`, `Rolled back`, `Promoted from` the previous environment, or `Deleted`), the time, and a short version id. The secondary line uses that same environment name. On the saved Dev and Prod pair it is Dev.

A save that changes nothing adds no version. Unsaved changes on the canvas are not in history. The panel says so while the canvas has unsaved changes: `You have unsaved changes. They show up here after you save.`

The history button shows only on a flow that has been saved, and only when history is on for the server.

## See what changed

Select a version in the panel. It opens as a read-only canvas at `/versions/:flowId/:versionId`. You can pan and zoom. You cannot edit it.

**Changes In This Version** is selected first. The **What changed** box lists what this save changed compared with the version before it. On the canvas, an added node has a green outline and a changed node has an orange one. A field change names the field, such as `Changed Conversation Chain: system message prompt`. A moved node is listed as moved, and a change in connections is listed as `Rewired connections`.

![A read-only version of Bakery helper with Changes In This Version selected. The What changed box lists Changed Conversation Chain: system message prompt. The Conversation Chain node has an orange outline.](../images/versioning/version-changes.png)

For the first version of a flow, the box says `This is the first saved version.`

**Back to editing**, the arrow at the top left, returns to the canvas.

## Compare with now

Select **Compare With Now**. The box is titled **Different from now** and lists how this version differs from the flow as it is saved now. A version that matches says `Same as now.`

![An older version of Bakery helper with Compare With Now selected. The box, titled Different from now, lists Conversation Chain differs from now: system message prompt, and In a different place now: Buffer Memory, Conversation Chain.](../images/versioning/version-compare-with-now.png)

That is what a restore would bring back. Unsaved changes on the canvas are not part of the comparison.

On a narrow window the buttons move under the title and are labelled **This Version**, **Now**, and **Restore**.

## Restore a version

Restoring needs permission to edit that kind of flow. A user who cannot edit flows does not see the button. Nothing in history is erased either way.

### Open a version as your draft

On a chatflow, agentflow, harness, or pipeline with drafts on, which is the default, the button on the version page is **Open as draft**. The version goes on the canvas as your draft, and Live does not change until you publish.

1. Open the version.
2. Select **Open as draft**.
3. Read the dialog and select **Open as draft**.

![The Open this version as your draft? dialog over the version page of Bakery helper. Open as draft is the button at the top right of the page. The dialog reads: This opens on the canvas as your draft. Live is unchanged until you publish. Nothing in history is erased. The buttons are Cancel and Open as draft.](../images/versioning/open-as-draft-confirm.png)

The canvas opens with that version as your draft, and the header says **Draft, not live yet**. The test chat runs that draft, including the harness canvas chat and **Try it**. Select **Publish** to put it Live, or **Discard draft** to go back to Live. History records it when you publish, as `Published: <what changed>`.

![The Bakery helper canvas after Open as draft. The header shows the yellow label Draft, not live yet, Saved just now, and a Publish button. A green message at the bottom reads Opened this version as your draft. Live is unchanged until you publish.](../images/versioning/after-open-as-draft.png)

| Message                                                                                   | Meaning                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Opened this version as your draft. Live is unchanged until you publish.`                 | The version is your draft. Live is as it was.                                  |
| `Opened this version as your draft. … Add these credentials before you publish: <names>.` | Some nodes have no credential. See [below](#missing-or-duplicate-credentials). |
| `This version is already live. There is nothing new to publish.`                          | The version matches Live, so there is no draft.                                |

To change Live at once instead, open **Version history** and select **Roll back Live to this version** on that version. See [Drafts and Publish](#drafts-and-publish).

### Restore straight to Live

Flows with **Publish instantly** on, and every flow on a server with drafts off, restore straight to Live. The button is **Restore This Version**. A harness or a pipeline with drafts on uses **Open as draft** instead. **Roll back Live** is what changes the published harness and the published pipeline.

1. Open the version.
2. Select **Restore This Version**.
3. Read the dialog and select **Restore**.

![The Restore this version? dialog over the version page of Bakery helper, with Compare With Now selected and Restore This Version at the top right. It reads: The flow goes back to this version and is live right away. Nothing in history is erased: the restore is saved as a new version, so you can undo it the same way. The buttons are Cancel and Restore.](../images/versioning/restore-confirm.png)

The flow goes back to that version and is live right away. That includes the canvas, the flow's name, its type, and its category. The restore runs through the same save as the canvas. With drafts off, or with **Publish instantly** on, a harness restore updates the roster `POST /api/v1/harnesses/:name/runs` serves. A pipeline restore updates the version that scheduled runs, a run you start, and a full rebuild read.

The restore is saved as a new version named `Restored: <name of that version> (<version id>)`, edited by you. To undo a restore, open the version before it and restore that one.

![The Bakery helper canvas after a restore. The header has no draft label, because this flow has Publish instantly on. A green message at the bottom reads Restored. History has a new version, so you can undo this the same way.](../images/versioning/after-restore.png)

![Version history after the restore. Newest first, the rows fully in view are: Restored: Changed credential, Temperature on ChatOpenAI, marked Current, edited by Rosa Diaz, Restored just now; Changed System Message on Conversation Chain, edited by Rosa Diaz, Saved just now; Changed Temperature on ChatOpenAI, edited by Rosa Diaz, Saved just now; Changed System Message on Conversation Chain, edited by Rosa Diaz, Saved 1 minute ago; Moved nodes, edited by Rosa Diaz, Saved 1 minute ago; and Changed credential, Temperature on ChatOpenAI, edited by Cuttlely (API key or system), Saved 1 minute ago. A green message at the bottom reads Restored. History has a new version, so you can undo this the same way.](../images/versioning/history-after-restore.png)

The message after a restore says what happened:

| Message                                                                   | Meaning                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Restored. History has a new version, so you can undo this the same way.` | The flow is restored and the restore is in history.                       |
| `Restored. Add these credentials before running it: <names>.`             | The flow is restored. Some nodes have no credential. See below.           |
| `The flow already matches this version.`                                  | Nothing was saved, because the flow already matches.                      |
| `Restored, but history could not record it.`                              | The flow is restored, but history could not write it. The reason follows. |

## Who changed it

Every version records who saved it.

-   A change made while signed in is recorded with your display name.
-   A save through an API key, a pipeline created from a sample, or another system path is recorded as `Cuttlely (API key or system)`.

When more than one person has edited a flow, **Edited by** at the top of the panel filters the list to one person. **Everyone** shows the whole list.

![The Version history panel filtered to Cuttlely (API key or system). One version is left: Changed credential, Temperature on ChatOpenAI.](../images/versioning/history-filter-by-person.png)

Your email address is never written to history. Each version stores your display name and an address made from your user id, `<user id>@users.versions.local`. A display name that looks like an email address is stored as `User` and the first 8 characters of your user id.

After a save of the flow could not be added to history, the canvas header stops showing **Last edited by**, because the newest version may not be the latest edit. The warning in **Version history** and the missing header line can stay after later saves succeed. They clear when the server restarts.

## Missing or duplicate credentials

A version stores each credential by its name and type, such as `OpenAI main`, an OpenAI API credential. When you open or restore a version, Cuttlely selects the credential in your workspace with that name and type.

If no credential has that name and type, the **What changed** box warns you, for example `Not in this workspace: OpenAI trial. Add a credential with that name to use this version.` The restore dialog says those nodes come back with no credential selected. Restoring still works. Before you run the flow, add a credential with that name under **Credentials**, or select another credential on the node and save.

![A read-only version of Bakery helper. The ChatOpenAI node has no credential selected, and the What changed box says Not in this workspace: OpenAI trial. Add a credential with that name to use this version.](../images/versioning/version-missing-credential.png)

If several credentials in the workspace have that name and type, Cuttlely picks the one the flow uses now. If none of them is in use, it picks the oldest. The choice is the same every time. The **What changed** box and the restore dialog say which one was used, for example `2 credentials are named OpenAI main. This version uses the one the flow uses now.` To use a different one, select it on the node after the restore and save.

![A read-only version of Bakery helper. Below the list of changes, a blue note in the What changed box reads 2 credentials are named OpenAI main. This version uses the one the flow uses now.](../images/versioning/version-duplicate-credential-name.png)

## What is stored, and what is not

Each version stores the canvas:

-   Every node and its settings, with long text such as prompts and instructions in their own files.
-   The connections between nodes.
-   Node positions on the canvas.
-   The flow's name, type and category.
-   Each credential's name and type.

These are never stored:

-   Credential values are never stored. A credential is stored as its name and type only.
-   Password, file, and folder fields are not stored.
-   Known fields that hold a path on the server's disk, such as a folder to load files from, are not stored. A web address, such as a model's base URL, is kept.
-   A setting whose key looks secret (`Authorization`, `apiKey`, `password`, `token`, and similar) is stored as a marker. So is a value that looks like a key or token, such as `Bearer ...`, `sk-...`, or a database URL with a password, inside headers, model options, or other structured settings.

When you open or restore a version, those fields come from the flow as it is now: each node gets the values the node with the same id has now. A node that is not in the flow now comes back with those fields empty. Fill them in before you run it.

### Keys typed into text fields

Before a version is written, Cuttlely checks the text you typed into prompts, instructions, headers, and every other text setting for values that look like secrets. Each one is replaced with `[secret hidden]` in the stored version. Your flow keeps what you typed. Only history changes.

It hides:

-   `Bearer <token>`
-   OpenAI keys (`sk-`, including `sk-proj-`) and xAI keys (`xai-`)
-   Slack tokens (`xoxb-`, `xoxp-`, `xoxa-`)
-   GitHub tokens (`ghp_`, `github_pat_`, and the other `gh*_` tokens)
-   AWS access key ids (`AKIA`, `ASIA`)
-   Google API keys (`AIza`)
-   PEM private key blocks
-   The password in a web address, such as `https://user:password@example.com`
-   A long, random-looking value right after a word such as key, token, secret, or password, also inside a name such as `OPENAI_API_KEY=` or `DB_PASSWORD=`

Ordinary words, ids in a sentence, and web addresses without a password are kept. A key in another format, or a short one, may not be recognized, so keep keys in credentials.

**Version history** shows a note under that version, for example `1 secret-looking value was hidden from history`. The **What changed** box and the restore dialog name the node and the setting. A restored version keeps `[secret hidden]` there, and the restore message says, for example, `Replace [secret hidden] in Conversation Chain (System Message) before running it.` Move the key into a credential, select that credential on the node, remove the placeholder from the setting, and save. Typing the key back into the setting works for running the flow, but the next save hides it again, so the note stays on each new version until the key is in a credential or gone from the setting.

**Compare with now** does not show a hidden value as a change. **Restore** still puts `[secret hidden]` back when your flow has a real value in that setting now.

As a backstop, a save is not added to history if a file still holds text in a few common key formats, for example a key in the flow's name, which is not a text setting. The formats are an OpenAI (`sk-`) or xAI (`xai-`) key, a GitHub token, an AWS access key id, a Postgres URL with a password, or a private key. The save itself works. Version history shows why, for example `Not saved to history: secret-shaped text in flow.json (sk). Move it to a credential.` Remove the key and save again.

Chat history, uploaded files, runs, and the app database are not in version history.

## Drafts and Publish

Drafts are on by default. A chatflow, agentflow, harness, or pipeline canvas saves to a **Draft**. A legacy multi-agent canvas does too. An assistant has no canvas drafts. Once the flow exists, the next canvas save goes to the draft. The first Save creates the published flow, and every import does too. A chatflow made with Build with AI keeps that first save as a draft and leaves Live empty until you publish. The prediction API, embeds, shared links, schedules, webhooks, and `POST /api/v1/harnesses/:name/runs` keep running **Live** until you **Publish**. The canvas test chat runs the draft, so you try the version you are editing. On a harness that is the canvas chat and **Try it**. They use the same internal route as a chatflow test chat, and that try runs the draft roster: its specialists, tools, and models. External callers of `POST /api/v1/harnesses/:name/runs` stay on Live. A pipeline's scheduled runs, a run you start from the canvas, and a full rebuild keep using the published pipeline until you **Publish**. **Preview** is the canvas test of a pipeline: it runs the draft (the canvas you are looking at) and does not write to the store.

### Which canvases get a check

**Publish** always lists what changed, in the same words as version history. A replay check is extra, and only some kinds run one. A pipeline's dialog is that change list and does not replay.

| Canvas                                                       | Publish dialog                          | What is replayed                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chatflow                                                     | Replay check                            | Recent questions. There is no Start node. A dataset's rows can be the questions.                                                                                                                                                    |
| Agentflow, Input Type **Chat Input** (`chatInput`)           | Replay check                            | Recent questions. A dataset's rows can be the questions.                                                                                                                                                                            |
| Agentflow, Input Type **Form Input** (`formInput`)           | Replay check                            | Recorded form submissions, newest first. The box is **Check recent runs**. A dataset is refused. **Passing test set** is hidden while it is off, and turning it on is 400.                                                          |
| Agentflow, Input Type **Webhook Trigger** (`webhookTrigger`) | Replay check                            | Recorded webhook calls, newest first. The box is **Check recent runs**. A dataset is refused. **Passing test set** is hidden while it is off, and turning it on is 400.                                                             |
| Agentflow, Input Type **Schedule Input** (`scheduleInput`)   | Replay check                            | Recorded schedule inputs, newest first. A schedule that sent a form is read as a form. The box is **Check recent runs**. A dataset is refused. **Passing test set** is hidden while it is off, and turning it on is 400.            |
| Harness                                                      | Replay check                            | Recent questions: the full prompts from saved chats, not the short line on **Runs**. A canvas whose harness file belongs to another team gets no questions. Another team's harness is a 404. A dataset's rows can be the questions. |
| Pipeline                                                     | Change list only                        | Nothing. The dialog does not run the question check.                                                                                                                                                                                |
| Legacy multi-agent canvas                                    | The box stays, and the check is refused | Nothing. The message is `The check works on chatflows and agentflows.`                                                                                                                                                              |

Live and the draft must start the same way. On an agentflow, a canvas with no Start node does not block the other side, so a flow that was never published can still be checked. Two different starts, a Start node with no input type, or no Start node on either canvas are not replayed. That refusal says `The check asks questions, so it works on agentflows that start with a chat message.`

The steps for a replay are in [Check recent questions before you publish](#check-recent-questions-before-you-publish). The routes and the stored types are in the [Drafts API](../reference/drafts-api.md#kinds-on-these-routes).

The canvas says **Draft, not live yet** and when that draft was saved, or **Live** when there is nothing waiting. **Publish** opens one dialog that lists what changed, in the same words as version history. **Keep editing** closes it. **Discard draft** throws the draft away and puts Live back on the canvas.

If Live changed after you started (for example through the API), the canvas and the dialog say so. Publishing then asks you to confirm, because it replaces those Live changes.

Version history marks a version **Published** when it was put Live by Publish or by Roll back, and marks the version people are served now as **Live**. **Roll back Live to this version** changes Live at once. In draft mode, **Open as draft** puts a version on the canvas without changing Live; see [Open a version as your draft](#open-a-version-as-your-draft).

**Publish instantly**, in the flow's configuration, makes every save live again, the way it worked before drafts. It stays off while a draft is still open: publish or discard that draft first. A draft saved while the setting is being turned on still blocks it, and nothing is written.

**Passing test set**, next to it, can require a passing dataset check before Publish. It is off until you turn it on. A chatflow has it, and so does an agentflow that starts with a chat message. It is hidden on a form, webhook, or schedule start while the setting is off. See [Require a passing test set before you publish](#require-a-passing-test-set-before-you-publish).

After an upgrade from a release without drafts, each flow's canvas stays Live as it was. Your next save on the canvas starts a draft. A harness saved before harness drafts works the same way: that canvas is Live, runs keep serving it, and the first edit on the canvas starts a draft. A pipeline saved before pipeline drafts works the same way: that canvas is Live, scheduled runs, a run you start, and a full rebuild keep using it, and the first edit on the canvas starts a draft. Nothing is copied or rewritten. Scripts that update flows through `PUT /api/v1/chatflows/:id` keep writing Live. For a harness that save still updates the roster runs serve, and for a pipeline it still updates the version those runs read; see [Drafts API](../reference/drafts-api.md).

To turn drafts off for the whole server, set `CUTTLELY_DRAFTS=off` (`false`, `0`, and `no` also work) and restart. The canvas then saves straight to Live, and Restore works as described above. See [History settings](../reference/versioning-settings.md#cuttlely_drafts).

### Require a passing test set before you publish

A chatflow or an agentflow can refuse Publish until the current draft passes a saved dataset. The setting is off until you turn it on. It is **Passing test set** in the flow's configuration, next to **Publish instantly**.

1. Open the flow's configuration and select **Passing test set**.
2. Choose the dataset, tick the evaluators, and set **Pass at** to a whole number from 0 to 100. 100 is the default, so every score must pass. An errored score counts as not passed. The verdict uses those counts, not the rounded pass rate, so one failed or errored score does not pass a mark of 100. An evaluator that was removed from the workspace stays listed as **Deleted evaluator** until it is unticked. Unticking it saves the setting without that id.
3. Turn on **Require a passing test set before Publish**.

Changing the dataset, the evaluators, or the pass mark sends a save, one at a time, so the later dataset choice is the one stored. Saving the same settings again is kept. One save can turn **Publish instantly** off and this setting on, or the reverse. The off is written first.

You need permission to update the flow. Turning it on also needs permission to view datasets and evaluators. Turning it off does not. Turning it on is refused when drafts are off for the server, or when **Publish instantly** is on. Turning **Publish instantly** on while this is on is refused too. A harness canvas uses the same Publish button, and this setting is not offered there. A harness check can still replay a dataset, and that result is not stored as a pass. A pipeline uses the same Publish button. Its dialog lists what changed and does not run the question check, and this setting is not offered there. An agentflow that starts with a form, a webhook, or a schedule does not show **Passing test set** while the setting is off, so it cannot be turned on. Turning it on through the API is refused with the same message as a dataset check on that start. If the start changes after the setting is already on, **Passing test set** stays in the configuration, shows that refusal, and the checkbox can be cleared. Publish stays blocked until it is turned off. The Publish dialog names the start and says to turn the setting off. It does not offer a run that cannot clear the block.

In the Publish dialog, the verdict is shown and **Publish** stays disabled, with the reason, until the latest result passed for this draft and these settings. After a stored pass, **Publish** is disabled again while a dataset check that matches these settings is still running. A running recent-question check does not disable it. **Run the test set** starts that check and keeps polling until the check leaves running or the server time limit is reached. That limit is `CUTTLELY_CHECK_MAX_SECONDS`, 180 seconds by default and at most 1,800. The poll is not capped at 200 reads. Closing the dialog stops the polling and does not stop the check, so a run already started can still record a pass. The question panel says that too when it is showing a check it did not start. A check that panel started still stops when the dialog closes. **Run the test set** needs permission to view datasets and evaluators. Without both, the button is hidden and the dialog says someone with those permissions has to run the test set, or the passing test set can be turned off. A check that does not use this dataset, these evaluators, and this pass mark does not replace or block a stored pass. The optional question check is different: closing its dialog stops the check. Editing the draft, or changing the dataset, the evaluators, or the pass mark, makes an earlier pass out of date. So does editing a row the check asked, adding a row it would ask, changing an evaluator's check, deleting the dataset or an evaluator, or editing the flow's answer post-processing. A failing result, or no result yet, also blocks Publish. The same rule is enforced by the API.

The server stores the last result for the flow: the draft hash, the settings used, the pass rate, the verdict, the time, and a hash of the rows the check asked and of each evaluator's type and settings. The hash includes the full expected answer, including characters past the 4,000 the check shows. It does not store the rows or the answers. The result is still there after a restart. Changing those rows or that evaluator check, or deleting the dataset or an evaluator, makes the pass out of date.

These other ways of changing what is Live do not use this rule:

| Way                                                                                             | With the setting on                                                                                |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `PUT /api/v1/chatflows/:id`                                                                     | Still writes Live.                                                                                 |
| **Roll back Live**                                                                              | Still sets Live to that earlier version. The draft is kept.                                        |
| **Restore** while the canvas saves to a draft                                                   | Still opens the version as the draft. Live is unchanged until Publish, and Publish is still gated. |
| Restore straight to Live (drafts off, **Publish instantly** on, or a canvas that has no drafts) | Still writes Live. Those flows cannot turn the setting on.                                         |
| Promote from Dev                                                                                | Still writes Live.                                                                                 |

With the setting off, Publish and every path above behave as they do today.

### Check recent questions before you publish

The Publish dialog can ask a few questions people really asked this flow again, once on Live and once on your draft, and show the two answers side by side. You see what your change does to real answers before anyone else does. The check is optional: **Publish** works with or without it, unless the flow requires a passing test set. To run the same check from a pipeline, see [Fail a build when answers change](./ci-gate.md).

1. Select **Publish** on the canvas. Under **Check recent questions**, choose **Past questions**: 4, 10, 25, 50, or 100. 4 is selected first.
2. The check uses the most recent questions people asked this flow, newest first, from the API, embeds, shared links and the canvas test chat. The same wording counts once: capitals and extra spaces are ignored, and the newest copy is kept. Asking for the same number again uses the same questions, until someone asks a newer one. It is not a random sample. Questions sent with a file are left out.
3. If the flow has fewer past questions than you chose, the dialog says so and compares every one it has, for example `Only 37 past questions available. Comparing all 37.`
4. Read the note under the list. It says how many runs that choice makes: each question runs twice, once on Live and once on your draft. The note does not quote a dollar figure before the models answer. To ask something else as well, type it in **Add your own question** and select **Add**. Then select **Run check**.

If your role can view datasets, **Questions from** offers **Recent questions** (the choice above) or **A dataset**. A dataset uses its rows in the order you saved them: the row input is the question, and the row output is the expected answer. Someone who can view the flow but not datasets does not receive those row inputs or expected outputs when they read the check. Someone who cannot view evaluators does not receive evaluator names. The check asks at most 100 rows, and it skips a row whose question is empty or longer than 2,000 characters. You do not send your own questions or a past-question count with a dataset. A role that cannot view datasets does not see **Questions from**; the check stays on recent questions. A flow that starts from a form, a webhook or a schedule cannot use a dataset. That request is refused, and the choice says **Recent runs** instead of **Recent questions**.

If your role can view evaluators, the same box lists them. Tick the ones that should score each answer. Text, JSON and numeric evaluators use the answer, and a numeric one also uses the tokens and the time the check already shows. A numeric check of prompt tokens, completion tokens, or a token total the run did not report scores Error, not Fail. An evaluator that grades with a model uses the model credential saved on the flow, and only a credential in this workspace. Each side shows Pass, Fail or Error for every evaluator you picked. An answer that failed to run scores Error, not Fail. A model grade that is only a number stays Error, because this check does not turn that number into Pass or Fail. A `result` of `Pass` or `Fail`, a boolean named `pass`, `passed`, or `correct`, or a grade with exactly one boolean, is Pass or Fail. Above the rows, each side has a pass rate: passed divided by passed, failed and errored. A check with no evaluators is the same comparison as before, and a dataset still shows the expected answer under the question. A dataset check also reports passed or failed for the draft against a pass mark (100 unless you send another). Errored scores count as not passed. That line does not block Publish unless the flow requires a passing test set.

![The Publish dialog for Bakery helper. The change list says Changed Conversation Chain: system message prompt. Questions from is Recent questions. The list is What time do you open on Saturday?, Do you have gluten-free bread today?, Can I order a birthday cake for Friday?, and Do you have rye loaves today?, with no checkbox on each question. Add your own question is empty. The note says each question runs twice, 8 runs for 4 questions, and a check stops at 100,000 tokens or 3 minutes. Evaluators says no evaluators in this workspace. Past questions is 4, next to Run check. Publish works with or without a check.](../images/versioning/publish-check-questions.png)

The picture shows four questions, which is the default. **Past questions**, next to **Run check**, is where you choose 4, 10, 25, 50, or 100.

Each question runs twice, so a check uses the flow's model and costs tokens on its account, like any other question. The note says how many runs your choice makes and where the server stops a check. A few questions run at the same time (2 by default, changed with `CUTTLELY_CHECK_CONCURRENCY`) so a long check does not open a hundred model calls at once. Live and the draft for one question still run one after the other. While it runs, the dialog shows how many questions have been asked, for example `Asked 12 of 100…`, and **Stop** ends it early. Questions that already finished stay on the page. Closing the dialog or publishing also stops it. A **Run the test set** gate run is not stopped that way: closing the dialog only stops the polling. See [Require a passing test set before you publish](#require-a-passing-test-set-before-you-publish). If one question fails, that row shows the error and the rest continue.

When it is done, the totals sit above the rows: how many answered the same, how many answered differently, how many had an error, the tokens each side used, the typical time each side took, and the difference between the sides. Each side also shows an estimated cost, in US dollars, from the tokens that side used and the current model prices. The total groups every answer's tokens by model and prices that model once. The same kind of estimate is under each answer, priced on its own, so it can differ from the total by one hundred-millionth of a dollar. A model with no price is shown as `no price`, not as $0. If some models have a price and some do not, the figure is only the priced models and the line says some models have no price. These figures are estimates, not a bill. With evaluators, a pass-rate line is added for Live and for the draft. Without evaluators there is no better or worse score. The rows are shown 12 at a time, with **Show more** for the next page. Each question shows the Live answer and the draft answer side by side, with the tokens, time, and estimated cost under each, a score chip for each evaluator when you picked some, and a label:

| Label     | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| `Same`    | Both answers have the same words, ignoring capitals and spacing.      |
| `Changed` | The words differ. Read both: the meaning may still be the same.       |
| `Error`   | One side could not answer, for example because it took over a minute. |

![The check results for Bakery helper: 1 of 4 answered differently, 3 of 4 answered the same. Tokens are Live 235 and draft 235. Typical time is 0.1 s on both sides. Estimated cost is no price. What time do you open on Saturday? is marked Changed: Live says We open at 8 AM on Saturdays, and Draft says We open at 7 AM on Saturdays. Do you have gluten-free bread today? is marked Same.](../images/versioning/publish-check-results.png)

A flow that was never published has nothing Live to compare with. The box says `Live is empty until the first publish`, each question runs once, on your draft, and the result counts the questions your draft answered, for example `3 of 3 answered on your draft.` A new flow with no past questions offers its starter questions, marked `(starter question)`, so there is still something to check. A chatflow made with [Build with AI](./canvas.md#build-a-chatflow-with-ai) starts this way: its first save is a draft and Live stays empty until you publish.

Answers from a model can vary a little between runs, even with no change, so `Changed` means "look at this one", not "something broke". Results belong to the draft they checked. When you change the draft, the old results are cleared the next time you open **Publish**; run the check again.

A check never touches Live or your draft. The questions it asks do not show up in chat history or in its memory, and each one starts with no memory of earlier turns. The tokens are added to that flow's daily usage total. The results, including the estimated cost, are kept for 30 minutes and are not written anywhere else.

#### Flows that act for real

Some steps do more than answer: they post to another service, write to a database, run your own code, or keep a conversation somewhere else. Asking the question again would repeat that action. When Live or the draft has such a step, the dialog names it and does not run the check unless you tick **Run it anyway, including those steps**. Tick it only if repeating those steps is safe, for example when they point at a test system. The full list of steps is in the [Drafts API](../reference/drafts-api.md#steps-that-act-for-real) reference.

![The Check recent questions box on Bakery helper with a warning: This flow has steps that could send, write or post something for real: Post-processing code. The check would repeat them, so it skips this flow unless you choose to run it anyway. The Run it anyway, including those steps checkbox is not ticked.](../images/versioning/publish-check-risky-steps.png)

The check works on chatflows, agentflows and harnesses. A chat-started agentflow replays questions, as above. An agentflow that starts from a form, a webhook or a schedule replays recent runs instead: the form payload, the webhook payload or the schedule trigger input, taken from **Executions**, newest first. A form run, and a schedule that sends a form, stores each field as a line `name: value`. The check splits each line on the first `: ` and replays the fields as strings. The marker line stays on the stored Start output. The check sends the readable lines in the stored field order, the same text the original run gave each node. An older row whose line break leaves a line with no field name is not replayed. An older saved row has no marker line, so a backslash in a value stays as it was typed. A form saved as an object is read as that object. Nested header and query names that hold a secret, such as `user[password]`, are shown as `[REDACTED]`. The box is titled **Check recent runs**. The dialog reads the Start input on Live and on the draft before the check request returns, so while that request is still loading the title is already **Check recent runs** and the line says `Loading recent runs…`. A chat start says **Check recent questions** and `Loading recent questions…` for that same wait. When those canvases do not show the start, the title is **Check** and the line says `Loading the check…`. Neither says questions or runs. A refusal keeps that title: it does not switch to **Check recent questions**. While recorded inputs run, progress says `Ran 1 of 2…`. Stopping or hitting a limit says these are the runs answered so far. If none were answered, it says no recorded input was answered. The list is named **Runs to compare**. If the setup request fails, a runs start says `Recent runs could not be loaded.` A chat start says `Recent questions could not be loaded.` When the start is unknown, it says `The check could not be loaded.` **Past runs** uses the same choices, 4, 10, 25, 50 or 100. When fewer runs exist than that choice, the picker is labeled **Requested runs** (the number is how many you asked for) and the line above the list says how many will be compared, for example `Only 2 past runs available. Comparing all 2.` Each row names where the input came from (**Form**, **Webhook** or **Schedule**) and when that run was recorded, then a short JSON preview of the input. The Live answer and the draft answer use the same `Same`, `Changed` and `Error` labels. There is no box to type your own input, because the check only replays something this flow has already run. If the flow has never run, the box says no past runs exist yet and how to record one: submit the form, call the webhook, or wait for or trigger the schedule. That is not a refusal. Live and the draft must start the same way. A chat start on one side and a webhook start on the other still says `The check asks questions, so it works on agentflows that start with a chat message.`

Two webhook deliveries count as one when they differ only by headers that change on every call: date, request id, trace, user agent, content length, forwarding headers, and signature or timestamp headers. They also count as one when they differ only by a sensitive header such as Authorization. The webhook stores that header as `[REDACTED]` before the execution is saved, so the token is never kept, and two copies of that placeholder are not a second input. The preview of that one input is the body alone. The body, the query, and a header the execution keeps, such as `x-bakery`, still count. When two kept rows share a body and differ by one of those headers, the preview adds it. A row whose body is unique does not add that suffix. Authorization, cookie, and any header or query name containing token, secret, key, password or signature is shown as `[REDACTED]` when a value is still present. The raw value is not in the dialog or in the check response. The picture is two runs that share the body `{"event":"bake","loaf":"rye"}` and differ by `x-bakery` (`oven-a` and `oven-b`). The previews are `{"event":"bake","loaf":"rye"} headers x-bakery: oven-b` and `{"event":"bake","loaf":"rye"} headers x-bakery: oven-a`.

![The Publish dialog on the Order webhook canvas, with the badge Draft, not live yet, Saved just now. Changed Reply: direct reply message sits above Check recent runs. The box says only 2 past runs are available and it is comparing all 2. Both inputs are Webhook and share the body {"event":"bake","loaf":"rye"}. The first preview is {"event":"bake","loaf":"rye"} headers x-bakery: oven-b and the second is {"event":"bake","loaf":"rye"} headers x-bakery: oven-a. Both were recorded Oct 13, 2026, 8:51 AM. Requested runs is 4. The note says each recorded input runs twice, 4 runs for 2 recorded inputs, and a check stops at 100,000 tokens or 3 minutes. Run Check is available, and Publish works with or without a check.](../images/versioning/publish-check-webhook.png)

A harness uses the same dialog. The questions are the full prompts people sent this harness, newest first, with the same distinct-wording rule and the same choices of 4, 10, 25, 50 or 100. They come from the saved chat turns, not from the short line on **Runs**. A canvas whose harness file belongs to another team gets no questions, and those prompts are not opened. Another team's harness is a 404, the same response as a missing name. A secret in a prompt is hidden the same way as on that line, and a prompt longer than 2,000 characters is cut at 2,000. Two prompts that share only a short opening stay two questions. Each one runs on the Live roster and on the draft roster. Both use the temporary try profile the canvas chat uses, and that directory, the specialist directory, and the gateway token are removed when the question finishes, when it fails, and when you select **Stop**. If the runtime still has one of those directories open, the next start removes it. A saved harness is left in place. A second check, and a run through `POST /api/v1/harnesses/:name/runs`, use different profiles and do not see this one. The check writes no chat message, no row under **Runs**, no session memory and no analyst page. The tokens under each answer are the route, specialist and handoff tokens added together. The estimated cost uses those same lines, grouped by model, which is what the usage total stores under the harness name. A specialist with **Shell**, **Browser**, **Code execution** or **Files** is named, and the check does not run until you tick **Run it anyway, including those steps**. SQL tools keep the refusal they already have on a canvas try. A saved dataset's rows are asked on both rosters the same way.

Legacy multi-agent flows are not checked. The box keeps the message `The check works on chatflows and agentflows.` On an agentflow a check reads execution records only to find those inputs. It writes no new run to **Executions**, and the tokens shown are the ones the model steps (LLM and Agent) report. The same steps that act for real are skipped unless you tick **Run it anyway, including those steps**. An administrator can change the token and time limits with `CUTTLELY_CHECK_MAX_TOKENS` and `CUTTLELY_CHECK_MAX_SECONDS`, and how many questions or inputs run at once with `CUTTLELY_CHECK_CONCURRENCY`; see [Publish check limits](../reference/versioning-settings.md#publish-check-limits). A provider that reports token usage nowhere does not move the token cap, so that check is bounded only by the time limit.

![The check results on the Bakery helper agentflow. 3 of 3 answered differently. Can I order a birthday cake for Friday? is marked Changed: Live says Yes, you need to place your birthday cake order by Wednesday, and Draft says Yes, please place your order by Wednesday for a Friday birthday cake. What time do you open on Saturday? is marked Changed: Live says We open at 8 AM on Saturdays, and Draft says We open at 7 AM on Saturdays. Do you have gluten-free bread today? is marked Changed: Live says No, we bake gluten-free bread only on Tuesdays, and Draft says Yes, we bake gluten-free bread every day.](../images/versioning/publish-check-agentflow-results.png)

## Where the history lives

History is a Git repo in a `versions` folder in the Cuttlely data directory:

| Install                     | Folder                                      |
| --------------------------- | ------------------------------------------- |
| [Docker](./docker.md)       | `/var/cuttlely/versions` on the data volume |
| [Render](./render.md)       | `/var/cuttlely/versions` on the disk        |
| `scripts/start-cuttlely.sh` | `.cuttlely/versions` in the repo            |
| Server started another way  | `~/.cuttlely/versions`                      |

`CUTTLELY_VERSIONS_DIR` puts it somewhere else. `CUTTLELY_DATA_DIR` moves it with the rest of the data. See [History settings](../reference/versioning-settings.md).

The repo has one folder per flow under `flows/`. You can read it with ordinary Git, for example `git log` in that folder. The file layout is in [Version files](../reference/version-files.md). Do not edit the repo while Cuttlely is running.

The repo stays on the server unless the owner connects GitHub. Then every new version is also copied there: see [Keep a copy in GitHub](#keep-a-copy-in-github). Cuttlely uses its own Git settings: it does not read your global Git config or Git credentials, and its commits skip hooks. The server needs `git` on its path. The Docker image includes it.

Back it up with the rest of the data directory. `docker compose down -v` deletes the Docker volume, and the history with it.

Deleting a flow adds a last version named `Deleted <flow name>`. The deleted flow's versions stay in the repo, but the app has no page for them.

## Keep a copy in GitHub

History always stays on the server. The owner can also connect a GitHub repository, so every version is copied there a few seconds after it is saved. That gives you an off-server copy you can browse on GitHub.

Open **Admin**, then **Version History**. Only the owner (Super User) sees this page, because the connection is for the whole server.

### Right after setup

Setup does not stop at a GitHub page: after **Sign Up** you land in Cuttlely, so a new owner can try a flow first. When you have flows worth keeping, open **Admin**, then **Version History**, and connect GitHub there. The same card also opens on its own at `/setup/github`.

![The Version History page under Admin. One GitHub card says Keep a copy of every version in your own GitHub repository, shows a Not connected chip, explains that keys are never copied, and has a Connect GitHub button. Below it, This server is, with Dev, Prod and Not set.](../images/versioning/github-not-connected.png)

When the environment list cannot be read, that card shows `The environment list could not be read. Save it again.` It does not offer Dev and Prod. It asks which row is this server, then saves that identity with the full list. The saved pair is dev then prod. Save stays off until a row is chosen. When the saved GitHub connection cannot be read, the card still shows the list and shows `The saved GitHub connection could not be read. Disconnect and connect again.` It does not ask you to save the list again. Saving the saved Dev and Prod pair in place of a named list that still parses, when that save would not change what this server reads or copies, is refused with `The environment list on this server is still valid, so it was not replaced.`

### Which GitHub token to use

The card asks for a GitHub token once. Make it a fine-grained token that reaches only the one repository you copy to, and only that repository's contents. Select the **i** at the end of the **GitHub token** box to see the same list in the card.

![Step 1, Sign in to GitHub, with the Which token to use card open next to the GitHub token box. It reads Token type: Fine-grained. Repository access: Only select repositories, then just the one for Cuttlely. Permissions: Contents: Read and write. Nothing else. GitHub adds Metadata: Read-only on its own. Expiration: 90 days, or a date you choose. When it runs out, paste a new token into the saved sign-in in Credentials. A note says to create the empty private repository on GitHub first, and that the link fills in the name, expiry and Contents. Buttons: Create a token on GitHub and Read the guide.](../images/versioning/github-token-help.png)

1. Create an empty private repository on GitHub first, without a README or license, for example `cuttlely-flows`. A token can only be limited to a repository that already exists.
2. Select **Create a token on GitHub** in the card. It opens GitHub's **New fine-grained personal access token** page with a name, a 90-day expiry and **Contents** already filled in.
3. Check these on GitHub's page:

    | On GitHub's page  | Pick                                                                                                                          |
    | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
    | Repository access | **Only select repositories**, then just the one repository                                                                    |
    | Permissions       | **Contents**: **Read and write**. Nothing else. GitHub adds **Metadata**: **Read-only** on its own                            |
    | Expiration        | A set date. 90 days is filled in. When it runs out, the card says GitHub did not accept the token, and you paste a new one in |

4. Select **Generate token**, copy it, and paste it into the card.

That is all Cuttlely needs. It uses the token to read your account name and the repositories the token can reach, to check the repository you pick, and to copy new versions into it. It never opens pull requests, never changes the repository's settings, issues or workflows, and never changes any other repository. A Prod server only reads, so its token needs **Contents**: **Read-only**; the card's link fills that in on a Prod server.

**Make a new private repository** in the card is the one thing this token cannot do. GitHub only lets a fine-grained token create repositories when it can reach all of your repositories and has **Administration** set to **Read and write**, which is far more than Cuttlely needs. Create the repository on GitHub yourself instead. A classic token with the `repo` scope also works, but it can reach every repository you can, so prefer the fine-grained one.

### Connect

1. Select **Connect GitHub**.
2. Paste a GitHub token: a fine-grained token for just that one repository, with **Contents** set to **Read and write** (see [Which GitHub token to use](#which-github-token-to-use)). **Create a token on GitHub** under the box opens GitHub's token page already filled in, and the **i** in the box shows what to pick. If this workspace already has a GitHub sign-in in Credentials, pick it from the list instead.

    ![Step 1, Sign in to GitHub. The GitHub token box shows dots and an i button at its end. Under it: Use a fine-grained token for just one repository, with Contents set to Read and write. It is saved in Credentials. Create a token on GitHub. Then Continue and Cancel buttons.](../images/versioning/github-sign-in.png)

3. Select **Continue**. Cuttlely lists the repositories the token can write to. Empty ones are marked **Empty** and listed first. A lock means private.

    ![Step 2, Pick where to keep it. Signed in as rosas-bakery. rosas-bakery/cuttlely-flows is selected and marked Empty. Below it are rosas-bakery/website, order-forms and menu-photos, then Make a new private repository.](../images/versioning/github-pick-repo.png)

4. Pick an empty repository, or select **Make a new private repository** and give it a name (`cuttlely-flows` is filled in for you).

    ![Make a new private repository is selected, with a name box that reads rosas-bakery/ cuttlely-flows.](../images/versioning/github-new-repo.png)

    A token made for one repository cannot create repositories (see [Which GitHub token to use](#which-github-token-to-use)). If Cuttlely says so, create an empty private repository on GitHub, give the token access to it, and pick it from the list.

5. Select **Connect**. Cuttlely checks the repository, saves the token, and copies every version so far. A check mark plays when the copy is done.

![Connected to rosas-bakery/cuttlely-flows, with a green check, Last synced just now, and an Up to date chip. The card names the sign-in it uses, GitHub: rosas-bakery/cuttlely-flows, and has Sync now and Disconnect buttons.](../images/versioning/github-connected.png)

Pick a repository that is empty or that only this server writes to. Cuttlely refuses a repository that already has other content, so nothing there is overwritten.

### What gets copied

The same files as the history on the server: one folder per flow under `flows/` (see [Version files](../reference/version-files.md)). Credentials go by name only, never their values, and the secret fields described in [What is stored, and what is not](#what-is-stored-and-what-is-not) are never in history, so they are never copied. Each version is checked again for key-shaped text before it leaves the server.

A pasted token is saved as a new **Github API** credential on the **Credentials** page, encrypted like every other key, and named after the repository, for example `GitHub: rosas-bakery/cuttlely-flows`. A sign-in you picked from the list keeps its own name. The card names the credential it uses. The token is not written to the history, the copy, or the logs. To use a new token, edit that credential. The next copy uses it.

### Status

The chip on the card says how the copy is doing:

| Chip            | What it means                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| Up to date      | Every version is on GitHub. The line under the repository says when it last synced.                               |
| Syncing soon    | A new version was just saved and is copied in a few seconds.                                                      |
| Syncing         | A copy is going now.                                                                                              |
| Retrying        | GitHub could not be reached, did not accept the token, or did not take the copy. Cuttlely tries again on its own. |
| Needs attention | Copying stopped until you fix something. The card says what, in plain words.                                      |

Publishing never waits for GitHub. If GitHub is down or the server is offline, saves and **Publish** work as usual, the card shows **Retrying** with when it tries next, and the versions saved meanwhile are copied once GitHub answers. **Try again** copies now instead of waiting.

![The card shows a Retrying chip and a warning: GitHub did not take the copy to rosas-bakery/cuttlely-flows. Publishing keeps working. Cuttlely tries again on its own. The line under the repository reads Trying again in a few seconds, and the button reads Try again.](../images/versioning/github-retrying.png)

If GitHub stops accepting the token, for example because it expired or was revoked, the card keeps showing **Retrying** and the message says GitHub did not accept it. Put a new token in that credential, then select **Try again**.

Copying stops with **Needs attention** when the GitHub copy has changes this server does not have, when a protection rule on GitHub refuses it, when a version has key-shaped text, or when the GitHub sign-in credential was deleted or has no token. Cuttlely never overwrites what is on GitHub. Fix the cause, then select **Try again**. If the credential was deleted, a new one is not picked up on its own: select **Disconnect**, then connect again with a new token or another saved sign-in.

**Sync now** copies right away. **Disconnect** stops copying. It keeps the history on the server, the copy on GitHub, and the saved GitHub sign-in, so connecting again later needs no new token.

### Label this server Dev or Prod

At the bottom of the card, **This server is** labels the server **Dev** or **Prod**. A Dev server, or one that is not set, copies its versions to GitHub as described above. A Prod server only reads the repository, to bring in what Dev published: see [Move a flow from Dev to Prod](#move-a-flow-from-dev-to-prod). To switch a connected server between Dev and Prod, disconnect GitHub first.

![The connected card on a Dev server, with Up to date and This server is set to Dev.](../images/versioning/github-dev.png)

The routes behind this card are in the [History API](../reference/versioning-api.md#copy-to-github).

## Move a flow from Dev to Prod

Build and try flows on a Dev server, then move the ones you are happy with to a Prod server. The two servers never talk to each other. They share one GitHub repository: Dev copies each version it publishes there, and Prod only reads it. Nothing goes Live on Prod until the owner of Prod looks at it and selects **Promote to Live**.

### Set up both servers

Do this once, as the owner, on each server:

1. On the Dev server, open **Admin**, then **Version History**, set **This server is** to **Dev**, and connect GitHub to an empty repository, as in [Keep a copy in GitHub](#keep-a-copy-in-github).
2. On the Prod server, set **This server is** to **Prod**, then connect GitHub to the same repository. Prod lists the repositories the token can read. A token with **Contents** set to **Read-only** is enough for Prod.

On Prod the card says it gets new versions from Dev. It looks every few minutes; **Look now** looks right away. When something is waiting, the card says how many flows have a new version, with a **Review** button.

![The Version History card on a Prod server, connected to rosas-bakery/cuttlely-flows with Up to date. It reads Get new versions from your Dev server through your GitHub repository, and Looked for new versions from Dev just now. A violet box says 3 flows have a new version from Dev, with a Review button. The buttons below are Look Now and Disconnect. This server is set to Prod.](../images/versioning/promote-card.png)

To switch a server between Dev and Prod, disconnect GitHub first.

### Add Staging between Dev and Prod

The same repository can hold more than two environments. List them in promotion order. Each one has a name (the label on screen), a branch (where that environment publishes), and a server identity (the value you set for **This server is**). An existing Dev and Prod setup is already that list: dev, then prod, both on `main`, and you do not have to change it. The promote page for that pair does not show a chain, and the behavior check column stays **From Dev**.

#### Three environments

Do this once, as the owner. Use one empty repository. Dev connects first.

1. Pick the labels, branches, and identities, and write them down. The example below is Dev on `main`, Staging on `staging`, and Prod on `prod`. Names, identities, and branches have to be different. The saved pair is the only list whose two branches are both `main`.
2. Save the same list on every server with `PUT /api/v1/flow-versions/environment`. Set `environment` to that server's identity. The list is stored on that server only. The servers do not copy the list from each other.
3. On Dev, set `environment` to `dev` and connect the repository, as in [Keep a copy in GitHub](#keep-a-copy-in-github). Dev publishes to `main` and records a fingerprint of the list with that copy. The copy is not finished until the fingerprint is on the repository.
4. On Staging, set `environment` to `staging` and connect the same repository. Staging reads `main`. Connect is refused unless the tip of that branch carries this server's list. A branch with no fingerprint, a fingerprint on some other commit, or a different list is refused, and nothing is saved or copied.
5. Promote the flow you want onto Staging. Staging then publishes its own versions, including that promotion, to `staging`.
6. On Prod, set `environment` to `prod` and connect the same repository. Prod reads `staging`, not `main`. Promote from Staging the same way Staging promoted from Dev: the behavior check, the credential names, and **Promote to Live**.

Prod does not take a version straight from Dev while Staging is in between. A promote that names Dev as the source is refused with `Promotion only moves to the next environment.`

On Staging and on Prod the page shows the chain Dev, Staging, Prod. Open one flow and **Where this version is** names the version of that flow on each environment, so you can see where the change sits. Dev's version is the one Dev published. Staging's version is the one Staging published, which is what Prod is asked to promote. Prod's own version is what is Live on Prod. The last environment does not publish, so a server earlier in the chain cannot see Prod's version and says it is only on that server. With only Dev and Prod, the page does not show a chain or that list, and it works as before.

The behavior check on a longer list titles the new version's column **From** plus the previous environment's name (**From Staging** on Prod). The saved Dev and Prod pair keeps **From Dev**.

```json
{
    "environment": "staging",
    "environments": [
        { "name": "Dev", "branch": "main", "server": "dev" },
        { "name": "Staging", "branch": "staging", "server": "staging" },
        { "name": "Prod", "branch": "prod", "server": "prod" }
    ]
}
```

The fields are in [History settings](../reference/versioning-settings.md#environments).

#### The fingerprint

Each server that publishes records a fingerprint of its list with the copy. A server that reads offers a new version only when the fingerprint on that version matches the list saved on the reading server. The servers never compare lists by talking to each other.

When they differ, the Version History card stops and says:

> This server's environment list does not match the list used to publish these versions. Save the same list on every server, then select Try again.

Nothing new is offered to promote. Versions already offered stay as they are. Save the same list, then select **Try again**.

A tip whose note matches the list on this server is offered. A normal Dev publish records the saved Dev and Prod fingerprint, and a Prod server still on that pair keeps promoting those versions.

A read stops in two cases. A different list uses the mismatch sentence in the table below: nothing new is offered until this server saves that same list. A fingerprint record that already exists, with no note on this tip, says:

> These versions have no environment list recorded yet, so nothing new is offered.

The saved Dev and Prod pair and a named list both refuse that unnoted tip. The saved pair still offers versions when the repository has no fingerprint record at all.

#### Add an environment to a chain that is already running

Dev can already be connected and copying as the saved pair.

1. On Dev, save the longer list with `environment` still `dev` and Dev's branch still `main`. That does not change what Dev reads or copies, so you can save it while GitHub is connected. Dev rewrites the fingerprint on the versions already copied. Staging can read those versions without waiting for a new publish.
2. On Staging, save the same list with `environment` `staging`, then connect. Staging reads Dev.
3. Prod was reading Dev. Its source is now Staging, which changes what it reads. Disconnect GitHub on Prod first, save the same list with `environment` `prod`, then connect. Prod reads Staging.
4. Promote on Staging, then on Prod.

Saving the saved Dev and Prod pair back over a named list that still parses, when that save would not change what this server reads or copies, is refused. The named list stays. Disconnect first if you mean to change what the server reads or copies.

#### When a promote or a connect is refused

| What you see                                                                                                                                        | Why                                                                                                                                                                                                               | What to do                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Promotion only moves to the next environment.`                                                                                                     | The promote named an environment that is not the previous one. Dev to Prod while Staging is between them does this.                                                                                               | Promote to the next environment. Staging first, then Prod.                                                                                                                                      |
| `This server's environment list does not match the list used to publish these versions. Save the same list on every server, then select Try again.` | The fingerprint on the copied version is a different list from the one saved here.                                                                                                                                | Save the same list on this server, then **Try again**. Versions already offered stay. Nothing new is offered until the lists match.                                                             |
| `These versions have no environment list recorded yet, so nothing new is offered.`                                                                  | A fingerprint record exists, and this tip has no note. The saved Dev and Prod pair and a named list both refuse it.                                                                                               | On the server that publishes, select **Try again** so the list is recorded with the copy, then look again here.                                                                                 |
| `Could not record the environment list with this copy.`                                                                                             | The versions were copied, and the fingerprint was not. The copy stays unfinished.                                                                                                                                 | Select **Try again**. The publisher tries again, including when another server records a fingerprint at the same time.                                                                          |
| `The environment list could not be read. Save it again.`                                                                                            | The list file on this server cannot be read.                                                                                                                                                                      | Save the full list again on **Version History**. Sending only this server's environment does not repair it.                                                                                     |
| `The saved GitHub connection could not be read. Disconnect and connect again.`                                                                      | The connection file cannot be read. The list is still there.                                                                                                                                                      | Disconnect, then connect again.                                                                                                                                                                 |
| `The environment list on this server is still valid, so it was not replaced.`                                                                       | A save tried to put the saved Dev and Prod pair in place of a named list that still parses, without changing what this server reads or copies.                                                                    | Send the named list you want to keep. Disconnect first if the goal is to change what this server reads or copies.                                                                               |
| `Pick this server's environment. Nothing is copied until you do.`                                                                                   | A named list is saved, and this server is not one of the identities in it.                                                                                                                                        | Set `environment` to one of those identities, then connect. Versions are not counted as waiting until you do.                                                                                   |
| `Pick an environment from the list.`                                                                                                                | The identity is not in the named list. On the saved pair the same mistake says `Pick Dev or Prod.`                                                                                                                | Choose one of the identities in the list.                                                                                                                                                       |
| `Disconnect GitHub before changing what this server reads or copies.`                                                                               | The new list would change the branch this server reads or the branch it copies to, and a repository is connected.                                                                                                 | Disconnect, save the list, then connect again. A list change that keeps the same read and the same copy does not need a disconnect. It rewrites the fingerprint on the versions already copied. |
| `Connect the repository your Staging server copies to. This one has no versions from Staging yet.`                                                  | The name in the sentence is the previous environment. Its branch is missing, or the tip does not carry this server's list. A branch by itself, a note on another commit, or a different list is the same refusal. | Publish from the previous environment with the same list, then connect. Nothing is saved on the refused connect.                                                                                |
| `This server publishes versions. The next environment promotes them.`                                                                               | This server is first in a named list, so it does not promote. The response is 409. On the saved Dev and Prod pair the sentence is `Only a server labeled Prod promotes versions from Dev.`                        | Promote on the next environment.                                                                                                                                                                |
| `Pick the repository your Staging server copies to. A new one has nothing for this server to read.`                                                 | A server that reads cannot create a repository. The response is 409. Staging is the previous environment's name. On the saved pair that name is Dev.                                                              | Connect the repository the previous environment already copies to.                                                                                                                              |
| `There is no new version from Staging for this flow.`                                                                                               | This flow has no new version from the previous environment. The response is 404. Staging is that environment's name. On the saved pair the sentence says Dev.                                                     | Reload the promote page. A flow that was already promoted shows up again when the previous environment publishes another version.                                                               |
| `This version from Staging is already Live here, or it is no longer offered. Reload to see the latest.`                                             | The version is no longer offered. The response is 409. Staging is the previous environment's name. On the saved pair the sentence says Dev.                                                                       | Reload, then promote the version that is offered.                                                                                                                                               |
| `A newer version of this flow arrived from Staging while you were looking. Review it, then promote.`                                                | A newer version arrived while the page was open. The response is 409. Staging is the previous environment's name. On the saved pair the sentence says Dev.                                                        | Review the newer version, then promote that one.                                                                                                                                                |

The routes are in the [History API](../reference/versioning-api.md#promote-from-dev-to-prod).

### See what is new

The **Chatflows** and **Agentflows** lists name the previous environment: **New flow from** that environment for a flow this server does not have yet, and **New version available from** that environment for one it has. Only the owner sees it. On the saved Dev and Prod pair that name is Dev, as in the picture.

![The Chatflows list on Prod. A banner at the top of the page reads 3 flows have a new version from Dev, with Review All. Order status and Catering quotes are each marked New flow from Dev, and Bakery helper is marked New version available from Dev. Each has a Review button.](../images/versioning/promote-banner.png)

**Review all** opens the promote page with every flow that has something new. On the saved Dev and Prod pair its title is **From Dev**.

![The From Dev page. It explains that Dev and this server share one GitHub repository and that nothing goes Live here until you promote it. Under 3 flows have a new version from Dev are three cards: Order status and Catering quotes, each New flow from Dev with 1 version published on Dev, and Bakery helper, New version available from Dev, with 2 changes on Dev since the last promote.](../images/versioning/promote-list.png)

### Review and promote

Select a flow to open its review page:

-   **What changes on this server** compares the version from the previous environment with what is Live here now. On the saved Dev and Prod pair that version is Dev's.
-   **What changed on** the previous environment lists the versions it published since the last promote, newest first. On the saved pair the heading is **What changed on Dev**.
-   **Credentials** says whether this server has every credential the flow uses. See [Credentials stay on each server](#credentials-stay-on-each-server).
-   **Check recent questions** runs the questions this server's users asked lately on Live and on the version from the previous environment, side by side, the same way as [Check recent questions before you publish](#check-recent-questions-before-you-publish), including the past-question count. A harness uses that same question check, from the full prompts saved for the harness. A canvas whose harness file belongs to another team gets no questions. Another team's harness is a 404. A form, webhook or schedule agentflow instead replays inputs recorded on this server, not on the previous environment. That box is titled **Check recent runs** and uses the same **Past runs** choices. When fewer runs exist than the choice, the picker is labeled **Requested runs**. If this server has no such run yet, the box says no past runs exist yet and how to create one here. A pipeline has no replay on this page: the review lists what would change. The check is optional. On the saved pair the new version's column is **From Dev**. On a longer list that column is **From** plus the previous environment's name.
-   **Where this version is**, on a longer list, shows the version of this flow on each environment in the chain. The saved Dev and Prod pair does not show it.

![The review page for Bakery helper, marked New version available from Dev. What changes on this server lists Changed ChatOpenAI: temperature and Changed Conversation Chain: system message prompt. What changed on Dev lists Changed System Message on Conversation Chain and Changed Temperature on ChatOpenAI, both by Rosa Diaz. Credentials says every credential it uses is on this server. Check recent questions says only 2 past questions are available and lists Do you have gluten-free bread today? and What time do you open on Saturday?](../images/versioning/promote-review.png)

![The check after it ran. 2 of 2 answered differently. Estimated cost is no price. Do you have gluten-free bread today? is marked Changed.](../images/versioning/promote-check.png)

When it looks right, select **Promote to Live**. The version from the previous environment is Live here right away. History titles it `Promoted from` that environment, and the secondary line uses the same name. On the saved Dev and Prod pair both say Dev.

![Promoted. This version is now Live on this server. History shows it as promoted from Dev. Roll back from version history any time. The buttons are Open The Flow and All New Versions From Dev.](../images/versioning/promote-done.png)

**Roll back** puts the previous Live version back in one step, the same as **Roll back live to this version** in version history. Rolling back does not offer the same version from the previous environment again; the next version that environment publishes shows up as usual. On the saved Dev and Prod pair that environment is Dev.

![Version history of Bakery helper on Prod. The newest version, marked Published and Live, begins Promoted from Dev: Changed System Message, edited by Rosa Diaz, with Roll back Live to this version. The version under it is the same kind of promoted line, marked Published.](../images/versioning/promote-history.png)

A new flow is created on Prod with the same name, Live, and the check is not offered for it because there is nothing Live to compare with.

### Credentials stay on each server

Each server uses its own **Credentials**. The files Dev copies carry only each credential's name and type, never its value. On promote, Prod uses its own credential with the same name and type.

If Prod does not have one, **Promote to Live** waits and the page lists exactly which credentials to add, with a link to **Credentials**. Add each one on Prod with the same name and type (and Prod's own key), then come back and promote.

![The review page for Order status, a new flow from Dev. Under Credentials a box reads Add these credentials on this server first. This version uses a credential this server does not have yet. Add one with the same name and type, then come back to promote. It lists OpenAI orders (openAIApi) and has an Open Credentials button. The Promote To Live button is greyed out, and the bar reads Promote is waiting for the credentials above.](../images/versioning/promote-missing.png)

If Prod has more than one credential with that name and type, the page says which one Promote uses: the one the flow uses on Prod now, or else the oldest.

### Prod's own changes are safe

-   Prod never writes to the repository and never puts anything Live by itself. Only **Promote to Live** does.
-   If someone has unpublished changes to the flow on Prod, the review page says so. Promote keeps those changes as they are, and **Publish** on that flow then asks before it replaces the newly promoted version.
-   If Dev publishes again while you are reviewing, Promote stops and asks you to look at the newer version first.

Only the owner (Super User) of Prod sees the From Dev page and can promote. The routes are in the [History API](../reference/versioning-api.md#promote-from-dev-to-prod).

## Turn history off

Set `CUTTLELY_VERSIONS=off` in the server environment and restart. `false`, `0`, and `no` also work. Any other value, or no value, leaves history on.

With history off, saves are not recorded, the **Version history** button and **Last edited by** do not show, and the history routes return no versions. The repo on disk is left as it is. Remove the setting and restart to turn history back on. Saves made while it was off are not in history. The next save records the flow as it is then.

In Docker, add `CUTTLELY_VERSIONS=off` to `.env` next to `docker-compose.yml`, then run `docker compose up -d`. On Render, add it in the Dashboard. All settings are in [History settings](../reference/versioning-settings.md).
