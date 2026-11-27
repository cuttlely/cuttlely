# Testing a saved team on Kraken

Kraken is the development branch for the 2.0 agent runtime. The bundled runtime remains the default. Keep it available during a canary and rollback.

## Enabling a canary

1. Upgrade the API and every harness worker to the same Kraken build. Keep a backup of the application database, managed files and installation encryption key.
2. Choose a saved team and set `CUTTLELY_NATIVE_PRIME_TEAMS` to its exact saved name on every process that admits turns. Separate multiple names with commas. Restart those processes.
3. Submit a known question through the chat or API your clients use. Check the answer, source documents, any attachment downloads and the run trace. Repeat with an existing chat and with a new chat. The native trace includes `engine: native`.
4. Run another turn after replacing a worker. Each queued turn carries the engine chosen when it was admitted. Jobs created by older releases use the bundled engine.

Selection applies to both router and agent mode. Native preflight checks every specialist in the team. A `native_unsupported` error identifies the affected specialists and saved capabilities before a model or tool runs. A supported configuration can still fail at execution if a credential is revoked, a destination is unavailable, or a query needs to be tested against its destination again.

## Supported configurations

| Saved configuration                         | Behavior to check                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prime, model-only specialist and Calculator | Prime delegates to the assigned roster. Primary and fallback models use their saved credential bindings. The trace records the model that answered.                                                                                                                                                                                        |
| Saved Markdown playbooks                    | The specialist can list its own playbooks, read their Markdown in pages and reread an earlier page. Bundled-runtime directory and session templates require the bundled engine.                                                                                                                                                            |
| Current Date Time                           | The saved timezone and the tool call’s timezone use the existing node implementation.                                                                                                                                                                                                                                                      |
| Retriever Tool                              | Supported saved Pinecone retrievers use the assigned OpenAI embeddings node, stored credentials and the admitted chat’s upload scope. Source documents returned by the card accompany the API result.                                                                                                                                      |
| SerpAPI                                     | The saved fixed-endpoint search card requires its selected credential. Check imported credential bindings before cutover.                                                                                                                                                                                                                  |
| Packaged Ops MCP example                    | The specialist can discover and call the saved read-only action. The host’s stdio policy and command/script grants still apply. Cancellation closes the tool process.                                                                                                                                                                      |
| PostgreSQL Analyst                          | Eligible URL-backed cards expose their configured guarded actions and verified saved queries. Destination-specific stamps, selected relations, secure parameters, query budgets and chat-scoped paging remain in force. A trusted report requires evidence from the actual query. Check the content and owner of each returned attachment. |

A successful preflight establishes that the runtime recognizes the saved configuration. Exercise the actual question and tools. A direct Prime answer alone does not test specialist execution.

## Rollback

Remove the team name from `CUTTLELY_NATIVE_PRIME_TEAMS` and restart the admitting processes. New turns use the bundled runtime. Let previously admitted turns drain on their recorded engine before removing their workers. Continue the same chat and check that the prior response and any stored attachments are available. Engine selection does not change the application's storage mode.

## Verification

Run `pnpm harness:check` and `pnpm verify` on the Node version in `.nvmrc`. Configure the disposable PostgreSQL fixtures as described in the repository test setup. The Kraken suites exercise saved chatflow prediction, external workers, cancellation, PostgreSQL queries, trusted outputs, managed attachments, empty-disk replacement and rollback. Provider calls in these compatibility fixtures are simulated.
