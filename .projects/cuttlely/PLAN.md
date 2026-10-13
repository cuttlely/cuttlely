# Plan

## Milestones

| #   | Milestone                                                                                        | State                                                                                             |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 1   | Agent teams: named harnesses with isolated profiles, a thin scheduler, any chat model (D3 to D9) | Done                                                                                              |
| 2   | Fast serving: streaming, turn budget, fallback model, context budgets, run report (D13, D14)     | Done                                                                                              |
| 3   | Harness queue and external workers (D15)                                                         | Done. The default stays `inline` until a live credentialed run on `external` is observed          |
| 4   | Harness runs page, playground and run traces                                                     | Done                                                                                              |
| 5   | Analyst with isolated storage and paging (D23, D24)                                              | Done. A dedicated analyst node is designed, not built (OPEN)                                      |
| 6   | Knowledge pipelines (ETL) with every store, splitter and embeddings node (D16, D17)              | Done. Live runs against hosted stores and some sources are still open (OPEN)                      |
| 7   | Prediction uploads and large-file path stubs (D18)                                               | Done                                                                                              |
| 8   | Sign-in, teams, roles and workspace scoping (D19 to D22)                                         | Done                                                                                              |
| 9   | Drafts, version history, the publish check, a copy in GitHub, Dev to Prod (D25, D26)             | Done. A single-file export bundle and a version id on each run are not built                      |
| 10  | Own chat widget for share links and embeds (D33)                                                 | Done                                                                                              |
| 11  | API guide and example web app                                                                    | Done                                                                                              |
| 12  | First ten minutes: Try the demo, your own key by default, start-up progress (D34)                | Done                                                                                              |
| 13  | Admin panel for server settings (D35)                                                            | Done                                                                                              |
| 14  | No call home and our own model list (D32)                                                        | Done                                                                                              |
| 15  | Release tooling, changelog, upgrade tests and Compose image fallback (D30, D31)                  | Done                                                                                              |
| 16  | Brand, theme and screenshots (D38)                                                               | Done                                                                                              |
| 17  | Fix the open issues                                                                              | Done. Closed issues stay in the tracker                                                           |
| 18  | First public release, v1.0.0                                                                     | Done. 1.0.1, 1.0.2, and 1.0.3 followed. 1.0.3 is the current tag, GitHub release, and npm version |
| 19  | Builder UI for harness credentials and MCP servers                                               | Later                                                                                             |
| 20  | Convert remaining `adapt` catalog rows when a harness needs them (D5)                            | Later, never blocking                                                                             |
| 21  | Project website with the docs (`website/`)                                                       | Built. Publishing it is a maintainer step                                                         |

## Next concrete tasks

1. **After v1.0.1.** Check whether GitHub Actions runs on pull requests, and if it does, decide whether it joins the merge gate (OPEN). Repository settings for the release are still to turn on (OPEN).
2. **Live checks that need real credentials.** A live credentialed run on `CUTTLELY_HARNESS_QUEUE=external` before switching its default; a live ETL run against a hosted vector store; a live upload-harness turn on a large file. Never invent keys; use a maintainer's test credentials.
3. **Later.** The canvas card look: both compact and classic cards are offered (`CANVAS_CARD_LOOK`); decide after the first release whether classic stays. The dedicated analyst node. A builder UI for harness credentials and MCP servers. The Usage page shows daily tokens and estimated cost per flow. Estimated cost is on that route, on the page, and on the Publish check (D62).
