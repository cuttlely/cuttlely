# ETL

An ETL pipeline loads files, cleans them, splits them into chunks, embeds the chunks, and writes them to a vector store. Chat flows and harnesses then search that store with the **ETL Retriever** node. **ETL** in the sidebar lists your pipelines. Each pipeline is a canvas of nodes: a source, a text splitter, a transform, an embeddings model, and a store.

Use ETL when an answer has to come from your own data, such as a product catalog, a handbook, or a code repository, and that data changes over time. A run only embeds what changed since the last run, keeps every saved version, and can run on a schedule. For a single document you paste into one chat flow, a document store is enough. To answer from the data in a chat, connect the pipeline to a [harness](./harnesses.md) or a chatflow with the **ETL Retriever**.

Install first: [Docker](./docker.md), [From source](./from-source.md), or [Render](./render.md). The account is [Sign in](./sign-in.md). A canvas save stores a draft. **Publish** is what scheduled runs read, and that publish is kept in [Version history](./versioning.md). The canvas pictures here show classic cards, with every setting on the card, except the Build with AI pictures, which show compact cards. With the default compact cards, select a card to change the same settings in its side panel. See [Canvas cards](./canvas.md).

The steps below use the **Outdoor Catalog** sample: a CSV of 33 outdoor products in `samples/etl/data/outdoor-catalog.csv`. It embeds with **Local Hash Embeddings**, which run on the server with no provider key. The last part connects the pipeline to a harness with an OpenAI model.

## Open the ETL page

Select **ETL** in the sidebar. With no pipelines yet, the page says `No pipelines yet` and offers **Import Sample** and **New Pipeline**.

![The ETL page with no pipelines. The title is ETL, with the line Load, clean, split, embed, and store data for retrieval. Import Sample and New Pipeline are at the top right. A What are you building? card offers Agent team, Chat / simple AI app, Workflow / automation, and Knowledge / data pipeline. The empty state reads No pipelines yet, Import a sample, or start a blank pipeline.](../images/etl/etl-empty.png)

