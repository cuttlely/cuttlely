# Sign in

A new Cuttlely install has no users. You create one local account, the owner, and sign in with its email and password. Owner recovery keeps that account available when another sign-in method is selected. When several people need to sign in, select Local login, WorkOS, or generic OIDC under **Admin** > **Auth / SSO**. See [Choose the sign-in method](./auth-sso.md). To let people who already have a password use Local login, see [Users without AuthKit](./users-without-authkit.md). That option is off by default. Invited people still have no password until a sign-in link exists.

Install first: [Docker](./docker.md), [From source](./from-source.md), or [Render](./render.md). Render uses WorkOS and does not show an ordinary password form.

## Turn on the local account

The owner password form shows when the durable active method is Local login, the server runs with `CUTTLELY_LOCAL_ADMIN=true`, and `CUTTLELY_LOCAL_USERS` is off. Creating the first owner with the setup link or `pnpm user` selects Local login in the same database transaction, so a fresh local install has that owner-only combination. An already-selected durable method is left unchanged. Existing owner-only installations that upgrade keep recovery access without automatically enabling ordinary Local login. When Local login is active and `CUTTLELY_LOCAL_USERS=true`, `/signin` shows the shared local-user form instead; the owner uses that form like any other active local user.

| Install     | Default                                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| From source | On for the default owner-only Local method. `scripts/start-cuttlely.sh` sets the flag unless you set it yourself, `packages/server/.env` sets it, or `WORKOS_API_KEY` is set.                               |
| Docker      | On for the default owner-only Local method. The start script turns the flag on when it is unset or blank. Set `CUTTLELY_LOCAL_ADMIN=false` in `.env`, then `docker compose up -d`, for a WorkOS deployment. |
| Render      | Off. Owner recovery is always available at `/owner-recovery`; run `pnpm user` first if the owner needs a password.                                                                                          |

With the flag off, Local users off, and no available selected remote method, the sign-in page says `Sign-in is not configured.` and still offers **Owner recovery**. A server with no account opens `/setup` instead of leaving you there. When accounts already exist, that page also says how to turn an ordinary sign-in method back on.

![The Sign In page. Under the Cuttlely logo and the Sign In title, the only line is Sign-in is not configured.](../images/sign-in/signin-not-configured.png)

### When nobody can sign in yet

A server with no account, the password sign-in off and no AuthKit (for example Render without the WorkOS values) prints a ready block when it starts. The link uses Render's public address, or `APP_URL` when it is set, and the code is in the fragment:

```text
2026-10-09 12:00:00 [INFO]: ✅ Cuttlely is ready — finish setup:
2026-10-09 12:00:00 [INFO]:    https://your-service.onrender.com/setup#code=madeupcode000001      ← open on this machine
2026-10-09 12:00:00 [INFO]:    Setup code: madeupcode000001   (valid 60 min, works once)
```

The page reads the code, then removes it from the address. It opens **Sign-in & identity**, with two choices:

-   **Use a password for now** creates the owner account and turns the password sign-in on.
-   **Set up AuthKit** runs the same four steps as Server settings. The owner email is required, and the test sign-in must use it. Nothing is saved until the test passes.

Either way Cuttlely restarts when it can, or lists what to do. The link stops working as soon as it has been used, the first account exists, or a sign-in method is on. A code lasts 60 minutes. A restart, or a second copy of the server on the same database, keeps a live code: the link printed first still works. A second running copy logs that the code was printed by another copy. A restart of this install logs that the setup code from the last start is still valid, with the time it expires. While setup is still open, an expired code is replaced when a setup request finds it, or on a one-minute check, and the new link is printed. The ready block is printed again every five minutes while setup is still open, using that live code.

If accounts already exist but the candidate for the durable selected method is unavailable, there is no setup link. The browser opens the Sign In page with **Sign-in is not configured.** Environment settings make Local or WorkOS available as candidates; they do not change the recorded selection. Open `/owner-recovery`, using `pnpm user --email you@example.com` first if the owner needs a password, then fix the selected candidate or choose the ordinary method under **Admin** > **Auth / SSO**.

