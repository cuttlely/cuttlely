# cuttlely.com

The Cuttlely website: a home page plus the docs from this repository, built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build). It is a static site with no analytics and nothing loaded from other sites.

The docs are written in [`docs/`](../docs) and nowhere else. Before every build, `scripts/sync-docs.mjs` copies them into `src/content/docs/` (gitignored), together with the quickstart section of the README, `CHANGELOG.md`, `FAQ.md`, `SECURITY.md`, `CREDITS.md` and `NOTICE`. Links between repository files become site links, and links to code go to GitHub. The sidebar follows the groups in `docs/README.md`.

Content screenshots on the home page and in the docs open in a full-screen viewer (zoom, pan, keyboard and touch). With JavaScript off, the same images are links to the full image file. Logos, icons and the mascot are not part of that.

Home page videos show the poster on first load. Sources stay detached and nothing plays until the visitor clicks play. A play button sits on the hero, the testing section, and each product tile. The testing section uses the same in-place player as the hero. The hero button is centred. The tile button is smaller than the hero button and sits just left of the product name in the preview. The button starts that video from the beginning with sound and pauses any other video. After that click, a product-tile silent loop may play, one at a time, while that tile is on screen, unless Save-Data, reduced motion, or a narrow screen is on. A hero that was playing with sound returns to the poster, button included. Scrolling that video off screen ends the sound session. Closing a dialog, the narration ending, a media error on that video, or the play being refused can start one on-screen silent loop. An error on any other video leaves the session running. A refused hero play returns the poster. A refused dialog play ends the narration and leaves its sources attached, so the next open plays the file. A volume the visitor set is left as it is. A tile's "Watch with sound" control opens its narrated video. With JavaScript off, that link still opens the file. Captions stay on the testing video.

## Run it

Node 22.22 or newer. The website has its own dependencies and lockfile, separate from the pnpm workspace.

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
| `/faq/`                  | The public FAQ, copied from the repository `FAQ.md`                                          |
| `/flowise/`              | Flowise import page (`src/pages/flowise.astro`). `/migrate/` redirects here                  |
| `src/components/`        | Header links, hero, footer, screenshot images and the Starlight components the site replaces |
| `src/scripts/`           | Screenshot viewer (bundled module, no inline script)                                         |
| `src/styles/`            | Brand colors (Cuttle Violet, light and dark) and the site layout                             |
| `src/assets/`, `public/` | Logos, mascot, icons, link preview images and the Urbanist font (SIL OFL)                    |
| `scripts/sync-docs.mjs`  | Copies the docs in and rewrites links                                                        |
| `scripts/check-site.mjs` | Checks the built site                                                                        |
| `render.yaml`            | The Render static site: build, headers and redirects                                         |

## Hosting

The site is a free Render static site named `cuttlely-site`, created from `website/render.yaml` (Blueprint Path `website/render.yaml`; the root `render.yaml` is the Cuttlely Blueprint for users). Render builds with `cd website && npm ci && npm run build` from the repository root, publishes `website/dist`, and redeploys when `website/`, `docs/` or the root docs files change. When a build fails, the last good site stays live.
