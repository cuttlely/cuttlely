English | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [繁體中文](./i18n/README-TW.md) | [简体中文](./i18n/README-ZH.md)

<p align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="./assets/brand/readme/cuttlely-readme-header-dark.png">
<img src="./assets/brand/readme/cuttlely-readme-header-light.png" alt="Cuttlely. Your applications deserve agents. The open-source agent platform for applications." width="880">
</picture>
</p>

# Cuttlely

[![Release](https://img.shields.io/github/v/release/cuttlely/cuttlely)](https://github.com/cuttlely/cuttlely/releases/latest)
[![License](https://img.shields.io/github/license/cuttlely/cuttlely)](https://github.com/cuttlely/cuttlely/blob/main/LICENSE.md)
[![Docker image](https://img.shields.io/badge/ghcr.io-cuttlely%2Fcuttlely-2496ED?logo=docker&logoColor=white)](https://github.com/cuttlely/cuttlely/pkgs/container/cuttlely)
[![npm](https://img.shields.io/npm/v/cuttlely)](https://www.npmjs.com/package/cuttlely)
[![CI](https://github.com/cuttlely/cuttlely/actions/workflows/main.yml/badge.svg?branch=main)](https://github.com/cuttlely/cuttlely/actions/workflows/main.yml)

**Your applications deserve agents.**

Cuttlely is an open-source visual graph editor for building and orchestrating AI agents. Drag agents and tools onto a canvas, wire them into a team, chat with it in minutes, then call it from your app through the API. It runs on infrastructure you control.

## Contents

-   [Watch a team resolve a complaint](#watch-a-team-resolve-a-complaint)
-   [A/B test every change before it goes live](#ab-test-every-change-before-it-goes-live)
    -   [Drafts, tests, and version history](#drafts-tests-and-version-history)
-   [Made for real teams](#made-for-real-teams)
-   [Agent teams that power your apps](#agent-teams-that-power-your-apps)
-   [Use a team from your app](#use-a-team-from-your-app)
-   [Small context, big answers](#small-context-big-answers)
-   [Tools your teams use](#tools-your-teams-use)
-   [Your first 10 minutes](#your-first-10-minutes)
-   [Guides](#guides)
-   [Bring your existing flows](#bring-your-existing-flows)
-   [Contributing](#contributing)
-   [About and credits](#about-and-credits)
-   [Contact](#contact)

## Watch a team resolve a complaint

<p align="center">
<a href="https://cuttlely.com/media/customer-care-demo.mp4"><img src="./website/public/media/customer-care-demo-poster.webp" alt="Watch a narrated run of the customer care team in Try the demo, 78 seconds with captions. The title card shows the Cuttlely mascot waving next to the logo and the line Your applications deserve agents." width="880"></a>
<br>
<a href="https://cuttlely.com/media/customer-care-demo.mp4">Watch the narrated run (78 seconds, sound on)</a>
</p>

A customer writes in about a late order. A customer specialist reads the account, an operations specialist finds that the parcel never left the warehouse, and a policy specialist checks the written policy once operations is done, each with its own data and tools. Harness Prime writes the decision, the reply and the actions, with the evidence. [Try the demo](./docs/how-to/try-the-demo.md) opens this team on your own model key.

## A/B test every change before it goes live

<a id="test-every-change-before-it-goes-live"></a>
<a id="ship-changes-safely-draft-compare-publish-roll-back"></a>

Every edit saves to a draft while Live keeps serving your app. Compare, in the Publish dialog, asks real questions on Live and on the draft and marks each answer Same, Changed, or Error before you publish. Turn on the passing test set and Publish waits until the draft passes. Test with up to 100 question-and-answer pairs, with more on the roadmap.

<p align="center">
<a href="https://cuttlely.com/media/products/testing.mp4"><img src="./website/public/media/products/testing-poster.webp" alt="The testing video title card: the Cuttlely mascot holds a clipboard and a magnifying glass beside the Cuttlely logo, the word Testing, and the line Compare, score, then publish." width="880"></a>
<br>
<a href="https://cuttlely.com/media/products/testing.mp4">Watch the testing run (56 seconds, sound on)</a>
</p>

![Passing test set in the Bakery helper configuration. Require a passing test set before Publish is on, the dataset is Saturday hours, Pass at is 100, and Mentions rye and Short answer are ticked.](./docs/images/evaluations/publish-gate-settings.png)

[A/B test a change with Compare](./docs/how-to/ab-testing.md) walks through it. [Drafts, tests, and version history](#drafts-tests-and-version-history) lists what else is covered.

### Drafts, tests, and version history

-   **Drafts never touch Live.** On chatflows, agentflows, harnesses, and pipelines the canvas saves to a draft. The API, embeds, shared links, schedules, webhooks, a harness's external runs route, and a pipeline's scheduled runs keep serving Live until you publish. The canvas test chat runs your draft, including a harness canvas chat and Try it. **Preview** on a pipeline runs the draft and does not write to the store.
-   **Compare before you publish.** Recent questions run on Live and on the draft, and each answer is marked Same, Changed, or Error.
-   **Real answers become tests.** Add one answer with [Add to test set](./docs/how-to/tests-from-answers.md), or thumbs-up or thumbs-down answers from a time window, up to 500 new rows at a time.
-   **Score the draft.** Text, JSON, numeric and model evaluators give Pass, Fail or Error and a pass rate for Live and the draft. [Evaluations](./docs/how-to/evaluations.md)
-   **Publish waits for a pass.** The Passing test set gate is off until you turn it on, for a chatflow or an agentflow that starts from chat. Once on, Publish stays disabled until the current draft passes. [`cuttlely check --gate`](./docs/how-to/ci-gate.md) runs the same check in CI.
-   **Every version is kept.** Open an old version as your draft or roll Live back in one step, and promote from Dev to Prod, which goes Live only when its owner selects **Promote to Live**.
-   Chatflows, agentflows, harnesses and pipelines keep each saved version, with what changed and who changed it.
-   Dev and Prod connect to the same GitHub repository. Prod lists what Dev published, shows what would change and which credentials it needs, and can run the same side-by-side check. Each server keeps its own credentials; only their names travel.

The gate covers Publish of the current draft only. Roll back Live, Promote from Dev, and `PUT /api/v1/chatflows/:id` still change Live: [see which](./docs/how-to/versioning.md#require-a-passing-test-set-before-you-publish).

On a chatflow, an agentflow, or a harness, the Publish dialog can replay recent questions (4, 10, 25, 50, or 100; 4 is selected first), once on Live and once on your draft, and show both answers side by side with the tokens and time each one took. **Choose questions** hand-picks stored questions instead, still up to that admin cap. **Save as dataset** keeps the ticked questions, with blank expected answers to fill in on Datasets. An agentflow that starts from a form, a webhook, or a schedule replays that many recorded inputs instead. A pipeline lists what changed and does not run that check. The check never changes Live or your draft and leaves nothing in chat history. A flow with steps that post or write for real is skipped unless you choose to run it anyway. On a chatflow or a chat-started agentflow, under **Questions from**, choose **A dataset**, pick the evaluators, and turn on the passing test set. A harness can score a dataset for that run only, and a form, webhook, or schedule start cannot. **Admin** > **Server Settings** > **Testing and Limits** turns the Publish check on or off. That switch applies on the next check and does not change Publish.

![The Publish dialog for Bakery helper after a check: 1 of 4 answered differently, 3 of 4 answered the same. Tokens: Live 235, draft 235. Typical time: Live 0.1 s, draft 0.1 s. Estimated cost: Live no price, draft no price. What time do you open on Saturday? is marked Changed: Live says We open at 8 AM on Saturdays, and Draft says We open at 7 AM on Saturdays. Do you have gluten-free bread today? is marked Same: Live and Draft both say No, we bake gluten-free bread only on Tuesdays. Each answer shows its tokens, 0.1 s, and no price.](./docs/images/versioning/publish-check-results.png)

[Version history guide](./docs/how-to/versioning.md) · [Check recent questions before you publish](./docs/how-to/versioning.md#check-recent-questions-before-you-publish) · [Move a flow from Dev to Prod](./docs/how-to/versioning.md#move-a-flow-from-dev-to-prod)

## Made for real teams

Roles, separate teams, sign-in and an audit log, on a server you run.

-   [Roles and permissions](./docs/how-to/roles-and-permissions.md). Teams, the built-in roles, and the permission key for each page and route.
-   [Sign in](./docs/how-to/sign-in.md). Create the first account. A team can sign in with local users (`CUTTLELY_LOCAL_USERS`) and no AuthKit. AuthKit can be turned on later, and a verified email links to an existing local user.
-   [Users without AuthKit](./docs/how-to/users-without-authkit.md). Local users, invite and reset links, the built-in Owner, Admin, Builder, and Viewer roles, and sessions.
-   [Audit log](./docs/how-to/audit-log.md). Sign-in, lockout, invite, reset, role change, user disable, and settings changes.
-   [Server settings](./docs/how-to/server-settings.md). Change sign-in, the database, storage and more from **Admin**. Runtime settings apply without a restart: Testing and Limits, security limits, invite and reset expiry, the SMTP host, port, secure flag, and user, `SENDER_EMAIL`, invite delivery, the settings-history cap, and `CUTTLELY_AUDIT_RETENTION_DAYS`. Env-only values, including secrets, `PORT`, the data folder, and the SMTP password, show only Set or Not set. The list is [Startup options](./docs/reference/startup-options.md).

## Agent teams that power your apps

Give your app a team instead of a single prompt. An agent team is a lead agent with specialists. In Cuttlely, an agent team is called a harness. The lead, Harness Prime, reads the question, splits it into parts, sends each part to the right specialist, and writes one answer. Each specialist can have its own model, tools, playbooks and data. A chatflow calls the whole team by name, so your app, a share link or a website embed can reach it. Your app sends the team a question through the API and gets back one researched answer, a chart or an action. [Harnesses guide](./docs/how-to/harnesses.md)

-   **The Analyst** is a specialist with its own database. It creates tables, adds rows and answers questions about them with the real numbers, and it never reads Cuttlely's own tables. Long results come back in pages. A harness can have several analysts, each with its own database, and Harness Prime sends each question to the one that fits. Turn it on with `CUTTLELY_ANALYST=auto`. [Analyst guide](./docs/how-to/analyst.md)

![The canvas chat after the database question, in the dark theme. The Run card says Harness Prime sent work to analyst, and the analyst row shows done, OpenAI gpt-5.6-luna, 3 tools. The answer is a table with title and status: draft agenda open, and send invites open.](./docs/images/harnesses/canvas-chat-analyst.png)

## Use a team from your app

Put the team behind a chatflow with one **Harness** card, publish it, and give it a key from **API Keys**. Your app sends a question and gets the team's answer back. Here is a real call to a small bakery team with two specialists, `baker` and `orders`:

```bash
curl -s http://localhost:43117/api/v1/prediction/<chatflow-id> \
  -H "Authorization: Bearer $CUTTLELY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"question": "How much are two croissants and a sourdough loaf, and can I pick them up on Monday?"}' \
  | jq '{text, agents: [.agents[] | {name, task}]}'
```

```json
{
    "text": "Two croissants and a sourdough loaf cost $14.00. However, you cannot pick them up on Monday because the bakery is closed; pick up is possible Tuesday to Sunday from 7:00 to 15:00.",
    "agents": [
        {
            "name": "baker",
            "task": "How much are two croissants and a sourdough loaf?"
        },
        {
            "name": "orders",
            "task": "Can I pick up two croissants and a sourdough loaf on Monday?"
        }
    ]
}
```

Harness Prime split the question: `baker` priced the order and `orders` checked the pickup day. The full response also has the tokens, the timings, the sources and any images the team made. The [API guide](./docs/api.md) covers the rest: API keys, streaming, conversation memory, file uploads, errors, and a runnable example web app that keeps your key on your server. Reference: [Prediction API for harnesses](./docs/how-to/harnesses.md#prediction-api) and [Call the harness from a chatflow](./docs/how-to/harnesses.md#call-the-harness-from-a-chatflow).

## Small context, big answers

Long chats, big tables and long rule books don't have to mean long prompts. Each agent sees only what its job needs, and every run shows the tokens it used.

-   **Each specialist gets its own job.** A common pattern hands every agent the whole chat. Harness Prime writes each specialist a task that stands on its own, with a short recap of the recent turns.
-   **Data stays in the database.** A common pattern pastes query results into the prompt. The analyst hands back one page of rows. Say "show more" for the next page. Earlier pages stay out of the next prompt.
-   **Only the tables you tick.** A common pattern pastes the whole database schema into the prompt. On a database connected by URL, tick tables and views in **Tables and views** on the PostgreSQL MCP node, and the analyst's prompt gets one line for each, with its column names. A `describe` tool returns one table's columns, keys and sample text values when the analyst needs them. On the made-up bakery demo database, six ticked relations take 663 tokens, against 2,562 for the whole schema. A **Rules** box under the list holds your own instructions for that analyst, up to 2,000 characters, such as which view answers which question. Rules guide the model; they cannot widen the ticked tables or allow writes. [Write your own rules](./docs/how-to/analyst.md#write-your-own-rules).
-   **Rules load when they're needed.** A common pattern puts every instruction in one giant system prompt. Long rules go in playbooks. A specialist opens one only when a question needs it.
-   **Short handoffs.** A common pattern pastes whole documents into the prompt that writes the final answer. Harness Prime reads a capped part of each specialist's answer, with the source names and a short snippet. The documents go back to your app in the response.
-   **See every token.** The run card shows input and output tokens, cached tokens when the model reports them, and the time each step took. The API response carries the same numbers. The Publish check shows Live and the draft side by side with the tokens and time each one used.

[How Cuttlely keeps context small](./docs/how-to/context-and-tokens.md)

## Tools your teams use

### Knowledge pipelines (ETL): answers from your own data

Load files, a CSV or a code repository, clean and split them, embed them and store them for search. A run only embeds what changed, can run on a schedule, and local embeddings work with no provider key. Teams and chatflows search the result with the **ETL Retriever**. [ETL guide](./docs/how-to/etl.md)

![Outdoor Catalog after a run. The run card says succeeded, with 33 embedded and 0 errors.](./docs/images/etl/etl-run-done.png)

### Chatflows: one assistant you can ship

A chat model, the agent or chain that answers, memory and tools, on one canvas. Each chatflow gets a prediction API, an embed for your website and a shareable link, and a chatflow with a **Harness** card puts a whole team behind them. [Canvas guide](./docs/how-to/canvas.md)

![The same chatflow after the first save, in the dark theme. The header reads Draft, not live yet. The test chat is open on the right: What is 18 times 24? is answered with a calculator chip and 18 times 24 is 432.](./docs/images/canvas/build-with-ai-chat.png)

### Agentflows: step-by-step workflows

Workflows that run step by step and can start from a chat message, a form, a webhook or a schedule. Selecting a card opens its settings in a side panel. [Canvas guide](./docs/how-to/canvas.md#workflows)

![The Bakery greeting workflow in the dark theme. Start connects to Reply. The Reply card is selected, and its Message field, reading Welcome to the bakery! Ask me about today's bread., is in a side panel docked on the right of the canvas.](./docs/images/canvas/canvas-workflow-panel.png)

### Built in everywhere

-   **Build with AI on every canvas.** Describe a team, an assistant, a pipeline or a workflow, and a first version lands on the canvas. Every part and connection is checked first. The building model is one of your own credentials. [Build a team](./docs/how-to/harnesses.md#build-a-team-with-ai), [a chatflow](./docs/how-to/canvas.md#build-a-chatflow-with-ai), [a pipeline](./docs/how-to/etl.md#build-a-pipeline-with-ai)
-   **An agent runtime in the box.** Specialists run in an agent runtime that ships with Cuttlely and starts with it, on the same server. There is nothing extra to install or host. [Harnesses guide](./docs/how-to/harnesses.md#agent-runtime-health)

## Your first 10 minutes

<a id="chat-with-a-team-in-minutes"></a>

New to agents? You do not need to write code. Describe a team with **Build with AI** and a first version lands on the canvas with starter questions. Ask them in the test chat, and the run card shows which specialists did the work. When it answers well, the chatflow that calls the team gives you a link to share and an embed for your website, so other people can chat with it too.

You need Docker and one model key. The steps use OpenAI. Any chat model provider listed under **Credentials** works the same way.

1. Get Cuttlely and start it:

    ```bash
    git clone https://github.com/cuttlely/cuttlely.git
    cd cuttlely
    docker compose up -d
    ```

    Compose pulls the published Cuttlely image. If it cannot pull it, Compose builds the image from your checkout instead, which takes several minutes the first time, and each long build step says which of four it is. `docker compose ps` shows `(health: starting)` until Cuttlely is ready, then `(healthy)`. Opening [http://localhost:43117](http://localhost:43117) early shows a **Cuttlely is starting** page that opens Cuttlely by itself.

    With Node.js 20 or newer you can skip the clone. This needs Docker, because `npx cuttlely start` pulls the image and runs it:

    ```bash
    npx cuttlely start
    ```

    That pulls `ghcr.io/cuttlely/cuttlely` and opens [http://localhost:43117](http://localhost:43117) when it is ready. [Install with npm](./docs/how-to/docker.md#install-with-npm) has `stop`, `status`, `logs` and `upgrade`.

2. When it is up, the server prints a one-time setup link. Show it with:

    ```bash
    docker compose logs cuttlely | grep "No account yet"
    ```

    Nothing yet? It is still starting. Run the command again in a few seconds.

3. Open the link and create your account. The password needs at least 8 characters, including a lowercase letter, an uppercase letter, a digit and a special character. You are signed in and land on **Chatflows**.
4. Try the demo. **Chatflows** shows a **Try the demo** card. Select **Add a model key**, choose **OpenAI API**, give it a name, paste the key, and select **Add**. The key is stored encrypted. Then select **Try the demo**: a ready-made customer care team opens with its chat open. Select the first starter question, a complaint about a late espresso machine. The run card shows Harness Prime sending the work to the customer and operations specialists, then to the policy specialist, and the answer gives the decision, the reply to the customer, the actions and the evidence. All the data is made up. [Try the demo](./docs/how-to/try-the-demo.md) shows each step, and the bakery quickstart on the same card.

    ![The customer care team's chat after the first starter question. The run card says Harness Prime sent work to customer, operations, then policy, each done, and the decision says the delay is Larkfield Home's fault, with a shipping refund, an Express reship arriving 2026-10-08, a recall, a store credit and a call from the Customer Care Lead.](./docs/images/try-the-demo/customer-care-run.png)

5. Build your own team: open **Harness · Agent Team**, select **New agent team**, then **Build with AI** (the sparkle button). Your model and key are already picked under **Chat model that builds**. Pick one of the examples and select **Build**, then open the chat and select a starter question.
6. Next time, sign in at [http://localhost:43117/signin](http://localhost:43117/signin) with **Sign in**.

Next: [put a pipeline behind your team](./docs/how-to/etl.md), [give a specialist its own tables](./docs/how-to/analyst.md), or [publish a chatflow](./docs/how-to/canvas.md#build-a-chatflow-with-ai). Docker settings, volumes and upgrades are in [Docker](./docs/how-to/docker.md). To change the code, use [Build from source and run the dev server](./docs/how-to/from-source.md).

## Guides

-   [Docker](./docs/how-to/docker.md). Install and run Cuttlely in one container on SQLite. `npx cuttlely` starts the same image.
-   [Build from source and run the dev server](./docs/how-to/from-source.md). Build Cuttlely yourself, run it, and change the code with live reload.
-   [Harnesses](./docs/how-to/harnesses.md). Build an agent team, try it, and call it from a chatflow.
-   [Context and tokens](./docs/how-to/context-and-tokens.md). How a team keeps each prompt to the job in front of it, and where a run shows the tokens it used.
-   [Analyst mode](./docs/how-to/analyst.md). Give a specialist its own database.
-   [ETL](./docs/how-to/etl.md). Load, embed and search your own data.
-   [Canvas cards](./docs/how-to/canvas.md). Chatflows, agentflows and Build with AI.
-   [Version history](./docs/how-to/versioning.md). Drafts, the Publish check, restore and Dev to Prod.
-   [Evaluations](./docs/how-to/evaluations.md). Build a test set, score answers, and keep Publish waiting for a pass.
-   [Turn real answers into tests](./docs/how-to/tests-from-answers.md). Save one rated answer, or a window of them, as rows in a test set.
-   [Fail a build when answers change](./docs/how-to/ci-gate.md). Run the Publish check from a pipeline with `cuttlely check`.
-   [Share and embed a chat](./docs/how-to/share-and-embed.md). A public link or a chat on your website, served by your Cuttlely server.
-   [Use the API in your own web app](./docs/api.md). Call your flows from your own site or app, with a runnable example.
-   [Render](./docs/how-to/render.md). A hosted install with Postgres.

Full documentation, including running from source and the API reference: [docs/README.md](./docs/README.md).

## Bring your existing flows

Have flows from another tool? On **Chatflows**, the **Import** menu has **Import Flowise JSON**, which opens a short wizard that checks a Flowise chatflow or agentflow export and opens it on the right canvas, and **Import Langflow JSON** loads a simple Langflow chat. What carries over, and what is not supported yet: [Bring your existing flows](./docs/bring-your-flows.md).

## Contributing

[CONTRIBUTING.md](./CONTRIBUTING.md) and [Build from source and run the dev server](./docs/how-to/from-source.md). On Node 24, `pnpm verify` before a pull request. Security reports go to [SECURITY.md](./SECURITY.md). The module boundary map is in [ARCHITECTURE.md](./ARCHITECTURE.md).

## About and credits

Cuttlely is open source under Apache 2.0. What changed in each release is in the [changelog](./CHANGELOG.md), and which versions get fixes is in [Releases and support](./docs/releases.md). The license text is in [LICENSE.md](./LICENSE.md), and attribution is in [NOTICE](./NOTICE).

Cuttlely builds on open-source work, including Flowise, Hermes from Nous Research and React Flow. [CREDITS.md](./CREDITS.md) lists each project with its license and link.

## Contact

Questions, partnerships or press: [info@cuttlely.com](mailto:info@cuttlely.com). Bugs and feature ideas go to [issues](https://github.com/cuttlely/cuttlely/issues), and vulnerabilities go through [SECURITY.md](./SECURITY.md).
