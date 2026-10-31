# Auth / SSO design note

## Status and intent

This note records the provider-neutral authentication and provisioning design for Cuttlely. Phase B2, now on the main line, implements the shared database session, one selected interactive sign-in method, the **Auth / SSO** page, and permanent owner recovery. This branch adds the generic OIDC B1 implementation on that base. SCIM v2 remains later work.

The selectable methods are:

-   **Local login**: Cuttlely credentials and Cuttlely sessions.
-   **Generic OIDC**: standards-based browser sign-in configured from issuer metadata.
-   **WorkOS**: the existing AuthKit experience behind the same provider boundary.

Only one method is active for ordinary users at a time. The separate, always-available owner recovery login shipped in B2.

## Current-state constraints

The present identity module already owns users, memberships, teams, roles, permission snapshots, local credentials, and local session rows. Local session tokens are random values whose hashes are stored in the database; browser cookies are HTTP-only, use `SameSite=Lax`, cover `/`, and use the request or configured redirect scheme to choose the secure flag. Idle and absolute expiry are enforced, permission changes can invalidate the cached session snapshot, password reset ends that user's sessions, and state-changing cookie requests require an internal-request header.

The current WorkOS path is expressed through `WorkosPort` in `identity/types.ts`. The callback exchanges a code for an identity and provider session id, then creates the same `identity_local_session` row and `cuttlely-local-session` cookie as the other sign-in methods. Refresh reads and renews that database session. Sign-out deletes the row first, then uses the stored provider session id to create a hosted logout URL. The adapter retains inert compatibility readers for the retired browser value, while Server settings uses `WORKOS_COOKIE_PASSWORD` only to seal and open the temporary AuthKit setup-test value. Existing linking accepts only a confirmed mailbox, refuses rebinding, protects pending invitations, and permits first-owner bootstrap only for an empty database and the configured bootstrap address.

The durable authentication state records the selected method and authentication epoch. A method change ends interactive sessions in its transaction. Local-user password sign-in is available only while Local is selected, while owner recovery remains available under every method. The Server settings AuthKit setup keeps draft secrets out of browser responses, binds a real test sign-in to the initiating browser session, expires the test after ten minutes, and saves only after a successful test and explicit apply.

These are compatibility requirements, not merely implementation details.

## Administrative experience and configuration model

The Admin Panel gains **Auth / SSO**, visible only to an owner or a principal with the dedicated authentication-settings permission. Its summary shows the active method, configuration health, last change, session-ending impact, and SCIM status. The method selector is a single-choice control for Local login, generic OIDC, or WorkOS.

Changing the selector is a staged operation:

1. Configure the candidate method without affecting live sign-in.
2. Run its configuration checks and, for remote methods, complete a test sign-in in the initiating administrator's browser.
3. Present an impact confirmation stating that all existing interactive sessions will end, including the administrator's current session.
4. In one transaction, record the new active method and a monotonically increasing authentication epoch, append an audit event, and revoke all Cuttlely sessions.
5. Activate the new method only after the transaction commits. Redirect the administrator to sign-in.

The saved model separates `activeMethod` from provider configuration. Secrets are references to environment values or the server secret store and are never returned to the browser. A configuration can be incomplete or staged without becoming active. Read APIs return presence, fingerprints, and health only. Writes use optimistic concurrency to prevent two administrators from applying conflicting changes.

The ordinary sign-in page displays only the active method. A discreet **Owner recovery** link reaches the separate recovery form. Public option responses expose capabilities and labels, never issuer secrets, client secrets, bearer tokens, or diagnostic details useful for account discovery.

## Provider boundary

The provider interface covers remote authentication only; it does not own Cuttlely sessions, authorization, users, teams, or roles. A conceptual shape is:

```text
AuthenticationProvider
  kind
  configurationStatus()
  begin(input) -> authorization redirect and transient transaction
  complete(input) -> validated external identity
  optional remoteLogout(input) -> redirect
  healthCheck()

ExternalIdentity
  providerKey
  subject
  email and issuer email-assurance status
  displayName
  claims needed by policy
```

`begin` creates a short-lived, single-use authentication transaction. `complete` consumes it and returns an identity only after all protocol checks pass. Provider adapters cannot directly set the application session cookie or mutate roles. Local login implements the same higher-level completion contract after checking the password, but need not mimic a redirect protocol.

