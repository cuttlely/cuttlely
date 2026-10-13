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

| Flag                | Meaning                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--flow`            | The flow id from the canvas address bar. Required.                                                                                              |
| `--server`          | Server origin. Default `http://127.0.0.1:43117`, the port [`npx cuttlely start`](./docker.md#install-with-npm) publishes.                       |
| `--timeout`         | Seconds to wait. Default 300, from 1 to 3600. The server stops starting new questions at its own limit, 180 seconds unless an admin changed it. |
| `--json`            | Write the full check to this path. Same object as [Read a check](../reference/drafts-api.md#read-a-check).                                      |
| `--fail-on-changed` | Exit 1 when any answer is Changed. Without this flag a finished check exits 0 even when answers differ, and the summary still lists them.       |

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

A check the server marks stopped or failed also exits 2. If the draft is saved, published, or discarded while the check runs, the command exits 2, because the answers may be for a draft that is already gone. After the check has started, a timeout, a 403, or any other failure asks the server to stop it. Cancelling the command, including a cancelled CI job, stops that server-side check too. That stop is best effort: if it fails, the exit code is still 2.

## GitHub Actions

Point the job at a Cuttlely server you already run. The workflow does not start one. Store the API key as a repository secret named `CUTTLELY_API_KEY`. The key needs `chatflows:view` and `chatflows:update`, or `agentflows:view` and `agentflows:update`. Set `CUTTLELY_URL` and `CUTTLELY_FLOW_ID` as repository variables.

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

The same file is [examples/ci/cuttlely-check.yml](../../examples/ci/cuttlely-check.yml). A Changed answer fails the job. Upload `check.json` from the job if you want the Live and draft answers in the build log.
