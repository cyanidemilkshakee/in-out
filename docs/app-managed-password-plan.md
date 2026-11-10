# App-owned Keycloak authentication

The application's own forms handle sign-in, administrator reauthentication, configured OTP verification, temporary-password setup and ordinary password changes. A version-pinned Keycloak extension performs credential checks and issues the provider's normal signed tokens. The browser stays on the application origin for these operations.

This is a custom authentication protocol built with Keycloak extension APIs. It is not Authorization Code + PKCE, is not an official general-purpose headless-login API, and does not remove the application's responsibility for handling credentials safely. Keycloak's recommended browser authentication architecture remains Authorization Code flow. The built-in password grant is disabled for `inout-frontend` and is not a fallback.

## Configuration and deployment

1. Build the provider into the Keycloak image using `keycloak/Dockerfile`. The current deployment target is **Keycloak 26.8.1**; the custom interaction protocol is `inout-app-interactions-v1`, extension version `1`. The 26.8.0 real-provider suite passed on 1 November 2026, but the 26.8.1 provider build/runtime suite had not been run as of the 5 November verification. Re-run it in an isolated realm before treating 26.8.1 as verified; the Authentication SPI is internal and can change between releases.
2. Preserve `KEYCLOAK_CLIENT_SECRET` from the existing confidential `inout-frontend` client. The app authenticates its private provider calls with this secret. Do not expose it, interaction tickets or provider tokens to browser JavaScript.
3. Through the loopback maintenance gateway, run `npm run keycloak:interactions:apply` and `npm run keycloak:interactions:check`. Both first authenticate a read-only `GET /realms/inout/inout-auth/status` probe, verify the exact provider/protocol version and check that no realm/global OAuth client policy is enabled. A missing/mismatched provider, malformed policy response or enabled policy stops configuration before any writes. No policy is disabled automatically.
4. Configuration enables `inout.app-interactions.enabled=true`, disables Direct Access Grants, retains confidential-client authentication and S256 browser code flow, and preserves existing secrets, unrelated attributes, scope mappings and return URLs. `keycloak:app-sign-in:apply` now uses the same readiness gate and cannot re-enable password grants.
5. Deploy the matching app and verify synthetic sign-in and password changes. During an existing-install cutover, enabling the extension and disabling the grant must be coordinated with the app deployment: the old app still requires its old sign-in path.
6. Only after the new app works, explicitly retire its previous administrative password client:

   ```powershell
   node scripts/configure-keycloak-interactions.mjs --apply --retire-native-password-client
   node scripts/configure-keycloak-interactions.mjs --check --retire-native-password-client
   ```

   This disables only `inout-password-updates`; it does not delete its secret, policy history, users or unrelated realm data. Default apply does not retire it prematurely. New realm templates leave this legacy client disabled. Do not run the legacy native-password provisioning command after cutover.

The private `PASSWORD_UPDATE_LOCK_API_URL` remains required for password changes. Compose supplies `http://python-api:1019`; manual development needs a reachable private API and matching `AUTH_SECRET` / `KEYCLOAK_STEP_UP_SIGNING_SECRET`. The old password-client ID/secret are migration-only settings and are not used by the interaction flow. All existing application services remain.

## Interaction protocol

The app's same-origin authentication/password routes retain signed CSRF validation, origin checks, bounded request fields/bodies and deadlines. Kong shares its credential-POST allowance with password changes. Keycloak interaction endpoints are private backend calls authenticated as the enabled confidential frontend client; a public or different client cannot use them.

For sign-in, the server creates a random verifier and its S256 challenge. It sends `mode=login`, username, current password, configured OTP and the challenge to `POST /inout-auth/verify`. The provider executes native password/OTP checks and dynamic required-action triggers. It rejects disabled/non-application accounts, missing or wrong credentials, and unresolved actions. Only a proven account whose sole action is `UPDATE_PASSWORD` receives the setup-required result; no session is created yet.

Successful login verification returns a random, 30-second, one-use code bound to its client, realm, user, authentication session, S256 challenge and credential fingerprint. The app redeems it through `POST /inout-auth/token` with its verifier and client authentication. Keycloak's shared one-use store prevents concurrent redemption across replicas; an incorrect verifier consumes the ticket too. The provider rechecks account and credential state before creating its normal access, ID and refresh tokens. The app verifies signatures, issuer, audience, token type, subject, freshness and matching authentication/session claims before creating an Auth.js session. Passwords are never stored in a ticket or session.

For setup/change, `POST /inout-auth/prepare` resolves the canonical user ID before the app acquires its per-user Redis lease. The server sends that pinned ID with credentials and the new password to `/inout-auth/verify`. Setup requires exactly `UPDATE_PASSWORD`; an ordinary change requires the current app-session subject and no unresolved action. Keycloak verifies credentials/OTP, evaluates policy and changes the password within the provider request transaction, clearing only `UPDATE_PASSWORD`. It returns `{ok:true,subject}` and creates no proof/login session. No administrative service token or native reset endpoint is involved.

