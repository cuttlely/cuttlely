# Hermes upgrades

Cuttlely runs agent teams on Hermes (NousResearch/hermes-agent, MIT). Hermes is vendored under `hermes/`: a trimmed copy of one upstream commit plus a few Cuttlely patches. This page is for maintainers who upgrade Hermes or change a Hermes file. Attribution is in [NOTICE](../../NOTICE).

## What is in hermes/

| Path                          | What it is                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| upstream files                | Hermes at the commit in `hermes/UPSTREAM_COMMIT`, minus the excluded paths.                                                                                           |
| `hermes/CUTTLELY_EXCLUDE.txt` | Upstream paths left out. `pnpm hermes:vendor` drops them, and `pnpm verify` fails if one comes back.                                                                  |
| `hermes/patches/`             | Cuttlely's changes to Hermes, one patch file per change. Each opens with what it changes and why.                                                                     |
| `hermes/CUTTLELY_VENDOR.lock` | The upstream repository, the tag or commit asked for, the commit it resolved to, and a fingerprint of `hermes/`. Written by the script.                               |
| `hermes/UPSTREAM_COMMIT`      | The pinned upstream commit.                                                                                                                                           |
| `hermes/CUTTLELY_VENDOR.txt`  | Short notes: what Cuttlely uses, what is left out, and one line per patch.                                                                                            |
| `hermes/CUTTLELY_LOADED.txt`  | Files a harness run loads. `pnpm hermes:vendor` keeps these, plus package init files, named data files, licenses, patch files, and the build and lock metadata below. |

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

`skills/`, `plugins/`, `locales/`, `plugin-catalog/`, `optional-mcps/` and `tui_gateway/` are not excluded by folder. `CUTTLELY_LOADED.txt` is what decides which of their files stay. The measurement keeps the files a harness run opens: the API server, the agent loop, the toolsets a profile can enable (terminal, browser, code execution, file, skills_read, delegation, memory, session_search, MCP), the custom model provider, and browser and web backends. Messaging platform plugins, other model providers, the plugin catalog, optional MCP descriptors, Nix and Docker files, and locale catalogs other than English stay out. A missing locale falls back to English. `native/fts5_cjk` stays: it is the only C in the tree, and the code scanner fails when it finds no C sources. The vendor step also always keeps `.python-version`, `pyproject.toml`, `uv.lock` and `pm/lock.json`. `scripts/setup-hermes.sh` reads `.python-version` and, on Python 3.14, installs the locked set from `uv.lock`.

### The patches