The existing `WorkosPort` remains the adapter-facing compatibility seam in phase A. A thin provider adapter translates its authorization, exchange, session, refresh, logout, and external-id operations into the new orchestration contract. This keeps current behavior stable before session convergence. At the convergence release, all sealed WorkOS sessions end once; there is no lazy exchange. All subsequent successful sign-ins create Cuttlely-owned sessions. Provider refresh data, if required, is encrypted server-side and is not the application session credential.

Errors are normalized into safe categories such as configuration unavailable, access denied, expired transaction, invalid response, unlinked identity, inactive user, and temporary upstream failure. Detailed causes go only to structured logs and audit records with secret and token redaction.

## Session ownership

Cuttlely is the sole owner of the application session. After any method completes, the server creates the existing database-backed session record and sends one opaque Cuttlely session cookie. The cookie contains no identity claims or provider tokens. The stored token is hashed; the row identifies the user, issue time, last activity, idle and absolute expiry, permission version, authentication method, provider-link id when applicable, and authentication epoch.

Every authenticated request checks the session row, user status, expiry, permission version, and epoch before constructing the existing `SessionUser` snapshot. Disabling a user, changing the active method, rotating relevant server session secrets, or an explicit revoke operation makes the session unusable. Disabling a user, whether through SCIM or an administrator action, also disables all of that user's API keys and personal tokens. A method switch does not disable API keys or personal tokens. Logout deletes the local row first and clears the cookie. A best-effort remote logout may follow, but remote availability cannot prevent local logout.

The Cuttlely cookie retains the current protections: HTTP-only, `SameSite=Lax`, `/` path, secure transport outside explicitly allowed local development, bounded lifetime, and no readable claims. Login and callback responses use `Cache-Control: no-store`. Session creation rotates any pre-authentication identifier. Viewing or changing the OIDC secret, applying a method switch, creating or rotating the SCIM token, and changing recovery settings require recent reauthentication, cross-site request protection, rate limits, and audit entries. A recent Local or owner-recovery database session satisfies this requirement for ten minutes, including while OIDC is active. An OIDC session counts only when its identity token has a qualifying `auth_time`; a WorkOS session does not count.

During phase A, existing sealed WorkOS cookies continue to work exactly as they do now. The convergence release ends every remaining sealed WorkOS session once and requires a new sign-in; it does not exchange cookies lazily. The release notes call out this one-time effect. No migration requires a user to edit settings. Compatibility routes, settings readers, and sealed-cookie handling remain for one minor release line, but expired sealed cookies cannot create sessions after convergence.

## Identity linking

External identity links are first-class rows keyed by `(providerKey, subject)` with a uniqueness constraint, plus a user id, normalized email observed at link time, and its assurance basis. `providerKey` is an immutable identifier for one configured provider instance, not merely the method name. This prevents the same subject string from two issuers or two successive configurations from colliding.

Sign-in resolves the provider-scoped link first. Once a durable subject link exists, email is profile data and is not required on later sign-ins. If no link exists, automatic email matching is allowed only when exactly one eligible active local user matches, no conflicting link exists, and the email qualifies on exactly one of three bases: the issuer sends `email_verified=true`, the provider's trust option below is enabled, or the user is accepting a valid invitation (next paragraph). Nothing else qualifies an email for first linking. Each provider also has an explicit **trust issuer email when verification is missing** option, off by default. When enabled, a present email with no verification claim may be used for first linking; an explicitly false claim is never trusted. The option, issuer, subject, matched user, and assurance basis are audited.

Invitation acceptance is a separate first-linking path. The user follows a valid one-time invitation, signs in with the intended provider, and the returned email must match the invitation. The invitation itself is the linking basis: a missing or false `email_verified` claim does not block a valid invitation, and email matching is case-normalized. The invitation is consumed and the subject link is created transactionally. Ordinary email matching never activates a pending invitation. Email is required only for first linking and invitation acceptance. Rebinding requires an explicit privileged recovery workflow and is never a side effect of sign-in.

