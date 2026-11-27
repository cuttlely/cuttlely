# Testing a saved team on Kraken

Kraken is the development branch for the 2.0 agent runtime. The standard image selects the bundled runtime by default. Use it to canary one team at a time. Keep the full image and its exact revision available for rollback.

## Checking a team before cutover

Export the saved harness canvas, then run the following command inside a built Kraken checkout or image. The command accepts a single export, a JSON array, or `-` for standard input.

```sh
node scripts/kraken-preflight.mjs ./team.canvas.json
```

Exit code 0 means the graph passed the capability check and is ready for a runtime test. Exit code 1 lists the specialists and assignments that need the bundled runtime. Exit code 2 identifies an unreadable or invalid export or an input containing no harness. Exit code 3 means the export needs an installation check for a playbook or file-enabled role. The export cannot prove which generation owns host files. A valid saved team name lets the preflight report matching local workspace files as observations. Run the saved team on the target installation and exercise the assigned file or playbook before cutover. Public Live prediction can use the published team's verified read-only playbook companions. A saved draft uses that caller's separate Try profile, including when its graph matches Live.

Run the check on the target worker image. It reads the exported assignments and probes local prerequisites for workspace files. Live credentials, host permissions, stored memory and destination-specific query stamps still need a rehearsal on the target installation.

## Enabling a canary

1. Upgrade the API and every harness worker to the same Kraken build. Keep a backup of the application database, managed files and installation encryption key.
2. Choose a saved team and set `CUTTLELY_NATIVE_PRIME_TEAMS` to its exact saved name on every process that admits turns. Separate multiple names with commas. Restart those processes.
3. Submit a known question through the chat or API your clients use. Check the answer, source documents, any attachment downloads and the run trace. Repeat with an existing chat and with a new chat. The native trace includes `engine: native`.
4. Run another turn after replacing a worker. Each queued turn carries the engine chosen when it was admitted. Jobs created by older releases use the bundled engine.

Selection applies to both router and agent mode. Native preflight checks every specialist in the team. A `native_unsupported` error identifies the affected specialists and saved capabilities before a model or tool runs. A supported configuration can still fail at execution if a credential is revoked, a destination is unavailable, or a query needs to be tested against its destination again.

## Supported configurations

| Saved configuration                         | Behavior to check                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prime, model-only specialist and Calculator | Prime delegates to the assigned roster. Primary and fallback models use their saved credential bindings. The trace records the model that answered.                                                                                                                                                                                            |
| Saved Markdown playbooks                    | The specialist can list its assigned playbooks, read them in pages, resolve the session and skill directory templates, and open verified read-only companion files.                                                                                                                                                                            |
| Current Date Time                           | The saved timezone and the tool call’s timezone use the existing node implementation.                                                                                                                                                                                                                                                          |
| Retriever Tool                              | Supported saved Pinecone retrievers use the assigned OpenAI embeddings node, stored credentials and the admitted chat’s upload scope. Source documents returned by the card accompany the API result.                                                                                                                                          |
| SerpAPI                                     | A bound card searches using its saved credential. A missing credential appears in the cutover report. With no host search key, agent mode can use another tool and the inline router reports a specialist failure when preparing the missing tool. If the old deployment supplied a host search key, select a saved credential before cutover. |
| Packaged Ops MCP example                    | The specialist can discover and call the saved read-only action. The host’s stdio policy and command/script grants still apply. Cancellation closes the tool process.                                                                                                                                                                          |
| PostgreSQL Analyst                          | Eligible URL-backed cards expose their configured guarded actions and verified saved queries. Destination-specific stamps, selected relations, secure parameters, query budgets and chat-scoped paging remain in force. A trusted report requires evidence from the actual query. Check the content and owner of each returned attachment.     |

The Web Browser card’s **Return source text** mode reads a public HTTP(S) page whose URL the caller includes in the current message. The reader follows same-site redirects, checks every network destination and returns bounded text and source metadata. The link must be present in the original message even when Prime rewrites the specialist’s task. Interactive browser automation and links selected solely by the model still require the bundled runtime.

### Playbook references on replacement workers

The normal `skill_view` call expands `${HERMES_SESSION_ID}` for the current specialist turn and `${HERMES_SKILL_DIR}` to `/skills/harness-playbooks/<book>`. Reading `SKILL.md` by its explicit file path returns the original Markdown. A saved canvas carries the playbook body. For an operator-provided companion, put the same immutable file on each worker and include its digest and assignment in the host manifest selected by `CUTTLELY_HOST_FILE_MANIFEST`.

```json
[
    {
        "path": "runtime/profiles/demo--reader/skills/harness-playbooks/handbook/references/guide.md",
        "sha256": "<64 lowercase hexadecimal digits>",
        "playbook": {
            "workspaceId": "<saved workspace id>",
            "chatflowId": "<saved harness canvas id>",
            "generation": "<createdAt from the saved harness record>"
        }
    }
]
```