-   **Import Sample** opens a menu with the two samples from `samples/etl/`.
-   **New Pipeline** opens a blank ETL canvas. Add nodes with **+** (**Add Node**), then save.
-   On a blank canvas, **Build with AI** builds a pipeline from a description of your data. See [Build a pipeline with AI](#build-a-pipeline-with-ai).

You can also open **Templates** in the sidebar and select the **ETL** chip, or select **Knowledge / data pipeline** on the **What are you building?** card.

## Import a sample

1. Select **Import Sample**.
2. Select **Outdoor Catalog**.

![The Import Sample menu. Bakery Handbook: Reads the made-up bakery handbook (Markdown), splits it, and stores local hash embeddings. Used by the Try the demo team. Cuttlely Handbook: Reads this checkout as a repository, splits Markdown, and stores local embeddings. Outdoor Catalog: Loads a product CSV by SKU and stores it with local hash embeddings.](../images/etl/etl-import-sample.png)

The sample is saved as version 1 and opens on its canvas, `/etlcanvas/<id>`. **Paths** on the Streaming Files node is already set to the sample CSV in your install.

![The Outdoor Catalog canvas, marked Live. Recursive Character Text Splitter (Chunk Size 800, Chunk Overlap 80), Streaming Files (the outdoor-catalog.csv sample, Format CSV, key column sku), Clean & Transform (Minimum Characters 20), Local Vector Store (collection outdoor-catalog), and Local Hash Embeddings (Dimensions 384). Preview, Run, and Schedule sit at the top right.](../images/etl/etl-canvas-sample.png)

| Node                                  | What it does                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Streaming Files**                   | Reads files or folders on the server, one path per line. **Format** is CSV here. Each CSV row becomes one document.                   |
| **Recursive Character Text Splitter** | Cuts long documents into chunks. Chunk Size 800 and Chunk Overlap 80. A product row fits in one chunk.                                |
| **Clean & Transform**                 | Normalizes whitespace and Unicode (NFC), can strip HTML, and drops documents shorter than **Minimum Characters** (20).                |
| **Local Hash Embeddings**             | Builds 384-dimension vectors on the server. No key and no cost. It matches words, not meaning. See [Better matches](#better-matches). |
| **Local Vector Store**                | Stores the vectors in the collection `outdoor-catalog` under `CUTTLELY_ETL_DIR`.                                                      |

The header has **Version history**, **Save Pipeline**, and **Settings** at the top right. **Preview**, **Run**, and **Schedule** open the **Pipeline** panel on the matching tab. The panel's first line reads `v1 · 0 chunks indexed` until a run has written the store.

An orange triangle on a card and an orange **Sync Nodes** button next to **+** mean a node was saved with an older version of that node than the app has now. Select **Sync Nodes**, then save. The save stores a draft. **Publish** creates a new pipeline version.

## Build a pipeline with AI

Instead of adding nodes yourself, describe your data and let **Build with AI** put the pipeline together. These pictures show the default compact cards.

1. Open a blank ETL canvas with **New Pipeline**.
2. Select **Build with AI**, the sparkle button next to **+**.
3. Under **Describe your data**, write what to load and how people will search it. Give full paths on the server, in a folder a pipeline may read (see [Which folders a pipeline can read](#which-folders-a-pipeline-can-read)), name the id column of a CSV, and say which files of a repository you want. You can also select one of the three examples and edit it.
4. Under **Chat model that builds**, Cuttlely starts on a model you have a key for on the **Credentials** page, with your key picked when only one fits; **Show all … models** lists the rest, and **Only models for your keys** returns to that shorter list. **More settings** holds the advanced ones. There is no built-in key. Your choice is remembered for next time.
5. Select **Build**.

![The Build with AI dialog on a new ETL canvas. The line under the title reads It builds a first version you can change and saves it as a new pipeline. Every part is checked before it lands. Under Describe your data are three examples and a description of the outdoor catalog CSV at /workspace/samples/etl/data/outdoor-catalog.csv, with sku as the id. Chat model that builds is OpenAI, Show all 29 models, credential OpenAI main, model gpt-4.1-mini, temperature 0.9. Build is at the bottom right.](../images/etl/build-with-ai-dialog.png)

The builder uses the bundled pipelines as examples. Unless you name others, it uses **Local Hash Embeddings** and the **Local Vector Store**, so the pipeline runs with no provider key. Before anything is saved, it checks the plan and fixes what fails:

-   Every path is a full path on the server.
-   A CSV, TSV, or JSONL source names its id column, so a second run updates rows instead of adding them again.
-   One source line ends in exactly one store, and every card reaches it.
-   Each **Include** glob on a repository source has a slash. `README.md` would match every README in every folder, so the builder writes `/README.md` for the top-level file or `**/README.md` for all of them.

The pipeline is saved right away as a new pipeline, named after its title (with a number when the name is taken), and opens on its own canvas. A message says what was built. When a node needs a credential you don't have yet, the message names it.

![The built pipeline Outdoor Product Catalog ETL, last edited by Rosa Diaz, on the canvas with compact cards: Recursive Character Text Splitter (Chunk Size 1000, Chunk Overlap 200), Streaming Files (Format CSV, Key Column or Field sku), Clean & Transform (Minimum Characters 1), Local Vector Store (Collection outdoor-catalog), and Local Hash Embeddings (Dimensions 384). Preview, Run, and Schedule are at the top right.](../images/etl/build-with-ai-built.png)

Select a card to check or change its settings, then [preview](#preview-the-data) and [run](#run-the-pipeline) it as below. The builder also writes three starter searches. After the first run they wait under **Try retrieval** on the **Run** tab; select one to search.

![The Pipeline panel on the Run tab for Outdoor Product Catalog ETL, with v1 serving and 33 chunks indexed. Under Try retrieval the search box reads What are the best products for hiking?, and the three starter chips are What are the best products for hiking?, Show me camping gear with good reviews., and Which products are suitable for outdoor cooking?. The first result chip is score 0.122 from data/outdoor-catalog.csv, Talus Mid GTX Hiking Boot.](../images/etl/build-with-ai-search.png)

Build with AI always makes a new pipeline. When the canvas already has cards, the new pipeline opens in a new tab, so nothing on this canvas is lost. With classic cards, the same button builds the same pipeline with full-size cards. Harnesses and chatflows have the same button: see [Build a team with AI](./harnesses.md#build-a-team-with-ai) and [Build a chatflow with AI](./canvas.md#build-a-chatflow-with-ai).

## Drafts and Publish

A pipeline canvas saves to a **Draft**. Scheduled runs, **Start run**, and a full rebuild keep using the published pipeline until you **Publish**. The canvas says **Draft, not live yet** while a draft is waiting.

**Preview** is how you try the draft. It runs the canvas you are looking at, including edits you have not saved yet, and it does not write to the store. There is no separate dry run of **Start run**: that button writes to the store, and it writes the published pipeline, not the draft.

**Publish** opens a dialog that lists what changed, in the same words as version history: nodes added, nodes removed, and changed settings. A pipeline has no question check. **Discard draft** puts the published canvas back. **Roll back Live to this version** changes what runs read at once. **Open as draft** puts an older version on the canvas and leaves runs alone until you publish.

The first save of a new pipeline creates the published pipeline, so a run has something to read. The next canvas save is a draft. A pipeline that already exists stays as it is after an upgrade. The first edit after that starts a draft. `PUT /api/v1/chatflows/:id` still writes the published pipeline. A pipeline is the change-list row in [Which canvases get a check](./versioning.md#which-canvases-get-a-check). See [Drafts and Publish](./versioning.md#drafts-and-publish).

## Preview the data

Preview runs the pipeline on a few documents and shows what each step would produce. It uses the canvas, which is the draft when you have one, and it never writes to the store.

1. Select **Preview**.
2. Leave **Documents per source** at `5`, or pick `3`, `10`, or `25`.
3. Select **Refresh Preview**.

![The Preview tab. Documents per source is 5, Call embeddings is off, and Refresh Preview is below. Step 1 Load reads 5 documents from Streaming Files (1 files, 6.0 KB) and shows product cards with chips for chars, source, root, row, sku, and category. The first card is Ridgeline 2P Ultralight Tent, sku TNT-2P-ULT, category Tents.](../images/etl/etl-preview.png)

The preview has five numbered steps. Select a step to open it.

| Step                    | What it shows                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| **1 Load**              | The documents read from each source, with their metadata. CSV columns other than the text become chips. |
| **2 Clean & transform** | How many documents were kept and dropped.                                                               |
| **3 Split**             | The chunks and their sizes. A `new` chip marks a chunk that is not in the store yet.                    |
| **4 Embed**             | The embeddings model, its dimensions, and the time it took.                                             |
| **5 Store**             | `Written by a run. Preview never writes.`                                                               |

![The Preview tab with Split open: 5 chunks, avg 217 chars, min 198, max 250. Each chunk card has a violet new chip. The first open card is Ridgeline 2P Ultralight Tent, 250 chars, sku TNT-2P-ULT.](../images/etl/etl-preview-steps.png)

**Call embeddings** is off by default. Local Hash Embeddings always run in the preview. Turn it on to also call a provider embeddings model. That call is billed to the model's credential.

A problem shows as a red message above the steps, for example a path that does not exist. See [When a run fails](#when-a-run-fails).

## Run the pipeline

A run reads every source, embeds the chunks, and writes them to the store. Save the pipeline first. A run uses the published pipeline, not the draft. While the canvas has unsaved changes, the panel says `Save your changes first. A save stores a draft. Preview uses this canvas and does not write to the store.` After that save, and until you publish, it says `This run uses the published pipeline and writes to the store. The draft is not included until you Publish. Preview uses the draft and does not write.`

1. Select **Run**.
2. Leave **Incremental** selected.
3. Select **Start Run**.

![The Run tab before a run, v1 and 0 chunks indexed. New run has Incremental selected, with the caption Skips unchanged sources and chunks, embeds what changed, and deletes what disappeared. Batch size, Parallel batches, and Retries per batch are below, then the green Start Run button.](../images/etl/etl-run-new.png)

| Setting               | Meaning                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Incremental**       | Skips unchanged sources and chunks, embeds what changed, and deletes what disappeared. Use it for every normal run. |
| **Full rebuild**      | Re-embeds every chunk, then deletes what disappeared. Use it after you change the embeddings provider settings.     |
| **Batch size**        | Chunks per embeddings call. Default 64.                                                                             |
| **Parallel batches**  | Embeddings calls at the same time. Default 4. Lower it if the provider returns rate-limit errors.                   |
| **Retries per batch** | How many times a failed batch is tried again before the run fails. Default 6.                                       |

A run card appears under **New run**. The sample takes about a second.

![The run card for Run bde64ac1: v1 · incremental · attempt 1 · started just now, a green succeeded chip, and a full progress bar at 6.0 KB of 6.0 KB, 100.0%. Embedded 33, Unchanged 0, Deleted 0, Rejected 0, Errors 0. The panel reads v1 · serving v1 · 33 chunks indexed.](../images/etl/etl-run-done.png)

The panel's first line now reads `v1 · serving v1 · 33 chunks indexed`. **Serving** is the version the ETL Retriever searches.

### Read the run card

| Part                                              | Meaning                                                                                                                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run** and 8 characters                          | The start of the run id. The same id is in **History**.                                                                                                                                               |
| `v1 · incremental · attempt 1 · started just now` | The version the run uses, the mode, and how many times it has been tried. A run keeps the version it started on, even if you edit the canvas while it runs.                                           |
| Status chip                                       | `queued`, `running`, `paused`, `succeeded`, `partial`, `failed`, or `cancelled`.                                                                                                                      |
| Progress bar                                      | Bytes read of the total.                                                                                                                                                                              |
| **Embedded**                                      | Chunks embedded and written by this run.                                                                                                                                                              |
| **Unchanged**                                     | Chunks that were already in the store. `N sources skipped` counts files that did not change at all.                                                                                                   |
| **Deleted**                                       | Chunks removed because their source row or file is gone.                                                                                                                                              |
| **Rejected**                                      | Records that failed the source's rules, such as a missing required column or a value that is too long. The run finishes as `partial`.                                                                 |
| **Errors**                                        | Errors counted while the run read and wrote: a malformed or invalid record (it also counts under **Rejected**), a file that could not be read, or a record the store refused. The log names each one. |
| chunks/s, B/s, ETA, Elapsed                       | Live speed while the run is going. A run this small finishes before a speed is measured.                                                                                                              |

Below the numbers, each step has a check mark when it is done, then a line of counts. The log at the bottom lists what happened, with times.

![The steps of Run bde64ac1: Load 33 documents, 1 of 1 sources; Clean & transform 33 kept, 0 dropped; Split 33 chunks; Embed 33 embedded, 0 unchanged; Store 33 written, 0s writing; Delete removed 0 deleted. The log says Queued, Started, and Succeeded: 33 records read, 33 new. Try retrieval is below the card.](../images/etl/etl-run-steps.png)

While a run is going, **Pause** stops it after the current batch and **Cancel** stops it for good. A paused run shows **Resume**. A run that read to the end but rejected some records, or could not read a file, is `partial`. A file it could not read keeps the chunks from the last run. A `partial` run is served, the same as `succeeded`. If more than 5% of the records are rejected, after at least 100 records, the run fails instead and the served version does not change.

### Run it again

Select **Start Run** again with nothing changed. The incremental run reads the file, sees it has not changed, and embeds nothing.

![A second run, Run 2a500170, succeeded. Embedded 0, Unchanged 0 with 1 sources skipped, Deleted 0. Load reads 0 documents, 1 of 1 sources, 1 unchanged.](../images/etl/etl-run-incremental.png)

Add, edit, or remove rows in the CSV and run again. Only the changed rows are embedded, and rows you removed are deleted from the store.

## Try retrieval

**Try retrieval** is under the run card once a version is serving. It searches the serving version the same way the ETL Retriever does in a chat flow or harness.

1. Type a question in **Ask something the data should answer**, for example `tent for alpine starts`.
2. Select **Search**.

![Try retrieval with the query tent for alpine starts. Four results from data/outdoor-catalog.csv: Basecamp 4 Family Tent at score 0.264, Summit Bivy Shelter at 0.254, Bear-Resistant Food Canister at 0.119, and Ridgeline 2P Ultralight Tent at 0.107.](../images/etl/etl-try-retrieval.png)

Each result shows its score, its source, and the chunk text. `No matches.` means the store has nothing close to the question.

A pipeline made with [Build with AI](#build-a-pipeline-with-ai) also lists its starter searches under the search box. Select one to search with it.

### Better matches

Local Hash Embeddings match words, not meaning. In the example, the Summit Bivy Shelter is the one built for alpine starts, but the family tent scores slightly higher because it shares more words with the question. To match on meaning, replace **Local Hash Embeddings** with a provider embeddings node, such as **OpenAI Embeddings**, select its credential, **Publish**, and run a **Full rebuild**. A canvas save alone leaves the rebuild on the published pipeline.

## When a run fails

To see a failure, change **Paths** on the Streaming Files node to a file that does not exist, such as `products-2026.csv` in the same folder, and save. The save stores a draft. **Preview** shows the missing file, and it does not write to the store. A run still uses the published pipeline until you **Publish**. Publish creates the next pipeline version.

**Preview** shows the problem before you run.

![The Preview tab while version 1 is still serving. A red message reads Streaming Files: File or folder "products-2026.csv" was not found on the server. Load reads 0 documents and says No documents came out of the sources.](../images/etl/etl-preview-missing-file.png)

After you publish, a run of that version fails with the same message.

![Failed Run 5bb85f2c of version 2. The panel still reads serving v1. A red message says File or folder "products-2026.csv" was not found on the server. Retry From Checkpoint and Cancel are below it, and the last log line repeats that message. Try retrieval still searches version 1.](../images/etl/etl-run-failed.png)

This run failed before it wrote anything, so the served data is as it was. The panel still reads `serving v1`, and **Try retrieval** still searches version 1. A run can also fail partway, for example when the embeddings provider stops answering. The batches it wrote before it stopped are already in the store, and search can return them. Retry the run, or start a new one, so the store matches a finished run again.

-   **Retry From Checkpoint** starts the same run again from where it stopped, on the same version, as attempt 2. Use it when the cause was outside the pipeline, such as a provider outage or a rate limit.
-   When the pipeline itself is wrong, fix the node, **Publish**, and select **Start Run**. A retry would run the old version again, and a canvas save alone does not change it.
-   **Cancel** ends the failed run. It stays in **History** as `cancelled`.

### Which folders a pipeline can read

A source path must be an absolute path on the server, without `..`. A pipeline can read:

-   the folders in `CUTTLELY_ETL_ROOTS`, when it is set;
-   this workspace's uploads (see [Upload a file](#upload-a-file-to-the-server));
-   `samples/etl` in the install.

A **Code Repository** source can also read the Cuttlely checkout itself while `CUTTLELY_ETL_ROOTS` is not set. Any other path is refused with `Path "..." is outside the folders pipelines may read (...). Set CUTTLELY_ETL_ROOTS on the server to the folders pipelines may read (comma-separated, each path or label=path) and restart it.`

## Restore an earlier version

**Publish**, **Roll back**, and a save through the API create a version when nodes, inputs, credentials, or connections change. A canvas save stores a draft and does not. Moving nodes does not. **Versions** lists the published versions, newest first.

1. Select **Versions** in the panel.
2. Select **Restore** on the version you want.

![The Versions tab while version 2 is latest and version 1 is serving. Version 2 was saved at 10:52:36 AM and version 1 at 10:52:26 AM. Version 1 has a Restore button. Each row reads Streaming Files → Local Vector Store.](../images/etl/etl-versions.png)

The canvas loads that version. Nothing is saved yet: an asterisk appears before the name, and **Paths** is back to `outdoor-catalog.csv`.

![The canvas after Restore on version 1. An asterisk before Outdoor Catalog shows the change is not saved, and the Live chip is still on. Paths on Streaming Files reads outdoor-catalog.csv again, and the Local Vector Store collection is outdoor-catalog.](../images/etl/etl-version-restored.png)

3. Select **Save Pipeline**. The canvas stores a draft. Select **Publish**. The published pipeline is a new version, version 3. Versions 1 and 2 stay in the list.
4. Run the pipeline. When the run succeeds, version 3 is serving.

![The Versions tab after the save and the run. The panel reads v3 · serving v3 · 33 chunks indexed. Version 3 has latest and serving chips. Versions 2 and 1 each have a Restore button. Each row reads Streaming Files → Local Vector Store.](../images/etl/etl-versions-after.png)

The ETL Retriever serves the version of the last `succeeded` or `partial` run, not the last save. A version without a run is never served. A row marked `incomplete` is a version with a problem in its graph, such as a missing source, store, or embeddings connection. Fix the canvas, save the draft, and **Publish**. **Version history** at the top right is the same history for the whole canvas. See [Version history](./versioning.md).

## Look at earlier runs

**History** lists every run of the pipeline, newest first. Each row has the run id, the version, the mode, the start time, how long it took, the counts, and the status.

![The History tab with four runs, newest first. a9bb2725 on v3, succeeded, 0 embedded. 5bb85f2c on v2, failed. 2a500170 on v1, succeeded, 0 embedded. bde64ac1 on v1, succeeded, 33 embedded.](../images/etl/etl-history.png)

Select a row to open that run's card in **Run**. With no runs, the tab says `No runs yet. Start one from the Run tab.`

## Run it on a schedule

A schedule starts a run at a fixed interval or on a cron expression.

1. Select **Schedule**, or **Schedules** in the panel.
2. Under **New schedule**, leave **Kind** at **Interval**. Set **Every** to `6` and **Unit** to **hours**.
3. Leave **Run** at **Incremental**.
4. Select **Add Schedule**.

![The Schedules tab before a schedule is saved. The caption reads Incremental is the default. A tick that finds a run still going is skipped, and the reason is kept on the schedule. Schedules live in this server process and fire again after a restart. New schedule: Kind Interval, Every 6, Unit hours, Run Incremental, and an Add Schedule button. Below: No schedule yet.](../images/etl/etl-schedule-form.png)

The schedule appears below the form.

![A schedule card under the form: Every 6 hours, with incremental and green active chips. Next run 10/14/2026, 4:52:32 PM, Last run never, Last result –. Edit, Pause, and Delete buttons.](../images/etl/etl-schedule.png)

-   **Kind** **Cron** takes five fields, `minute hour day month weekday`, in UTC. `0 2 * * *` runs at 02:00 UTC every day.
-   **Edit** changes the schedule, **Pause** stops it until you select **Resume**, and **Delete** removes it.
-   If a run is still going when the schedule fires, that tick is skipped, and the card says why under **Last result**.
-   Schedules run inside the Cuttlely server. They do not fire while it is stopped, and they continue after a restart.

## Upload a file to the server

A source reads files on the server, not on your computer. To use a file from your computer, upload it from the **Preview** tab.

1. Select **Preview** and scroll to **Upload a file to the server**.
2. Select **Choose File** and pick the file.
3. Select the copy icon (**Copy path**) next to the path that appears.
4. Paste the path as a new line in **Paths** on the Streaming Files node, save, and run.

![The bottom of the Preview tab. Upload a file to the server, with the hint Large files stream to disk without passing through memory. Paste the path into Streaming Files. Below Choose File, crumb-co-bakes.csv is listed with its path under the server upload folder and a copy icon.](../images/etl/etl-upload.png)

Uploads go to `CUTTLELY_ETL_DIR/uploads/`, in a folder for your workspace. A pipeline in one workspace cannot read another workspace's uploads.

## See all pipelines

Once a pipeline is saved, the ETL page lists it. **Search pipelines** filters the list by name. **Upcoming runs** shows the next scheduled run of each pipeline.

![The ETL page with Search pipelines and the What are you building? card. Upcoming runs lists Outdoor Catalog, Every 6 hours, incremental, 10/14/2026, 4:52:32 PM. The table row is Outdoor Catalog: Streaming Files, Local Vector Store, Local Hash Embeddings, 33 chunks, v1 and serving v1, a green succeeded chip, and the same next run.](../images/etl/etl-list.png)

| Column   | Meaning                                               |
| -------- | ----------------------------------------------------- |
| Pipeline | The pipeline name. Select the row to open its canvas. |
| Sources  | The source nodes.                                     |
| Target   | The store node, with the embeddings node under it.    |
| Chunks   | Chunks indexed in the store.                          |
| Version  | The latest version, and the version that is serving.  |
| Last run | The status of the last run and when it ran.           |
| Next run | The next scheduled run and its schedule.              |

Deleting a pipeline also deletes the vectors it wrote to its store, and to any store it used before you changed it. A run that is still going is cancelled first, and no run can start or be retried while the delete is going on. Other pipelines that use the same collection or namespace keep their vectors. If the store cannot be reached, for example because its credential was deleted, the pipeline is still deleted, and the server log names the store that kept its vectors. Two cases cannot be fully cleaned up. A store that makes up its own vector ids (SingleStore, Zep) and that the pipeline used before you moved it to another store keeps its vectors, and the server log names it. An earlier store also keeps chunks whose text or embeddings model changed after the move, because their ids are no longer known.

## Use the pipeline in a harness

The **ETL Retriever** node searches a pipeline by name. Attach it to a Harness Specialist, and the specialist can look things up in your data. The example below is a harness named `gear-desk` with one specialist, `catalog`.

1. Open **Harness · Agent Team** and select **New agent team**. Add **Harness Prime**, one **Harness Specialist**, and an **OpenAI** chat model connected to **Chat Model** on Harness Prime, as in [Harnesses](./harnesses.md#connect-a-chat-model-to-harness-prime).
2. Select **+** (**Add Node**), type `ETL Retriever`, and drag **ETL Retriever** from **Tools** onto the canvas.
3. Drag from the ETL Retriever output dot to the **Attached** dot on the Harness Specialist.
4. Under **Pipeline**, select `Outdoor Catalog`. Each pipeline in the list shows the version it serves. A pipeline with no successful run says `No successful run yet`.

    ![The Pipeline list open on the ETL Retriever. One option: Outdoor Catalog, Serving version 1. Top K is 4. The retriever is on the gear-desk canvas with the catalog specialist, an OpenAI card set to gpt-4o-mini, and Harness Prime.](../images/etl/etl-retriever-pick.png)

5. Name the specialist `catalog`. Give it instructions such as `Answer product questions from the Outdoor Catalog. Search it with the ETL Retriever tool, and quote names, weights, and prices as written.`
6. Give Harness Prime instructions such as `Product questions go to the catalog specialist. Do not invent products.`
7. Save the harness as `gear-desk`.

![The saved gear-desk harness, last edited by Rosa Diaz. ETL Retriever (Pipeline Outdoor Catalog, Serving version 1, Top K 4, Output Tool) is joined to the catalog Harness Specialist. The specialist is joined to Harness Prime, whose instructions read Product questions go to the catalog specialist. Do not invent products. An OpenAI card set to gpt-4o-mini and temperature 0.2 is joined to Harness Prime's Chat Model.](../images/etl/harness-etl-canvas.png)

| ETL Retriever field                                 | Meaning                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Pipeline**                                        | The pipeline, by name. If you rename the pipeline, select it here again and save.                                              |
| **Namespace**                                       | Shown after you pick a pipeline, and only when it has written a named namespace. Leave it empty to search the serving version. |
| **Top K**                                           | How many chunks a search returns. Default 4.                                                                                   |
| **Tool Name** (Additional Parameters)               | The tool name the model sees. Defaults to `search_` and the pipeline name.                                                     |
| **Tool Description** (Additional Parameters)        | Tells the model when to search this data. Defaults to a sentence that names the pipeline.                                      |
| **Return Source Documents** (Additional Parameters) | Also returns the chunks as source documents.                                                                                   |
| **Output**                                          | **Tool** for a specialist or an agent. **Retriever** for a chain that takes a retriever.                                       |

Search uses the embeddings model and the store of the version it searches, so the retriever needs no embeddings node of its own. With **Namespace** empty, that is the serving version. With a namespace selected, it is the newest succeeded or partial version that wrote that namespace.

### Ask it

Select the chat button and ask: `Which shelter is built for alpine starts, and what does it weigh and cost?`

![The gear-desk canvas chat. The visible answer is the retrieval result itself: [1] (data/outdoor-catalog.csv) name Summit Bivy Shelter, category Tents; then Storm Shell 3L Rain Jacket; Returns and exchanges; and Lifetime warranty.](../images/etl/harness-etl-chat.png)

The Run card says `Direct to catalog`. When a harness has exactly one specialist and that specialist has exactly one tool and nothing else, Harness Prime skips routing and the handoff. The model only fills in the search query, and the search results are the answer. Each result starts with its number and source, then the chunk.

For a written answer, give the harness a second specialist or give the specialist a second tool. Harness Prime then routes the question and writes the answer from the specialist's results.

### Use it in a chatflow

Set **Output** to **Tool** and connect the ETL Retriever to an agent's tools, or set it to **Retriever** and connect it where a chain takes a retriever. The search is the same.

## Troubleshooting

| You see                                                                                                                                                 | What to do                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `File or folder "..." was not found on the server.`                                                                                                     | The path is wrong, or the file is on your computer instead of the server. Fix **Paths**, or [upload the file](#upload-a-file-to-the-server), then save and start a new run. |
| `Path "..." is outside the folders pipelines may read (...)`                                                                                            | Upload the file, or add its folder to `CUTTLELY_ETL_ROOTS` and restart the server. See [Which folders a pipeline can read](#which-folders-a-pipeline-can-read).             |
| `Path "..." is not absolute. Give an absolute path on the server.`                                                                                      | Give the full path, starting with `/`.                                                                                                                                      |
| `Save the pipeline to create its first version, then run it.`                                                                                           | A new pipeline has no version yet. Select **Save Pipeline**.                                                                                                                |
| `Save your changes first. A save stores a draft. Preview uses this canvas and does not write to the store.`                                             | The canvas has edits that are not saved. Save, then start the run. That run still uses the published pipeline until you **Publish**.                                        |
| `This run uses the published pipeline and writes to the store. The draft is not included until you Publish. Preview uses the draft and does not write.` | A draft is waiting. **Start run** writes the published pipeline. **Preview** tries the draft and does not write.                                                            |
| **Retry From Checkpoint** fails with the same error                                                                                                     | The retry runs the same version. Fix the node, save, and select **Start Run**.                                                                                              |
| The run is `partial`                                                                                                                                    | Some records were rejected, or a file could not be read and kept its old chunks. The log says which and why. Fix the source and run again. A `partial` run is still served. |
| `reject_ratio_exceeded: ...`                                                                                                                            | More than 5% of the records were rejected. Nothing was deleted and the served version is the same. Fix the source data and run again.                                       |
| Search results match words but miss the meaning                                                                                                         | Local Hash Embeddings match words. Use a provider embeddings node and run a **Full rebuild**. See [Better matches](#better-matches).                                        |
| `ETL pipeline "..." has no successful run yet. Run it from the ETL menu first.`                                                                         | The ETL Retriever needs a served version. Run the pipeline until a run succeeds.                                                                                            |
| `No ETL pipeline is named "...".`                                                                                                                       | The pipeline was renamed or deleted, or is in another workspace. Select it again under **Pipeline** on the ETL Retriever and save.                                          |
| `Pick an ETL pipeline on the ETL Retriever node.`                                                                                                       | **Pipeline** is empty. Select one and save.                                                                                                                                 |
| The schedule did not run                                                                                                                                | Check **Last result** on the schedule card. A tick is skipped while a run is still going, and schedules do not fire while the server is stopped.                            |
| Orange triangle on a card, **Sync Nodes** button                                                                                                        | The node was saved with an older node version. Select **Sync Nodes**, then save.                                                                                            |

## Settings

These are environment variables on the server.

| Variable                   | Default                                                                  | Meaning                                                                               |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `CUTTLELY_ETL_DIR`         | `etl` under the data folder; `/var/cuttlely/etl` in Docker and on Render | Where a pipeline's own files live: its run records, local vector stores, and uploads. |
| `CUTTLELY_ETL_ROOTS`       | not set                                                                  | Folders pipelines may read, comma-separated. Each entry is a path or `label=path`.    |
| `CUTTLELY_ETL_CONCURRENCY` | `1`                                                                      | How many runs can go at the same time on this server. Others wait as `queued`.        |
| `CUTTLELY_ETL_SCHEDULE_MS` | `15000`                                                                  | How often, in milliseconds, the server checks whether a schedule is due.              |

The app database for a local install is still SQLite. ETL keeps its own records under `CUTTLELY_ETL_DIR`. On Docker and Render, keep that folder on a persistent disk so versions, runs, and vectors survive a restart. See [Docker](./docker.md) and [Render](./render.md).
