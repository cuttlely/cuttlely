# Health baseline

Recorded on 2026-10-11 from commit `8a86936`. [scripts/health-report.mjs](../../scripts/health-report.mjs) measures the current tree and prints the same tables. CI appends that report to the job summary. The report does not fail a build.

## Production dependencies

The lockfile lists 3,197 `name@version` entries. The workspace production closure is 2,303 packages.

| Package     | Direct | Closure |
| ----------- | -----: | ------: |
| Components  |    156 |   1,396 |
| Server      |     88 |     994 |
| UI          |     67 |     652 |
| Chat widget |      0 |       0 |
| CLI         |      0 |       0 |

Direct is the production dependency list with workspace links left out. The closure follows those dependencies, including optional dependencies, and does not follow a workspace link into another package. The workspace closure is the union of every package in the lockfile, including the workspace root. Dev dependencies are left out.

That audit counted three dependency aliases, the `*-cjs` names that install an existing package under a second name, as their own packages. The report resolves an alias to the package it installs, so the same lockfile measures a workspace closure of 2,300, a components closure of 1,393 and a server closure of 991. The UI, the chat widget and the CLI match the table.

## Image

The image was 3.04 GB.

| Part                  | Size                      |
| --------------------- | ------------------------- |
| `node_modules`        | 2,051 MB (2,257 packages) |
| System packages layer | 860 MB (Chromium 376 MB)  |
| Agent runtime         | about 400 MB              |

The agent runtime portion was a Python virtualenv of 171 MB, a uv Python of 107 MB and uv itself of 56 MB. The Docker job records the current image size with `docker image inspect`.

## Nodes

The module catalog listed 297 nodes. 11 of them have a unit test in the same directory.

## Security alerts

On 2026-10-11, 165 alerts had been raised and 0 were open.
