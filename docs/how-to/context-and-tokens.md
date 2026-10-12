# Context and tokens

A long chat, a big table or a long rule book does not have to become a long prompt. Cuttlely gives each specialist the task for its job, keeps table data in the database and loads a playbook when a question needs it. Every run shows the tokens it used.

This page uses a made-up bakery. The team is `bakery-team`. The `orders` specialist queries the shop's own tables. The `baker` specialist answers from the menu and from a playbook about custom cakes.

## Each specialist gets its own task

Harness Prime reads the question and writes one task per specialist. The task stands on its own. A follow-up such as "and the chocolate ones?" is written out in full, with the measure, the filters and the names the earlier turns settled. The specialist does the task. It does not receive the whole conversation.

The prompt for the next turn is a short summary of older turns, up to eight pinned facts, and the last two turns. The full transcript stays on disk. A specialist that runs in the agent runtime also gets each of those earlier messages cut at 1,500 characters. Its instructions are already part of its agent runtime profile, so they are not sent again with the task. Each turn starts a new session there.

Any other specialist gets those same last two turns and the same summary. If that prompt is over its cap, older turns are dropped first. The run card says so.

On Saturday someone asks the bakery team, "How many rye loaves did we sell, and can I order a custom chocolate cake for Monday?" Harness Prime can send `orders` a task about rye loaves and `baker` a task about the Monday cake. `orders` does not also receive every earlier message about cakes.

You can change how large a specialist prompt may be. In **Admin** > **Server settings** > **Agent runtime**, **Specialist prompt cap** is 4,000 tokens by default. `0` turns the cap off. The change applies the next time the server starts. On the specialist card, **Handoff limit** is a different setting: it caps what Harness Prime reads back, which is the next section.

## What a specialist hands back

Harness Prime writes the answer from the specialists' results. It reads each result up to that specialist's **Handoff limit**. Empty means 4,000 characters. You can set it from 160 to 20,000 under **Additional Parameters** on the Harness Specialist. A long knowledge answer may need more.

Source documents in that prompt are the name and a short snippet, at most eight. The documents themselves go back to your app on the response `sources`, with the text the tool returned. They are not pasted in full into the prompt that writes the answer.

**Harness Prime handoff cap**, on the same **Agent runtime** settings page, is how large that whole handoff prompt may be. The default is 6,000 tokens. `0` turns it off. If the handoff is still over the cap, the answer limits shrink in steps, and the run card says the context was cut. One of those later steps is 480 characters. That is not the starting cut. The starting cut is the handoff limit above.

A page of analyst rows is kept even when it is longer than the usual handoff limit, so the answer can still list the rows. That extra room is there so rows are not dropped. It is not a way to spend fewer tokens.

Ask `baker` what is in the chocolate cake. The menu document comes back with a name such as `chocolate-cake.md` and a short snippet in the handoff. The response your app receives still has the document on `sources`.

## One page of rows

The analyst is a specialist. It is not a separate canvas node. Its database tool is the **QUERY** action on **PostgreSQL MCP**.

A query returns one page of rows. The page is 100 rows. A statement that already asks for fewer rows returns that many. There is no setting that raises the page size. The rows stay in the database. The specialist receives that page, formatted as rows, and a page line when more rows exist. The raw tool payload is not pasted into the prompt.

With 150 Saturday cake orders, the first answer ends like this:

```text
rows 1-100 of 150 (page 1 of 2, say "show more" for the next page)
```

Say `show more`, `next page` or `page 2` in that same chat. The analyst fetches the next page of the same select. It does not run the question as a new query, and it does not send the earlier rows to the model again. The next turn's history keeps the page line from the previous answer. The last page reads `rows 101-150 of 150 (page 2 of 2, last page)`.

