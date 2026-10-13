<p align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="../assets/brand/logo/cuttlely-logo-horizontal-dark.svg">
<img src="../assets/brand/logo/cuttlely-logo-horizontal.svg" alt="Cuttlely" width="200">
</picture>
</p>

# Cuttlely docs

Cuttlely is the open-source agent platform for applications. It gives your applications their own intelligent capabilities and coordinated agent teams. A team is a lead agent, Harness Prime, that splits each question among specialists, and in Cuttlely it is called a harness. Your app calls a team through the API, and people can chat with it on a share link or a website embed. Knowledge pipelines (ETL), visual workflows (chatflows and agentflows) and Build with AI give the teams what they need, and every change is a draft until you publish it. It all runs on infrastructure you control.

New here? Start with [Your first 10 minutes](../README.md#your-first-10-minutes), or watch a customer care team resolve a late-order complaint in about a minute with [Try the demo](./how-to/try-the-demo.md). Building an app? Start with the [API guide](./api.md), then [Use a team from your app](../README.md#use-a-team-from-your-app). The harness [Prediction API](./how-to/harnesses.md#prediction-api) section is the reference for harness responses and stream events.

## Build

-   [Harnesses](./how-to/harnesses.md). A team of specialists that Harness Prime sends work to. Build one from a description, try it, and call it from a chatflow.
-   [How the customer care demo works](./how-to/customer-care-demo.md). Specialists that each own one system, a step that waits for another's finding, and amounts that come from code, so you can build the same kind of team on your own data.
-   [Context and tokens](./how-to/context-and-tokens.md). How a team keeps each prompt to the job in front of it, and where a run shows the tokens it used.
-   [Analyst mode](./how-to/analyst.md). A specialist with its own database that creates tables and answers from them. Turn it on with `CUTTLELY_ANALYST=auto`; on Render, see [Analyst database](./how-to/render.md#analyst-database).
-   [ETL](./how-to/etl.md). Pipelines that load, clean, split, embed and store your data for search, on a schedule if you like.
-   [Evaluations](./how-to/evaluations.md). Datasets of example questions, evaluators that grade an answer, and a run of those examples against a chatflow or agentflow.
-   [Canvas cards](./how-to/canvas.md). Chatflows and agentflows, compact or classic cards (`CANVAS_CARD_LOOK=classic` sets classic for everyone), Build with AI, and [older V1 agentflows](./how-to/canvas.md#older-v1-agentflows).
-   [Optional node packs](./how-to/node-packs.md). Vector store nodes, tool and MCP server nodes that call an outside service, cache nodes, memory backends that use an outside service, completion model nodes, and the chain nodes that carry the DEPRECATING badge ship as packs. Load more nodes from a directory or a package, and open a flow whose node is not installed.
-   [Version history](./how-to/versioning.md). Drafts and Publish, the [check before Publish](./how-to/versioning.md#check-recent-questions-before-you-publish), restore and roll back, a [copy in GitHub](./how-to/versioning.md#keep-a-copy-in-github), and [Dev to Prod](./how-to/versioning.md#move-a-flow-from-dev-to-prod).
-   [Fail a build when answers change](./how-to/ci-gate.md). `cuttlely check` runs the Publish check and can fail the build when an answer comes back Changed, or when a scored test set is below its pass threshold. The example workflows for both modes are in `examples/ci/`.
-   [Share and embed a chat](./how-to/share-and-embed.md). A public link for any chatflow, a chat button or full-page chat on your website, how the share settings change the look, and the [`@cuttlely/chat`](./how-to/share-and-embed.md#embed-with-cuttlelychat) package.
-   [Use the API in your own web app](./api.md). API keys, calling chatflows, agentflows and harnesses, streaming, conversation memory, uploads, errors and allowed origins, with a runnable [example app](../examples/web-app).

## Install and sign in

-   [Docker](./how-to/docker.md). The install most people want. SQLite, one container. [npm](./how-to/docker.md#install-with-npm) starts that image with `npx cuttlely`.
-   [Build from source and run the dev server](./how-to/from-source.md). Build Cuttlely yourself, run it, change the code with live reload, and run the tests and `pnpm verify`.
-   [Render](./how-to/render.md). A hosted install with Postgres.
-   [Server settings](./how-to/server-settings.md). Change how the server runs from **Admin** > **Server settings**: sign-in and AuthKit, the database, storage, the analyst and more, with a review step, safe boot and History.
-   [Sign in](./how-to/sign-in.md). Turn on the local account, create the first account in a terminal or the browser, and sign in. [Set up WorkOS AuthKit](./identity/workos-authkit-setup.md) when a team signs in.
-   [Roles and permissions](./how-to/roles-and-permissions.md). Teams, the built-in roles, how to add a role and assign it, and every permission key with the pages and API routes that check it.

## Reference

-   [History settings](./reference/versioning-settings.md), [History API](./reference/versioning-api.md), [Drafts API](./reference/drafts-api.md) and [Version files](./reference/version-files.md).
-   [Usage API](./reference/usage-api.md). Daily input and output token totals for a workspace, by flow and model, with an estimated cost. The Usage page shows the same figures.
-   [Override configuration](./reference/override-config.md). What a prediction request may change with `overrideConfig`, and what it never can.
-   [Upgrading Cuttlely](./upgrading.md). Back up, upgrade, check and roll back, for Docker, Render and source installs.
-   [Changelog](../CHANGELOG.md) and [Releases and support](./releases.md). What changed in each release, what counts as a breaking change, and which versions get fixes.
-   [Run traces](./how-to/observability.md). Optional OpenTelemetry traces for chatflow predictions and agentflow runs, off unless you turn them on.
-   [What Cuttlely connects to](../SECURITY.md#what-cuttlely-connects-to). Every outbound connection, when it happens, and how to turn it off.
-   [Credits](../CREDITS.md). The open-source projects Cuttlely builds on, with their licenses and links.
-   [Updating the model list](./reference/model-list.md). For maintainers: the model dropdowns and prices come from `packages/components/models.json`, kept by hand in this repository.
-   [Agent runtime upgrades](./reference/hermes-upgrades.md). For maintainers: how the bundled agent runtime is vendored and upgraded.
-   [Health baseline](./reference/health-baseline.md). For maintainers: the dependency, image and node figures recorded on 2026-10-11. CI prints the current figures and does not fail on them.

## Bring your existing flows

-   [Bring your existing flows](./bring-your-flows.md). What opens from other tools today, and what is not supported yet. The rule-by-rule details are in [Flowise migration wizard](./flowise-migration-wizard.md) and [Langflow import](./langflow-import.md).
