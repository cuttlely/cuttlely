# Hermes upgrades

Cuttlely runs agent teams on Hermes (NousResearch/hermes-agent, MIT). Hermes is vendored under `hermes/`: a trimmed copy of one upstream commit plus a few Cuttlely patches. This page is for maintainers who upgrade Hermes or change a Hermes file. Attribution is in [NOTICE](../../NOTICE).

## What is in hermes/

| Path                          | What it is                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| upstream files                | Hermes at the commit in `hermes/UPSTREAM_COMMIT`, minus the excluded paths.                                                             |
| `hermes/CUTTLELY_EXCLUDE.txt` | Upstream paths left out. `pnpm hermes:vendor` drops them, and `pnpm verify` fails if one comes back.                                    |
| `hermes/patches/`             | Cuttlely's changes to Hermes, one patch file per change. Each opens with what it changes and why.                                       |
| `hermes/CUTTLELY_VENDOR.lock` | The upstream repository, the tag or commit asked for, the commit it resolved to, and a fingerprint of `hermes/`. Written by the script. |
| `hermes/UPSTREAM_COMMIT`      | The pinned upstream commit.                                                                                                             |
| `hermes/CUTTLELY_VENDOR.txt`  | Short notes: what Cuttlely uses, what is left out, and one line per patch.                                                              |

The pin today is v0.21.4+canary, commit `f42f579`.

### What is left out

| Path                                              | Why                                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| every `tests/` folder                             | Upstream tests. Cuttlely's own Hermes test comes back through the MCP patch.                   |
| `contributors/`, `website/`, `evals/`, `.github/` | Contributor records, the website, evals and CI.                                                |
| `apps/`                                           | The desktop and mobile apps.                                                                   |
| `optional-skills/`                                | Skills only the skills hub installs. Every runtime read checks that the folder exists first.   |
| `ui-tui/`                                         | The terminal chat UI. Cuttlely never starts it.                                                |
| `web/`                                            | The dashboard source. Cuttlely never starts the dashboard.                                     |
| `scripts/`                                        | Upstream installers, CI and release tools. Nothing loads them at boot.                         |
| `acp_adapter/`                                    | The editor (ACP) adapter. Its `hermes-acp` entry point is never run.                           |
| files the `.gitignore` files match                | For example `package-lock.json`, `dist/` and `build/`. The vendor run lists each one it drops. |

`skills/`, `plugins/`, `locales/`, `plugin-catalog/`, `optional-mcps/` and `tui_gateway/` stay: Hermes reads them at boot.

### The patches

| Patch                    | Files                                                                                                          | What it does                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 delegate roster     | `run_agent.py`, `tools/delegate_tool.py`, `tools/delegate_tool_toolsets.py`                                    | Each specialist gets the tool allowlist from its profile's roster, and a harness chief's delegation waits for the result.                           |
| 0002 MCP retry           | `tools/mcp_tool*.py` (logic in the new `tools/mcp_tool_cuttlely.py`), `tests/tools/test_cuttlely_mcp_retry.py` | Retries an empty startup tool list, rediscovers tools, keeps expected analyst results off the circuit breaker, and scopes page cursors to one chat. |
| 0003 API server MCP wait | `gateway/platforms/api_server.py`                                                                              | An API run waits for MCP tools before it builds the agent. Its usage also reports the cached prompt tokens.                                         |
| 0004 skills_read toolset | `toolsets.py`                                                                                                  | A read-only skills toolset (`skills_list`, `skill_view`) for specialists with playbooks.                                                            |
| 0005 models.dev offline  | `agent/models_dev.py`                                                                                          | No models.dev request unless `CUTTLELY_MODELS_DEV=1`. Cached data still serves; lookups without data fall through to the other sources.             |

## Upgrade Hermes

Run it on a branch, with `hermes/` committed:

```bash
pnpm hermes:vendor v0.21.6        # a tag or a commit
bash scripts/setup-hermes.sh      # Python dependencies may have changed
pnpm verify
```

`pnpm hermes:vendor` does this:

1. Checks that `hermes/` has no uncommitted changes and that you are not on `main`.
2. Fetches only that tag or commit into a cache outside the repository (`~/.cache/cuttlely/hermes-vendor`, or `CUTTLELY_HERMES_VENDOR_CACHE`), and prints the commit and its date.
3. Builds a staging copy: upstream at that commit minus `CUTTLELY_EXCLUDE.txt` and the files the `.gitignore` files match.
4. Applies `hermes/patches` in order, three-way. `hermes/` is not touched until every patch applies.
5. Rewrites the patch files against the new commit, replaces the upstream files in `hermes/` (keeping `hermes/.venv` and Cuttlely's own files), and writes `UPSTREAM_COMMIT` and the lock.
6. Prints how many files changed and every file `.gitignore` dropped.

Then open the pull request with the old and new tag, the patch status and any Python dependency changes, and run a real-model harness run on the box before merging. Back up the Hermes data folder before deploying an upgrade: a newer Hermes may migrate its state database, and rolling back would then need that backup.

Re-running `pnpm hermes:vendor` at the current pin changes nothing. That is a quick way to check the script and the patches.

## When a patch does not apply

The run stops, names the patch and its files, and leaves `hermes/` as it was.

1. Read the patch header for what it is for.
2. In the staging folder the message names, reapply that intent to the new upstream code and `git add` the files there.
3. Run `pnpm hermes:vendor --continue`. It records the fixed patch against the new base and finishes.

`pnpm hermes:vendor --abort` drops the staging copy instead.

To keep conflicts small, put Cuttlely logic in new Cuttlely files (like `tools/mcp_tool_cuttlely.py`) and keep only short hooks in upstream files.

## Change a Hermes file

1. Edit the file under `hermes/`.
2. Run `pnpm hermes:vendor --save-patches`. Each changed file goes into the patch that already owns it.
3. For a file no patch owns yet, run `pnpm hermes:vendor --save-patches --new "<short name>" --message "What: ... Why: ..."`. That adds a new patch file.
4. Add a line for a new patch to `hermes/CUTTLELY_VENDOR.txt` and to the table above.

Each Hermes file belongs to one patch only. `--save-patches` fetches the pinned commit to compare against, so it needs the network.

To leave out another upstream folder, add it to `CUTTLELY_EXCLUDE.txt` and run `pnpm hermes:vendor` at the same pin. To bring one back, take it off the list and do the same.

## What pnpm verify checks

| Step            | When          | Fails if                                                                                                                                                                                                      |
| --------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hermes-vendor` | fast and full | a path in `CUTTLELY_EXCLUDE.txt` is back, a patch no longer matches the files, two patches share a file, or anything in `hermes/` changed outside the script (`CUTTLELY_VENDOR.txt` excepted). Works offline. |
| `hermes-import` | full          | a Hermes module Cuttlely runs does not import from `hermes/`. Uses `HERMES_PYTHON` or `hermes/.venv`, and skips with a message when neither exists.                                                           |

A failing `hermes-vendor` after an intended edit means the edit is not saved as a patch yet: run `pnpm hermes:vendor --save-patches`.