The example assigns `references/guide.md` to the `handbook` playbook of specialist `reader` on team `demo`. An owned draft also needs its exact `tryId` and draft profile path. Older manifest rows containing only a path and digest need a separate matching digest for the compiled parent harness-roster.json, with the same canvas generation and saved assignment. Rehearse on a replacement worker with the same manifest and files. Preflight reports unresolved dependencies. Inline shell execution in a playbook requires the bundled runtime. If the saved team changes during a run that uses a playbook, the worker checks the revision again before sending more answer text or attachments. A client can retry on the new revision.

### Workspace MCP status endpoint

A saved Custom MCP Server Tool can use Streamable HTTP or SSE for the read-only `ops_status` action. Register its exact workspace, saved server ID, URL and action on the API and the workers using `CUTTLELY_NATIVE_MCP_ENDPOINTS`. An example configuration follows.

```json
[{ "workspaceId": "<workspace>", "serverId": "<saved-server-uuid>", "url": "https://ops.example.org/mcp", "actions": ["ops_status"] }]
```

For SSE, add `ssePostUrl` with the exact same-origin message endpoint. Keep the Authorization or X-API-Key header in the existing encrypted server credential. The runtime checks the server record, grant and tool schema before dispatch. A missing grant, revoked credential or changed schema stops the action. An offline export needs its saved workspace ID to match this grant during preflight.

### Specialist workspace files

On a supported Linux host, a file-enabled specialist can read, write, search and patch its own workspace and return files saved under `output/` to the chat. Use a signed-in account or an identified API key. Upload a representative file through the chat, ask the specialist to transform it, download the result and check the bytes. Repeat under the original identity after replacing a worker. Other users and keys may choose the same chat ID and retain separate workspaces.

Each workspace is limited to 256 files and 64 MiB of decoded content. It uses the selected harness session store. PostgreSQL preserves these workspaces across empty-disk replacements. SQLite requires a retained data volume. The image ships a fixed document decoder and search binary. The worker requires Linux Landlock ABI 3 or later and libseccomp. On a host that cannot enforce the file boundary, preflight identifies the team as requiring the bundled engine. A configured hosted OCR service or language server is a separate dependency. Preflight reports these settings so the operator can retain the full runtime for teams that use them. Rehearse with the documents the team processes, including scanned PDFs.

An existing shared workspace may contain files without a reliable owner. A nonempty legacy workspace blocks this team’s native cutover. Back it up, review its contents, and re-upload the required files through the owner's chat before retiring the original workspace. Preserve older copies until the owner confirms the required outputs.

### Reporting on an uploaded CSV

An authenticated chat or API client can attach a CSV and ask for a table or bar chart. Use a specialist with File Access and an eligible PostgreSQL Analyst query grant. The report tool reads the verified original upload, including small CSVs that the chat displays inline. Each worker must be able to reopen the original stored bytes. PostgreSQL and hybrid installations use their configured file store. A changed file fails verification and the caller can send it again.

For example, ask “From the attached CSV, group by Region, sum Net, and return the table and a bar chart.” The response identifies the source, counted rows and groups, and includes a downloadable CSV and optional PNG. Supported operations are count, sum, mean, minimum and maximum. Means round to eight decimal places. The calculation supports 4 MiB, 50,000 rows and 250 groups, with up to 40 groups in a chart. A database request still needs its own database result. Protected saved-query outputs keep their existing verification rules.

For a PDF, Word document or Excel workbook, ask for the format by name. The report tool accepts `documentFormats` with one or more of `pdf`, `docx` and `xlsx`. Each document uses the same verified rows and totals as the CSV. Excel preserves high-precision decimal values as text. Each specialist can return up to four report files per turn, including the CSV, plus its chart. If the fixed PDF font cannot display a label, request the Word or Excel version.

The Docker image includes the Linux document renderer. For a source installation, install its pinned dependencies with `/usr/bin/python3 scripts/install-native-report-assets.py /opt/cuttlely-report-assets` and provide the DejaVu Sans regular and bold fonts. If the operator selects another dependency directory, set `CUTTLELY_NATIVE_REPORT_ASSETS` to the same absolute path on each worker. Rehearse an actual download after replacement.

### Primary and fallback model responses

A specialist with a single model streams text as it arrives. When a primary and fallback can compete, the native runtime waits for a winner before sending that specialist’s text. A slow primary or backup may already have generated a different draft. The client receives the selected answer once. Inspect the run trace to see which model answered and its token usage. If the provider omits usage, the count is unknown. A reported zero for cached prompt tokens is retained.

For custom streaming clients, `harness.final` contains the complete answer. Render it as the completed message. Appending it to the accumulated partial text will duplicate the answer. In agent mode, v1.7.15 could flush a buffered partial after the final event. Native flushes that text before the final event. Both engines send `harness.recorded` when conversation metadata is available.

### Conversation search

