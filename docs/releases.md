# Releases and support

This page covers how Cuttlely is versioned, what counts as a breaking change, and which versions get fixes. The [changelog](../CHANGELOG.md) lists what changed in each release.

## Versions

Cuttlely uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html): `MAJOR.MINOR.PATCH`.

-   **Major** (`2.0.0`): a breaking change, as defined below.
-   **Minor** (`1.1.0`): new features and settings that existing installs can ignore. A new setting ships with a default that keeps today's behavior, unless the change fixes a security problem.
-   **Patch** (`1.0.1`): fixes only, with no new settings.

The product version is the `version` in the root `package.json`, `packages/server/package.json`, `packages/cli/package.json` and `packages/chat-widget/package.json`. The About dialog and `GET /api/v1/version` report the server package's version. The `cuttlely` launcher and `@cuttlely/chat` use that same version, because the launcher's default image tag is its own version. The other workspace packages keep their own internal version numbers, which are not the product version.

Each release is an annotated Git tag `vX.Y.Z`, a GitHub release whose notes come from the changelog, and a Docker image tagged `X.Y.Z`. [Cutting a release](#cutting-a-release) covers how a maintainer makes one.

## What counts as a breaking change

A change is breaking when an install or a client that follows the docs has to change something to keep working:

-   An API route, request field or response field is removed or renamed, or a documented response shape changes.
-   A documented status code changes for a request that used to succeed.
-   An environment variable or setting is removed or renamed, or its meaning changes.
-   A default changes, so an existing install behaves differently after the upgrade without any action from you.
-   A path inside the image, the data directory layout or a port changes.
-   A database change cannot be undone by restoring the backup taken before the upgrade and starting the previous version.
-   The minimum Node version goes up.

These changes are not breaking:

-   New routes, fields, settings and canvas cards.
-   Layout and wording changes in the app.
-   A fix that makes Cuttlely do what its docs already say.
-   Internal code names, package names and file layout outside the image.

A security fix can change behavior in a minor or patch release when waiting for the next major would leave installs exposed. The changelog then lists the fix under **Upgrade notes / breaking changes**, with what to change.

A setting or route that will be removed is marked **Deprecated** in the changelog in a minor release first. It is removed no sooner than the next major release.

## Which versions get fixes

| Version                       | Gets fixes         |
| ----------------------------- | ------------------ |
| Latest minor (today: `1.0.x`) | Yes                |
| Older minors and majors       | No. Upgrade first. |

Fixes, including security fixes, ship as a patch release of the latest minor. An older minor does not get a backport. Upgrading within a major is meant to be safe: read the changelog's upgrade notes and back up first, as [Upgrading Cuttlely](./upgrading.md) describes. Every full `pnpm verify` checks that data from an older release opens on the current code.

## The changelog

Each pull request that changes what users see adds a line under `## [Unreleased]` in `CHANGELOG.md`. Use the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) groups: **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed** and **Security**. Anything that needs action from people upgrading also goes under **Upgrade notes / breaking changes**, with the exact thing to change.

When a release is cut, `## [Unreleased]` becomes `## [X.Y.Z] - YYYY-MM-DD`. A planned version can be written as `## [X.Y.Z] - Unreleased` ahead of time, as 1.0.0 is.

## Cutting a release

Releases are cut from a maintainer machine with `pnpm release`. GitHub Actions does not build or publish them.

You need Node 24, pnpm, Docker and the GitHub CLI signed in (`gh auth status`). To push the image, also sign Docker in to the registry, for example `gh auth token | docker login ghcr.io -u <your GitHub user> --password-stdin` with a token that has the `write:packages` scope (`gh auth refresh -s write:packages`).

1. Make sure `CHANGELOG.md` lists everything under `## [Unreleased]`, or under `## [X.Y.Z] - Unreleased` for a planned version.
2. Review the model list, `packages/components/models.json`, against each provider's current models and prices, and merge any update first. See [Updating the model list](./reference/model-list.md).
3. Check out `main`, pull, and run a dry run. It changes nothing and prints every check, every command and the release notes:

    ```bash
    pnpm release --dry-run            # version from "## [X.Y.Z] - Unreleased"
    pnpm release minor --dry-run      # or major, patch, or an exact X.Y.Z
    ```

4. Run it for real:

    ```bash
    pnpm release                      # draft: nothing public
    pnpm release --push --publish     # push the image and publish the release
    ```

`pnpm release` refuses unless the working tree is clean (untracked files included), the checkout is on `main`, and `main` matches `origin/main`. It also refuses when the tag already exists, when the version is not newer than the last tag, or when `CHANGELOG.md` has nothing to release.

It then runs these steps, in order:

1. Run the full `pnpm verify`.
2. Set the version in `package.json`, `packages/server/package.json`, `packages/cli/package.json` and `packages/chat-widget/package.json`.
3. Date the changelog section, open a fresh `## [Unreleased]`, and update the compare links.
4. Commit `Release vX.Y.Z` and create the annotated tag `vX.Y.Z`.
5. Build the image as `ghcr.io/cuttlely/cuttlely:X.Y.Z` and `:latest` for `linux/amd64`. Labels record the version and the commit.
6. Start the image with a throwaway volume and wait for `/api/v1/ping` to answer.
7. Push the release commit and the tag, then create a draft GitHub release with the changelog section as its notes.

Two flags go further, and neither is ever the default:

-   `--push` pushes the image. When the current buildx builder can build `linux/arm64` (a `docker-container` builder, made with `docker buildx create --use`), it builds and pushes `linux/amd64` and `linux/arm64` together. Otherwise it pushes the `linux/amd64` image it built.
-   `--publish` publishes the GitHub release instead of leaving a draft. The image has to be in the registry, so use it with `--push`, or after an earlier `--push`.

`--local` stops after step 6, so nothing leaves the machine. A pre-release such as `1.1.0-rc.1` gets no `:latest` tag and is marked as a pre-release.

A run that stopped part way can be started again with the same version. When the release commit is already tagged on this machine, `pnpm release X.Y.Z` reuses it and skips the steps that are done, for example `pnpm release 1.0.0 --push --publish` after a draft run.

The release commit is pushed straight to `main`. When `main` requires pull requests, the maintainer who cuts releases needs to be allowed to bypass that rule.

## Publish the npm packages

GitHub Actions does not publish to npm. After the image is in the registry (`pnpm release --push`, or `--push --publish`), a maintainer publishes two packages from that same checkout:

-   `cuttlely` (`packages/cli`) is the Docker launcher. `npx cuttlely` pulls `ghcr.io/cuttlely/cuttlely` at the package's version tag.
-   `@cuttlely/chat` (`packages/chat-widget`) is the embeddable chat widget.

The server itself is not an npm package. The image carries the Python agent runtime.

`NPM_TOKEN` is an npm access token for the cuttlely org, provided as an environment variable. It is not stored in this repository. `pnpm release` already builds the widget. If `packages/chat-widget/dist` is missing, run `pnpm --dir packages/chat-widget build` first.

```bash
npm publish packages/cli --userconfig <(printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN")
npm publish packages/chat-widget --userconfig <(printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN")
```

Both packages set `publishConfig.access` to `public`. There is no publish workflow.