Successful temporary setup returns to ordinary app sign-in with the username preserved. A user signs in again with the new password. Ordinary changes preserve the existing app identity and administrator window. Account-preview data is never used as an authentication identity.

## Failure behavior and limits

- No credential verification, ticket redemption or password mutation is retried automatically. Provider/gate/version mismatch fails closed, with no fallback to password grants or privileged reset APIs.
- One-use code expiry, wrong-verifier redemption, replay and account/credential changes require a new sign-in. Existing token refresh and revocation use the provider's standard endpoints.
- A lost password-write response returns an unconfirmed result and retains the short app lease. Check whether the new password works before another submission; never restore a password after an uncertain write.
- The app lease serializes app-originated updates across replicas. External provider administration and federated credential writes do not participate in that lease. Do not claim global serialization against concurrent external changes.
- Only configured OTP verification and the password action are supported by this custom interaction. Other required actions fail closed. Profile, email, authenticator enrollment, passkeys, recovery-code, locale and identity-provider controls remain previews. The existing provider email-recovery flow remains separate; this change does not create app-owned enrollment or recovery protocols.
- The provider refuses client requirements it cannot satisfy, including consent, minimum browser ACR, DPoP/mTLS-bound tokens, or disabled refresh-token issuance. It also rejects **any enabled realm or global OAuth client policy**, even one targeting a different client: the custom REST protocol does not execute standard OAuth grant/authorization policy contexts. Native credential-flow checks and token generation still apply, but these policies require a separate compatibility review before the custom protocol can be enabled safely. The configuration must not silently disable an existing policy.
- Keep Keycloak client secrets and interaction routes private, use HTTPS outside local development, and retain native brute-force protection and gateway controls. The extension still receives app-forwarded passwords and does not make that architectural risk disappear.

## Validation

`npm test` covers bridge token validation and configuration regressions, including refusal to change clients before an authenticated version probe. `npm run test:keycloak:interactions` runs configuration checks alone. After `npm run build`, use the built-app authentication/password HTTP harnesses with isolated provider/lease stubs. Backend lease regressions are in `backend/tests/test_password_update_locks.py`.

Run real-provider checks only in a disposable project, using a separate PowerShell session so fixture environment overrides cannot affect app maintenance commands:

```powershell
docker compose -p inout-interactions-test -f keycloak/compose.test.yaml -f keycloak/compose.interactions-test.yaml up -d --build --wait --wait-timeout 600 kong
$env:KEYCLOAK_PORT = '1098'
$env:KEYCLOAK_ADMIN_PORT = '1099'
$env:KEYCLOAK_ADMIN_USERNAME = 'fixture-master'
$env:KEYCLOAK_ADMIN_PASSWORD = 'isolated-keycloak-test-master-password'
node scripts/configure-keycloak-interactions.mjs --apply
npm run test:compile
$env:TEST_INTERACTION_FIXTURE = '1'
node scripts/test-keycloak-interactions.mjs
docker compose -p inout-interactions-test -f keycloak/compose.test.yaml -f keycloak/compose.interactions-test.yaml run --rm tests python /tests/check_interactions.py
docker compose -p inout-interactions-test -f keycloak/compose.test.yaml -f keycloak/compose.interactions-test.yaml down --volumes
```

An isolated real-provider test must verify temporary master-admin setup followed by new-password sign-in; ordinary changes preserving subject/window; incorrect password/OTP; brute-force lockout; disabled accounts; unrelated actions; policy rejection; mismatched subject/client; forged or expired tickets; wrong PKCE; concurrent redemption; provider/lease outage; and uncertain password responses. Verify the standard password grant rejects frontend/Postman requests after configuration. Browser acceptance and SMTP delivery require their own checks. Do not exercise destructive cases with real user credentials.

Verification on 2026-11-01 passed production builds, the frontend regression suite, both built-app HTTP harnesses, the compiled bridge against real provider tokens, and all 21 real-provider/compatibility cases on Keycloak 26.8.0. After cutover, `node scripts/test-app-interaction-deployment.mjs --local` passed temporary setup, new-password sign-in, identity-preserving password change, logout and changed-password sign-in through the deployed app. That explicit local smoke command creates and deletes only its own synthetic operator; it performs no scans or organization-data changes. The old reset client was then disabled and the private provider boundary was verified. These results do not establish complete browser acceptance, SMTP delivery or compatibility with another Keycloak release.

## Provider references

- [Keycloak 26.8 server extensions and Authentication SPI](https://www.keycloak.org/docs/26.8.0/server_development/)
- [Official OIDC flows and password-grant limitations](https://www.keycloak.org/securing-apps/oidc-layers)
- [Keycloak 26.8 authentication, actions and credential policies](https://www.keycloak.org/docs/26.8.0/server_admin/)