The existing single `externalId` value is retained during phase A. A later migration creates link rows from it using the stable WorkOS provider key, with uniqueness and rollback checks, before any generic OIDC configuration can activate. A stable provider key combines a generated installation id stored in the database with a fingerprint of issuer and client id. Startup warns and blocks unsafe automatic linking when a restored or cloned database produces an installation or fingerprint mismatch that requires administrator review.

## Generic OIDC

### Setup card

The generic OIDC card contains:

-   Issuer URL.
-   Client id.
-   Client secret reference, with set or replace action and presence-only display.
-   Derived callback URL for copying, with the provider marker in the path and no query parameters. Generic OIDC sign-out returns directly to Cuttlely, so the card shows no logout registration address.
-   Requested scopes, fixed to `openid`, `email`, and `profile`.
-   **Trust issuer email when verification is missing**, off by default, with explanatory risk text.
-   Discovery and key-set status, last successful check, and sanitized error state.
-   **Test sign-in** and **Activate** actions.

Saving a draft fetches discovery metadata from the issuer's well-known endpoint over TLS. The server validates issuer equality, authorization and token endpoints, supported code flow, signing algorithms, and a usable signing-material URL. Public addresses require no entry. An exact allowlisted issuer host, including `localhost` or `ip6-localhost`, may additionally resolve to `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, or `fc00::/7`. It remains refused if any answer is `0.0.0.0`, `::`, in `169.254.0.0/16`, `fe80::/10`, `224.0.0.0/4`, `240.0.0.0/4`, or `ff00::/8`, or is `255.255.255.255`. The specific service addresses `100.100.100.200`, `169.254.169.253`, `169.254.169.254`, `192.0.0.192`, and `fd00:ec2::254` also remain refused. An `::ffff:` address follows the decision for its embedded IPv4 address. Every answer is checked, the selected address is pinned, unrelated hosts are unchanged, and `HTTP_DENY_LIST` remains authoritative.

Discovery and JWKS retrieval both reuse the single outbound request guard introduced in PR #350. That guard validates every resolved IP, pins the connection to the validated address, sends the intended host for TLS and HTTP, forbids redirects, and applies scheme, credential, port, size, and timeout limits. No second outbound-fetch implementation is permitted. This supports explicitly allowed private-network issuers, such as other OIDC providers hosted on a LAN, while retaining DNS-rebinding protection.

The test flow is bound to the initiating administrator and current browser session, expires quickly, is single-use, and does not replace the active method or create a durable user session. It reports protocol steps, the returned email, and its assurance status in a sanitized result. Activation is unavailable until the current configuration fingerprint has passed a test sign-in.

### Authorization and callback

The authorization-code flow always uses PKCE with a fresh high-entropy verifier and an `S256` challenge. Each attempt also has independent high-entropy `state` and `nonce` values. Only hashes of these secrets, or an authenticated encrypted transaction envelope, are stored server-side with provider key, redirect target, initiating session where applicable, and a short expiry. The callback consumes the transaction atomically before exchanging the code. Redirect destinations are allowlisted local paths.

The token response and unencrypted `id_token` are accepted only after validation of:

-   TLS and endpoint binding from discovery.
-   Expected issuer and client audience.
-   Signature against a currently acceptable discovered key.
-   Expiration with 60 seconds of clock skew; issue time when present.
-   Nonce equality.
-   Authorized-party claim when multiple audiences are present.
-   A nonempty stable subject.
-   Email assurance under the first-link or invitation policy when either is attempted.
-   A signing algorithm of `RS256`, `PS256`, or `ES256`; unsigned, symmetric, other, and encrypted id tokens are rejected.

Key-set caching follows response cache controls with a bounded maximum. An unknown key id triggers one rate-limited refresh before failure. Access tokens and refresh tokens are not placed in the browser session and are discarded unless a future, separately reviewed capability needs them.

## WorkOS compatibility

Phase A places current AuthKit behavior behind the provider interface without changing routes, cookie handling, bootstrap rules, invitation behavior, settings checks, test sign-in behavior, logout behavior, or failure messages. Existing environment names and secret-file values remain authoritative. The settings UI reads them into the WorkOS card with no manual conversion.

On first startup after upgrade:

