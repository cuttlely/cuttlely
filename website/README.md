# cuttlely.com

The Cuttlely website: a home page plus the docs from this repository, built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build). It is a static site with no analytics and nothing loaded from other sites.

The docs are written in [`docs/`](../docs) and nowhere else. Before every build, `scripts/sync-docs.mjs` copies them into `src/content/docs/` (gitignored), together with the quickstart section of the README, `CHANGELOG.md`, `SECURITY.md`, `CREDITS.md` and `NOTICE`. Links between repository files become site links, and links to code go to GitHub. The sidebar follows the groups in `docs/README.md`.

Content screenshots on the home page and in the docs open in a full-screen viewer (zoom, pan, keyboard and touch). With JavaScript off, the same images are links to the full image file. Logos, icons and the mascot are not part of that.

Home page videos keep a silent looping preview, or the poster when autoplay is off, with a play button over the hero and each product tile. The hero button is centred. The tile button is smaller than the hero button and sits just left of the product name in the preview. The button starts that video from the beginning with sound and pauses any other video. A hero that was playing with sound returns to the silent preview, button included. Closing a dialog, or the hero narration ending, resumes on-screen previews the loading queue has already started, and does not fetch the ones still waiting. A volume the visitor set is left as it is. The hero plays in place, and returns to its poster when autoplay is off. A tile opens its narrated video. With JavaScript off, the tile's "Watch with sound" link still opens the file.

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

| Path                     | What it is                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `src/pages/index.astro`  | The home page                                                                                |
| `src/pages/404.astro`    | The page for unknown addresses                                                               |
| `src/components/`        | Header links, hero, footer, screenshot images and the Starlight components the site replaces |
| `src/scripts/`           | Screenshot viewer (bundled module, no inline script)                                         |
| `src/styles/`            | Brand colors (Cuttle Violet, light and dark) and the site layout                             |
| `src/assets/`, `public/` | Logos, mascot, icons, link preview images and the Urbanist font (SIL OFL)                    |
| `scripts/sync-docs.mjs`  | Copies the docs in and rewrites links                                                        |
| `scripts/check-site.mjs` | Checks the built site                                                                        |
| `render.yaml`            | The Render static site: build, headers and redirects                                         |

## Hosting

The site is a free Render static site named `cuttlely-site`, created from `website/render.yaml` (Blueprint Path `website/render.yaml`; the root `render.yaml` is the Cuttlely Blueprint for users). Render builds with `cd website && npm ci && npm run build` from the repository root, publishes `website/dist`, and redeploys when `website/`, `docs/` or the root docs files change. When a build fails, the last good site stays live.
