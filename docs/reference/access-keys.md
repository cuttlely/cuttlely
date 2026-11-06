# Access keys

Access keys authorize inbound API and SDK requests to Cuttlely. A principal has a workspace, an owner, permissions, operation scopes, resource grants, caller restrictions and limits. Its credentials are bearer secrets. Rotation creates another credential for the same principal, so policy, counters and audit identity stay together.

Provider credentials remain outbound secrets in **Credentials**. Public embeds, MCP endpoint tokens, webhook signatures and Dashflows public share links retain their separate transports. Keep privileged access keys on your server, including when using a JavaScript SDK.

## Rollout and migration

Back up the application database and the installation encryption key before upgrading. The encryption key also provides the domain-separated HMAC pepper for new credentials; replacing it invalidates those credentials.

`INBOUND_ACCESS_V2` controls rollout:

| Value           | Behavior                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` (default) | Existing integrations retain their legacy authorization. New principal issuance, policy editing and rotation are unavailable. Revocation remains available.                                                    |
| `shadow`        | Serve legacy decisions and compute the scoped decision without charging another request. Aggregate mismatches appear in **Admin > Audit log**, under access-key use events. New principals remain unavailable. |
| `on`            | Enforce operation scopes, resource grants, caller policies and limits. Enable this after checking migration diagnostics and the route matrix below.                                                            |

Build the server, then run `node scripts/access-keys-migration-report.cjs` against a restored database using the deployment's normal database environment. It reads only key IDs, workspace IDs, existing bindings and Harness names, and prints aggregate counts. It does not migrate or print secrets. Startup applies the migration transactionally and prints the same aggregate summary. Review orphan bindings, cross-workspace bindings and unresolved Harness names before enabling enforcement.

The migration preserves existing bearer values, scrypt verifiers, owners and workspaces. It creates exact resource grants from each flow's existing key binding and resolves the key's Harness names to stable canvas IDs in that workspace. It never grants all resources. Unresolved names, orphan pointers and cross-workspace pointers grant nothing. Flows with an existing binding become explicitly private; unbound flows become explicitly public. Provider credentials and public share tokens are untouched.

Existing principals have a migration-only compatibility marker and no newly imposed expiry. Their existing management permissions continue to work through the legacy exception; their bound prediction resources and Harness lists remain restricted. The owner's current workspace access is checked on every request. Saving a policy replaces compatibility with the explicit scopes and resource grants shown in the editor. It does not change the existing bearer value. Rotate only when you choose to.

To roll back enforcement, set `INBOUND_ACCESS_V2=off` and restart. This restores legacy principals' old authorization decisions and refuses scoped principals. Keep the added tables and columns. A schema downgrade cannot reconstruct modern credentials as legacy secrets. Keep the legacy adapter and name columns for at least two minor versions after measured parity; their removal is a separate change.

## Create and manage a principal

With enforcement enabled, open **Access Keys**. Create a principal, choose its workspace permissions and operation scopes, and select its resources. New principals start with no scopes and no resources. An empty policy can be saved and authorizes no runtime calls.

Resources are grouped as Chatflows, Agentflows, Harnesses and Dashflows. Grants use stable IDs. Deleting a Harness and recreating its name does not inherit its grants. A flow that calls a Harness also needs a grant for that Harness and the `harness:run` scope; the editor shows referenced Harness names. A grant to a public flow does not make it private. Set the flow's **API Endpoint** access control to **Private (selected access keys)** when the flow must require a bearer.

**All resources in this workspace** includes present and future resources in that workspace only. It requires `apikeys:grant-all` and a separate confirmation. It replaces only resource selection. Scope, permissions, caller policy, expiry and limits still apply. Owners and built-in Admins hold this permission; other roles must receive it explicitly. Keys cannot manage or issue descendant keys: management writes require an interactive session and current RBAC, including reauthorization of the target policy.

The default expiry is 90 days. Presets include 30 days, 90 days, a custom absolute UTC time and explicit no expiry. Environment (`live` or `test`) and service name are descriptive metadata, not separate resource environments.

Creation and rotation reveal a secret once. New credentials use `ctu_live_` or `ctu_test_`, a public token ID and 32 random bytes. Only an indexed HMAC digest, display prefix and final four characters are stored. Lists never return the digest, legacy verifier or bearer value.

Revoke a principal to block new requests using any of its credentials. Revoke an individual credential to retire only that value. Rotation defaults to one hour of overlap; choose 0 for immediate retirement or up to 86,400 seconds. Repeated rotations never extend an earlier credential's cutoff. Revoked credentials do not become valid during grace. Changing principal expiry never revives or extends an already issued credential; rotate to inherit the new expiry. Admitted streams and background runs may finish; new requests see the changed policy without a cross-request cache.

## Caller policies and counters

Origins are exact normalized HTTP(S) origins, with no paths, wildcards or Referer fallback. Adding an origin allowlist defaults to refusing a missing Origin. You may explicitly allow server callers without an Origin. An empty origin list has no origin restriction. CORS and Origin never replace the bearer.

IP rules accept exact IPv4/IPv6 addresses and CIDRs. An empty list has no IP restriction. Checks use Express `req.ip` and the deployment's `TRUST_PROXY` configuration, never arbitrary forwarded headers. Leave proxy trust off unless the deployment has a known trusted proxy boundary.

RPM is principal-wide, with operation buckets, and is shared by rotating credentials. Daily and monthly quotas use UTC calendar windows. A limit of 0 explicitly means unlimited. Count one accepted HTTP operation, including one streaming request, rather than tokens, chunks or nested Harness tasks. Middleware/controller rechecks do not charge again. Unauthorized calls are not admitted. Downstream execution errors remain charged once admitted.

Current UTC day/month totals and per-operation counts are persisted atomically. Old windows are removed; no request payload or per-request history is stored. SQL quota failures fail closed. A rejected limit returns `429` and `Retry-After`, with reset timestamps and remaining day/month quota headers. Minute admission uses bounded process memory and resets on restart. Configure `CUTTLELY_API_KEY_INSTANCES=1`; any other value refuses admission. Do not promise globally exact limits across replicas: the shared Redis limiter is a follow-on.

Modern caller policy and exhausted-budget checks run before JSON parsing. Final admission waits until body-dependent scopes are known. URL-resolved prediction, attachments and vector admission also run before parsers and file writes. Multipart prediction requires `predict`, `upload` and `stream` scopes up front so a later multipart field cannot widen access after storage starts. JSON streaming additionally requires `stream` and is refused before SSE headers. Body-resolved feedback and lead operations are checked after the bounded JSON parser. Existing flow/IP abuse limits and Harness/report caps still apply.

Lifecycle changes and policy/resource diffs appear in **Admin > Audit log**. Usage/refusal events are aggregated to at most one event per principal, operation and outcome per five minutes. They contain IDs and policy data, never bearer values, request IPs or origins, prompts, files or report contents.

## API route matrix

Authorization requires an active credential, the resource's owning workspace, current RBAC, the operation scope and a resource grant. A different workspace is `401`; absent scopes/grants or refused caller policy are `403`; unknown resources are `404`; limits are `429`. A supplied invalid bearer never falls through to public access when enforcement is on. Signed-in sessions retain their existing role checks.

| Route family                                                                         | Scope and resource                                                                                                   |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/prediction/:id`, Orchestrate and A2A adapters                          | `predict` and the exact flow grant; `stream` for streaming; referenced Harness grants plus `harness:run`             |
| Attachments, vector upsert and authenticated file reads                              | `upload` and the parent flow grant; existing conversation ownership and exact expiring signed-file links still apply |
| Feedback reads/writes                                                                | `feedback:read` / `feedback:write` and the parent flow grant                                                         |
| Chat-message reads/deletes/abort and leads                                           | `feedback:read` / `feedback:write`, the parent flow grant and existing route RBAC                                    |
| Chatflow item CRUD, draft CRUD/publish/rollback, version item/diff/restore           | `api:read` / `api:write`, the exact resource grant and existing route RBAC                                           |
| Flow streaming/upload capability reads                                               | `api:read` and the exact flow grant                                                                                  |
| Harness runs, async starts, status, result and diagnostics                           | `harness:run` / `harness:read`, the stable Harness canvas grant and existing run-ownership checks                    |
| Dashflows published snapshot, refresh status and owned report reads                  | `dashflow:read` and the dashboard grant                                                                              |
| Dashflows refresh and account-report generation                                      | `dashflow:report`, dashboard grant, referenced Harness grant and `harness:run`                                       |
| Access-key management                                                                | Interactive session, `apikeys:view/create/update/delete`; additional `apikeys:grant-all` for workspace-wide grants   |
| Unregistered/scoped workspace list APIs, scheduler changes and public-access changes | Refused for new scoped principals; explicit legacy management compatibility remains                                  |
| Public embeds and Dashflows UUID share links                                         | Existing public transport, without a required bearer; existing public abuse/report limits remain                     |

