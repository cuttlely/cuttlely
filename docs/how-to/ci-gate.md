# Fail a build when answers change

A pipeline can run the same check as the Publish dialog. `cuttlely check` starts a check on a flow's draft, waits until it finishes, and prints how many answers came back the same, changed, or with an error.

The check asks the flow's recent questions again, once on Live and once on the draft. It uses the flow's model and costs tokens. It never publishes, and it never changes Live or the draft. What the check does and refuses: [Publish check](../reference/drafts-api.md#publish-check). How it looks in the app: [Check recent questions before you publish](./versioning.md#check-recent-questions-before-you-publish).

## Run it

The command reads the API key from `CUTTLELY_API_KEY`. It does not take the key as a flag. Create the key under **API Keys** with both permissions for the flow's type. Starting the check needs update, and reading the result needs view. A key with only the update permission can start the check, and the command then gets 403 when it reads the result.

| Flow      | Permissions the key needs                 |
| --------- | ----------------------------------------- |
| Chatflow  | `chatflows:view` and `chatflows:update`   |
| Agentflow | `agentflows:view` and `agentflows:update` |
| Harness   | `chatflows:view` and `chatflows:update`   |

An ETL pipeline is not in that table. Its Publish dialog lists what changed and does not replay, and `cuttlely check` against it is refused with `The check works on chatflows and agentflows.`

```bash
export CUTTLELY_API_KEY=<key>
npx cuttlely check --flow <flow id> --fail-on-changed
```

| Flag                | Meaning                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--flow`            | The flow id from the canvas address bar. Required.                                                                                                                                                                                                        |
| `--server`          | Server origin. Default `http://127.0.0.1:43117`, the port [`npx cuttlely start`](./docker.md#install-with-npm) publishes.                                                                                                                                 |
| `--timeout`         | Seconds to wait for the check. Default 300, from 1 to 3600. The server stops starting new questions at its own limit, 180 seconds unless an admin changed it. The final confirmation read after a `--gate` pass has its own window of at most 30 seconds. |
| `--json`            | Write the full check to this path. Same object as [Read a check](../reference/drafts-api.md#read-a-check).                                                                                                                                                |
| `--fail-on-changed` | Exit 1 when any answer is Changed. Without this flag a finished check exits 0 even when answers differ, and the summary still lists them.                                                                                                                 |

`pnpm dev` serves the API on port 3000. `scripts/start-cuttlely.sh` and `npx cuttlely start` listen on port 43117, which is already the default for `--server`.

```bash
npx cuttlely check --flow <flow id> --server http://127.0.0.1:3000 --timeout 300 --json check.json --fail-on-changed
```

That `--server` value is for `pnpm dev`. Leave it off when the server is `scripts/start-cuttlely.sh` or `npx cuttlely start`.

From a checkout of this repository, before the published package includes the command, run `node packages/cli/bin/cuttlely.js` with the same arguments.

The command asks the 4 most recent questions, the same default as the Publish dialog. The flow needs a draft and at least one past question. A flow with steps that act for real is refused, the same way the dialog skips it until someone chooses to run those steps. This command does not send that choice.

A question that errors is listed under **Errors** and is not a Changed answer. With `--fail-on-changed`, only Changed answers exit 1.

## Exit codes

| Code | When                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The check finished. No answer was Changed, or `--fail-on-changed` was off.                                                               |
| 1    | `--fail-on-changed` was set and at least one answer was Changed.                                                                         |
| 2    | The check timed out, the server returned an error, `CUTTLELY_API_KEY` was missing, the flow has no draft, or the command was used wrong. |

A check the server marks stopped or failed also exits 2. If the draft is saved, published, or discarded while the check runs, the command exits 2, because the answers may be for a draft that is already gone. After the check has started, a timeout, a 403, or any other failure asks the server to stop it. Cancelling the command, including a cancelled CI job, stops that server-side check too. The command prints `The check was cancelled.` and exits 2. That stop is best effort: if it fails, the exit code is still 2.

## Scored mode

Scored mode and `--gate` need Cuttlely 1.1.0 or later. 1.1.0 is the first release with scored mode. The published 1.0.3 package has no `--gate`. Diff mode, including `--fail-on-changed`, is in 1.0.3.

`--dataset` or `--gate` runs the dataset check instead of the four recent questions. Diff mode stays the default: a command with neither flag still sends `{ "count": 4 }` and still uses the exit codes above. How a test set is built, and how to turn the passing test set on, is in [Evaluations](./evaluations.md#set-the-pass-mark-and-turn-on-the-gate).

`--dataset` exits on the server `verdict`. It does not score the answers, and it does not compare the pass rate itself. `passed` exits 0. `failed` exits 1. `--gate` with a failed verdict exits 1 and does not read the flow again. `--gate` exits 0 only when that verdict is `passed` and a second read of the flow still stores this check as passed with an empty `block` (`publishGate.enabled` is true, `publishGate.result.checkId` is this check, and `publishGate.result.verdict` is `passed`). That read waits at most 30 seconds. Exit 2 means the confirmation read failed: a non-empty block, a different checkId, or a missing passed. Turning the passing test set off during a `--gate` check, after the server verdict is `passed`, exits 2. The message is `The saved test set changed during the check. Run it again.` when the server sends no `block` text. Changing the dataset, the evaluators, or the pass mark during that check exits 2 the same way, and a `block` from the server is printed instead. A missing verdict, a stopped or failed check, a draft that changed during the check, a timeout, a 403, a missing key, no draft, or a usage error also exits 2.

The gate covers Publish of the current draft only. Roll back, Promote, and `PUT /api/v1/chatflows/:id` can still change Live.

An enabled gate always has a dataset and at least one evaluator. If that read leaves the dataset id out, or the evaluator list empty, the command exits 2 before it starts a check. The message says the key needs `datasets:view`, `evaluators:view`, or both.

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

The key needs the same flow view and update pair as the question check, plus `datasets:view` and `evaluators:view`. A 403 names that whole set.

The summary adds the draft pass rate, the threshold, and the cases whose draft scores are not Pass. `--json` writes the full check, including each case's scores. Diff mode reads `summary.changed`. A scored check reads `verdict.result`. What those scores mean is in [Evaluations](./evaluations.md#run-the-publish-check-on-a-dataset). The file does not contain the API key. The same object is [Read a check](../reference/drafts-api.md#read-a-check).

A flow that starts from a form, a webhook, or a schedule cannot take a dataset check. The server refuses that start, and the command exits 2. A harness cannot store a passing test set. `--dataset` can score a harness for that run only, and the verdict is not stored. The server refuses the setting with `A passing test set before Publish is for chatflows and agentflows.` See [Require a passing test set before you publish](./versioning.md#require-a-passing-test-set-before-you-publish). `--gate` on a harness exits 2 before any check and prints `This flow has no saved test set. Turn the passing test set on, or pass --dataset.` That line is the same one any flow with the setting off prints. A harness has no saved test set to turn on.

## GitHub Actions

Point the job at a Cuttlely server you already run. The workflow does not start one. Store the API key as a repository secret named `CUTTLELY_API_KEY`. The step does not print the secret. A diff job needs `chatflows:view` and `chatflows:update`, or `agentflows:view` and `agentflows:update`. A scored job needs that same pair plus `datasets:view` and `evaluators:view`. Set `CUTTLELY_URL` and `CUTTLELY_FLOW_ID` as repository variables.

Scored mode and `--gate` need Cuttlely 1.1.0 or later. 1.1.0 is the first release with scored mode. The diff workflow leaves `npx cuttlely` unpinned because `--fail-on-changed` is in the 1.0.3 package. The scored workflow pins `cuttlely@^1.1.0`.

Both workflows set `permissions: {}`, because the job never uses the GitHub token, and use `concurrency` with `cancel-in-progress`, so a new push stops the older run and the CLI cancels its check on SIGTERM. Use one of the two workflows for a given flow. The server runs one check per flow at a time, so running both against the same flow on one pull request makes the second one exit 2 with `A check is already running for this flow.`

```yaml
name: Cuttlely draft check

on:
    pull_request:

permissions: {}

concurrency:
    group: cuttlely-check-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
    cancel-in-progress: true

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

The same file is [examples/ci/cuttlely-check.yml](../../examples/ci/cuttlely-check.yml). A Changed answer fails the job. Upload `check.json` from the job if you want the Live and draft answers in the build log.

`--gate` is only for a chatflow or an agentflow with the passing test set on. A harness exits 2. The file is [examples/ci/cuttlely-check-gate.yml](../../examples/ci/cuttlely-check-gate.yml).

```yaml
name: Cuttlely scored check

on:
    pull_request:

permissions: {}

concurrency:
    group: cuttlely-check-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
    cancel-in-progress: true

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