Signed-in users and identified API keys can use `session_search` on a saved agent-mode team for user/assistant exchanges whose ownership the installation recorded. Test with an existing chat, switch engines, then ask for a specific earlier answer. Verify a second caller and a different chat cannot retrieve it. A successful v1.7.15 queued turn can establish ownership when its saved caller, workspace, canvas generation and chat agree. An old bundled transcript can also exist without that association. Keep the bundled installation available for older transcripts or profile-wide memory awaiting operator review. The application’s ordinary stored chat messages, the search index and the bundled runtime’s private transcript have different recovery and access rules.

### If a worker stops during a tool call

Queued native calls record their selection, dispatch and acknowledgement in the application queue. If a worker disappears before acknowledgement, the job reports an uncertain outcome and retains the call ID for investigation. Check the destination before retrying an external action. A call still queued has not reached its tool. A confirmed call has already returned to the worker. The public event stream keeps its existing event types. Call arguments and tool results are excluded from these receipts.

A successful preflight establishes that the runtime recognizes the saved configuration. Exercise the actual question and tools. A direct Prime answer alone does not test specialist execution.

## Previewing an installation without the bundled runtime

Run the named-team canary and the team’s real workflow first. A native-only image selects the native engine for every team. A team that requires a capability absent from the native engine receives a runtime-unavailable response. On the standard image, keep that team on the bundled engine.

Build the preview locally with the same source revision on the API and workers.

```sh
docker build --build-arg INCLUDE_BUNDLED_RUNTIME=0 -t cuttlely-native .
```

Use the normal image entrypoint. The application starts the native runtime directly. An external worker starts with `node packages/harness/worker.mjs`. Set `CUTTLELY_HARNESS_QUEUE=external` and `CUTTLELY_HARNESS_WORKERS=0` on the API when deploying workers as separate services. Keep the API and worker on the same application database and installation key. Confirm strict readiness at `/api/v1/ping`, submit a real team run, and check the worker’s resulting answer and tool trace. A fresh data directory is sufficient after a verified PostgreSQL storage cutover. SQLite needs a retained volume. Hybrid uses the same durable PostgreSQL stores and the configured private object bucket for managed files. Operator-provided local dependencies still need to be available on each replacement host.

The native image can be built from a checkout that omits the entire bundled runtime source directory. It ships the Cuttlely-authored recovery helper from the ETL package. The full-checkout compatibility gate checks that this file matches its copy in the bundled runtime byte for byte. The image uses that recovery code for encrypted runtime settings and SQLite session images stored in PostgreSQL. An incorrect installation key stops recovery. To roll back, drain native jobs and redeploy the full image on the API and every worker with the same database and key. Clear any named canary selection before admitting bundled jobs. A binary rollback and a storage rollback are separate operations.

Run `bash scripts/check-kraken-package.sh` from a full, built checkout to create the isolated source export and exercise the complete package gate. The gate needs the pinned Node and pnpm, disposable PostgreSQL and a standalone Python with sqlite3 serialization, pg8000 and cryptography. Set `CUTTLELY_RECOVERY_PYTHON` to that interpreter when it differs from `python3`. The script removes its temporary install on exit.

To verify an existing local native build, set `CUTTLELY_TEST_NATIVE_PACKAGE` to the absolute path of the separate installed native package and run the following command in a built full checkout with the bundled runtime available. The tests start their own API and worker, use disposable PostgreSQL databases and simulate the model.

```sh
node --test scripts/kraken-ops.test.mjs scripts/kraken-upgrade.test.mjs
```

The package gate covers a fresh install and replacement of an existing installation with separate empty API and worker disks. It checks the saved caller, team, credential, schedule and chat, exercises the Ops MCP tool and restores encrypted settings and a real bundled SQLite transcript. It also checks rejection of an incorrect key and recovery after redeploying the full package.

## Rollback

Remove the team name from `CUTTLELY_NATIVE_PRIME_TEAMS` and restart the admitting processes. New turns use the bundled runtime. Let previously admitted turns drain on their recorded engine before removing their workers. Continue the same chat and check that the prior response and any stored attachments are available. Engine selection does not change the application's storage mode.

On a PostgreSQL installation, rehearse a question that requires the bundled chief to delegate. Check that the run records the intended specialist as completed and that the answer contains the expected tool result. A direct answer from the chief cannot establish this. For the published read-only Ops example, keep the operator’s existing grants for the saved command and script on every worker.

The full Kraken build can record bundled specialist progress in PostgreSQL for published agent-mode teams that use directly assigned chat models with basic generation options and model-only specialists or the packaged read-only Ops action. The progress record belongs to the live chat turn and saved team revision. Drafts, custom modules, other MCP actions, preset roles, playbooks and file-enabled roles need their own rollback rehearsal. Keep the previous working deployment and its storage available until that rehearsal succeeds.

## Verification

Run `pnpm harness:check` and `pnpm verify` on the Node version in `.nvmrc`. Configure the disposable PostgreSQL fixtures as described in the repository test setup. The Kraken suites exercise saved chatflow prediction, external workers, cancellation, PostgreSQL queries, trusted outputs, managed attachments, empty-disk replacement and rollback. Provider calls in these compatibility fixtures are simulated.