-   If the existing WorkOS configuration is complete, `activeMethod` is inferred as WorkOS and its stable provider key is created from the database installation id and issuer/client-id fingerprint. The existing switch record is imported so startup does not repeat session deletion. A cloned-database mismatch produces an administrator warning and prevents unsafe automatic linking until reviewed.
-   If WorkOS is not configured and local-user mode is enabled, `activeMethod` is inferred as Local login.
-   If only the owner recovery mode exists, it remains available and no ordinary method is silently enabled.
-   If configuration is ambiguous, startup preserves the sign-in behavior computed by the prior release and records an administrator warning rather than guessing.

Inference is idempotent and recorded once. Existing users, invitations, credentials, links, cookies, routes, and deployments need no operator edits in phase A. Compatibility routes, settings readers, and cookie handling remain for one minor release line; new settings become the source of truth only after successful migration. The convergence release deliberately ends sealed WorkOS sessions once as documented in its release notes.

## Local login and break-glass access

Local login keeps the current password hashing, rate limits, account and source lockouts, one-time invitation and reset links, session lifetimes, and session deletion after password reset. It is an ordinary selectable method for active local users.

In phase A, no new recovery route is enabled and sign-in behavior is unchanged. The Auth / SSO page and an application banner warn administrators until `CUTTLELY_LOCAL_ADMIN` enables the existing recovery route and `pnpm user --email` creates an active owner credential with a usable password. Panel activation of WorkOS continues to return `409 Conflict` until both conditions hold.

Beginning in phase B, break-glass access is a separate owner-only path and is always available regardless of the selected method or remote provider health. It uses the owner's local credential and the same Cuttlely-owned session system, but is clearly marked as recovery use, has stricter throttling, emits a high-severity audit event, and can trigger an administrator alert. It cannot be disabled from the Admin Panel.

The recovery route must not disclose whether an address is the owner. It does not bypass user-disabled state, and recovery of a disabled owner requires the trusted server-side operator procedure. A break-glass session remains subject to idle and absolute limits. Switching the ordinary method ends it along with every other interactive session; the owner can immediately sign in again through the recovery path.

## SCIM v2 provisioning

SCIM is optional and independent of the selected interactive method. Its base path exposes `/Users` and `/Groups` beneath a versioned SCIM root, with JSON resource types and error responses appropriate to SCIM v2.

### Authentication and token lifecycle

An owner creates a high-entropy bearer token from the Auth / SSO page. The clear token is shown once; only a keyed hash, short display prefix, creation time, creator, last-used time, and status are stored. Token comparison is constant-time. There is one active token. Rotation creates its replacement and permits a short, explicit overlap window during which only the previous and replacement tokens coexist; ending the old token is available immediately. Create, rotate, revoke, and authentication failures are audited. Tokens are scoped only to SCIM routes, are never accepted as application API keys, and are redacted from logs.

### Users

`/Users` supports service-provider configuration discovery plus the needed create, get, filter, update, patch, and paginated list operations. Filters support `eq` and `and`/`or` expressions on `userName`, `externalId`, and `displayName`. Patch paths follow forms commonly used by Entra ID and Okta. There is no bulk endpoint in v1. The stable SCIM resource id maps to an internal provisioning-link row rather than email. `externalId` is stored as provider-controlled metadata with an appropriate uniqueness policy. Email normalization is used for cautious initial matching, but an existing linked resource wins and conflicting matches return a clear conflict.

Creation produces a provisioned account; it never grants owner status. The account has no session until its first successful SSO sign-in, with no policy toggle in v1. Setting `active` to false disables the user transactionally, invalidates open invitation and reset artifacts, increments the permission or authentication version, deletes all of that user's sessions, and disables all of the user's API keys and personal tokens before returning success. Re-enabling does not restore old sessions, keys, or tokens. Destructive deletion is represented as deactivation initially to retain audit and ownership integrity.

SCIM can never deactivate, delete, or demote an owner, including the last owner. Such a request returns `409 Conflict`, makes no user, role, credential, or session change, and records an audit event. The same last-owner invariant applies to administrator actions; attempts to disable, delete, or demote the last owner fail with `409 Conflict` and are audited.

### Groups and mappings

`/Groups` supports create, get, filter, update, patch, paginated list, membership add and membership remove. SCIM groups and membership are stored independently from Cuttlely authorization unless an administrator creates an explicit mapping.

