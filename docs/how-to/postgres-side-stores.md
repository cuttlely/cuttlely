# Move side stores into the application PostgreSQL database

The Instance Operator can move ETL pipelines, incremental state, local vector collections, published and draft agent team conversations, the turn queue, schedules, run history and Dashflows into the configured application PostgreSQL database. Open **Server Settings → Database → Application database storage** to see the source tables and counts. Switching the primary application database offers the same upgrade. The operator starts the copy explicitly.

![Operator upgrade screen with a populated ETL store](../images/server-settings/storage-upgrade.png)

## Before the upgrade

1. Back up the application database and the persistent volume. Check that both backups can be restored. Keep the installation encryption key and operator recovery material with the deployment's protected backups.
2. Enable `CUTTLELY_APP_DATABASE_STORES=1` and restart with the original volume connected. Apply the same database settings to external workers and replicas. On Docker, set the variable on the Compose service. On Render, set it on the service across a deploy with its disk attached. On bare metal, update the service environment and restart the service manager.
3. Leave one application instance running. Stop external workers, other replicas and older binaries or scripts that can write directly to the files. Finish queued runs, active chats and refreshes. Schedules retain their due times during the pause.
4. Inspect the inventory in Server Settings. Verify free space in the PostgreSQL host dashboard or filesystem and enter it in MiB. The estimate reserves twice the source size. PostgreSQL SQL sessions cannot report the hosting volume's available space. The application checks SQLite backup disk space, SQLite versions, active work and the database login's schema privileges.

## Run and verify

Select **Upgrade storage**. API callers receive HTTP 503 and `Retry-After: 30` during the pause. The server makes private SQLite backups under `side-store-backups/` in the data directory, including committed WAL content. Each logical store copies in a transaction and verifies before cutover. Local vectors keep their binary embeddings. Dashflows uses its existing pilot verifier and rebuilds its disposable query cache. A pilot already serving PostgreSQL continues there.

The report shows per-store results. Ordinary SQLite, MySQL and MariaDB installations keep their existing storage paths. On PostgreSQL, restart the workers and other application instances after verification. Check a known chat, a saved schedule and vector search. Run an unchanged incremental pipeline and check its embedded count is zero. Read-only `*.migrated` files remain beside the original locations. Server Settings reminds the operator after 30 days. The operator backup directory also retains a verified read-only original for each published profile, so deleting a team cannot erase the operator’s retained transcript. Rollback checks profile ownership before it restores a conversation. Remove the retained files explicitly when the rollback window ends.

If a copy stops, restart against the same database and disk. Select **Resume storage upgrade**. An interrupted upgrade stays paused. Cuttlely rechecks the backups, the source contents and any previous copy before finishing. A missing file, unexpected schema, changed source or occupied target requires investigation. The report contains counts and digests. Keep the backups private because they contain the original records.

## Roll back

Finish current work and stop the other instances. On the original volume, confirm the warning and select **Restore retained SQLite files**. Rollback requires all retained files, their original owner scopes and matching checksums. It restores the pre-upgrade conversations, ETL state and schedules. Writes since the upgrade stay in PostgreSQL archive schemas named `cuttlely_retired_<oid>`. Keep a database backup before separately removing any archive. After rolling back, another upgrade copies the current SQLite contents into fresh targets.

## What still needs the volume

Keep the disk for uploads, flow version repositories, agent team record JSON, the agent runtime home and operator/settings files configured locally. Agent runtime `state.db`, state owned by workflow nodes, browser profiles and user-provided file-backed databases each have their own lifecycle. Agent teams on multiple hosts still need consistent access to their profile files and uploaded artifacts. Render's single-instance Blueprint remains in place. See the [disk and settings inventory](../reference/disk-storage-inventory.md) for paths and owners.
