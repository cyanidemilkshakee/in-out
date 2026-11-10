# IN / OUT Management System

InOut is an inbound/outbound management system for an organization’s branches. It manages people, visitors, hardware, checkpoint access, movement records, and alerts. Administrators configure access; operators scan at assigned checkpoints.

## Contents

- [Installation and first use](#installation-and-first-use)
- [Usage and features](#usage-and-features)
- [Architecture and services](#architecture)
- [Configuration](#configuration)
- [Development and testing](#development-and-testing)
- [API](#api)
- [Operations and maintenance](#operations-and-maintenance)
- [Troubleshooting](#troubleshooting)
- [Main documentation](#main-documentation)

# Installation and first use
## Requirements

The application runs in Linux containers and can be used from Windows, macOS, or Linux. Install Docker Desktop on Windows/macOS, or Docker Engine with the Compose v2 plugin on Linux. Node.js 22.12+ with npm is used for the repository's setup and maintenance helpers; Python runs inside Docker. The same Docker Compose and npm commands work from PowerShell, macOS Terminal, or a Linux shell. No host Python installation is required. The test compiler loads the ESM JWT verifier through CommonJS, using the [ESM loading support enabled in Node 22.12](https://nodejs.org/en/blog/release/v22.12.0).

## Quick start

### 1. Prepare the environment

Existing databases and realms require [existing-volume maintenance](#existing-volume-maintenance). Existing Temporal data also requires the [Temporal upgrade guide](#temporal-upgrade); startup refuses an automatic multi-minor jump. Preserve their configuration and volumes.

```text
npm run env:init
npm run env:secrets:generate
```

The script fills missing or empty app-generated secret fields with independent random URL-safe values and prints only the field names. It leaves existing values untouched and never generates provider-issued credentials such as SMTP passwords. For an existing installation, scope it to a feature, for example `npm run env:secrets:generate -- invitations`; do not fill blank database or Keycloak bootstrap values unless you have confirmed that they match the persisted services. The default application URL is `http://app.localhost:1008`. Never commit `.env`. It does not rotate passwords or client secrets saved in an existing database/provider.

`KEYCLOAK_ADMIN_USERNAME` and `KEYCLOAK_ADMIN_PASSWORD` bootstrap Keycloak's server-level administrator only when its database is first initialized. Editing those values later does not change an existing Keycloak account. If a secret has been exposed in a screenshot or shared, replace the credential in the service that owns it and update the matching app configuration before restarting dependent services.

For an **existing realm**, keep its current client secret from **Clients → inout-frontend → Credentials**. Changing `.env` does not rotate the saved secret, and startup import does not overwrite an existing realm. Back up the realm before applying identity changes; make and verify those changes in Keycloak before relying on the updated application configuration.

Sign-in stays on the application's `/login` page with its own username/password form. A custom Keycloak **26.8.1** extension authenticates private server-side interactions for the confidential `inout-frontend` client, using native password/configured-OTP checks and one-use, short-lived codes bound to an S256 verifier before issuing signed provider tokens. Direct Access Grants are disabled and are not a fallback. Temporary-password setup stays on the same app page. Auth.js CSRF, strict origin/input checks, gateway limits and cryptographic token verification remain. Client secrets and interaction tickets stay server-side; provider tokens enter only private exchanges and encrypted HttpOnly cookies, excluded from public session JSON. Passwords are not stored in sessions. This is a custom extension protocol, not Keycloak's recommended Authorization Code browser flow; app-owned credential handling and version-compatibility responsibilities remain. Use HTTPS outside local development.

For an existing realm, startup import does not overwrite clients: first install and verify the matching extension image, then coordinate the app cutover with `npm run keycloak:interactions:apply` through the maintenance gateway in step 3 and verify with `npm run keycloak:interactions:check`. Configuration authenticates an exact protocol/version readiness probe before writes, enables the app-interaction client attribute and disables password grants while preserving secrets, scope mappings, unrelated attributes and exact return URLs. Standard Flow with S256 remains available for OIDC and provider recovery. The older `keycloak:app-sign-in` commands use the same readiness gate and cannot re-enable Direct Access Grants. Postman's public client keeps password grants disabled; implicit flow and service accounts remain disabled for the application.

The account page's profile, email, authenticator-enrollment, passkey, recovery-code, locale, and identity-provider controls remain **UI previews**. Required-action selections in Manage users are also preview-only. Password changes use the app's `POST /api/auth/password/update`: current or temporary password, new password/confirmation and OTP when configured. The server pins the user ID and acquires its private API/Redis lease, then the extension verifies credentials, required actions and policy and changes credentials inside its provider transaction. No administrative reset service is used. Setup accepts only `UPDATE_PASSWORD` and returns to normal sign-in; ordinary changes require the current verified session subject and preserve its identity and administrator window. Unsupported required actions fail closed. Lost write responses are not retried automatically. External administration/federated writes do not participate in the app lease. See [the custom protocol, deployment sequence and operating limits](docs/app-managed-password-plan.md).

To send recovery emails, set `KEYCLOAK_SMTP_*` values in `.env` before running `npm run keycloak:recovery:apply`. Without an SMTP host and sender address, the recovery page is available but Keycloak cannot deliver reset emails. For an SMTP service outside Docker's internal networks, add `compose.keycloak-smtp.yaml` when starting the stack; it gives only Keycloak outbound connectivity. The recovery command updates only recovery and supplied SMTP settings while preserving users and clients.

### 2. Build and start

```text
docker compose up --build -d --wait
docker compose ps -a
```

`-d` runs services in the background. `db-provision`, `temporal-schema-init`, `temporal-namespace-init` and `backend-init` should exit successfully; the API and worker remain running. A new cluster initializes workflow schemas using only its database owner, verifies real gRPC/namespace readiness, then seeds reference checkpoints and alert rules and registers the durable alert schedule. Startup does not create application login users.

For later starts without code changes, use `docker compose up -d --wait` to reuse the built images. Keycloak is compiled into its image, and the app initializes alongside its dependencies; Kong waits for all required services before opening the public listeners. Startup probes run every second during their grace periods. Frontend compilation and Python dependency downloads are cached between builds. Direct PostgreSQL connections reuse prepared statements; set `DATABASE_STATEMENT_CACHE_SIZE=0` when using a transaction pool that does not preserve them.

The Temporal inspection interface is intentionally off by default. Start it only when diagnosing workflows:

```text
docker compose --profile observability up -d temporal-ui
```

### 3. Create application users

The loopback-only administration gateway starts with the default Compose stack. If it was manually stopped, start it with:

```text
docker compose up -d --wait keycloak-admin
npm run keycloak:interactions:apply
npm run keycloak:interactions:check
node scripts/configure-keycloak-password-policy.mjs --apply
node scripts/configure-keycloak-password-policy.mjs --check
npm run keycloak:account:repair
npm run keycloak:master-admin:apply
npm run keycloak:master-admin:check
```

The interaction commands require the matching extension already installed and the existing confidential-client secret unchanged. Their authenticated readiness probe uses the app-configured `KEYCLOAK_CLIENT_SECRET`; a stale app secret must fail the check. Password-policy apply requires the rebuilt image's bundled denylist. New credentials must contain 12 to 128 characters and a non-whitespace character, cannot equal the username or email, and must pass Keycloak's configured policy. The bundled list rejects common passwords; it is a small baseline, not a complete breached-password corpus. Existing stronger requirements and administrator-managed denylists are preserved. Existing credentials are not rotated by applying the policy; review weak existing accounts and arrange a separate password update when required.

For an existing deployment, first verify synthetic sign-in and password changes with the matching app/provider, then explicitly disable the previous privileged password client using `node scripts/configure-keycloak-interactions.mjs --apply --retire-native-password-client`. Default apply deliberately leaves that client alone during cutover; new realms keep it disabled. Do not run the legacy native-password provisioning command after migration. To enable the separate provider password-reset email workflow, configure SMTP values in `.env` and run `npm run keycloak:recovery:apply` while the maintenance gateway is available.

1. Open [Keycloak administration](http://auth.localhost:1009/admin/master/console/) using the master credentials from `.env`. Port `1009` is the loopback administration gateway; Keycloak's internal port `1022` is not a browser URL. The gateway routes `/` and `/admin` to the console.
2. Select the `inout` realm, create a user under **Users**, and set a temporary password under **Credentials**. At first sign-in, the extension verifies credentials before returning its setup-required result and the app offers **Change temporary password**. Complete the inline form, then sign in normally with the new password. A signed-in user changes a password from **Account and security → Password**, entering the real username/email and current credentials; other account controls remain previews. Neither password form redirects to Keycloak.
3. Assign `master-admin` to the designated first application administrator; it includes the `zone-admin` role. Assign `zone-admin` to later branch administrators and `operator` to terminal-only accounts, preserving default realm roles.
4. Sign in at [app.localhost:1008](http://app.localhost:1008). After role changes, sign out and back in to obtain updated claims.

The administration gateway remains bound to loopback. Stop it when provider administration is not needed; the regular identity listener continues to serve login, account security, and token refresh while rejecting provider administration:

```text
docker compose stop keycloak-admin
```

### 4. Register subjects and start operations

Use the admin Registry and Permission Manager pages to create people/assets and configure access. Assign the scanning account a checkpoint through **Manage users** before scanning at `/terminal`.

## Optional local fixtures

Normal startup creates reference zones/checkpoints and alert rules, but does not create sample employees, visitors, hardware, permissions, or movement history. To replace the local InOut application records with a full five-zone walkthrough dataset, run this from any supported host shell while the normal stack is healthy:

```text
npm run seed:demo
```

The script temporarily stops Kong, the app, API, and Temporal worker so no live requests race with the reset. It then uses a one-shot Docker container and a single database transaction to truncate **only the InOut `public` schema's application data**, keep `alembic_version`, and load the fixtures. It does not drop databases or volumes, change migrations, or clear the Keycloak schema or Temporal databases. If loading fails, the app-data transaction rolls back. The script rebuilds and starts the app, API, Temporal worker, and Kong even when seeding fails; after a successful seed it verifies that all 75 visitor approvals remain pending once Temporal is running.

The full fixture contains **5 zones**, **4 checkpoints per zone**, **7 real Keycloak operator accounts per zone** (35 total), one zone administrator per zone, one demo master administrator, **500 employees**, **500 visitors**, **500 hardware assets**, several thousand movement scans, permissions, visitor and manual-review queues, alert examples, audit history, and presence state. Each zone has 100 employees, 100 visitors, and 100 hardware records. Employees include active, restricted, and inactive examples with zone-wide and checkpoint-limited permissions; visitor data covers approved, pending, denied, expired, and currently-overstayed visits. Each checkpoint has at least one operator account assigned to it. Demo zone administrators start offline so operator status indicators can be exercised.

The loader creates or refreshes only its marked `demo-*` users in the existing `inout` Keycloak realm. It does not delete your existing Keycloak users. Demo IDs use the `demo-` prefix and barcodes use `DEMO-`. Login credentials are written to the gitignored file `.local-test-accounts/full-demo-accounts.csv`; treat it as secret and share it only with the people testing locally. The accounts are `demo-master-admin`, `demo-zone-a-admin` through `demo-zone-e-admin`, and `demo-operator-{a..e}-{01..07}`. The Keycloak bootstrap administrator values must already be configured in `.env`; the seed command does not print passwords.

The existing one-record `demo`, `additional`, and `test` seed modes remain for their development workflows. Do not use any local fixture against an organization database.

## Reset a disposable local database

This removes all InOut, Keycloak, and Temporal records held in the Compose PostgreSQL volume. It does not remove the separate Prometheus volume. Use only for a disposable local environment. First stop the stack, then verify the exact PostgreSQL volume name and Compose project label before removing it:

```text
docker compose down
docker volume inspect --format '{{.Name}} {{index .Labels "com.docker.compose.project"}}' in-out_pg-primary-data
```

For this checkout, the expected project label is `in-out`. If the inspected volume name or label differs, identify the exact disposable PostgreSQL volume before continuing. Then remove only that volume and initialize a new stack:

```text
docker volume rm in-out_pg-primary-data
docker compose up --build -d --wait
```

Avoid `docker compose down -v` for a targeted reset: it removes every named Compose volume, including observability data. In this stack, the PostgreSQL volume contains InOut, Keycloak, and Temporal state. If you use an external Keycloak database, clearing the local PostgreSQL volume will not clear those external accounts or settings.

## Invitation-gated Zoho sign-in (optional)

This lets administrators invite accounts without enabling public self-registration. The invite acceptance link is single-use and expires after 15 minutes by default; this is separate from visitor permission approvals. It adds no database table and needs no migration or database reset.

1. **Set the app values.** Keep `KEYCLOAK_INVITE_CLIENT_ID=inout-invitations`. Generate only its secret with `npm run env:secrets:generate -- invitations`; this fills a missing or empty `KEYCLOAK_INVITE_CLIENT_SECRET` and preserves all other values. Do not reuse `KEYCLOAK_CLIENT_SECRET` or the legacy password-update client secret. Set `INOUT_APP_URL` to the app origin (`http://app.localhost:1008` locally, your real HTTPS origin in production). Set `INVITE_TTL_SECONDS` if you need a different link lifetime (supported range: 60–86,400 seconds; default: 900).
2. **Configure invitation email.** Supply a working sender in `.env` using `KEYCLOAK_SMTP_HOST`, `KEYCLOAK_SMTP_PORT`, `KEYCLOAK_SMTP_FROM`, `KEYCLOAK_SMTP_FROM_DISPLAY_NAME`, `KEYCLOAK_SMTP_AUTH`, `KEYCLOAK_SMTP_USER`, `KEYCLOAK_SMTP_PASSWORD`, `KEYCLOAK_SMTP_STARTTLS`, and `KEYCLOAK_SMTP_SSL`. The sender address must be permitted by the mail provider. These values go to the app's Python invitation mailer; the SMTP password is provider-issued and is not generated by the secret script. If using Keycloak's recovery email feature too, apply its SMTP configuration with `npm run keycloak:recovery:apply`.
3. **Provision the Keycloak client.** Ensure the loopback Keycloak administration gateway is running, then execute:

   ```text
   npm run keycloak:invitations:check
   npm run keycloak:invitations:apply
   npm run keycloak:invitations:check
   ```

   These commands use the local Keycloak administrator configuration and target the **`inout` realm**, not the built-in `master` realm. They create or verify a confidential, server-only `inout-invitations` client with browser flows, direct grants, redirects, and web origins disabled. The app enables the client only after verifying its service account has exactly the required `realm-management` roles: `manage-users`, `query-users`, and `view-users`. The client secret is passed only to Python API. If this client already exists, the script will not rotate its secret; preserve and coordinate its existing value.
4. **Add invitation attributes in Keycloak.** In the Admin Console select **`inout` → Realm settings → User profile**. Add optional text attributes named `invite_status`, `invite_nonce_hash`, and `invite_expires_at`. Allow administrators to view and edit them; keep them hidden and non-editable for end users. Do not require these fields or enter their values manually. The app stores `pending`/`accepted`/`revoked`, the SHA-256 hash of the one-use token, and its Unix-second expiry; the raw link secret is never stored.
5. **Bind Zoho's broker flow to invited accounts.** Under **Authentication → Flows**, copy **First Broker Login** and configure the copy for Zoho only. Require **Detect Existing Broker User**, then **Automatically Set Existing User**. Remove any execution or fallback that creates a new user when no invited account matches. In **Identity Providers → Zoho**, set **First Login Flow** to this copy; leave other providers' flows unchanged. Zoho must return a verified email, and Keycloak must match that exact email. Enable **Trust Email** only if Zoho guarantees email verification. Disable self-registration and alternate creation routes that could grant an InOut account without invitation. Keep the app's Zoho broker hint enabled.
6. **Reload app configuration and verify.** After changing `.env`, recreate the services so they receive the new environment:

   ```text
   docker compose up -d --no-deps --force-recreate python-api app
   ```

   In **User management**, select the role and required zone/checkpoint scope, then send an invitation to a mailbox you control. Before acceptance, verify the Keycloak account is disabled and direct Zoho sign-in is denied. Accept the one-use link and continue with Zoho; reopening the link must fail. Try an uninvited Zoho identity; it must not create an account or gain an app role. A zone admin may invite operators only within assigned zones; only a master-admin may invite a zone-admin. Resend/revoke actions apply to pending invitations.

Resetting PostgreSQL does not reset Keycloak users or realm settings. After a database reset, recreate the relevant zones/checkpoints before issuing invitations, and separately remove old Keycloak test users if required.

# Usage and features

- **Manage users and branches:** master-admins manage organization zones and zone admins; zone admins manage checkpoints and operators in their zones.
- **Register and control access:** create employee, visitor, and hardware records; grant checkpoint access and review permission requests.
- **Operate checkpoints:** scan barcodes, make entry/exit decisions, submit manual reviews, and retain movement history.
- **Detect and review issues:** evaluate attendance and visitor rules, group alert events, review warnings, and track audit history.
- **Report and monitor:** dashboard analytics, exports, presence, and live updates.

The application roles are `master-admin` (organization-wide administration), `zone-admin` (administration scoped to assigned zones), and `operator` (terminal access scoped to an assigned checkpoint). These roles are separate from Keycloak’s built-in `master` realm administrator.

# Architecture


| Service | Responsibility |
| --- | --- |
| **Kong** | Public routing, request limits, streaming, and optional terminal certificate identity |
| **Next.js + Auth.js** | Web UI, server-side API layer, and application sessions |
| **Keycloak** | User identities, roles, OIDC tokens, and the private credential interaction extension |
| **FastAPI** | Authorization, access decisions, registry, scans, alerts, and reporting APIs |
| **PostgreSQL + Redis** | Durable business/workflow state; quotas, leases, presence events, and live updates |
| **Temporal** | Durable approval/alert workflows and scheduled processing |

## Local port allocation

Host-facing ports bind to loopback in the `1001–1011` block. Container-side listeners use `1012–1100`; ports `1037–1100` are reserved for future services.

| Host access | Host port | Container-side path |
| --- | ---: | --- |
| Browser app | 1008 | Kong 1012 → Next.js 1018 |
| API | 1002 | Kong 1013 → FastAPI 1019 |
| Public identity login | 1005 | Kong 1014 → Keycloak 1022; management/health 1023 |
| Keycloak maintenance admin (loopback) | 1009 | Separate Kong listener 1015 |
| Terminal client-certificate listener (optional) | 1011 | Kong listener 1016 |
| Temporal UI (optional) | 1007 | Temporal UI 1035 |
| Prometheus | 1010 | Prometheus 1036 |
| Container-only services | — | Kong status 1017; PostgreSQL 1020; Redis 1021; Temporal 1024–1034 |

# Configuration
## Environment variables

[.env.example](.env.example) lists settings; [compose.yaml](compose.yaml) defines which values each container receives.

| Setting | Purpose |
| --- | --- |
| `POSTGRES_PASSWORD` | Provisioning administrator credential; application services receive separate scoped credentials |
| `APP_DB_PASSWORD`, `MIGRATION_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD`, `TEMPORAL_DB_PASSWORD` | Independent URL-safe credentials for application DML, migrations, identity persistence and workflow persistence |
| `REDIS_QUOTA_PASSWORD`, `REDIS_EVENTS_PASSWORD`, `REDIS_GATEWAY_PASSWORD` | Independent Redis ACL credentials for data/behavior/leases, presence events, and Kong request counters |
| `AUTH_SECRET` | Encrypts/authenticates Auth.js session cookies |
| `AUTH_TRUST_HOST` | Auth.js host handling; Compose supplies this for the local stack |
| `KEYCLOAK_ADMIN_USERNAME`, `KEYCLOAK_ADMIN_PASSWORD` | Bootstrap master credentials, used when Keycloak first initializes |
| `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | Frontend client configuration; Compose uses `inout-frontend` and requires its matching secret |
| `KEYCLOAK_INVITE_CLIENT_ID`, `KEYCLOAK_INVITE_CLIENT_SECRET` | Dedicated server-only invitation acceptance client in the `inout` realm; secret is used by Python API only and generated with `npm run env:secrets:generate -- invitations` |
| `KEYCLOAK_PASSWORD_UPDATE_CLIENT_ID`, `KEYCLOAK_PASSWORD_UPDATE_CLIENT_SECRET` | Legacy native-reset configuration only; unused by the custom interaction flow. Preserve existing values during migration; explicitly retire the old client after verifying the new app |
| `PASSWORD_UPDATE_LOCK_API_URL` | Private password-update lease API; Compose supplies `http://python-api:1019`. Manual development must supply a reachable private API and matching `AUTH_SECRET`/`KEYCLOAK_STEP_UP_SIGNING_SECRET` |
| `AUTH_URL`, `APP_PORT` | Browser-facing application origin and Docker port; keep callback URLs consistent |
| `INOUT_APP_URL`, `INVITE_TTL_SECONDS` | Public origin used in invitation links and their expiry; defaults to `http://app.localhost:1008` and 900 seconds |
| `KEYCLOAK_VERSION`, `KEYCLOAK_PORT` | Server image pin and local identity-provider port |
| `KEYCLOAK_ADMIN_PORT` | Loopback administration gateway; default `1009`, starts with the default Compose stack |
| `TEMPORAL_UI_HOST_PORT`, `PROMETHEUS_PORT` | Optional observability host ports; Temporal UI uses the observability profile, while Prometheus is available on the local stack |
| `KEYCLOAK_ISSUER`, `KEYCLOAK_ISSUER_PUBLIC`, `KEYCLOAK_JWKS_BASE`, `KEYCLOAK_AUDIENCE` | Token issuer, optional browser-facing issuer override, internal JWKS address, and required API audience |
| `KEYCLOAK_SMTP_*` | SMTP host, port, permitted sender, auth and TLS settings. Python API uses these for invitation mail; `npm run keycloak:recovery:apply` applies them to Keycloak recovery email settings when that feature is used. SMTP credentials must come from the mail provider |
| `KEYCLOAK_JWKS_CACHE_TTL` | Signing-key cache lifetime; default 300 seconds |
| `PYTHON_API_URL`, `DATABASE_URL`, `READ_DATABASE_URL` | API and database connections; an empty read URL uses the primary database |
| `DATABASE_STATEMENT_CACHE_SIZE`, `DATABASE_CONNECT_TIMEOUT_SECONDS`, `DATABASE_POOL_TIMEOUT_SECONDS`, `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_LOCK_TIMEOUT_MS` | PostgreSQL prepared-statement cache, connection/pool timeouts, and server-side statement/lock deadlines |
| `QUOTA_REDIS_URL`, `EVENTS_REDIS_URL`, `TEMPORAL_HOST` | Separate authenticated cache pools and internal workflow connection |
| `PYTHON_API_PORT`, `APP_PORT`, `KEYCLOAK_PORT` | Loopback gateway listener port overrides; infrastructure ports are not published |
| `KONG_VERSION` | Pinned Kong OSS image version; default `3.9.3` |
| `KONG_TERMINAL_SECRET` | Optional Kong-to-API terminal identity secret, at least 32 random characters |
| `KONG_IDENTITY_SECRET` | Independent 32+ character secret for Kong's internal identity lookup; never reuse `AUTH_SECRET` |
| `KEYCLOAK_STEP_UP_SIGNING_SECRET` | Backend verification secret for browser user-management proofs; Compose supplies the same value as `AUTH_SECRET` |
| `KONG_TLS_DIR`, `TERMINAL_TLS_PORT` | Certificate directory and listener port for `compose.mtls.yaml` |
| `gateway/kong.yml` | Sole request-frequency configuration: ordinary API 300/minute per verified account or terminal; permission actions 60/minute and 10/second; user and alert actions each 20/minute and 5/second; API ingress 6,000/minute per socket peer before authentication |
| `MAX_REQUEST_BODY_BYTES`, `REQUEST_ADMISSION_CONCURRENCY` | API resource bounds; defaults 262,144 body bytes and 64 active requests per worker |
| `DATA_BYTES_PER_MINUTE`, `DATA_WINDOW_SECONDS` | Successful authenticated JSON reads and live-stream chunks share 67,108,864 bytes (64 MiB) per verified account in a fixed 60-second window; token refresh and API replicas share the account budget |
| `MAX_DATA_RESPONSE_BYTES` | Maximum complete JSON read response or individual live-stream chunk; default 16,777,216 bytes (16 MiB) |
| `DATA_SNAPSHOT_MAX_ROWS`, `DATA_ANALYTICS_MAX_ROWS` | Complete-read source caps; defaults 10,000 snapshot/directory/bucket/note rows and 50,000 activity-range events; excess returns 422 instead of sampled results |
| `MAX_SUBJECT_METADATA_BYTES` | Stored employee, visitor and hardware metadata cap; default 16 KiB, including server fields; creation and cumulative updates reject excess before committing |
| `BEHAVIOR_FAILURES_PER_MINUTE` | Authenticated 400/403/409/422 response threshold; default 20 per sliding minute |
| `BEHAVIOR_UNKNOWN_BARCODES_PER_MINUTE` | Fresh distinct unregistered barcode threshold per verified scanning identity; default 30 per sliding minute |
| `BEHAVIOR_COOLDOWN_SECONDS` | Temporary write pause after a behavior threshold; default 60 seconds; accounts are not suspended |
| `REQUEST_BODY_DEADLINE_SECONDS`, `INOUT_UPLOAD_DEADLINE_SECONDS` | Total API/gateway upload deadlines, both 30 seconds by default |
| `PRESENCE_STREAMS_PER_PRINCIPAL`, `PRESENCE_STREAMS_GLOBAL`, `PRESENCE_LEASE_SECONDS` | Distributed live-stream admission; defaults 3 per principal, 128 globally, 45-second crash recovery leases |
| `QUOTA_REDIS_MAX_CONNECTIONS`, `EVENTS_REDIS_MAX_CONNECTIONS` | Independent bounded Redis pools, default 64 and 160 connections |
| `ALERT_EVALUATION_MAX_SUBJECTS`, `ALERT_EVALUATION_MAX_MOVEMENTS`, `ALERT_EVALUATION_MAX_ALERTS`, `ALERT_EVALUATION_MAX_RULES` | Whole-evaluation capacity caps; exceeding any cap returns 503 without partial alerts |
| `IDEMPOTENCY_RETENTION_DAYS`, `AUDIT_RETENTION_DAYS`, `ALERT_RETENTION_DAYS`, `MOVEMENT_RETENTION_DAYS` | Maintenance windows: idempotency records default to 30 days; audit events, alerts, and movements default to indefinite retention (`0`) |

Compose supplies scoped credentials and private service addresses. Host-side backend development uses disposable test services or explicitly authenticated maintenance access. Backend settings are defined in [backend/config.py](backend/config.py). Settings not forwarded in a service's `environment` must be passed explicitly, for example with `docker compose run -e NAME=value ...`; adding a value to the root `.env` alone does not automatically inject it into every container.

## Data and behavior protection

Kong owns HTTP request-frequency limits using its bundled `rate-limiting` plugin, the synchronous Redis policy (`sync_rate: -1`), and `fault_tolerant: false`. Configure these only in [gateway/kong.yml](gateway/kong.yml), then recreate Kong. Each operation group has one stable service ID, so alternating endpoints or routing through another gateway does not create a fresh allowance. Ordinary authenticated API reads, writes and stream connections share one credential-based allowance; sensitive writes use their group's stricter credential-based allowance. Public API health/docs and CORS preflight use an IP-based route allowance. Limits use Kong's fixed calendar second/minute windows, rather than the removed application's sliding action windows. Kong returns `429` with `Retry-After`; a required gateway Redis failure returns `500` and does not reach a business handler.

Before accounting an account allowance, Kong's identity adapter calls the API's private `POST /internal/gateway/identity` endpoint with a separate secret and the bearer token. The existing Keycloak verifier checks signature, issuer, audience, type and expiry. Kong caches only successful verification for at most 30 seconds, checks expiry on every hit, and derives a hashed credential from issuer and subject. Token refresh cannot reset a quota. Verified physical terminals use their certificate DN. Public listeners block the internal endpoint and strip forged trusted headers; application role and checkpoint authorization still run in FastAPI. API paths use static ASCII/UUID segments; percent escapes, dot segments, repeated slashes, backslashes and semicolons in paths return `400` before routing so alternate spellings cannot select a weaker group limit. Encoded query parameters remain supported. The stock plugin applies one effective rate-limit configuration to each request: authenticated API and terminal routes use credential-based quotas, while public API routes use IP-based limits. No project-owned ingress-rate-limit Lua wrapper is needed.

The browser listener allows 1,800 requests per socket-peer IP per minute, including static assets and browser API calls; the public Keycloak listener allows 600. App sign-in POSTs have a stricter 10/minute, 3/second allowance, and Keycloak credential/MFA/recovery POSTs have a 60/minute, 5/second allowance. Public API health/docs and OPTIONS requests have a 6,000/minute IP allowance. Authenticated API requests use their account/action quotas instead of an additional broad IP quota; terminal scans use the verified terminal identity quota. These limits are separate from FastAPI's data and behavior budgets. Caller-supplied `Host`, listener and forwarded-address headers cannot select a different listener allowance. The loopback maintenance listener is excluded from public ingress limits. Keycloak's failed-login protection remains enabled independently.

Redis ACL users have explicit connection-command allowlists. Application data, presence events and Kong counters retain separate key/channel scopes; service accounts cannot pause Redis, kill or unblock other clients, configure the server, or clear the database.

The API selects identities only after JWT verification or trusted terminal certificate validation. Redis atomically shares data and behavior budgets across API replicas. Two access tokens or browser sessions for one account share the same account budget; a different account has a separate budget. Physical terminals use their verified certificate identity. Caller-supplied identity and forwarded-address headers cannot select another account's allowance.

Successful authenticated `GET` JSON responses are charged by their actual UTF-8 body bytes. The API holds the complete body until its size and remaining allowance pass, so a rejection sends an error without a partial successful response. A response over 16 MiB returns `413`; an exhausted 64 MiB allowance returns `429` with `Retry-After`. Complete source reads fetch at most their configured cap plus one sentinel row and return `422` on overflow. Paginated routes remain available within their existing page limits, and SQL dashboard counts still aggregate the complete matching history. Narrow report ranges or page through records; a failed page or capacity check must not become a partial CSV export presented as complete.

Live presence streams charge each emitted chunk, including heartbeats. If a chunk exceeds the size cap, the account exhausts its data budget, or quota storage becomes unavailable, the stream emits a safe `throttled` event with a retry delay and closes. The rejected chunk is withheld and stream resources are cleaned up. Ordinary JSON responses retain an HTTP admission slot through buffering and delivery; live streams use their separate distributed stream leases.

Backend behavior checks count authenticated validation/access failures and distinct fresh unknown barcodes, rather than ordinary action frequency. A denied scan decision returning `200` does not count as a validation failure. Replaying the same scan key does not spend the distinct-barcode allowance or create another movement; it still passes Kong's request quota and any active behavior cooldown. A behavior cooldown temporarily rejects subsequent writes with `429` and a decreasing `Retry-After`, while reads remain available subject to their own data and Kong limits. Locking the user-management window remains possible during a behavior cooldown. Rejected attempts do not extend that cooldown, and no account suspension is performed.

The first data or behavior throttle transition records a security audit event, deduplicated by verified identity and limit kind for the retry window. Inspect `GET /v1/audit-events?category=security` for `request_throttled`, limit kind, actor, route template, retry delay and signal details. Bearer tokens, request bodies, query strings and raw unknown barcodes are omitted. Structured application logs retain evidence if audit persistence fails. Kong request-frequency rejections appear in gateway access logs; they do not create application audit rows. Required API data/behavior-store failures return `503`; required Kong counter-store failures return `500`. Both reject instead of permitting unmetered work. See [Workflow 16](docs/workflows.md#16-enforce-data-and-behavior-limits-and-recover-safely) for the acceptance procedure.

Report generation shares a 10,000-row and 16 MiB budget across every selected source, with a 60-second loading deadline. Capacity, inconsistent-page and timeout failures stop further pagination and block export. Up to three already-running requests can finish under their existing HTTP deadlines. Browser API routes preserve upstream `Retry-After` for reads, commands, identity management and initial stream failures.

# Development and testing

Install the frontend dependencies with `npm ci`. For the local stack, start the backend services with Docker and run the frontend with `npm run dev`; development callbacks use `http://app.localhost:3001` and must be configured in Keycloak.

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | TypeScript checks |
| `npm test` | Frontend, authentication, and contract suites |
| `npm run build` | Production frontend build |
| `npm run test:postgres` | Backend/database tests in the isolated Compose test profile |
| `npm run test:gateway` | Disposable Kong and rate-limit tests |
| `npm run test:python` | Python unit tests |

The complete acceptance procedures, test details, benchmark commands, and latency regression workflows are in [Development and test workflows](docs/workflows.md). Dated verification records there are historical evidence, not a claim that every procedure was run recently.

# API

The browser uses same-origin Next.js routes. Direct clients use FastAPI `/v1` endpoints with a verified Keycloak access token and the required role/audience. User-management routes also enforce their reauthentication policy.

# Operations and maintenance
Before release or recovery work, identify the exact installation and compatible schema/workflow revisions. A complete isolated restore drill is not documented as completed; treat recovery as unverified until rehearsed.

| Task | Command |
| --- | --- |
| Start or apply code/configuration updates | `docker compose up -d --build --wait` |
| Inspect services and completed jobs | `docker compose ps -a` |
| Follow logs | `docker compose logs -f` |
| Stop while preserving data | `docker compose stop` |
| Restart stopped services | `docker compose start` |
| Preview configured retention cleanup | `docker compose run --rm backend-init python -m maintenance cleanup` |

Migrations run in `backend-init`; restarting only `python-api` does not apply them. Retention cleanup requires `--apply` to delete records and is not automatically scheduled. Review the output and configured windows first.

Before upgrading from a version with the admin notification inbox, let existing manual-override workflows finish on the old Temporal worker. Their recorded histories contain the retired activity and cannot replay on the new worker. The upgrade migration removes the old inbox table; approval requests, decisions, and audit history remain available in Permission Manager.

The Phase 3 migration preserves existing Phase 2 registry, permission, movement, retry, alert, audit, and checkpoint records. It maps the two legacy location scopes to Zone A/B, retains checkpoint IDs used by operator assignments and history, and adds the required branch/checkpoint constraints. It does not reset the application database or remove Temporal data. Existing non-master admins need zone assignments from a master-admin after migration; the master-admin role itself sees every active zone.

## Existing-volume maintenance

Changing `.env` does not rotate PostgreSQL passwords saved in an existing volume. The normal provisioner verifies installed roles and refuses silent adoption of populated, unprovisioned schemas. Before explicit maintenance, stop all application/provider/workflow writers and rehearse a restore of **all three databases**, roles and configuration on an isolated copy. Preserve the operational volume. Custom schemas, security-definer routines or unexpected owners require review before changing privileges.

Set independent random 32+ character URL-safe secrets for `POSTGRES_PASSWORD`, the four service database passwords, the three Redis passwords and `KONG_IDENTITY_SECRET`. Supply the **current persisted** administrator credential transiently as `POSTGRES_CURRENT_PASSWORD` through a hidden prompt or secret manager. Keep credentials out of arguments and logs. With only PostgreSQL running, execute:

```text
docker compose run --build --rm --no-deps db-provision python /maintenance/provision_database.py --apply --allow-existing
```

This explicit operation rotates scoped credentials and supported ownership/grants without rewriting application rows, then synchronizes the administrator password to `POSTGRES_PASSWORD`. It refuses connected project clients; it does not terminate them. Clear the transient credential afterward, run `backend-init`, and check health, login and service boundaries before restoring writers. Interrupted cross-database maintenance needs inspection and an idempotent rerun with the valid administrator credential; rollback requires the tested backup.

Keycloak import preserves existing realms. Through the temporary administration gateway, keep the existing client secret and set the `inout-frontend` callback exactly to `${AUTH_URL}/api/auth/callback/keycloak`, web origin to `${AUTH_URL}`, and logout URLs to `${AUTH_URL}/login` and `${AUTH_URL}/logout/complete`. After installing the rebuilt 26.8.1 image and its bundled common-password denylist, check with `node scripts/configure-keycloak-password-policy.mjs --check`, apply the baseline with `node scripts/configure-keycloak-password-policy.mjs --apply`, then check again. This partial update preserves stronger existing length requirements, other policy clauses, an existing administrator-managed denylist, users, clients, and unrelated realm settings; it does not clear password strength or rotate existing credentials. Verify login and account/API permissions, then stop the gateway.

## Temporal upgrade

The base deployment targets digest-pinned server **1.32.1** and schemas **1.19 / 1.14**. The existing local cluster remains on the guarded **1.26.3** compatibility overlay, schemas **1.14 / 1.7**, cluster `active` and four shards. Its ignored local `.env` selects:

```dotenv
COMPOSE_PATH_SEPARATOR=|
COMPOSE_FILE=compose.yaml|compose.temporal-legacy.yaml
```

Keep these values until the staged upgrade completes. The legacy guard validates exact schemas, scoped ownership, persisted cluster/shard metadata and absence of an upgrade marker without modifying data. Both startup paths retain private networks, scoped credentials and nonroot read-only operation. Availability recovery does not complete the vendor security upgrade.

Follow the [official sequential-upgrade procedure](https://docs.temporal.io/self-hosted-guide/upgrade-server). The documented target chain is **1.26.3 → 1.27.4 → 1.28.4 → 1.29.7 → 1.30.7 → 1.31.3 → 1.32.1**; recheck release instructions, intermediate image availability and digests before executing maintenance. Rehearse the entire chain on a restored isolated copy first. Back up both Temporal databases, roles, namespace/configuration and worker revision. Stop workflow starters, scheduler and workers. At each stage, update both schemas with matching official SQL tooling before starting that server, allow roughly ten minutes per version for all History shards' conversion, and verify health and persisted-history replay. Preserve namespace settings and four shards. Never skip minors, delete histories or forge a marker to bypass the guard.


## Temporal post-upgrade verification

After the full operational chain has actually completed, stop writers/server again and verify schemas **1.19 / 1.14**. As the scoped `inout_temporal` owner, attest the validated baseline in **each Temporal database**, keeping stage evidence with the backup:

```sql
CREATE TABLE public.inout_temporal_bootstrap (
    singleton boolean PRIMARY KEY CHECK(singleton),
    origin_minor text NOT NULL,
    status text NOT NULL
);
INSERT INTO public.inout_temporal_bootstrap VALUES (true, '1.32', 'ready');
```

This marker records operator verification; it does not prove conversion itself. Remove both local Compose selector values, run `temporal-schema-init` with `--verify-only`, then verify server/namespace readiness and current worker replay before restoring writers. Rollback requires the rehearsed full backup and matching server/worker configuration; switching image tags does not reverse rewritten histories.

## Backup and reset

Create a custom-format backup of application and Keycloak data. First create `.data/backups` using your file manager or the command for your shell (`mkdir -p .data/backups` on macOS/Linux; `New-Item -ItemType Directory -Force .data/backups` in PowerShell), then run the shared Docker commands:

```text
docker compose exec -T postgres-primary pg_dump -U inout -d inout -Fc -f /tmp/inout.dump
docker compose cp postgres-primary:/tmp/inout.dump .data/backups/inout.dump
```

Use a distinct filename for each backup. This single dump covers the `inout` database only. A coordinated recovery set also needs `temporal`, `temporal_visibility`, global roles, protected configuration/secrets, and matching runtime/worker revisions. A coordinated restore must be rehearsed in an isolated project: quiesce writers for the capture and restore into a separate fresh PostgreSQL project with no source networks, volumes or listeners. Preserve ownership/ACLs and verify business state, identity, workflow replay and pending delivery before planning a cutover. A dump or a second database in the operational PostgreSQL container alone is not a completed recovery drill.

For a disposable local reset, use the targeted PostgreSQL-volume procedure in [first-use guide](#reset-a-disposable-local-database). `docker compose down -v` removes every non-external named volume declared by the project, including observability data; use it only when that broader deletion is intended.

## Deployment boundaries

This Compose stack uses loopback listeners and a prebuilt Keycloak image with optimized startup over local HTTP. A shared deployment needs HTTPS for browser/identity traffic, managed secrets, and backups. Kong enforces API body and request-frequency limits using verified account/certificate credentials and strips forged terminal headers. FastAPI retains authorization, data/resource bounds and semantic behavior checks. Optional terminal mTLS requires trusted certificates and the `compose.mtls.yaml` configuration. Browser offline storage is not a database backup.

The ordinary identity listener exposes `/realms/`, `/resources/`, and `/.well-known/`, while blocking the realm SCIM user-management API. It rejects provider `/admin` paths and ambiguous encodings, repeated separators, dot segments, and matrix parameters before contacting Keycloak. A bearer carrying `realm-management:manage-users` cannot bypass application user-management reauthentication through the public Admin REST or SCIM endpoints. FastAPI retains internal `KEYCLOAK_ADMIN_BASE=http://keycloak:1022` access after its own authorization and step-up checks. The administrator role composites are preserved for this delegated operation. Keycloak's `hostname-admin` setting alone does not enforce this boundary; the [official hostname documentation](https://www.keycloak.org/server/hostname) requires reverse-proxy enforcement.

The maintenance gateway exposes the provider Admin Console and REST API on a loopback-only host port and starts with the default Compose stack. Stop it with `docker compose stop keycloak-admin` when provider administration is not in use. For shared deployments, put provider administration behind a separate restricted network with independent operator authentication. The current delegated human role composites still grant realm-wide native user administration to zone admins who can reach this maintenance interface; those native operations bypass the application's zone, master-admin, and step-up checks. Loopback limits remote reachability but does not distinguish accounts using browsers on the same machine. The server-only administration-authority migration has not been applied. Docker-network access and local operating-system administrator access remain trusted infrastructure boundaries. Follow Keycloak's [reverse-proxy exposure guidance](https://www.keycloak.org/server/reverseproxy) when adapting this stack.

Offline scan evidence and cached terminal details also remain plaintext in the shared browser profile. Account ownership checks protect replay and UI visibility, but they do not encrypt IndexedDB or prevent another person with access to that browser profile from inspecting retained data. The encryption redesign has not been applied. Keep terminal browser profiles under the intended operator's device-access controls and preserve held evidence for reconciliation.

## Keycloak upgrade

The configured custom-image pin is `26.8.1`, [released on 2026-10-13 with upstream security fixes](https://www.keycloak.org/2026/10/keycloak-2681-released). The provider compiles against that runtime and rejects mismatched versions. Changing the source default does not update an existing `.env` override or running container. An existing installation must deliberately update its own `KEYCLOAK_VERSION` after rehearsing the migration.

1. Review all applicable changes from your current version in the [upgrading guide](https://www.keycloak.org/docs/latest/upgrading/index.html). Version 26.8 enables SCIM support by default; the gateway therefore also blocks `/realms/{realm}/scim` publicly. This application uses the regular OIDC and Admin REST APIs; verify login, refresh, logout, Account Console access, application roles, and fresh user-management reauthentication against the target version.
2. Schedule an identity outage, stop the maintenance gateway and Keycloak, and take a distinct custom-format backup using the procedure above. The actual identity tables are in the `keycloak` schema of the `inout` database. For an identity-only backup while Keycloak is stopped, use `pg_dump -U inout -d inout --schema=keycloak -Fc -f /tmp/keycloak-before-upgrade.dump` through `docker compose exec -T postgres-primary`, then `docker compose cp` to a distinct file under `.data/backups/`. Preserve the old image version, Compose files, realm template, and secrets securely. Saved users and credentials require the database dump; a realm template alone is insufficient. Back up Temporal separately when rehearsing recovery of the whole stack.
3. Restore the dump into a separate PostgreSQL instance with a fresh volume and no application writers. Start the target image against that restored copy on an isolated network; retain the original stack's database and image. Confirm that migration completes and run the authentication checks plus the public `/admin` denial checks. Rehearse rollback by restoring the pre-upgrade dump and using the old image on another fresh volume.
4. After successful rehearsal, set `KEYCLOAK_VERSION=26.8.1` in the existing `.env`, build the custom image with its extension and password denylist, and recreate Keycloak and the regular gateway during the scheduled outage:

```text
docker compose build keycloak
docker compose up -d --no-deps --force-recreate --wait keycloak
docker compose up -d --no-deps --force-recreate --wait kong
```

Verify the effective running image with `docker compose images keycloak`, then test sign-in/refresh/logout, account security, user-management unlock/lock/expiry, and `http://auth.localhost:1005/admin/realms/inout/users` returning `404` even with a valid administrator token. The loopback maintenance gateway starts by default; stop it after provider checks if it is not otherwise in use. If migration or validation fails, stop the new Keycloak instance and restore the pre-upgrade database into a fresh volume before starting the old image. Keycloak does not support downgrading an already-migrated database; [rollback requires restoring the backup](https://www.keycloak.org/docs/latest/upgrading/index.html#_prepare-for-upgrade).

Historical verification on **2026-11-05**: **245 frontend tests** and **365 backend tests** passed; the backend discovered 634 tests and skipped 269 integration tests. TypeScript checking, the Next.js 15.5.29 production build, and the three synthetic localhost HTTP suites (sign-in, password updates, and security boundaries) passed. Cross-zone checks cover checkpoint grants, analytics, shared hardware custody, warning resets, restriction releases, and rule changes. Docker was unavailable, so real database/cache/Temporal checks and the Keycloak 26.8.1 provider build/runtime suite were not executed; no live deployment or policy repair was applied. The user deferred the administration-authority and terminal-storage redesigns; those redesigns remain deferred.

# Troubleshooting

| Symptom | Check / action |
| --- | --- |
| Service fails to start | Run `docker compose ps -a` and inspect that service’s logs; one-shot initialization jobs should exit successfully. |
| PostgreSQL is healthy but provisioning fails | Existing volumes retain saved passwords. Check the current persisted administrator credential and follow [existing-volume maintenance](#existing-volume-maintenance). |
| Login callback or client-secret error | Match `AUTH_URL`, registered redirect URLs, public issuer, and the existing frontend client secret. |
| API returns `401` or `403` | `401` means the token is missing, invalid, expired, or has the wrong audience; `403` means the account lacks the required role/scope. Sign in again after role changes. |
| Keycloak admin console is unavailable | Start `keycloak-admin` and use the loopback URL on port `1009`; `/admin` on public port `1005` is intentionally blocked. |
| Scan remains queued | Restore connectivity, check the API/session, and retry queued scans. A queued scan is not an approval. |
| Registry is empty | Fresh startup seeds reference data only; create people/assets in Registry or load optional local fixtures. |

Health checks: [frontend](http://app.localhost:1008/api/health), [API liveness](http://localhost:1002/health/live), and [API readiness](http://localhost:1002/health/ready). Readiness checks PostgreSQL, Redis, and Temporal.

# Main documentation

- [Development and test workflows](docs/workflows.md)
- [Zoho invitation setup](docs/zoho-invitation-setup.md)
- [App-owned Keycloak authentication](docs/app-managed-password-plan.md)