The page cursor lasts 15 minutes and only works in the chat that ran the query. The full paging rules, including a count that has nothing to page, are in [Paging through large results](./analyst.md#paging-through-large-results). The run card still lists every row that page returned, up to the 100-row cap, when you open the query chip. Harness Prime's answer can show fewer.

## Playbooks load when a question needs them

Long rules do not have to sit in the specialist's instructions, which travel with every prompt. Open **Additional Parameters** on a Harness Specialist and add **Playbooks**. Each one has a **Name**, a **When to use** line and the **Content**.

The specialist sees each playbook's name and when-to-use line in its instructions (the first 30). It opens the content only when a question needs that playbook, then follows it. Keep the rules every question needs in **Instructions**, and move the rest into playbooks, one topic each.

For the bakery, `cake-notice` has the when-to-use line "Questions about custom cakes and how much notice we need." The content says a custom cake needs 48 hours. A Monday cake question matches that line, so the specialist loads the playbook. A question about Saturday's rye loaves does not match it.

The limits (how many playbooks, and how long each part may be) are in [Give a specialist playbooks](./harnesses.md#give-a-specialist-playbooks).

## Where a run shows the tokens

### On the run card

The same card shows in the canvas chat, in a chatflow chat and on the harness page. Next to the wall time it shows input and output tokens for the whole run. For the gluten-free loaf response below, that line is `129 in · 52 out`, because `cached` is `0` and a cached figure of zero is left off the card. When the model reports a cached amount greater than zero, the card adds it after the input count. Cuttlely reports the number the model sent. It does not change the prompt to chase a cache.

Under that, the card shows how long **Route**, **Specialists**, **Handoff** and **Profile** took. Each specialist row has its own time and tokens.

**Context kept** means nothing was shortened. **Context cut in N places** means some text was shortened to fit. Select it to see where. The places include an earlier turn dropped from a specialist prompt, or a specialist answer shortened before Harness Prime read it.

The card is described line by line in [Read the run card](./harnesses.md#read-the-run-card).

### In the API response

`POST /api/v1/prediction/:id` on a chatflow that runs the team returns the answer plus the specialists, the timings and a `report`. This is a real response from the [API guide](../api.md#agentflows-and-harnesses), for a bakery question about a gluten-free loaf:

```text
"text": "You cannot pick up a gluten-free loaf on Monday because Rosa's Bakery is closed that day. Gluten-free loaves are available only on Tuesdays and Fridays from 7:00 to 15:00."
"harness": "bakery-team"
"agents": [{"name":"orders","status":"completed","ms":1143,"task":"Can I pick up a gluten-free loaf on Monday?","model":"ChatOpenAI · gpt-4.1-mini","tokens":{"prompt":129,"completion":52,"cached":0}}]
"timings": {"routeMs":855,"specialistsMs":1145,"handoffMs":787}
```

`agents[].tokens.prompt` is input tokens, `completion` is output tokens, and `cached` is the part of the input the model reported as cached. `cached` is `0` when the model reported none, and it is left out or `null` when the model did not report a cache figure.

`timings.routeMs` is the routing step, `specialistsMs` is the specialists, and `handoffMs` is Harness Prime writing the answer.

The same response includes `report`:

-   `report.tokens` uses those same `prompt`, `completion` and `cached` fields for the whole run.
-   `report.timings` repeats the step times and adds `profileMs`, the time spent preparing specialists that run in the agent runtime.
-   `report.truncated` lists what was shortened. It is empty when the card would say **Context kept**.

`sources` on that response carries documents the specialists returned. The handoff prompt had the names and short snippets.

### In the Publish check

Before you publish a chatflow or an agentflow, the Publish dialog can ask recent questions again, once on Live and once on your draft. Each question shows the two answers side by side, with the tokens and the time under each. The summary shows the token total and the typical time for Live and for the draft.

Those tokens are the total the check counted for that side. The check does not split them into input, output and cached, and it does not show the route, specialist and handoff times. Those stay on the run card and in the API response.

The dialog is in [Check recent questions before you publish](./versioning.md#check-recent-questions-before-you-publish).

## Usage over time

A finished run also adds its input and output tokens to a daily total. The total is kept per workspace, per flow, per model, and per UTC day. A chatflow or an agentflow is stored under that flow's id. A harness run started from the harness API is stored under the harness name. A chatflow that calls a harness stores the tokens on the chatflow, not a second time on the harness name. A run that did not report token counts adds nothing. Saving the total never changes the answer: if the write fails, the run still returns.

`GET /api/v1/stats/usage` returns those totals for the caller's workspace. The range is the last 7, 30, or 90 UTC days, or a custom `startDate` and `endDate`. You can filter with `flowId` and `model`. The response has one row per day (including days with zero tokens), a total per flow, and a total per model. The numbers are token counts. The reference is [Usage API](../reference/usage-api.md).

A publish check is a finished run, so its tokens are included. A run that stops for human input is not included until it finishes.
