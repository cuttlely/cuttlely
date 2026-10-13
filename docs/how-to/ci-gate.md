# Fail a build when answers change

A pipeline can run the same check as the Publish dialog. `cuttlely check` starts a check on a flow's draft, waits until it finishes, and prints the result. It uses the flow's model and costs tokens. It never publishes, and it never changes Live or the draft.

This is one recipe: create a scoped API key, pick diff mode or scored mode, read the exit code, read the JSON file, and know what a cancelled job does. Point the job at a Cuttlely server you already run. The workflow does not start one.

What the check does and refuses: [Publish check](../reference/drafts-api.md#publish-check). How it looks in the app: [Check recent questions before you publish](./versioning.md#check-recent-questions-before-you-publish).

## Create a scoped API key

Create the key under **API Keys**. The command reads it from `CUTTLELY_API_KEY`. It does not take the key as a flag, and it does not read the key from the server URL.

Store that key as a repository secret named `CUTTLELY_API_KEY`. The workflow copies `secrets.CUTTLELY_API_KEY` into the environment variable of the same name. The step does not print the secret. Set `CUTTLELY_URL` (the server origin) and `CUTTLELY_FLOW_ID` (the flow id from the canvas address bar) as repository variables.

Starting the check needs update. Reading the result needs view. A key with only the update permission can start the check, and the command then gets 403 when it reads the result and exits 2. The message names the permissions below.

| Flow      | Permissions the key needs                 | Scored mode also needs                |
| --------- | ----------------------------------------- | ------------------------------------- |
| Chatflow  | `chatflows:view` and `chatflows:update`   | `datasets:view` and `evaluators:view` |
| Agentflow | `agentflows:view` and `agentflows:update` | `datasets:view` and `evaluators:view` |
| Harness   | `chatflows:view` and `chatflows:update`   | `datasets:view` and `evaluators:view` |

An ETL pipeline is not in that table. Its Publish dialog lists what changed and does not replay, and `cuttlely check` against it is refused with `The check works on chatflows and agentflows.`

## Pick a mode

Diff mode is the default. A command with neither `--dataset` nor `--gate` asks the 4 most recent questions, the same default as the Publish dialog, and sends `{ "count": 4 }`. Scored mode asks a dataset and exits on the server verdict.

The flow needs a draft. A flow with steps that act for real is refused, the same way the dialog skips it until someone chooses to run those steps. This command does not send that choice.

`pnpm dev` serves the API on port 3000. `scripts/start-cuttlely.sh` and `npx cuttlely start` listen on port 43117, which is already the default for `--server`. From a checkout of this repository, before the published package includes the command, run `node packages/cli/bin/cuttlely.js` with the same arguments.

Scored mode and `--gate` need Cuttlely 1.1.0 or later, the next release. The published 1.0.3 package has no `--gate`. A job that runs `npx cuttlely check --gate` on 1.0.3 fails. Diff mode, including `--fail-on-changed`, is in 1.0.3.

| Flag        | Meaning                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--flow`    | The flow id from the canvas address bar. Required.                                                                                              |
| `--server`  | Server origin. Default `http://127.0.0.1:43117`, the port [`npx cuttlely start`](./docker.md#install-with-npm) publishes.                       |
| `--timeout` | Seconds to wait. Default 300, from 1 to 3600. The server stops starting new questions at its own limit, 180 seconds unless an admin changed it. |
| `--json`    | Write the full check to this path. Same object as [Read a check](../reference/drafts-api.md#read-a-check).                                      |

### Diff mode

Diff mode asks recent questions again, once on Live and once on the draft, and compares the answers.

```bash
export CUTTLELY_API_KEY=<key>
npx cuttlely check --flow <flow id> --fail-on-changed
```

| Flag                | Meaning                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--fail-on-changed` | Exit 1 when any answer is Changed. Without this flag a finished check exits 0 even when answers differ, and the summary still lists them. |

A question that errors is listed under **Errors** and is not a Changed answer. With `--fail-on-changed`, only Changed answers exit 1.

```bash
npx cuttlely check --flow <flow id> --server http://127.0.0.1:3000 --timeout 300 --json check.json --fail-on-changed
```

That `--server` value is for `pnpm dev`. Leave it off when the server is `scripts/start-cuttlely.sh` or `npx cuttlely start`.

The flow needs at least one past question.

### Scored mode

`--dataset` or `--gate` runs the dataset check instead of the four recent questions. The command exits on the server `verdict`. It does not score the answers, and it does not compare the pass rate itself.

```bash
npx cuttlely@^1.1.0 check --flow <flow id> --dataset <dataset id> --evaluator <evaluator id> --threshold 80
npx cuttlely@^1.1.0 check --flow <flow id> --gate
```

| Flag          | Meaning                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dataset`   | Dataset id. Selects scored mode. The server asks that dataset's rows.                                                                             |
| `--evaluator` | Evaluator id. Repeat the flag for another evaluator.                                                                                              |
| `--threshold` | Pass mark, a whole number from 0 to 100. Omit it and the server uses 100.                                                                         |
| `--gate`      | Use the dataset, evaluators, and threshold saved on the flow (`publishGate` from `GET /api/v1/flow-drafts/:id`). Do not pass `--dataset` with it. |

`--evaluator` and `--threshold` need `--dataset`. `--gate` already carries those settings, so do not pass `--evaluator` or `--threshold` with it either. Combining any of these flags with `--fail-on-changed` is a usage error (exit 2).

The summary adds the draft pass rate, the threshold, and the cases whose draft scores are not Pass. `--json` writes the full check, including each case's scores.

A flow that starts from a form, a webhook, or a schedule cannot take a dataset check. The server refuses that start, and the command exits 2. A harness can be scored with `--dataset`; the exit code is still the server verdict. A harness cannot turn the passing test set on, so `--gate` is for a chatflow or an agentflow that has that setting saved.

## Exit codes

| Code | When                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Diff mode: the check finished, and no answer was Changed or `--fail-on-changed` was off. Scored mode: `verdict.result` is `passed`.                                                                                                                                                                                                                                                                                                |
| 1    | Diff mode: `--fail-on-changed` was set and at least one answer was Changed. Scored mode: `verdict.result` is `failed`. The command does not compute that verdict.                                                                                                                                                                                                                                                                  |
| 2    | The check timed out, the server returned an error, `CUTTLELY_API_KEY` was missing, the flow has no draft, the command was used wrong, the server marked the check stopped or failed, the draft was saved, published, or discarded while the check ran, or the job was cancelled. Scored mode also exits 2 when the verdict is missing, `--gate` finds no saved test set, or the flow starts from a form, a webhook, or a schedule. |

After the check has started, a timeout, a 403, or any other failure asks the server to stop it. That stop is best effort: if it fails, the exit code is still the one in this table.

## Read the JSON output

`--json check.json` writes the check the server returned. The file does not contain the API key. If an answer included the key, the command replaces it with `[redacted]` before writing.

Diff mode reads `summary.changed`. A case with `same` false, both answers present, and no error on either side is Changed. Scored mode reads `verdict.result` (`passed` or `failed`), `verdict.passRate`, and `verdict.threshold`. Each scored answer is `cases[].draft.scores[].result` (`Pass`, `Fail`, or `Error`). `draftChanged` true means the draft moved during the check, and the command exits 2.

```bash
jq '{status, changed: .summary.changed, result: .verdict.result, passRate: .verdict.passRate, threshold: .verdict.threshold}' check.json
```

```json
{
    "status": "done",
    "draftChanged": false,
    "summary": { "changed": 0 },
    "verdict": { "result": "passed", "threshold": 80, "passRate": 100 }
}
```

A diff-mode file has `verdict` null. The same object is [Read a check](../reference/drafts-api.md#read-a-check). Upload `check.json` from the job if you want the Live and draft answers in the build log.

## When the job is cancelled

Cancelling the job sends SIGTERM. After the server has returned a check id, the command sends `DELETE /api/v1/flow-drafts/:id/check/:checkId`, prints `The check was cancelled.`, and exits 2. The stop is best effort: a failed DELETE still exits 2. A check that already finished is left as it is. Cancelling before the server returns a check id exits 2, and there is no id to stop. The command does not print the API key on the way out.

## Example workflows

Both files are valid workflow YAML. Neither prints the API key. Neither uses a GitHub Action. If you add a `uses` step, pin it to a version tag such as `actions/checkout@v4`.

Scored mode and `--gate` need Cuttlely 1.1.0 or later, the next release. The diff workflow leaves `npx cuttlely` unpinned because `--fail-on-changed` is in the 1.0.3 package. The scored workflow pins `cuttlely@^1.1.0`, so a copied job does not install 1.0.3 and fail on `--gate`.

### Diff workflow

A Changed answer fails the job. The file is [examples/ci/cuttlely-check.yml](../../examples/ci/cuttlely-check.yml).

```yaml
name: Cuttlely draft check

on:
    pull_request:

jobs:
    check:
        runs-on: ubuntu-latest
        steps:
            - name: Check the draft
              env:
                  CUTTLELY_API_KEY: ${{ secrets.CUTTLELY_API_KEY }}
                  CUTTLELY_URL: ${{ vars.CUTTLELY_URL }}
                  CUTTLELY_FLOW_ID: ${{ vars.CUTTLELY_FLOW_ID }}
              run: |
                  npx --yes cuttlely check \
                    --flow "$CUTTLELY_FLOW_ID" \
                    --server "$CUTTLELY_URL" \
                    --timeout 300 \
                    --fail-on-changed \
                    --json check.json
```

### Scored workflow

A failed server verdict fails the job. The flow needs the passing test set saved, because `--gate` reads it. The file is [examples/ci/cuttlely-check-gate.yml](../../examples/ci/cuttlely-check-gate.yml).

```yaml
name: Cuttlely scored check

on:
    pull_request:

jobs:
    check:
        runs-on: ubuntu-latest
        steps:
            - name: Check the saved test set
              env:
                  CUTTLELY_API_KEY: ${{ secrets.CUTTLELY_API_KEY }}
                  CUTTLELY_URL: ${{ vars.CUTTLELY_URL }}
                  CUTTLELY_FLOW_ID: ${{ vars.CUTTLELY_FLOW_ID }}
              run: |
                  npx --yes cuttlely@^1.1.0 check \
                    --flow "$CUTTLELY_FLOW_ID" \
                    --server "$CUTTLELY_URL" \
                    --timeout 300 \
                    --gate \
                    --json check.json
```