Optional mappings connect one provider-scoped group to a Cuttlely team and, optionally, an allowed non-owner role. Mapping changes show a preview and require confirmation. Reconciliation is deterministic: group membership can add or remove team membership and set only roles allowed by the mapping policy. It cannot grant, demote, or remove owner status and cannot alter unrelated teams or manually managed roles unless the mapping explicitly owns that assignment. Removing a mapping previews the assignments owned by that mapping and, after explicit confirmation, removes those assignments transactionally. Conflicting mappings fail closed and appear in sync diagnostics.

### Operations view

The Admin Panel shows token state, last successful request, last failed request category, last completed request time, counts for created, updated, disabled, group, and membership operations, and recent sanitized errors with correlation ids. SCIM diagnostic records are retained for 30 days. No bearer token or sensitive attribute is displayed.

Conformance coverage exercises schemas, resource types, filtering, pagination, patch paths, idempotency, conflict responses, group membership, deactivation, authentication errors, and content types. Unsupported operations return standards-shaped errors rather than partial success.

## Switching semantics and consistency

Every change from one ordinary method to another ends all interactive sessions but keeps API keys and personal tokens enabled. Reapplying an unchanged method with an unchanged configuration does not. Changing security-significant fields of the active remote configuration is treated as a method transition and also ends sessions after a fresh successful test sign-in.

The database transaction increments the global authentication epoch and deletes session rows. The epoch check protects against replicas or delayed deletion. Provider callbacks begun under an older epoch or configuration fingerprint cannot create a session. In-flight SCIM calls use token state checked at commit time. Audit records capture actor, old and new method, configuration fingerprint, session count ended, time, and outcome without secrets.

If activation fails before commit, the old method and sessions remain valid. If remote cleanup fails after commit, Cuttlely still remains locally secure and reports the cleanup failure for retry.

## Security considerations

-   Apply least privilege: provider adapters return identity, while Cuttlely alone decides linking, roles, and sessions.
-   Encrypt stored provider secrets and transient remote credentials with managed server keys; never log authorization codes, tokens, passwords, cookie values, PKCE verifiers, or SCIM bearer values.
-   Require TLS in production and derive public callback addresses from trusted configuration, not untrusted forwarded headers.
-   Protect login, callback, local password, setup, token, and SCIM endpoints with route-specific limits and bounded request sizes.
-   Use state, nonce, PKCE, one-time transactions, exact redirect matching, and short expiries to prevent callback substitution and replay.
-   Retain authentication transactions for 10 minutes, then remove them; consumption remains single-use within that window.
-   Route discovery and JWKS fetching through the existing PR #350 outbound request guard, with resolved-IP validation, pinned connections, no redirects, size and time bounds, and the explicit issuer-host allowlist as the only private-network exception.
-   Pin identity to provider key plus subject. Treat email as mutable profile data after linking, not as the durable key.
-   Preserve invitation gates, first-link email-assurance requirements, inactive-user denial, last-owner protection, and explicit rebinding rules.
-   End sessions on method changes, user deactivation, password reset, and relevant privilege changes. User deactivation also disables API keys and personal tokens; method changes retain them. Keep idle and absolute lifetimes server-enforced.
-   Store session and bearer credentials as hashes, use constant-time comparisons, rotate credentials safely, and make revocation effective across all application instances.
-   Make setup and recovery responses non-cacheable and resistant to framing; protect state-changing cookie requests against cross-site actions.
-   Audit administrative changes, recovery use, linking decisions, SCIM mutations, token lifecycle actions, and repeated failures, while minimizing personal data.
-   Retain audit records according to the existing audit retention policy and SCIM diagnostics for 30 days.
-   Fail closed when configuration, issuer metadata, keys, database state, or time checks are uncertain. Provider outages must not block local logout or owner recovery.

## Testing strategy

Unit tests cover provider normalization; 10-minute state and nonce retention and consumption; PKCE generation; the allowed id-token algorithms, 60-second skew, and encrypted-token rejection; key rotation and cache bounds; provider-scoped linking; the default email-assurance rule and per-provider missing-claim option; invitation linking; epoch handling; cookie policy; redaction; SCIM filters and patches; group reconciliation and mapping removal; token rotation overlap; and owner protection.

