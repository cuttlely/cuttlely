# Cuttlely brand files

The logos, icons and images the product, the README and the docs use. The server serves the app's copies itself; nothing loads from a CDN.

## Files

| File                                                   | Use                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `logo/cuttlely-logo-horizontal.svg`, `-dark.svg`       | The usual logo: the C-wave mark and the wordmark, for light and dark backgrounds |
| `logo/cuttlely-logo-stacked.svg`, `-dark.svg`          | Mark above the wordmark, for square spaces                                       |
| `logo/cuttlely-mark.svg`                               | The C-wave mark in color. `-white.svg` and `-black.svg` are one-color versions   |
| `logo/cuttlely-mark-small.svg`                         | The mark for 32px and below (one bubble, so it stays clean)                      |
| `logo/cuttlely-wordmark-ink.svg`, `-white.svg`         | The wordmark alone                                                               |
| `readme/cuttlely-readme-header-light.png`, `-dark.png` | README header                                                                    |
| `social/cuttlely-og-light.png`, `-dark.png`            | Link preview cards, 1200x630                                                     |
| `social/cuttlely-github-social-preview.png`            | Repository social preview, 1280x640                                              |
| `social/cuttlely-avatar-500.png`                       | Organization and profile avatar                                                  |

In the app: `packages/ui/src/assets/images/brand/` (header logo, mark, mascot poses) and `packages/ui/public/` (favicons, home-screen icons, link preview card, `manifest.json`). The chat widget draws the small mark inline (`packages/chat-widget/src/icons.js`).

## Rules

-   The C-wave mark is the icon everywhere: favicon, app icons, avatars and small spots in the UI.
-   Use the color mark with dark text on light backgrounds and with white text on dark backgrounds. Use the white or black versions on photos or colored backgrounds.
-   Leave clear space around a logo at least as tall as the "C" in the wordmark. The horizontal logo is at least 96px wide; the mark is at least 16px.
-   Don't recolor, stretch, rotate or add effects to the logos, and don't retype the wordmark.
-   The cuttlefish mascot is for large, friendly moments only (first run, empty states, error pages) and is never shown smaller than 96px. Neutral is the default, wink means success, laptop means building or loading, lightbulb is a tip, goggles is a demo.

## Colors

| Name                       | Hex       |
| -------------------------- | --------- |
| Cuttle Violet (main)       | `#6A3DF2` |
| Indigo                     | `#5C60F9` |
| Ocean Blue                 | `#5380FC` |
| Sky                        | `#5FB3FD` |
| Ink (text on light)        | `#0A0D1E` |
| Midnight (dark background) | `#0C0F26` |
| Mist (light background)    | `#F5F8FE` |

## Type

The wordmark is set in Urbanist ExtraBold (SIL Open Font License 1.1) and converted to outlines, so the logo files need no font.
