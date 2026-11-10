# Zoho invitation-gated access

InOut creates a disabled Keycloak account when an administrator invites a person. The app emails a short-lived, single-use link. Accepting the link activates the account; the recipient then signs in through Zoho. The app stores invitation state on the Keycloak user, so this feature adds no database table and needs no migration or database reset.

## Configure the local app

1. Generate the invitation client secret without changing other fields using `npm run env:secrets:generate -- invitations`. This fills a missing or empty `KEYCLOAK_INVITE_CLIENT_SECRET` with an independent random URL-safe value. Keep `KEYCLOAK_INVITE_CLIENT_ID=inout-invitations`; do not reuse the frontend or password-update client secret.
2. Set `INOUT_APP_URL` to the app's public origin. Local development uses `http://app.localhost:1008`; use the real HTTPS origin in deployment.
3. Configure `KEYCLOAK_SMTP_*` in `.env` with a working sender. Compose passes those values to the app invitation sender too. The sender address must be allowed by your mail provider.
4. With the local Keycloak administrative port available, run `npm run keycloak:invitations:check`, then `npm run keycloak:invitations:apply`. The provisioning script creates or verifies the confidential, server-only `inout-invitations` client and its service account. It enables only after verifying the required `realm-management` roles. It will not rotate an existing secret.
5. Restart the app and Python API after changing `.env` so they load the new values.

The invitation client has the Keycloak `manage-users`, `query-users`, and `view-users` roles because the app must activate one Keycloak user from an unauthenticated acceptance page. Its secret is passed only to the Python API container. Keep it private and use a dedicated realm for this application.

## Configure Keycloak user attributes

In **Realm settings → User profile**, register these optional text attributes and allow **admin** to view and edit them:

| Attribute | Purpose |
| --- | --- |
| `invite_status` | `pending`, `accepted`, or `revoked` |
| `invite_nonce_hash` | SHA-256 hash of the single-use link secret |
| `invite_expires_at` | Expiry time in Unix seconds |

Keep the attributes unavailable to end users. The raw link secret is never stored in Keycloak or Postgres.

## Bind the Zoho broker flow to invitations

Create a copy of Keycloak's **First Broker Login** flow and configure the copy for the Zoho identity provider only:

1. Require **Detect Existing Broker User**.
2. Require **Automatically Set Existing User** after the existing account has been detected.
3. Remove any execution or fallback in this flow that creates a new user when no matching invited account exists.
4. Set the Zoho provider's **First Login Flow** to this copied flow. Leave other providers on their own flow.
5. Have Zoho supply a verified email claim. Match the existing account using that exact email; do not trust an unverified email claim or link accounts by username alone. Enable Keycloak's **Trust Email** option only if Zoho guarantees verified email addresses.
6. Disable self-registration and any alternate sign-in path that could create an InOut account without an invitation. Keep the existing Zoho broker hint enabled in the app.

The person must accept the invitation before Zoho sign-in. This enables the pre-created account; the Zoho flow then links the verified Zoho identity to that existing account. Unknown Zoho identities must fail the flow instead of being provisioned.

## How administrators use it

In **User management**, choose the person's role and required checkpoint or zones, then send the invitation. The recipient opens the link, explicitly accepts it, and continues with Zoho. Admins can resend or revoke a pending invitation. The link expires after 15 minutes by default; set `INVITE_TTL_SECONDS` to change that duration.

Kong limits public acceptance to 10 requests per IP per minute to slow token guesses, and limits invitation-management posts to 30 requests per IP per minute.

Invitation status and access assignments are coordinated with Keycloak and the app's existing database records. Resetting Postgres does not reset the Keycloak realm or delete its users. After a database reset, re-create the relevant zones/checkpoints and issue invitations against those current records; remove old Keycloak test accounts separately if they should not remain.

## Verify the setup

- `npm run keycloak:invitations:check` reports the server-only client and roles as configured.
- Send a test invitation to a mailbox you control; confirm the link uses the configured app origin and expires as expected.
- Before acceptance, verify the account is disabled and direct Zoho sign-in is denied.
- Accept once, then continue through Zoho. Reusing the same link must fail.
- Try an uninvited Zoho identity; it must not create an account or gain an app role.
- Verify a zone admin can invite only an operator in their assigned zones, while only a master admin can invite a zone admin.
