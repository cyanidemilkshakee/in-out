# Zoho invitation-gated access

InOut creates a disabled Keycloak account when an administrator invites a person. The app emails a short-lived, single-use link. Accepting the link activates the account; the recipient then signs in through Zoho. The app stores invitation state on the Keycloak user, so this feature adds no database table and needs no migration or database reset.

## Configure the local app

1. Generate the invitation client secret without changing other fields using `npm run env:secrets:generate -- invitations`. This fills a missing or empty `KEYCLOAK_INVITE_CLIENT_SECRET` with an independent random URL-safe value. Keep `KEYCLOAK_INVITE_CLIENT_ID=inout-invitations`; do not reuse the frontend or password-update client secret.
2. Set `INOUT_APP_URL` to the app's public origin. Local development uses `http://app.localhost:1008`; use the real HTTPS origin in deployment.
3. Configure `KEYCLOAK_SMTP_*` in `.env` with a working sender. Despite the variable prefix, these values configure the app's invitation sender; the sender address must be allowed by your mail provider. Invitation SMTP traffic passes through the dedicated `mail-relay` container. Only that relay has an outbound Docker network, and its code connects only to the configured SMTP host on port 465 or 587. The API stays on internal networks; TLS and server-certificate validation remain end-to-end between the API and Zoho.
4. Configure the Zoho OIDC identity provider in Keycloak first, using alias `zoho` (or set `KEYCLOAK_ZOHO_IDP_ALIAS` to your chosen alias). Request the `openid`, `email`, and `profile` scopes, and confirm Zoho returns `email_verified: true`. Then enable **Trust Email** for that provider. Zoho documents the `email_verified` claim in its OIDC token.
5. With the local Keycloak administrative port available, run `npm run keycloak:invitations:check`, then `npm run keycloak:invitations:apply`. The provisioning script creates or verifies the confidential, server-only `inout-invitations` client and its service account, grants only `manage-users`, `query-users`, and `view-users`, maps those roles into the service token, and assigns Keycloak's built-in `kc-admin-api` scope required by Keycloak 26.8+. It also creates the three hidden, admin-only invitation fields in the Keycloak user profile, creates the app-managed first-broker flow with only **Detect Existing Broker User** and **Automatically Set Existing User** as required steps, and binds that flow to the Zoho provider. It enables the client only after verifying the configuration. It will not rotate an existing secret or replace a flow it does not recognize.
6. Recreate the relay and Python API after changing `.env` so they load the new values: `docker compose up -d --build --force-recreate mail-relay python-api`.

The invitation client has the Keycloak `manage-users`, `query-users`, and `view-users` roles because the app must activate one Keycloak user from an unauthenticated acceptance page. The client also needs the built-in `kc-admin-api` default client scope and those three explicit role scopes: Keycloak 26.8 requires an Admin API audience in addition to the management roles. Its secret is passed only to the Python API container. Keep it private and use a dedicated realm for this application.

## Invitation user attributes

`npm run keycloak:invitations:apply` adds these as optional user-profile attributes that only Keycloak administrators can view or edit:

| Attribute | Purpose |
| --- | --- |
| `invite_status` | `pending`, `accepted`, or `revoked` |
| `invite_nonce_hash` | SHA-256 hash of the single-use link secret |
| `invite_expires_at` | Expiry time in Unix seconds |

No manual Keycloak profile edit is needed. The raw link secret is never stored in Keycloak or Postgres. If an invitation was sent before these fields were configured, resend it after applying the setup; the old link has no saved token hash and cannot be accepted.

## Invite-only broker behavior

The setup command creates and checks the Zoho-specific first-broker flow. It has exactly two required steps: **Detect Existing Broker User** and **Automatically Set Existing User**. There is no create-user fallback. Keycloak rejects a first Zoho sign-in when no matching InOut account exists. The matching email must be verified by Zoho; do not enable **Trust Email** for a provider that does not guarantee verified email addresses.

The person must accept the invitation before Zoho sign-in. Acceptance enables the pre-created Keycloak account and burns the one-time link secret; Zoho then links its verified identity to that existing account. The prior **SSO approvals** path for assigning roles to accounts created without invitations has been removed. Existing Keycloak users and role assignments are not automatically deleted or disabled by this setup. Review any accounts created through the old approval path and disable or remove uninvited accounts through Keycloak before relying on invite-only behavior. A Postgres reset does not remove Keycloak users.

## How administrators use it

In **User management**, choose the person's role and required checkpoint or zones, then send the invitation. The recipient opens the link, explicitly accepts it, and continues with Zoho. Admins can resend or revoke a pending invitation. The link expires after 15 minutes by default; set `INVITE_TTL_SECONDS` to change that duration.

Kong limits public acceptance to 10 requests per IP per minute to slow token guesses, and limits invitation-management posts to 30 requests per IP per minute.

Invitation status and access assignments are coordinated with Keycloak and the app's existing database records. Resetting Postgres does not reset the Keycloak realm or delete its users. After a database reset, re-create the relevant zones/checkpoints and issue invitations against those current records; remove old Keycloak test accounts separately if they should not remain.

## Verify the setup

- `npm run keycloak:invitations:check` reports the server-only client, restricted service account, exact Zoho broker flow, verified-email trust setting, and provider binding as configured.
- Send a test invitation to a mailbox you control; confirm the link uses the configured app origin and expires as expected.
- Before acceptance, verify the account is disabled and direct Zoho sign-in is denied.
- Accept once, then continue through Zoho. Reusing the same link must fail.
- Try an uninvited Zoho identity; the first-broker flow must reject it without creating a Keycloak user or granting an app role.
- Verify a zone admin can invite only an operator in their assigned zones, while only a master admin can invite a zone admin.
