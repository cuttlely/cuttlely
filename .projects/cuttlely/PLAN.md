# Plan

## Milestones

| #   | Milestone                                                                                        | State                                                                                    |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1   | Agent teams: named harnesses with isolated profiles, a thin scheduler, any chat model (D3 to D9) | Done                                                                                     |
| 2   | Fast serving: streaming, turn budget, fallback model, context budgets, run report (D13, D14)     | Done                                                                                     |
| 3   | Harness queue and external workers (D15)                                                         | Done. The default stays `inline` until a live credentialed run on `external` is observed |
| 4   | Harness runs page, playground and run traces                                                     | Done                                                                                     |
| 5   | Analyst with isolated storage and paging (D23, D24)                                              | Done. A dedicated analyst node is designed, not built (OPEN)                             |
| 6   | Knowledge pipelines (ETL) with every store, splitter and embeddings node (D16, D17)              | Done. Live runs against hosted stores and some sources are still open (OPEN)             |
| 7   | Prediction uploads and large-file path stubs (D18)                                               | Done                                                                                     |
| 8   | Sign-in, teams, roles and workspace scoping (D19 to D22)                                         | Done                                                                                     |
| 9   | Drafts, version history, the publish check, a copy in GitHub, Dev to Prod (D25, D26)             | Done. A single-file export bundle and a version id on each run are not built             |
| 10  | Own chat widget for share links and embeds (D33)                                                 | Done                                                                                     |
| 11  | API guide and example web app                                                                    | Done                                                                                     |
| 12  | First ten minutes: Try the demo, your own key by default, start-up progress (D34)                | Done                                                                                     |
| 13  | Admin panel for server settings (D35)                                                            | Done                                                                                     |
| 14  | No call home and our own model list (D32)                                                        | Done                                                                                     |
| 15  | Release tooling, changelog, upgrade tests and Compose image fallback (D30, D31)                  | Done. No release is cut yet                                                              |
| 16  | Brand, theme and screenshots (D38)                                                               | Done                                                                                     |
| 17  | Fix the open issues                                                                              | In progress. See the issue list                                                          |
| 18  | First public release, v1.0.0                                                                     | Next                                                                                     |
| 19  | Builder UI for harness credentials and MCP servers                                               | Later                                                                                    |
| 20  | Convert remaining `adapt` catalog rows when a harness needs them (D5)                            | Later, never blocking                                                                    |
| 21  | Project documentation website                                                                    | Planned after the first release                                                          |

## Next concrete tasks

1. **Open issues.** Work through the [open issues](https://github.com/cuttlely/cuttlely/issues): [#2](https://github.com/cuttlely/cuttlely/issues/2) signed download links, [#6](https://github.com/cuttlely/cuttlely/issues/6) persistent rate limits and [#10](https://github.com/cuttlely/cuttlely/issues/10) dependency advisories. Check open pull requests before starting one; another contributor may already have it in review.
2. **Release v1.0.0.** A maintainer runs `pnpm release --dry-run`, then `pnpm release`, then `--push --publish` (RUNBOOK, Release). Then: make the image public, check that the README Docker install pulls it, and set up branch protection with a bypass for the releasing maintainer (D30), secret scanning with push protection, and private vulnerability reporting.
3. **After v1.0.0.** Refresh the upgrade fixture from the v1.0.0 tag (D31). Check whether GitHub Actions runs on pull requests, and if it does, decide whether it joins the merge gate (OPEN).
4. **Live checks that need real credentials.** A live credentialed run on `CUTTLELY_HARNESS_QUEUE=external` before switching its default; a live ETL run against a hosted vector store; a live upload-harness turn on a large file. Never invent keys; use a maintainer's test credentials.
5. **Later.** The canvas card look: both compact and classic cards are offered (`CANVAS_CARD_LOOK`); decide after the first release whether classic stays. The dedicated analyst node. A builder UI for harness credentials and MCP servers.