Planned integration tests run generic OIDC and SCIM flows against a disposable standards test service in CI; they do not claim conformance testing against named identity providers. OIDC cases include success, denial, replay, mismatched issuer or audience, stale and future tokens, wrong nonce, unknown and rotated signing keys, malformed discovery, unreachable endpoints, missing and false email assurance, invitation acceptance, duplicate subjects, duplicate email, inactive users, callback races, remote logout failure, and a cloned-database provider-key mismatch. Network cases prove that discovery and JWKS use the PR #350 guard, reject redirects and DNS rebinding, and reach a private IdP only when its issuer host is explicitly allowed. SCIM cases cover `/Users`, `/Groups`, pagination, the defined filters, common patch paths, repeated requests, group mappings and confirmed removal, deactivation, disabled keys and tokens, immediate session loss, `409` owner protection, one-token rotation overlap, and rejection of bulk requests.

Session tests assert that all three methods produce the same Cuttlely cookie and authorization snapshot after convergence; cookie theft resistance properties, idle and absolute expiry, permission-version changes, password reset, user and administrator deactivation, method switching, retained API keys on switching, logout, and concurrent requests are covered. Browser tests cover the setup card, secret masking, recent reauthentication for each sensitive action, owner-recovery satisfaction of that requirement while OIDC is active, same-browser test binding, activation confirmation, sign-in labels, error copy, recovery route, token one-time display, mapping removal preview and confirmation, and operations diagnostics.

Upgrade suites start from representative 1.4.x databases and environment sets:

-   Existing complete WorkOS AuthKit install remains on WorkOS with its routes and settings intact, links migrate to the stable provider key, and startup does not end sessions a second time.
-   Existing local-user install remains on Local login with credentials, invitations, session limits, and routes intact.
-   Existing owner-only install retains owner recovery without silently enabling ordinary local access.
-   Mixed, partial, empty, and previously switched configurations choose the documented compatibility result and emit actionable warnings.
-   Migration reruns are idempotent on every supported database engine, preserve rollback safety, and do not expose secrets.
-   The convergence upgrade ends old WorkOS sealed sessions once, performs no lazy exchange, and thereafter issues only the Cuttlely cookie; compatibility handling remains inert for one minor release line.

The release gate includes schema migration checks, route contract checks, security regression tests, SCIM conformance tests, full application tests, and an architecture and security review for each phase.

## Phased delivery

### Phase A: provider foundation and Admin Panel

-   Add the Auth / SSO section, permission, active-method model, audit events, and staged switching workflow.
-   Put WorkOS behind the provider interface while retaining the `WorkosPort`-shaped adapter and current behavior.
-   Generalize the existing one-time switch record into method plus epoch state.
-   Implement the database installation id, issuer/client-id fingerprint, cloned-database mismatch warning, and compatibility inference for current WorkOS, local-user, and owner-only installs.
-   Keep existing cookies and routes stable in this phase; prove no behavior change with characterization and upgrade tests.
-   Warn administrators when the existing owner recovery credential is unavailable; do not add or enable the phase B recovery route.

### Phase B: generic OIDC and session convergence

-   Add discovery through the PR #350 outbound guard, the private issuer-host allowlist, authorization code flow with PKCE, state and nonce, the fixed scopes and token-validation profile, and provider-scoped link rows.
-   Add the setup card, secret references, missing-email-assurance option, invitation linking, configuration checks, same-browser test sign-in, and activation gate.
-   End sealed WorkOS sessions once at release, make the Cuttlely database session and cookie authoritative for remote sign-ins, and document the effect in release notes.
-   Keep compatibility routes, settings readers, and cookie handling for one minor release line, without lazy session exchange, and add unified logout semantics.
-   Add the separate, always-available owner break-glass route.
-   Make the break-glass alert and audit entry mandatory and not suppressible, require a second factor (TOTP or WebAuthn) on the break-glass owner or document that limit, and document manual owner offboarding.
-   Check user status on every API credential request and every session request, so a disabled user is refused on the next call; state that IdP deactivation ends sessions only with SCIM, or add OIDC back-channel logout.
-   Treat `xms_edov=true` as a verified email for Entra ID issuers, and make invitation linking refuse an explicit `email_verified=false`.
-   Name the env var or KMS source and the rotation procedure for managed server secrets, state whether rotating the client secret ends sessions, keep the PKCE verifier in an encrypted envelope, and add a log-redaction test for the code, verifier, client secret and bearer token.
-   Run the disposable test IdP in this phase's CI instead of waiting for Phase D.
-   Derive the epoch-binding HMAC secret with HKDF and its own label instead of reusing `WORKOS_COOKIE_PASSWORD`.
-   Use outcome-specific audit summaries, so a failed attempt is not recorded as refused.
-   Identify the authorization issuer before code exchange: check `iss` when returned, require it when advertised, and otherwise use a distinct redirect URI per configured issuer. Rate-limit the switch stage and apply routes with a 429 test.

