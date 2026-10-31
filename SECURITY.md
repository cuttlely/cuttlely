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

Do not email vulnerability details. The general address, [info@cuttlely.com](mailto:info@cuttlely.com), is for questions that are not security reports.

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

After a user's first successful run, Cuttlely may show a local-only "It worked!" prompt: a one-line server log and a dismissible UI toast with a link to the project on GitHub. This prompt makes no network call of its own — the link opens only if you click it — and it shows at most once per install or user. Set `CUTTLELY_DISABLE_IT_WORKED=true` to disable it everywhere.

| Host                                                                                              | When                                                                                                                                                                                                                                                                                                                                                                                             | How to turn it off                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Your model provider (for example `api.openai.com`) and any service a node or credential points at | When a chatflow, agentflow or harness runs a node you configured                                                                                                                                                                                                                                                                                                                                 | Remove the credential or the node. Cuttlely only calls the providers your flows name.                                                                              |
| `raw.githubusercontent.com` (`cuttlely/cuttlely/main/packages/components/models.json`)            | At most once every 24 hours, the first time a model dropdown or a cost lookup needs the model list. 5 second timeout; on any failure the server uses the copy bundled with its build. See [Updating the model list](./docs/reference/model-list.md).                                                                                                                                             | `MODEL_LIST_CONFIG_JSON=bundled`. A file path or your own URL there replaces it.                                                                                   |
| Hosts that MCP servers, Custom Tools, Custom Functions and web loaders reach                      | When a flow runs one you added. An MCP server started with `npx` or `uvx` may download its package first.                                                                                                                                                                                                                                                                                        | Remove the tool or loader from the flow.                                                                                                                           |
| Your configured OIDC issuer hosts                                                                 | When Cuttlely reads the discovery document or JWKS, exchanges an authorization code at the token endpoint, or reads UserInfo. These requests use the outbound guard. The **Private issuer hosts** setting admits the exact hosts configured there; `HTTP_DENY_LIST` still takes precedence.                                                                                                      | Remove the Generic OIDC configuration or select another sign-in method.                                                                                            |
| PostHog (`us.i.posthog.com`, or the host your key belongs to)                                     | Only when `POSTHOG_PUBLIC_API_KEY` is set. The server then sends usage events (flow created, prediction sent, the node types in a flow, the app version) to that PostHog project. Cuttlely ships no key.                                                                                                                                                                                         | Leave `POSTHOG_PUBLIC_API_KEY` unset (the default).                                                                                                                |
| The collector address in `CUTTLELY_OTEL_TRACES_ENDPOINT`                                          | Only when run traces are on, after a chatflow prediction, an agentflow run, or a harness run. The trace has ids, node types, model name, and token counts. Question and answer text are included only when `CUTTLELY_OTEL_TRACES_CONTENT` is on, cut at `CUTTLELY_OTEL_TRACES_CONTENT_MAX` characters (4,000 by default; `0` sends the full text). [Run traces](./docs/how-to/observability.md). | Leave `CUTTLELY_OTEL_TRACES` unset (the default).                                                                                                                  |
| `api.github.com` and `github.com`                                                                 | Only after you connect a repository for flow version history and publish or sync.                                                                                                                                                                                                                                                                                                                | Disconnect the repository under version settings.                                                                                                                  |
| `api.hub.langchain.com`                                                                           | Only when you open the prompt browser to load a prompt from LangChain Hub.                                                                                                                                                                                                                                                                                                                       | Do not open it.                                                                                                                                                    |
| `nts.ngc.nvidia.com` and NVIDIA's container registry                                              | Only in the NVIDIA NIM setup dialog, when you pull a NIM container.                                                                                                                                                                                                                                                                                                                              | Do not use the NIM dialog.                                                                                                                                         |
| `models.dev`                                                                                      | Off. A local patch to the agent runtime (`hermes/patches/0005`) stops it from fetching the models.dev registry, which it would otherwise do when an image is attached in a harness turn or a model is switched. Cached data still serves; without it, the runtime checks the model's abilities from its other sources.                                                                           | Already off. `CUTTLELY_MODELS_DEV=1` in the server's environment turns it back on; `models_dev.url` in the agent runtime `config.yaml` can then point at a mirror. |
| Nous Research, GitHub and OpenRouter model catalogs                                               | Off. Cuttlely writes `model_catalog.enabled: false` into the agent runtime `config.yaml`.                                                                                                                                                                                                                                                                                                        | Already off. Setting it to `true` turns the 20-minute catalog refresh back on.                                                                                     |
| `github.com` release downloads for tirith                                                         | Off. Cuttlely writes `security.tirith_enabled: false`, so the agent runtime does not download Python, uv and tirith (about 480 MB) on first start.                                                                                                                                                                                                                                               | Already off. tirith only guards the terminal toolset, which Cuttlely disables.                                                                                     |

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

## Local passwords

Two password paths exist, and neither ships a default password.

-   `CUTTLELY_LOCAL_ADMIN` is the owner break-glass account. `POST /api/v1/auth/login` accepts only that owner.
-   `CUTTLELY_LOCAL_USERS` is off unless set to exactly `true`. With AuthKit not configured, `POST /api/v1/auth/local/login` accepts any active user who already has a password. That request must send `x-request-from: internal`, the same check as the owner password sign-in. Without that header the response is the generic sign-in failure and no cookie is set, so another site cannot sign the browser into an account it chose. The sign-in page sends the header. AuthKit leaves that route off. The owner break-glass route still follows its own flag.

