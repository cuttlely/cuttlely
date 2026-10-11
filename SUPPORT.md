# Getting help with Cuttlely

Cuttlely is free, open-source software maintained by a small team. Help is best effort: there is no paid support and no guaranteed response time.

## Start with the docs

-   [README](./README.md): install and the first ten minutes
-   [Documentation](./docs/README.md): guides, how-tos and reference
-   [Upgrading Cuttlely](./docs/upgrading.md): back up, upgrade and roll back
-   [Changelog](./CHANGELOG.md): what changed in each release, and what to change when you upgrade

## Ask a question or report a bug

Open an [issue](https://github.com/cuttlely/cuttlely/issues). Search first, in case someone has already asked.

A useful bug report includes:

-   the Cuttlely version (the About dialog, or `GET /api/v1/version`)
-   how you run it: Docker, from source, or Render, and your operating system
-   what you did, what you expected, and what happened
-   the server log around the error (`docker compose logs cuttlely` on Docker)

Remove API keys, passwords, tokens and personal data from anything you paste. Cuttlely never needs them to debug a problem.

Feature ideas are welcome as issues too.

## Contact the team

For partnerships, press, or a question that doesn't belong in a public issue, email [info@cuttlely.com](mailto:info@cuttlely.com). Bugs and feature ideas still go to issues, so everyone can find the answer.

## Security problems

Do not open a public issue for a vulnerability. Follow [SECURITY.md](./SECURITY.md).

## Which versions are supported

Fixes go into the latest minor release only. If you are on an older version, upgrade first: the problem may already be fixed. [Releases and support](./docs/releases.md) has the policy.

## What we can't help with

-   Your model provider's accounts, quotas or billing
-   Problems in third-party services a flow connects to
-   Custom deployments we cannot reproduce with the documented install
