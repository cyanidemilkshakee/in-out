# Security remediation — 5 November 2026

The routine fixes are authorized by the request to fix the audit findings. No
service is removed. Daybreak is excluded from all work. The following major
changes were presented for approval and deferred by the user on 5 November
2026. Neither change is implemented; the authority and storage risks remain.

## A. Application user administration

Status: deferred — keep the current authority model for now.

Problem: human zone administrators inherit Keycloak's realm-wide `manage-users`
role and can bypass the application's target, zone and step-up checks through
the maintenance listener.

Proposed implementation:

- Remove realm-management roles from human `zone-admin`/`master-admin`
  composites and frontend/Postman scopes.
- Add a confidential `inout-user-management` client with a service account.
  Give only that account the user-management roles needed by the existing API.
- Keep the secret in the Python API's environment only, separate from the
  frontend client secret. Obtain short-lived tokens with client credentials.
- Preserve the existing authenticated-actor, step-up, master-admin, target-role
  and zone checks before any administrative call. Human tokens authenticate
  the actor but no longer authorize direct Keycloak administration.
- Add a check/apply migration that verifies the replacement authority before
  removing human grants; fail closed on missing credentials. Invalidate human
  sessions and apply a native Keycloak not-before cutoff after role migration,
  verifying that old bearer tokens cannot reach the native Admin API. Redis
  application revocation alone is not sufficient for this migration.
  Keep the bootstrap administrator and its
  maintenance access intact.
- Add regressions for forbidden cross-zone and protected-account operations,
  direct human management claims, service-token failures and secret redaction.

Impacted areas: backend Keycloak client/config, realm import, configuration
scripts, Compose API environment and identity tests. User-management UI and
available operations remain unchanged. Deploying this requires a new secret
and a coordinated role migration; existing sessions will need sign-in again.

## B. Durable terminal evidence encryption

Status: deferred — keep the current storage behavior for now.

Problem: the shared browser profile retains offline scan evidence and asset
details in plaintext after logout. UI filtering is not a storage boundary.

Proposed implementation:

- Encrypt persisted scan evidence and cached terminal configuration with
  AES-GCM, using a separate random nonce for every write.
- Derive account-specific keys server-side from a dedicated stable storage
  secret. Release only the authenticated account's key after backend terminal
  authorization; keep the browser's key in memory, never in persistent storage.
- Clear memory on logout/account changes. Another account cannot decrypt the
  previous account's evidence. Reloading requires online authorization before
  stored evidence can be read.
- Migrate an account's legacy plaintext records transactionally after its next
  authorized sign-in. Never delete held evidence or rewrite scan keys/payloads.
  Legacy records without an identified owner require explicit reconciliation.
- Keep the storage secret stable and back it up; rotating or losing it makes
  old ciphertext unreadable. Add tamper, account-isolation, migration, reload
  and failed-key-fetch tests.

Impacted areas: terminal IndexedDB adapter, authenticated key endpoint, logout
cleanup, Compose app configuration and tests. Offline capture while the current
page is authorized remains available. Reading retained data after a reload
requires a live connection. No evidence retention period is shortened.

## Implemented routine changes

Checkpoint and analytics scope enforcement; shared-subject custody, rule and
entry-hold mutation checks; atomic Registry audit records; password reset,
session termination and partial-delete revocation; password policy and
credential audit events; CSV escaping; strict date/time component validation;
pinned security patch updates; readiness and CI regression coverage.

Verification: 245 frontend tests and 365 backend tests passed. The backend run
discovered 634 tests and skipped 269 integration tests. TypeScript checking,
the Next.js 15.5.29 production build, and all three synthetic localhost HTTP
suites passed (sign-in, password updates and application security boundaries).
The isolated Python environment uses the locked dependencies; Windows timezone
data is now included in the lockfile.

Docker was unavailable. The disposable PostgreSQL/Redis fixture configuration
was validated, but no fixture containers were created. Real PostgreSQL/Redis,
Temporal and Keycloak 26.8.1 provider compilation/runtime checks remain pending.
No live role migration, password-policy application or service deployment was
performed. Existing `.env` overrides and running images are preserved; follow
the README upgrade procedure before deploying the prepared Keycloak patch.