### Phase C: SCIM v2

-   Add bearer-token create, rotate, overlap, and revoke controls.
-   Add `/Users` and `/Groups`, resource linking, the defined filters and patch paths, pagination, and standards-shaped errors; omit bulk in v1.
-   Make deactivation disable the user, sessions, API keys, and personal tokens atomically, with audited `409` protection for owners.
-   Add optional group-to-team and role mappings, assignment ownership, preview-and-confirm removal, and 30-day diagnostics.
-   Run the conformance suite in CI.
-   Let SCIM deactivate an owner other than the last active owner; keep the audited `409` for the last owner only.
-   Accept the Okta and Entra ID deprovisioning forms: PUT with `active:false`, PATCH with no `path`, capitalized operation names, member removal through `value` arrays and `members[value eq ...]`, `excludedAttributes=members`, and the random-id connection probe that expects an empty `ListResponse`; route every form into the same disable transaction (sessions, API credentials, personal tokens).
-   Implement DELETE `/Groups/{id}` to remove the assignments that group owns, and make DELETE `/Users/{id}` answer 204 and then 404 and omit the user from queries (RFC 7644 section 3.6) while the internal row is kept.
-   Bump the permission version in the group reconcile transaction, so removal from a mapped group takes effect on the next request, and refuse mappings to roles that hold `authentication:manage`.
-   Add recorded Okta and Entra ID request fixtures to this phase's CI instead of waiting for Phase D.

### Phase D: hardening and release readiness

-   Complete architecture and security passes, threat review, load and race testing, redaction review, and operational documentation.
-   Run 1.4.x upgrade matrices across supported databases and deployment shapes.
-   Run OIDC and SCIM integration suites against the disposable CI service.
-   Document setup, recovery, reauthentication, switching impact including retained API keys, token rotation, mapping behavior, troubleshooting, rollback boundaries, compatibility duration, and the one-time sealed-session cutoff in release notes.

## Decisions

1. The convergence release ends all sealed WorkOS sessions once. There is no lazy exchange, and the release notes state the one-time sign-in impact.
2. A stable provider key uses a generated installation id stored in the database plus an issuer and client-id fingerprint. A cloned-database mismatch raises an administrator warning and blocks unsafe automatic linking pending review.
3. Generic OIDC scopes are fixed to `openid`, `email`, and `profile`.
4. Email is required only for first linking and invitation acceptance. A durable provider-subject link does not require email on later sign-ins.
5. Accepted id-token algorithms are `RS256`, `PS256`, and `ES256`, with 60 seconds of clock skew. Encrypted id tokens are unsupported.
6. LAN and private-network IdPs require an explicit administrator allowlist of issuer hosts. Discovery and JWKS retrieval reuse the PR #350 outbound request guard with resolved-IP validation, pinned connections, and no redirects.
7. A SCIM-provisioned account has no session until its first SSO sign-in. There is no v1 policy toggle.
8. SCIM filters support `eq` plus `and`/`or` on `userName`, `externalId`, and `displayName`. Patch paths follow forms commonly used by Entra ID and Okta. There is no bulk endpoint.
9. Removing a group mapping removes the assignments it owns after preview and explicit confirmation.
10. SCIM permits one active token plus a rotation overlap window.
11. Authentication transactions are retained for 10 minutes, SCIM diagnostics for 30 days, and audit records according to the existing policy.
12. A method switch keeps API keys and personal tokens.
13. Recent reauthentication is required for the OIDC secret, method switch, SCIM token, and recovery settings. A recent owner-recovery or Local database session satisfies it for ten minutes, including while OIDC is active.
14. Compatibility routes, settings readers, and cookie handling remain for one minor release line.
