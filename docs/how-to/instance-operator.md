# Designate the instance operator

The host CLI break-glass account is the default instance operator. When `pnpm user --email you@example.com` successfully creates the first owner or resets an active owner's password, it writes a host-only binding for that account and the effective database connection. With no `CUTTLELY_INSTANCE_OPERATOR` override, that bound active owner can configure the service in the browser. Other organization owners gain no service authority.

Existing installations need one explicit host step with the incoming build: bind the intended existing owner, or rerun the password CLI. Upgrading, signing in, creating an account through browser setup, or setting a bootstrap email never binds anyone automatically. Plan this step and keep host recovery available before deploying the planned 1.7.0 security-exception release.

## Onboard an operator

1. Back up the application database, encryption key and settings directory. Run commands inside the application installation/container, with the same environment, settings, mounts and effective database connection as the server. A source checkout needs its usual build first. Keep the original data and settings paths.
2. On a fresh installation, configure sign-in on the host first. For local setup, enable `CUTTLELY_LOCAL_ADMIN=true` and create the first owner with `pnpm user --email you@example.com`. It prompts for a password and writes the binding after successful account creation. Browser account setup is also available when host-enabled, but requires the bind step below afterward. A setup code cannot configure the service or write this binding.
3. For an existing account, use the explicit bind-only command. It does not prompt for or change a password:

    ```bash
    pnpm user --email you@example.com --bind-operator
    ```

    For Docker:

    ```bash
    docker compose exec -u node cuttlely pnpm user --email you@example.com --bind-operator
    ```

    The command requires one unambiguous email, an active user and active owner membership. With local-admin mode off, the selected account must also be the Super User accepted by the existing password CLI. With local-admin mode on, an explicitly selected active owner the CLI would accept can be bound. It never chooses an owner without an explicit command. A non-owner password reset keeps its existing behavior and does not bind an operator.

4. Sign in as that owner and open **Admin > Server settings**. No restart is needed for file binding changes. The server rechecks the interactive session ID, running connection fingerprint and current active ownership on every request. Other owners see **Only the instance operator can change server-wide settings**, without sensitive configuration or history. API keys and bearer-only callers cannot administer the service.

## Host file, overrides and revocation

The binding lives in `settings/instance-operator.json` under the installation's `CUTTLELY_DATA_DIR` (or the usual checkout data fallback). It contains exactly `version: 1`, `userId`, `database` (the existing operator connection fingerprint) and `createdAt`. The CLI atomically replaces it with owner-only `0600` permissions. On POSIX the server checks the file owner and mode; symlinks, oversized files, bad JSON/version/fields and connection mismatches fail closed with a host log notice. No file bytes, credentials or fingerprint are logged. Protect the installation directory and run the CLI as the same OS user as the server.

The file is separate from the database and `server.json`. It is never registered as a setting and cannot be created, changed or restored through browser settings, guided setup, settings PUT, history restore, safe boot, batch helpers or settings environment export/injection. Preserve it separately in host backups; reviewing or restoring it is host administration. A valid file binds only while its account is still an active owner. Binding replacements are recorded in the host settings history without identity values or credentials; host logs record binding changes and revocation/invalidity notices.

`CUTTLELY_INSTANCE_OPERATOR` takes precedence over the file:

| Host value                                | Browser service authority                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| Unset                                     | The valid CLI-bound active owner                                           |
| `none`                                    | Nobody, even when a valid binding file exists                              |
| JSON with exactly `userId` and `database` | That explicitly designated active owner, if the running connection matches |
| Empty or invalid value                    | Nobody; no file fallback                                                   |

Use `CUTTLELY_INSTANCE_OPERATOR=none` to revoke all browser service administration. Removing only an explicit JSON override returns authority to a valid file binding. Removing the file when the override is unset revokes its authority. Host overrides and changes to deployment environment reach the server after restart/recreation; changing the running process environment applies on the next request. Already accepted work can finish.

For a JSON override, select the exact account explicitly, verify its active owner membership on the host, and read its `user.id`. Run `pnpm settings operator-fingerprint` inside the same installation/environment. This prints the 64-character effective connection fingerprint without opening a database connection or printing its credentials. Set the host variable to `{"userId":"<existing-user-id>","database":"<64-lowercase-hex-fingerprint>"}` with real values; placeholders are invalid. Never put it in `server.json` or shared reports. Compose forwards a present host override and omits an unset one. Recreate with the same Compose file/options using `docker compose up -d --force-recreate`; a plain restart retains the old container environment. With the npm launcher use `cuttlely start --env-file <path>` for host configuration.

## Provisioning failures and recovery

The CLI completes the credential operation before writing authority. A failed credential operation never writes a binding. If the binding or its history write fails after a password change, the command exits nonzero and states that the password operation completed. A failed history write restores the previous binding (or removes a newly created one); failures are never reported as successful provisioning. Check host output and directory ownership, permissions and free space. Repair the host history destination, then run `--bind-operator` against the same installation/database without another password change. For a corrupt or unsafe existing binding, remove it on the host before rebinding. Keep `none` set during recovery if all browser administration must remain revoked; unset it explicitly when ready to use the file again.

If the bound account is disabled or loses active ownership, browser service administration closes. Recover that account or explicitly bind another active owner accepted by the CLI. The password command remains available when a reset is needed; no password goes in arguments or logs. There is no automatic fallback to another owner, the oldest user, or the bootstrap email.

The binding covers the effective database connection. A database switch still saves the connection and requires restart. After restart, a changed database/path, host, port, database username/password or TLS configuration invalidates the old binding. Verify the destination account and connection, then run the explicit bind command there (or recompute a host JSON override). A copied database with the same user ID/session at a different connection does not inherit authority. Changing the account's sign-in password alone does not change the database fingerprint.

Host/database administrators remain trusted: replacing contents at the same connection, changing DNS or replacing SQLite at the same canonical path is host/database administration. The fingerprint does not authenticate database contents against a hostile database administrator. No automatic rebinding occurs on upgrade, restore, retry or safe boot.

Host configuration remains available: `pnpm settings list`, `pnpm settings unset NAME`, `pnpm settings restore`, and `CUTTLELY_IGNORE_ADMIN_SETTINGS=1`. They never write or restore an operator binding. Restore and unset retain previous settings if their history write fails. Authentication-method changes end sessions as before; sign in again using owner recovery if needed.

## Scope

The operator boundary covers database/storage settings, tests, restart, settings history, retry/discard/restore, guided AuthKit setup, global sign-in/OIDC and version-history host configuration. Recent-authentication checks still apply. It grants no cross-organization flows, keys, users or provisioning. Tenant roles and organization-scoped SCIM are unchanged.

Access-key enforcement remains default `off`. Binding an operator does not activate it. Host `INBOUND_ACCESS_V2=off` overrides a saved mode for recovery. Compose forwards `INBOUND_ACCESS_V2` and `CUTTLELY_IGNORE_ADMIN_SETTINGS` with safe empty defaults; apply host changes by recreating the container. See [access-key rollout](../reference/access-keys.md#rollout-and-migration).