A session is bound to that user id. It does not grant the owner role. The role is read on every request. Sign-in, sign-out, disable, and a password change store revocation in `identity_local_session`, so an old cookie fails after a restart. Unknown emails, wrong passwords, users with no password, and disabled users get the same failure body. Ten failures in 15 minutes lock the client address and that email, including an email that matches nobody. Both counts are stored for that window. The email is stored as an HMAC made with the server secret, not as the address, and old rows are deleted so unknown addresses cannot fill the table. A restart keeps both the client-address lockout and the email lockout. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` when the request is https. A trusted proxy's scheme counts when `TRUST_PROXY` says so. State-changing session routes need `x-request-from: internal`. The server does not log passwords, hashes, setup codes, or raw emails. At debug level the request log keeps other cookies but writes `[redacted]` for the values of `cuttlely_session`, `cuttlely-local-session`, `wos-session`, and `cuttlely-invite`, and for a `token` or `password` in a request body.

The first owner is still created with the one-time setup code. No route sets another user's password. Invited users have no password until a sign-in link exists. Details are in [Users without AuthKit](./docs/how-to/users-without-authkit.md) and the [Auth API](./docs/reference/auth-api.md).

## Invites

A person an admin adds is stored as a pending invite (`invited`). They have no access to any team until they accept, and only their own one-time invite link accepts:

-   **A token is required.** The link carries a random token in the URL fragment, which the server log does not receive. The database stores only its SHA-256. With AuthKit on, the token reaches the sign-in callback in an `HttpOnly`, `SameSite=Lax` cookie that lasts 15 minutes, never in a URL. The browser sends that cookie only to `/api/v1/auth/callback`, every callback expires it, and the debug request log redacts it. With generic OIDC, an encrypted, single-use server-side transaction holds the token, is bound to the browser that started it, and completes at `/api/v1/auth/oidc/callback`.
-   **Single use.** Using the token, making the person active, and binding their AuthKit sign-in happen in one transaction, so a second use of the same link is refused, even when two sign-ins race.
-   **Expiry.** A link lasts the invite link lifetime: 72 hours by default, 1 to 168 hours in **Server Settings** (`INVITE_TOKEN_EXPIRY_IN_HOURS`).
-   **Only for that person.** The token must be the one made for that user, and the AuthKit email must match the email the invite was sent to.
-   **No password route around AuthKit.** With AuthKit on, `POST /api/v1/auth/local/accept` refuses an invite token and leaves it unused, so an invite can only be accepted by the AuthKit sign-in that checks the email and binds the account. Without AuthKit, that route is how an invite sets a password.
-   **Revoked or removed invalidates.** A newer link for the same person replaces the older one. Disabling a pending person, or removing them from the team or the organization, marks their open links used, so adding them back does not bring an old link back. Enabling a user never makes a pending invite active.
-   **An email match alone never activates.** A sign-in whose email matches a pending invite does not activate it, even when the identity provider reports the email as verified. The sign-in page shows `You have a pending invite. Open the invite link from your email to join.` and the person stays pending.

Issued, used, and refused links are audit rows with a short reason. They do not store the token, the URL, or the email. People added before 1.3.0 were stored as active, not pending, so these rules do not cover them until they are removed and invited again ([Upgrading](./docs/upgrading.md#invites-after-130)). The full flow is in [Invite people](./docs/how-to/sign-in.md#invite-people).

## Stored files

In local storage (the default), every file name and folder part is checked before any write or read: `..`, encoded separators, control characters, and absolute paths are refused, and separators and leading dots are then removed, so a file stays inside the storage folder even with `PATH_TRAVERSAL_SAFETY=false`. In S3, Google Cloud Storage, and Azure storage, the file name gets the same check, but the folder parts (organization, flow, chat, or document store ids) are joined into the object key as the caller passes them. Those are object keys in the bucket or container, not paths on the server's disk. Upload bodies are saved under random names. ETL uploads keep only letters, digits, `.`, `_`, and `-`, inside a new random folder. A harness file name must be a letter followed by letters, digits, `_`, or `-`, and harness file staging copies only files that resolve inside the upload folders, under their base name. Document loaders that download from S3 write through a check that keeps each path inside a new temporary folder. `PATH_TRAVERSAL_SAFETY=false` turns that loader check off, so leave it unset.

## Maintainer checks

The merge gate is `pnpm verify` on Node 24, described in [CONTRIBUTING.md](./CONTRIBUTING.md). It fails when a secret-like value or a removed commercial path is committed. Do not commit secrets, tokens or `.env` files.

CodeQL code scanning (`.github/workflows/codeql.yml`) leaves out `hermes/`, except the files Cuttlely's own patches touch, which a separate analysis scans. That folder is a pinned copy of the agent runtime's upstream code, and its security releases are tracked weekly and brought in with `pnpm hermes:vendor`. [Hermes upgrades](./docs/reference/hermes-upgrades.md#code-scanning) has the details.