The registry is closed: adding a handler beneath a route prefix does not automatically expose it to scoped keys. New management operations must be explicitly registered. Management scopes do not imply prediction or Harness execution. A scoped key cannot change execution configuration, publish/restore a canvas, change a schedule, change public/private access or legacy bindings, or invoke draft test/check routes through a management scope. Metadata edits bypass the canvas-save path so an existing schedule cannot be re-enabled as a side effect.

### Management requests

The existing `/api/v1/apikey` path remains stable. `GET /options` lists the operations, resource choices and privileged-grant availability for the signed-in actor. `POST /` creates a principal; `PUT /:id` replaces its policy and grants. The body includes `keyName`, `permissions`, `accessPolicy`, `resources` and `expiresAt`. Use explicit `null` for no expiry; omit it on creation for the 90-day default. Each resource contains `resourceType` and `resourceId`. `allResources: true` also requires `confirmAllResources: true`.

`POST /:id/rotate` accepts `graceSeconds`. `POST /:id/credentials/:credentialId/revoke` revokes a credential (`legacy` identifies the compatibility credential). `DELETE /:id` soft-revokes the principal and preserves audit history.

### Dashflows reports

Dashflows remains Experimental and off by default. With it enabled, use the dashboard ID with a server-side bearer:

-   `GET /api/v1/dashflows/:id/published` reads the published snapshot.
-   `POST /api/v1/dashflows/:id/accounts/:accountId/report` starts a report only for an account in that published snapshot and returns `202` with `runId`.
-   `GET /api/v1/dashflows/:id/reports/:runId` reads that principal's report for that dashboard. Ownership receipts expire after seven days; another principal or dashboard cannot borrow the run ID.

Public UUID share URLs retain their existing report-ownership and abuse controls. They do not require both a share token and a bearer.

## Verification and follow-ons

`node --test scripts/access-keys.test.cjs` exercises the real SQLite migration, lifecycle, concurrent SQL quotas and management API. It also checks portable up/down fixture plans for SQLite, Postgres, MySQL and MariaDB. Server unit/HTTP tests cover the authorization matrix, caller policy, upload ordering and transport error statuses. The full repository gate is `pnpm verify` on Node 24.

Shared Redis admission for multiple API replicas, browser delegation, exports/alerts and removal of the legacy adapter are follow-ons. They are not enabled or implied by this release. The single-instance implementation writes accepted quota counters synchronously for exact admission; asynchronous telemetry batching is a performance follow-on, not a relaxation of quota enforcement.