![Choose how people sign in. Two cards: Use a password for now, and Set up AuthKit. The note says this page works once.](../images/server-settings/setup-link-choose.png)

![Create the owner account, with empty fields for Your name, Email, Password and Password again, and Create account and restart.](../images/server-settings/setup-link-password.png)

![Set up AuthKit opened from the setup link, on Connect WorkOS, with a Staging chip. The API key is masked. Client ID reads client_demo_bakery.](../images/server-settings/setup-link-authkit.png)

![This setup link can't be used. The note says to copy it again from the server log. Go to sign in is the button.](../images/server-settings/setup-link-closed.png)

## Create the first account

The first account is the owner, shown as **Super User**. You can create it in the browser or in a terminal. Either way it works only while the install has no users.

### In the browser

On a new install, opening the app goes to `/setup`. Open the link in the ready block, or paste the setup code. The account form appears only after the code is accepted. Fill in your name, email, and password, then select **Create account**. The page is pictured in [From source](./from-source.md#in-the-browser).

Show the block with:

```bash
docker compose logs cuttlely | grep "Setup code"
```

```text
2026-10-09 12:00:00 [INFO]:    http://localhost:43117/setup#code=madeupcode000001      ← open on this machine
2026-10-09 12:00:00 [INFO]:    Setup code: madeupcode000001   (valid 60 min, works once)
```

The code is in the link fragment. It lasts 60 minutes from when it is printed and stops working once the first account exists. A restart or a second copy of the server keeps a live code, so the first printed link still works for register and the setup page. A second running copy logs that the code was printed by another copy. A restart of this install logs that the setup code from the last start is still valid, with the time it expires. An expired code is replaced when register or a setup page finds it, or on a one-minute check, and the new link is printed. The same link works through Docker's published port: open it on that host, or open `/setup` and paste the code. Without the code, the form does not appear.

After **Create account** you are signed in and land in Cuttlely. Keeping a copy in GitHub is optional and waits in **Version History**; see [Right after setup](./versioning.md#right-after-setup).

### In a terminal

Run `pnpm user` with the email. It asks for the password and doesn't show what you type.

From source, in the repository root, against the same database the server uses:

```bash
CUTTLELY_LOCAL_ADMIN=true pnpm user --email you@example.com
```

Docker:

```bash
docker compose exec -u node -it -e CUTTLELY_LOCAL_ADMIN=true cuttlely pnpm user --email you@example.com
```

It ends with:

```text
[INFO]: Super User created for you@example.com.
```

On a fresh owner-only install, this command selects Local login in the same transaction that creates the owner, just like browser setup. It does not replace a durable method that is already selected.

The password needs 8 to 128 characters, with a lowercase letter, an uppercase letter, a digit, and a special character. A password that misses a rule is refused, with one line for each rule it misses:

```text
[ERROR]: Password must be at least 8 characters
[ERROR]: Password must contain at least one uppercase letter
[ERROR]: Password must contain at least one digit
[ERROR]: Password must contain at least one special character
```

Without a terminal, for example in a script, the command reads the password from standard input until the input closes. Never put the password on the command line.

## Sign in

1. Open `/signin` on your server, for example [http://localhost:43117/signin](http://localhost:43117/signin). Opening any page while signed out also brings you here.
2. Type your **Email** and **Password**.
3. Select **Sign in**. On an owner-only Local installation, this posts to `POST /api/v1/auth/login` and creates an ordinary Local session.

![The owner password form on the Sign In page, with empty Email and Password fields, an eye icon on the password, and a Sign in button.](../images/sign-in/signin-break-glass.png)

The screenshot shows the password form only. The live page for an owner-only Local installation also shows the discreet **Owner recovery** link below the form.

The app opens **Chatflows**, or the page you were going to.

A wrong email or password shows `Invalid email or password.` After 10 failed tries in 15 minutes, the form says `Too many sign-in attempts. Try again later.` Wait, then try again.

![The Sign In page with a red message: Invalid email or password. Email is rosa.diaz@example.com and the password is masked. The button is Sign in.](../images/sign-in/signin-wrong-password.png)

## Sign out

Select the gear at the top right. The menu shows your name, then **Version** and **Logout**. Select **Logout**.

![The account menu open under the gear. It shows Rosa Diaz and Cuttlely, then Classic cards switched off, Version and Logout. Chatflows is the page behind it.](../images/sign-in/account-menu.png)

## Accounts and passwords

| Task                       | Command                                                                                | Result                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| List the accounts          | `pnpm user`, with no email                                                             | `Email addresses: ...` and `Email count: N`.                             |
| Reset a forgotten password | `pnpm user --email you@example.com`, with the email of an existing account             | `Password updated for you@example.com.` The new password works at once.  |
| Add a second account       | Not from the terminal. `pnpm user` with a new email prints `No account exists for ...` | Add people with WorkOS. See [Sign in with WorkOS](#sign-in-with-workos). |

With the flag off, `pnpm user` can still reset the owner's password. It refuses everything else, with `Refusing to create a user while the local admin flag is off.` for a new account, or `Refusing to set a password for ...` for another user.

There is no **Forgot password** link. A lost password is reset with `pnpm user`, on the server.

## Sign in with WorkOS

Use WorkOS when several people sign in. Cuttlely sends the browser to WorkOS AuthKit, and AuthKit checks who the person is. Teams, roles, permissions, workspaces, and API keys stay in Cuttlely's database.

1. Set `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` on the server, plus the other WorkOS values in [WorkOS AuthKit setup](../identity/workos-authkit-setup.md), and restart it. Then open **Admin** > **Auth / SSO** and switch the ordinary method to WorkOS. That switch ends existing interactive sessions. Environment-only selection applies only to a fresh installation or a first boot with no durable authentication state. A verified AuthKit email links to the one user with that mailbox; two users with the same mailbox are not linked. See [Turn AuthKit on](./users-without-authkit.md#turn-authkit-on).
2. On an empty database, also set `CUTTLELY_BOOTSTRAP_EMAIL`. The first person to sign in through AuthKit must have that verified email, and becomes the owner.
3. Open `/signin`. It now shows **Sign in with WorkOS**. The button opens `/api/v1/auth/login`, for example `http://127.0.0.1:43117/api/v1/auth/login` on a local server.

While WorkOS is the durable active method, `/signin` shows the WorkOS button and the discreet **Owner recovery** link. It does not show an ordinary password form, even when `CUTTLELY_LOCAL_ADMIN=true`; use `/owner-recovery` when the owner needs the recovery path.

To add people, see [Invite people](#invite-people). Roles, teams, and the permission each page checks are in [Roles and permissions](./roles-and-permissions.md).

The owner can also do steps 1 and 2 in the browser: open **Admin**, then **Server Settings**, then **Sign-in**, and select **Set up AuthKit**. It fills in the redirect addresses, makes the value used to seal one temporary setup-test session, and runs a real test sign-in with the new values before anything is saved. Application sessions remain database-backed. Password sign-in can be turned off only after that test passes. The values apply when Cuttlely restarts.

Field-by-field setup, redirect URIs, and WorkOS troubleshooting are in [WorkOS AuthKit setup](../identity/workos-authkit-setup.md).

### Invite people

An invited person joins only through their own invite link. Signing in through the active remote method with the invited email is not enough, even when the provider has verified that email.

1. Open **Admin**, then **Users**, and select **Add User**. Give the person a name, an email, a team and a role, then select **Create User**.
2. The dialog shows each returned one-time invite link, once. Select **Copy link** and send it to the matching person, then select **Done**. The dialog stays open while those links are visible. When the mail server is set in **Server Settings**, Cuttlely also emails them. With **Invite delivery** set to **Email**, Cuttlely only emails them and the dialog closes.
3. The person opens the link, selects **Accept invite with WorkOS** or **Accept invite with OIDC**, and signs in with the email the invite was sent to. The button follows the active method.

That first sign-in through the link makes the person active and creates their provider link in the same transaction that consumes the invitation. After that they use the active remote sign-in method like everyone else. If AuthKit public sign-up is off, also create them in the WorkOS Users directory.

For an OIDC invitation, the provider asks the person to sign in again even when another account already has a provider session. They can then sign in with the account whose email received the invitation.

Until they accept, the person is a pending invite: the Users list shows them as `invited`, and they have no access to any team. Signing in through WorkOS or generic OIDC without the link shows `You have a pending invite. Open the invite link from your email to join.` and leaves them pending.

An invite link:

-   works once;
-   lasts 72 hours, or the **Invite link lifetime** in **Server Settings** (1 to 168 hours);
-   works only for the person it was made for, signed in with that email;
-   stops working when a newer link is made for that person, when they are disabled, and when they are removed from the team or the organization. Adding them back does not bring the old link back.

With WorkOS or generic OIDC active, the link cannot be used to set a password instead: the password route refuses an invite token and leaves it unused. A link that fails any of these shows `This invite link is not valid. Ask for a new invite.` To make a new link for someone who is still pending, call `POST /api/v1/users/:id/reset-link` from their team. For a pending invite it returns a new invite link and the older one stops working. On the Users page, editing a pending person offers **Invited (pending)** or **Inactive**. Turning a disabled pending invite back on with **Invited (pending)** does not make them active: they still need a new link.

Field names and status codes are in [One-time links](../reference/auth-api.md#one-time-links).

## Troubleshooting

| You see                                                                       | What to do                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Sign-in is not configured.`                                                  | The candidate for the durable selected method is unavailable. Environment settings configure candidates; they do not change the recorded selection. Open `/owner-recovery`, use `pnpm user --email you@example.com` to set the owner password if needed, then fix that candidate or choose the ordinary method under **Admin** > **Auth / SSO**. |
| `Invalid email or password.`                                                  | Check the email. To set a new password, run `pnpm user --email` with that email.                                                                                                                                                                                                                                                                 |
| `Too many sign-in attempts. Try again later.`                                 | 10 failed tries in 15 minutes. Wait 15 minutes.                                                                                                                                                                                                                                                                                                  |
| `Refusing to create a user while the local admin flag is off.`                | Run `pnpm user` with `CUTTLELY_LOCAL_ADMIN=true`.                                                                                                                                                                                                                                                                                                |
| `No account exists for ...`                                                   | The install already has an owner, and the terminal only creates the first account. Use the owner's email to reset it, or add people through the selected sign-in method.                                                                                                                                                                         |
| `Not Found` while creating the first account                                  | An account already exists. Sign in instead.                                                                                                                                                                                                                                                                                                      |
| `Open the setup link from the server log ...` on **Create the owner account** | The setup code was missing or wrong. Look for `Setup code` in `docker compose logs cuttlely`, or create the first account with `pnpm user` this way.                                                                                                                                                                                             |
| `First-user setup is not available.` after WorkOS sign-in                     | On an empty database, `CUTTLELY_BOOTSTRAP_EMAIL` is unset or doesn't match the email you signed in with. Set it to your email and restart.                                                                                                                                                                                                       |
| `You have a pending invite. Open the invite link from ...`                    | You were invited and have not accepted yet. Open the invite link you were sent and select **Accept invite with _provider_**. The button names the selected remote provider.                                                                                                                                                                      |
| `This invite link is not valid. Ask for a new invite.`                        | The link was already used, expired, replaced by a newer one, or revoked, or you signed in with a different email. Ask an admin for a new invite.                                                                                                                                                                                                 |
| After moving a legacy `3.1.4` installation you cannot sign in                 | Passwords from that installation are accepted (bcrypt). Sign in once, or reset the owner with `pnpm user --email you@example.com`.                                                                                                                                                                                                               |
