# Security

Cuttlely is open-source software you run yourself. Report a vulnerability privately, so it can be fixed before the details are public.

## Report a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to [the report form](https://github.com/cuttlely/cuttlely/security/advisories/new). Only you and the maintainers can see the report.

Include what you can:

-   the Cuttlely version (the About dialog, or `GET /api/v1/version`) or the commit
-   how you run it: Docker, from source, or Render
-   the request path or screen, and what an attacker can do with it
-   the steps to reproduce

Do not put exploit steps, payloads or proof-of-concept code in a public issue, a pull request, a discussion or a public chat. A public issue is for bugs that are not vulnerabilities.

If the report form is not available to you, open a public issue that says only that you have a security report. Wait for a maintainer to reply before you send any details.

## Supported versions

Security fixes ship as a patch release of the latest minor version. [Releases and support](./docs/releases.md) has the full policy.

| Version                        | Security fixes            |
| ------------------------------ | ------------------------- |
| The latest minor release       | Yes                       |
| Older minor and major versions | No. Upgrade first.        |
| Builds of `main` between tags  | No. Use a tagged release. |

[Upgrading Cuttlely](./docs/upgrading.md) explains how to back up and move to the fixed version.

## What to expect

Cuttlely is maintained by a small team, so these are aims, not guarantees:

-   We aim to acknowledge a report within a week.
-   Once we can reproduce it, we tell you whether we accept it and what we plan to do.
-   We keep you updated while the fix is in progress.
-   When the fix is released, we publish a GitHub security advisory and list the fix under **Security** in the [changelog](./CHANGELOG.md).

Please give us a reasonable time to ship a fix before you disclose the issue publicly. There is no paid bug bounty. If you want, we credit you in the advisory.

## Scope

In scope: the Cuttlely server, the web app, the published Docker image, the Compose files, `render.yaml` and the scripts in this repository.

Out of scope: a deployment's own settings (for example a server exposed to the internet with auth turned off), problems in model providers and other third-party services, and reports that need an attacker who already has admin access or the server's encryption key.

Report vulnerabilities in code Cuttlely includes from other open-source projects, such as the agent runtime under `hermes/`, the same way: privately, through the form above. The maintainers fix it here and pass it on to the project concerned when the fix belongs there. [CREDITS.md](./CREDITS.md) lists the included projects and their licenses. Copyright and the Apache 2.0 text are in [LICENSE.md](./LICENSE.md).

## What Cuttlely connects to

Cuttlely does not report usage, check for updates or load fonts, scripts or images from other sites. Besides the model providers your flows use, a server makes one request of its own: once a day it fetches the model list the Cuttlely maintainers keep in this repository. Every other connection below starts because you configured something or opened a feature that needs it.

| Host                                                                                              | When                                                                                                                                                                                                                                                                                                                   | How to turn it off                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Your model provider (for example `api.openai.com`) and any service a node or credential points at | When a chatflow, agentflow or harness runs a node you configured                                                                                                                                                                                                                                                       | Remove the credential or the node. Cuttlely only calls the providers your flows name.                                                                              |
| `raw.githubusercontent.com` (`cuttlely/cuttlely/main/packages/components/models.json`)            | At most once every 24 hours, the first time a model dropdown or a cost lookup needs the model list. 5 second timeout; on any failure the server uses the copy bundled with its build. See [Updating the model list](./docs/reference/model-list.md).                                                                   | `MODEL_LIST_CONFIG_JSON=bundled`. A file path or your own URL there replaces it.                                                                                   |
| Hosts that MCP servers, Custom Tools, Custom Functions and web loaders reach                      | When a flow runs one you added. An MCP server started with `npx` or `uvx` may download its package first.                                                                                                                                                                                                              | Remove the tool or loader from the flow.                                                                                                                           |
| PostHog (`us.i.posthog.com`, or the host your key belongs to)                                     | Only when `POSTHOG_PUBLIC_API_KEY` is set. The server then sends usage events (flow created, prediction sent, the node types in a flow, the app version) to that PostHog project. Cuttlely ships no key.                                                                                                               | Leave `POSTHOG_PUBLIC_API_KEY` unset (the default).                                                                                                                |
| `api.github.com` and `github.com`                                                                 | Only after you connect a repository for flow version history and publish or sync.                                                                                                                                                                                                                                      | Disconnect the repository under version settings.                                                                                                                  |
| `api.hub.langchain.com`                                                                           | Only when you open the prompt browser to load a prompt from LangChain Hub.                                                                                                                                                                                                                                             | Do not open it.                                                                                                                                                    |
| `nts.ngc.nvidia.com` and NVIDIA's container registry                                              | Only in the NVIDIA NIM setup dialog, when you pull a NIM container.                                                                                                                                                                                                                                                    | Do not use the NIM dialog.                                                                                                                                         |
| `models.dev`                                                                                      | Off. A local patch to the agent runtime (`hermes/patches/0005`) stops it from fetching the models.dev registry, which it would otherwise do when an image is attached in a harness turn or a model is switched. Cached data still serves; without it, the runtime checks the model's abilities from its other sources. | Already off. `CUTTLELY_MODELS_DEV=1` in the server's environment turns it back on; `models_dev.url` in the agent runtime `config.yaml` can then point at a mirror. |
| Nous Research, GitHub and OpenRouter model catalogs                                               | Off. Cuttlely writes `model_catalog.enabled: false` into the agent runtime `config.yaml`.                                                                                                                                                                                                                              | Already off. Setting it to `true` turns the 20-minute catalog refresh back on.                                                                                     |
| `github.com` release downloads for tirith                                                         | Off. Cuttlely writes `security.tirith_enabled: false`, so the agent runtime does not download Python, uv and tirith (about 480 MB) on first start.                                                                                                                                                                     | Already off. tirith only guards the terminal toolset, which Cuttlely disables.                                                                                     |

### At install and build time

Installing Cuttlely downloads code once, from these places:

-   `pnpm install`: the npm registry (`registry.npmjs.org`), at the versions in `pnpm-lock.yaml`.
-   `scripts/setup-hermes.sh` (first start from source): uv downloads Python 3.14 and the agent runtime packages from PyPI (`pypi.org`, `files.pythonhosted.org`) at the versions in `hermes/uv.lock`.
-   `docker build`: the `node:24-trixie-slim` base image from Docker Hub, Debian packages (Chromium and build tools) from `deb.debian.org`, uv 0.12.3 from its GitHub release (checked against the sha256 in `hermes/pm/lock.json`), and the same npm and PyPI packages.
-   Agent runtime tools fetched by its package manager come from GitHub releases and are checked against the sha256 sums in `hermes/pm/lock.json`.

Apart from MCP servers started with `npx` or `uvx`, a running server does not download code.

### Pages you open yourself

Some settings link to a provider's own setup guide (Google, Microsoft, Slack and others). These are plain links: nothing loads until you click one.

The embed code shown under Share and the shared chat link both load the widget from your own server (`/embed/chat.js`).

`scripts/outbound-guard.test.mjs` runs in `pnpm verify` and fails if a tracker, a remote font, a remote template icon or a call to an upstream server comes back into the shipped code, or if the agent runtime loses its offline defaults (model catalogs, tirith and models.dev off).

## Maintainer checks

The merge gate is `pnpm verify` on Node 24, described in [CONTRIBUTING.md](./CONTRIBUTING.md). It fails when a secret-like value or a removed commercial path is committed. Do not commit secrets, tokens or `.env` files.