| Patch                        | Files                                                                                                                                                                                                                                                                              | What it does                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 delegate roster         | `run_agent.py`, `tools/delegate_tool.py`, `tools/delegate_tool_toolsets.py`                                                                                                                                                                                                        | Each specialist gets the tool allowlist from its profile's roster, and a harness chief's delegation waits for the result.                                                                                                                                                                                                     |
| 0002 MCP retry               | `tools/mcp_tool*.py` (logic in the new `tools/mcp_tool_cuttlely.py`), `tests/tools/test_cuttlely_mcp_retry.py`                                                                                                                                                                     | Retries an empty startup tool list, rediscovers tools, keeps expected analyst results off the circuit breaker, and scopes page cursors to one chat.                                                                                                                                                                           |
| 0003 API server MCP wait     | `gateway/platforms/api_server.py`                                                                                                                                                                                                                                                  | An API run waits for MCP tools before it builds the agent. Its usage also reports the cached prompt tokens.                                                                                                                                                                                                                   |
| 0004 skills_read toolset     | `toolsets.py`                                                                                                                                                                                                                                                                      | A read-only skills toolset (`skills_list`, `skill_view`) for specialists with playbooks.                                                                                                                                                                                                                                      |
| 0005 models.dev offline      | `agent/models_dev.py`                                                                                                                                                                                                                                                              | No models.dev request unless `CUTTLELY_MODELS_DEV=1`. Cached data still serves; lookups without data fall through to the other sources.                                                                                                                                                                                       |
| 0006 security pins           | `pyproject.toml`, `uv.lock`, `package.json`, `tests-js/package.json`                                                                                                                                                                                                               | Raises dependencies that have published security advisories to fixed versions. Drop it once upstream ships them.                                                                                                                                                                                                              |
| 0007 unused dependencies     | `pyproject.toml`, `uv.lock` (continues 0006)                                                                                                                                                                                                                                       | Drops tenacity, jinja2, watchfiles and resvg-py from the core dependency list and relocks for Python 3.14. jinja2 stays on the kittentts extra and watchfiles stays on the modal extra. Also raises mcp to 2.2.0 (GHSA-84m7-p3x7-pcfv) and aiohttp to 3.14.4 (GHSA-5wr8-gcqf-gqf3, GHSA-2g87-pp6c-29x5, GHSA-494j-54xm-rwp3). |
| 0008 git config commands     | `hermes_cli/_subprocess_compat.py`, `agent/coding_context.py`, `tools/subagent_worktree.py`, `tools/async_delegation_recovery_hints.py`, `hermes_cli/worktree_gc.py`, `hermes_cli/worktree_ops.py`, `hermes_cli/kanban_db_workspace.py`, `tui_gateway/methods_complete_helpers.py` | Stops automatic git calls from running commands named in the repository's own config: fsmonitor, hooks, and clean/smudge/process filters. Ported from NousResearch/hermes-agent pull 130661. The pin stays `f42f579`. Website docs and the upstream `tests/` tree are not vendored.                                           |
| 0009 tool error preview tail | `gateway/platforms/api_server_runs.py`                                                                                                                                                                                                                                             | A failed tool call's `tool.completed` preview keeps its head and its tail, up to 1200 characters, so the exception, the URL and the HTTP status stay visible. Successful calls are cut at 500 characters as before. Test: `scripts/hermes-tool-error-preview.test.mjs`.                                                       |

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
5. When a patch now touches a file it did not before, or no longer touches one, update `.github/codeql/hermes-patched-files.txt`. See [Code scanning](#code-scanning).

A later patch may continue a file an earlier patch already edits. `--save-patches` leaves that earlier patch as it is and writes the new edit into the last patch that lists the file. A file no patch lists still needs `--new`. `--save-patches` fetches the pinned commit to compare against, so it needs the network.

To leave out another upstream folder, add it to `CUTTLELY_EXCLUDE.txt` and run `pnpm hermes:vendor` at the same pin. To bring one back, take it off the list and do the same.

## Measured subset

`node scripts/measure-runtime-loads.mjs` rewrites `hermes/CUTTLELY_LOADED.txt`. It needs the agent runtime's virtualenv (`bash scripts/setup-hermes.sh`, or `HERMES_PYTHON`). The script imports the modules the server boots, starts the API server the way `scripts/cuttlely-hermes-api.py` does, discovers built-in tools and bundled plugins, loads the custom model provider, and calls the harness toolsets. It then follows import statements and `importlib` literals, including lazy imports in the agent loop, the API server and those toolsets.

After an upstream bump:

```bash
node scripts/measure-runtime-loads.mjs
pnpm hermes:vendor <same-pin>
node scripts/measure-runtime-loads.mjs --check
```

`--check` fails when a measured module is not in the tree. Commit the new list before `pnpm hermes:vendor`; the vendor command refuses an uncommitted `hermes/`. Re-running `pnpm hermes:vendor` at the same pin still changes nothing.

## Code scanning

CodeQL does not analyze the upstream code in `hermes/`. `.github/codeql/codeql-config.yml` lists `hermes/**` under `paths-ignore`, and `.github/workflows/codeql.yml` runs CodeQL with that config for GitHub Actions, JavaScript and TypeScript, and Python. The folder stays in the repository and in the image.

The files Cuttlely's patches touch are still scanned. `.github/codeql/hermes-patched-files.txt` lists every file a patch in `hermes/patches/` touches, one path per line, including `hermes/tools/mcp_tool_cuttlely.py`. The workflow's `hermes-patches` entry checks the repository out into `repo/`, copies those files with their paths to `hermes/` at the workspace root, and runs a Python analysis on that copy alone with `.github/codeql/codeql-hermes-patches.yml` (category `/language:python/hermes-patches`), so alerts point at the files in `hermes/`. The copy has to be at the workspace root because CodeQL extracts from there whatever `source-root` says. The list cannot go under `paths` in a CodeQL config: the Python extractor treats each `paths` entry as a folder and fails on a single file, and listing the parent folders would pull in all of `hermes/`, because `hermes/run_agent.py` and `hermes/toolsets.py` sit at its root. When a patch touches a new file, or stops touching one, update that list in the same pull request. `scripts/codeql-config.test.mjs`, in the `verify-test` step, reads the patches and fails when a patched file is missing from the list or a listed file is no longer patched.

Why: `hermes/` is a pinned copy of one upstream commit (`hermes/UPSTREAM_COMMIT`), not code Cuttlely writes. Hermes security releases are tracked weekly. A fix arrives as a new pin through `pnpm hermes:vendor`, or as a dependency raise in a local patch (0006, 0007) until upstream ships it. Alerts on upstream code would repeat that work and bury alerts on Cuttlely's own code.

C and C++ are not in the CodeQL matrix, because the only C and C++ files are under `hermes/native`.

Code scanning uses this advanced setup, and the repository's CodeQL default setup is off. Keep it off: default setup does not read a config file, so turning it back on would scan `hermes/` again and stop this workflow's uploads.

## What pnpm verify checks

| Step            | When          | Fails if                                                                                                                                                                            |
| --------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hermes-vendor` | fast and full | a path in `CUTTLELY_EXCLUDE.txt` is back, a patch no longer matches the files, or anything in `hermes/` changed outside the script (`CUTTLELY_VENDOR.txt` excepted). Works offline. |
| `hermes-import` | full          | a Hermes module Cuttlely runs does not import from `hermes/`. Uses `HERMES_PYTHON` or `hermes/.venv`, and skips with a message when neither exists.                                 |

A failing `hermes-vendor` after an intended edit means the edit is not saved as a patch yet: run `pnpm hermes:vendor --save-patches`.
