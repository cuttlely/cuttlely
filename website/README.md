# cuttlely.com

The Cuttlely website: a home page plus the docs from this repository, built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build). It is a static site with no analytics and nothing loaded from other sites.

The docs are written in [`docs/`](../docs) and nowhere else. Before every build, `scripts/sync-docs.mjs` copies them into `src/content/docs/` (gitignored), together with the quickstart section of the README, `CHANGELOG.md`, `SECURITY.md`, `CREDITS.md` and `NOTICE`. Links between repository files become site links, and links to code go to GitHub. The sidebar follows the groups in `docs/README.md`.

## Run it

Node 22.12 or newer. The website has its own dependencies and lockfile, separate from the pnpm workspace.

```bash
cd website
npm ci
npm run dev       # http://localhost:4321, after copying the docs
npm run build     # copy the docs, build to dist/, then check the result
npm run preview   # serve dist/
npm test          # unit tests for the build scripts
```

`npm run build` ends with `scripts/check-site.mjs`, which fails the build when:

-   an internal link or `#anchor` does not exist
-   a page loads an image, script or stylesheet from another site
-   an inline script is not listed in the Content-Security-Policy in `render.yaml`

`pnpm verify` at the repository root runs the unit tests and checks every docs link (`node website/scripts/sync-docs.mjs --check-only`) without installing the website.

## What is where

| Path                     | What it is                                                                |
| ------------------------ | ------------------------------------------------------------------------- |
| `src/pages/index.astro`  | The home page                                                             |
| `src/pages/404.astro`    | The page for unknown addresses                                            |
| `src/components/`        | Header links, hero, footer and the Starlight components the site replaces |
| `src/styles/`            | Brand colors (Cuttle Violet, light and dark) and the site layout          |
| `src/assets/`, `public/` | Logos, mascot, icons, link preview images and the Urbanist font (SIL OFL) |
| `scripts/sync-docs.mjs`  | Copies the docs in and rewrites links                                     |
| `scripts/check-site.mjs` | Checks the built site                                                     |
| `render.yaml`            | The Render static site: build, headers and redirects                      |

## Hosting

The site is a free Render static site named `cuttlely-site`, created from `website/render.yaml` (Blueprint Path `website/render.yaml`; the root `render.yaml` is the Cuttlely Blueprint for users). Render builds with `cd website && npm ci && npm run build` from the repository root, publishes `website/dist`, and redeploys when `website/`, `docs/` or the root docs files change. When a build fails, the last good site stays live.
