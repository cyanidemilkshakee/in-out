# Development, test, and performance workflows

Use disposable local data for the acceptance and failure-recovery procedures below. Commands are preserved from the project guide; dated verification notes are historical records and do not imply that a workflow was rerun today. See the [installation and first use](../README.md#installation-and-first-use) before starting a local stack.

## Development setup

Install host-side dependencies with `npm ci`. Keep Docker backend services running, then start the frontend with its development callback origin:

```powershell
$env:AUTH_URL = "http://app.localhost:3001"
npm run dev
```

Open [app.localhost:3001](http://app.localhost:3001). Register this exact callback/origin through authenticated provider maintenance for development; the default realm permits only the Compose app origin. `npm run dev` is the normal Turbopack server. Use `npm run dev:webpack` only as a Webpack fallback or for comparison. `npm run dev:bounded` is the same Turbopack server with a 15-minute timeout for temporary sessions. Remove the temporary override with `Remove-Item Env:AUTH_URL` before returning to the Docker application URL. Backend code changes require rebuilding its services through `docker compose up --build -d`.

After `npm run build`, use `npm start` to serve the production build locally. `npm run start:bounded` adds a 15-minute limit for temporary runs.

| Command | Verification |
| --- | --- |
| `npm run typecheck` | TypeScript types |
| `npm audit --audit-level=moderate` | Known advisories in the locked npm dependency tree |
| `npm run test:frontend` | Frontend workflows, shared data contracts, offline queue, and analytics helpers |
| `npm run test:auth` | Authentication, Keycloak integration, and security boundary checks |
| `npm test` | Both local frontend and authentication test groups; does not start Docker |
| `npm run test:all` | `npm test`, isolated PostgreSQL backend suite, then isolated Kong gateway suite; requires Docker |
| `npm run test:keycloak:interactions` | Readiness-gated interaction-client configuration and explicit legacy-client retirement regressions |
| `npm run build` | Production frontend build |
| `npm run test:auth:http` | HTTP authentication using isolated identity/API stubs; run after building |
| `npm run test:auth:password-updates` | Built-app temporary setup, account password changes, identity/CSRF checks, conflicts and ambiguous writes using isolated provider/lease stubs; run after building |
| `npm run test:postgres` | Backend suite, migrations, and transaction behavior against isolated PostgreSQL |
| `uv audit --project backend --frozen --no-dev` | Known advisories in the locked Python runtime dependencies |
| `npm run test:gateway` | Disposable real Kong, certificate authentication, request limits, and streaming with fixture upstreams |
| `npm run test:auth:account` | Live local Keycloak account endpoints, signed frontend role claims, and parallel admin API authorization; creates and removes a temporary test identity |

For a single backend test area, use `npm run test:python` for the local Python suite, or `npm run test:postgres` for the isolated Docker/PostgreSQL suite. Use `npm run test:gateway` for Kong. `npm run test:all` runs the project's standard frontend/auth, backend/PostgreSQL, and gateway groups in sequence; it does not run live-account checks or disposable Keycloak-provider compatibility fixtures.

PostgreSQL tests use the `test` Compose profile, a separate temporary database, and a schema per database test. They require Docker and the Compose configuration values. Stop the test service afterward with `docker compose --profile test stop db-test`. The live account check additionally requires the running local stack and matching credentials in `.env`.

[GitHub Actions](../.github/workflows/verify.yml) runs dependency audits, frontend type checks, tests, the production build and HTTP security checks, plus isolated backend, Kong, Keycloak, database/Redis and workflow-restart suites. Pinned Trivy checks cover all configured runtime images and the scoped workflow maintenance image. Known vendor HIGH findings currently prevent clean release gates; findings are not suppressed. Run `npm run test:gateway` locally to verify routing, streaming, body/upload bounds, the public Keycloak administration boundary, terminal certificate authentication, and shared verified-identity rate limits across two gateways. Backend tests verify data budgets, behavior signals and resource admission; request-frequency counters live only in Kong.

`npm run keycloak:account:check`, `npm run keycloak:account:repair`, and `npm run test:auth:account` require the temporary administration gateway from quick start. The live account test creates and deletes a disposable identity. Stop the gateway after maintenance. These Node scripts connect to loopback with the configured `auth.localhost` Host header, so host DNS does not need to resolve that browser-only hostname.

The frontend and Postman clients disable **Full scope allowed** and explicitly map the `zone-admin` and `operator` realm roles. Their composites retain account self-service and the administrator's delegated user-management permissions, while unrelated user roles stay out of application tokens. This follows [Keycloak's role scope guidance](https://www.keycloak.org/docs/26.8.1/server_admin/#_role_scope_mappings). Existing realms are preserved on startup, so changing the import file alone does not repair them. Run `npm run keycloak:account:repair` through the maintenance gateway: it adds and verifies the required mappings before disabling full scope, preserves client secrets and other settings, and checks effective token roles and the API audience. Repeating it makes no further changes. Obtain a fresh application session afterward.

To verify the configured Keycloak image and realm template independently, use the disposable provider suite. It runs PostgreSQL on tmpfs, publishes no host ports, uses fixture credentials, and checks signed OIDC login/refresh/logout, account security, role mappings, and the public Admin REST/SCIM boundary:

```powershell
docker compose -p inout-keycloak-test -f keycloak/compose.test.yaml run --build --rm tests
docker compose -p inout-keycloak-test -f keycloak/compose.test.yaml down --volumes
```

`KEYCLOAK_TEST_VERSION` overrides this suite's target image for compatibility checks; it does not change the main stack's `KEYCLOAK_VERSION`.

For a reproducible isolated check, run the frontend commands in the order below, then use named Compose projects for the backend and gateway. Run these commands from a fresh PowerShell terminal; the dummy environment values satisfy Compose interpolation and do not change `.env`.

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run test:auth:http

$env:POSTGRES_PASSWORD = "isolated-test-postgres"
$env:KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME = "isolated-test-admin"
$env:KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD = "isolated-test-password"
$env:KEYCLOAK_CLIENT_SECRET = "isolated-test-client-secret"
$env:AUTH_SECRET = "isolated-test-auth-secret"

docker compose -p inout-backend-test --profile test run --build --rm backend-tests
docker compose -p inout-backend-test --profile test down --volumes
docker compose -p inout-kong-test -f gateway/compose.test.yaml run --build --rm tests
docker compose -p inout-kong-test -f gateway/compose.test.yaml down --volumes
```

Check each command's exit status before proceeding. These projects start only their test dependencies; their cleanup commands target those project names. Close the terminal afterward to discard its environment overrides. Run the live account check separately with the real local stack and its matching configuration.

## Coverage status

The API inventory checked on **2026-10-10** has **51 OpenAPI method/path operations**, including complete dashboard-period aggregates, employee-activity queries, and persistent user-management window lock endpoints. The original 2026-10-05 audit inventoried 44 operations; its run results below are historical evidence. Endpoint behavior, every business-rule branch, and performance are **not completely covered**. There is no configured line/branch coverage measurement, and passing tests do not establish a percentage of endpoint coverage.

| Area | Existing evidence | Still needed |
| --- | --- | --- |
| Scans, access policy, retries, manual decisions | Policy tests and PostgreSQL transactions through selected FastAPI routes; race, rollback, stale-timeout, checkpoint-spoofing and replay regressions | Concurrent scan retries, all validity/cooldown boundaries, full browser → Kong → Keycloak → API integration |
| Registry, typed requests, historical movements | Selected PostgreSQL routes plus handler/helper tests, including completed-notice dismissal and checkpoint ownership | Direct list/get/options/sync/conflict tests; complete routed visitor/zone/custody decision matrix |
| Direct grants and critical entry restrictions | Routed PostgreSQL grant/release/scan regressions, atomic rollback and concurrency tests, migration backfill, and date/schema validation | Complete grant/release browser lifecycle, every authorization/failure branch, real Redis/Temporal integration |
| Authentication and administration | Real signed JWT tests with mocked JWKS; isolated Next.js HTTP session tests; provider-failure recovery tests and PostgreSQL checkpoint rollback | Complete live user-management lifecycle; authorization matrix for every route |
| Alerts, audit, presence, health | Attendance-rule tests, review/reset/assignment PostgreSQL tests, live-update merge contracts, mocked publication, gateway streaming | Full rerun of the new migration-backed suite, real Redis delivery, real Temporal scheduling/replay, and browser workflows |
| Performance | Small serial dashboard handler comparison | Repeatable large-data HTTP, write/concurrency, SSE, workflow, and browser benchmarks |

Verified during this audit on **2026-10-05**: **106 backend tests, 36 frontend tests, and 6 gateway tests passed**, as did TypeScript checking, a production frontend build in Docker, and isolated HTTP authentication/terminal-role checks. The host Windows build encountered `spawn EPERM`; Docker provided the successful build. The live Keycloak account script, manual browser workflows, and new large-data benchmarks were not executed in this audit.

Current verification on **2026-10-07**: the isolated PostgreSQL backend suite passes **191 tests**, the frontend suite passes **54 tests**, `npm run typecheck` passes, and `npm run build` completes successfully. The manual workflows and large-data benchmark procedure below remain acceptance steps to run against a disposable environment; no benchmark result is implied by this verification.

Verification on **2026-10-09** after the UI/backend fixes: **219 backend tests passed** against isolated PostgreSQL, as did the complete `npm test` suite, TypeScript checking, the production build, and the isolated HTTP authentication harness. Regression coverage includes provisioning/save recovery, refreshed step-up cookies, bounded provider logout, profile-load safeguards, visitor registration, offline queue ownership/recovery, carried hardware, complete analytics, exact drilldowns, separate alert saves, and calendar bounds. These results do not establish live provider failure recovery, complete browser acceptance, or representative load performance.

Targeted authentication verification on **2026-10-10**: **21 signed-JWT authentication tests**, **12 realm-repair tests**, and **5 real Keycloak 26.8.0 compatibility tests** passed. Authentication batches of 24 requests cover startup, expired keys, rotation, and an unavailable provider; separate regressions cover cancellation and cache expiry while queued for verification. The existing realm was repaired without reimporting it, and a subsequent check confirmed both application clients have full scope disabled with required role mappings. Fresh signed admin/operator tokens passed the live account and terminal checks; all **18 parallel admin API requests** returned `200`, and all **3 operator requests** to those admin endpoints returned `403`. Quota tests passed with their one Redis integration test skipped; all 7 presence privacy tests passed. The API image was rebuilt and deployed healthy, and the temporary identity and isolated provider test stack were removed. This was targeted authentication verification, not a full-suite rerun or representative performance benchmark.

Kong migration verification on **2026-10-13**: **18 real gateway tests**, **72 targeted backend tests**, **6 private identity callback tests**, and **3 Redis ACL tests** passed. Gateway tests use two Kong instances and shared Redis to check account isolation, token refresh, grouped quotas, concurrent requests, cache expiry, invalid credentials, path aliases and dependency failures. The frontend suite, production build and HTTP authentication harness passed, including Kong error messages and `Retry-After` propagation. The live Keycloak account check passed for signed admin/operator tokens with Kong limit headers, preserved role authorization and a publicly inaccessible identity callback. App, API, Redis and Kong were deployed healthy; the temporary account was deleted and the maintenance listener stopped. This was targeted migration verification, not a full backend-suite rerun or a representative load benchmark.

Security remediation verification on **2026-10-14**: **19 real gateway tests**, **14 infrastructure tests**, and **5 real Keycloak tests** passed with the narrowed Redis ACL and browser/public-identity ingress limits. All **10 new manual-access snapshot tests** passed, including metadata-only records, change-then-revert, identical regrants, cosmetic edits, legacy grants, admitted exits and concurrent revocation. The full isolated backend run exercised **412 tests in 897.488 seconds**: 410 passed, an older manually constructed approval fixture lacked the newly required snapshot, and an existing key-rotation test timed out at its one-second scheduling wait. The fixture now uses the real approval function; all **43 authentication/cross-building/manual-snapshot tests passed on rerun** in 66.951 seconds, including the unchanged key-rotation test. No failures remained in those rerun suites; the complete suite was not repeated after the fixture-only correction. API/worker images built successfully, and disposable fixture stacks were cleaned up. Main application services were already stopped; the source/configuration and rebuilt images are ready for the next Compose startup. Daybreak was not accessed or modified. No representative load benchmark or new runtime-image advisory scan was performed.

Current app-interaction verification is separated into configuration tests (`tests/keycloak-sign-in.test.mjs`, `tests/keycloak-interactions.test.mjs`), the built-app HTTP harnesses (`npm run test:auth:http`, `npm run test:auth:password-updates`), and the isolated real extension fixture (`keycloak/compose.test.yaml` plus `keycloak/compose.interactions-test.yaml`). Configuration tests cover authenticated version/readiness gates, disabled password grants, preserved secrets/settings, read-only checks, idempotent repair and explicit retirement of the previous reset client. `keycloak/tests/check_interactions.py` tests provider wire behavior; `scripts/test-keycloak-interactions.mjs` tests the compiled app bridge against real provider tokens. These checks cover credential/OTP rejection, temporary setup and changes, subject binding, one-use S256 tickets, unsupported actions, refresh and revocation as exercised by the named suites. Existing realm changes require the documented apply command; source changes alone do not alter the running provider. Enabled realm/global OAuth client policies are rejected by the custom interaction until compatibility has been reviewed. SMTP delivery, complete browser acceptance and representative benchmarks remain separate checks. Daybreak is unnecessary for these authentication checks.

On **2026-10-15**, the frontend suite passed **145 tests**, including **10 sign-in configuration tests**, and TypeScript checking passed. All **9 real Keycloak 26.8.0 checks** passed in **46.833 seconds**. OTP checks authenticate successfully before intentional failures so they retain the provider's quick-login and replay protections. The disposable provider project published no host ports; its containers, network and temporary data were removed afterward. Its readiness allowance was increased for slower fresh-schema initialization without changing the normal stack's health checks. The production Docker build and isolated HTTP suite passed against the exact exported runtime, including all six own-form unlock durations, failed extension retries with a changed selection, token verification, OTP, and logout after both form sign-in and optional account setup. The local app was updated, its `/login` returned HTTP `200` with username/password inputs, and the existing realm's application sign-in settings were applied and verified. The temporary maintenance gateway was stopped afterward.

Verified on **2026-10-06**: the full isolated PostgreSQL backend suite passed **145 tests in 244.180 seconds**, and **49 frontend tests**, TypeScript checking, and production app/API/worker builds passed. After a database backup, migration `s7t8u9v0w1` was applied locally; app, API liveness, and API readiness checks returned HTTP `200`, and the worker was healthy. Browser end-to-end checks and new load benchmarks were not run.

Verified on **2026-10-07** for selectable user-management windows: **54 frontend tests**, **12 backend selected-window tests plus 5 existing robustness tests** in Docker Python 3.10, TypeScript checking, the isolated HTTP harness, a host production frontend build, and production app/API image builds passed. The HTTP harness verified the main six-duration flows with synthetic sessions before the final callback-cleanup gate was added; the current session unit tests separately cover that gate's success/error criteria, and the final production app image includes it. App and API were recreated healthy; frontend health and API liveness/readiness probes returned HTTP `200`. The running configuration confirmed matching app/API proof-signing keys and all six supported durations without printing secrets. This targeted run did not rerun the full PostgreSQL suite, real browser/OIDC login, or load benchmarks.

The suites contain direct route tests, helper tests and mocked dependencies; these establish different levels of coverage. Offline queues retain their originating account and checkpoint; legacy records without an owner are held for reconciliation. The workflows below are acceptance procedures to execute; documenting a check does not mean it has passed or is automated.

Performance verification on **2026-10-16**: **172 frontend tests**, TypeScript checking, the production frontend Docker build and the isolated production HTTP authentication/stream harness passed. The broad PostgreSQL/Redis run exercised **475 backend cases**; its two outdated physical-terminal fixtures were corrected and passed their targeted rerun. Additional durable-delivery, export, migration, stream and concurrency cases passed separately. On the same disposable fixture (1,000 synthetic employees, 5,000 movements, 500 alerts), Registry first-read median fell from **498.776 to 259.849 ms**, Alerts from **101.098 to 40.348 ms**, and the complete report read from **733.158 to 332.637 ms**; report requests fell from **25 to one**. These are handler comparisons with explicit limits, not browser/production SLAs. See [full results and rollout notes](unofficial/application-latency-records.md). No operational migration/deployment was run; all services, including Temporal, remain.

Security source verification on **2026-11-05**: **47 focused Python authentication, gateway, checkpoint, password-reset, and revocation checks passed**, with real RSA/JWKS validation and mocked external stores. Reset regressions cover confirmed writes, ambiguous provider responses, both cleanup failure paths, no automatic reset retry, definitive rejections, and passphrase preservation. Configuration/credential tests cover the app-secret readiness probe, unsupported-action messages, stronger policy preservation, and credential-event retention. See [reset regressions](../backend/tests/test_password_reset_security.py), [credential exchange checks](../tests/keycloakCredentials.test.ts), [policy checks](../tests/keycloak-password-policy.test.mjs), and [readiness checks](../tests/keycloak-interactions.test.mjs). The real provider suite now includes modern success/error credential-event assertions, and CI is configured to run both `check_*.py` provider suites plus the built-app password-update HTTP harness. Docker was stopped during this verification: the new **26.8.1 Java compilation, container/provider suite, migration, and live deployment were not executed**. These are source/unit results; the dated 26.8.0 runtime results above do not establish 26.8.1 compatibility.

## Test workflows

Use a disposable local installation for manual workflows and dependency-failure experiments. Start it with the [installation instructions](../README.md#installation-and-first-use), use separate admin/operator browser profiles, and prefix fixture names/barcodes with a unique value such as `QA-20261005-01`. Record starting presence, movement count, pending-request count, and relevant permission/custody values before each case. Registry people and Keycloak login accounts must be created separately.

For API-only cases, use the [Postman collection](../inout_api_collection.postman_collection.json) with Authorization Code + PKCE and the [Swagger schema](http://localhost:1002/docs). Use an access token with the required role/audience; zone-admin user-management calls also require recent reauthentication. Browser API mutations must use the same-origin session flow and JSON. A business-policy scan denial is a recorded decision, normally HTTP `200` with denied result; `401`/`403` indicate authentication/authorization failure, `409` a conflict, and `422` invalid input.

Keep a case log with fixture IDs, request/idempotency keys, observed status/body, before/after values, and screenshots where useful. Mark cases as pass, fail, or not run. Records with movement/request history may intentionally resist deletion; rebuild only the disposable test installation when a clean fixture set is needed.

### 1. Create users, assign checkpoints, and enforce roles

**Setup:** A master-admin account with user-management rights; Zone A and Zone B are active and each has an active checkpoint 1. Keep one operator unassigned to check the viewing/scanning distinction.

1. Open **Manage users**, complete a fresh reauthentication, and create `QA-operator` with the `operator` role and Zone B checkpoint 1. Use the duration selector and **Extend** if a longer management window is needed. Complete any temporary-password change in a separate browser profile.
2. Sign in as that operator. The terminal must show the assigned Zone B checkpoint as fixed. Admin pages and `/v1/keycloak/users` must be inaccessible. Sign in as an assigned admin and verify zone-scoped admin data and Terminal can be opened.
3. Create an employee allowed only Zone A. Scan at Zone B checkpoint 1: expect a zone denial and unchanged presence. Repeat the request with Zone A checkpoint 1's actual ID from `GET /v1/checkpoints` and a fresh UUID: expect `403` before any movement/retry record is created.
4. As an admin assigned to both zones, reassign the operator to Zone A checkpoint 1, refresh the terminal, and verify the displayed assignment. Revoke it and confirm new scans and old-checkpoint retries fail with `403`. An unassigned admin can view Terminal but cannot scan.

**Edges:** Reject creation of an operator without a checkpoint; reject an unknown checkpoint; preserve the assignment when PATCH omits it and revoke when it explicitly supplies `null`. Check stale user-management unlock, email updates, role changes, password reset, forced logout, and upstream failure recovery. Logout does not promise immediate revocation of already-issued bearer tokens.

**Automation:** [Checkpoint assignment tests](../backend/tests/test_terminal_assignments.py), `test_admin_creates_operator_with_checkpoint_before_granting_role` in [PostgreSQL tests](../backend/tests/test_database.py), and [account recovery tests](../backend/tests/test_keycloak_admin_recovery.py). Recovery uses a stateful provider stub; the complete live identity-provider lifecycle remains a manual integration check.

### 2. Register, update, and delete registry subjects

**Setup:** Admin session; unique employee and hardware barcodes. A deletion-eligible isolated fixture must have no movement, permission, or request references; ordinary Registry creation also creates an access-policy row.

1. In Registry, create employees A/B and a laptop with required metadata, current validity, and explicit zones. Read them back through the list, detail, and bundle APIs.
2. Use `PUT /v1/registry/subjects/{subject_id}` to edit an employee's name, status, barcode, zones, and validity; Registry currently has no edit control. Refresh Registry and check related access metadata is consistent. Repeat for a hardware asset.
3. Attempt deletion through the API. A subject with a permission row can return `409` even without scans; record this current limitation. For a reference-free subject seeded only in the disposable fixture database, expect `204`, disappearance, and `404` on subsequent lookup.
4. Scan a different subject to create history, then attempt deletion. Expect `409` and retained subject/history. Also test permission-request and hardware-custodian references; record whether deletion is refused or leaves a stale reference, since JSON custody fields are not foreign keys.

**Edges:** Duplicate barcodes, including different letter case, must return `409` without partial records. Check missing subjects, blank names, invalid statuses, unknown/empty zones where disallowed, reversed validity windows, and operator attempts to create/edit/delete employee/hardware records.

**Automation:** Registry create/update/delete regressions in [PostgreSQL tests](../backend/tests/test_database.py). Direct list/detail routes, reference combinations, and the full metadata validation matrix still need tests.

### 3. Scan an employee with hardware, retry, and exit

**Setup:** Operator assigned to Zone A checkpoint 1; active employee A and active laptop both allowed `a`, currently outside, with the laptop assigned to A. Open Dashboard in the admin browser.

1. Scan A with the laptop selected. Expect one approved entry, both inside states, and the admin's live presence update. Equipment must not increase the dashboard's people-inside count.
2. Replay the identical request with the same UUID `Idempotency-Key`. Expect the original response/event, no second movement, and no stale presence publication.
3. Wait at least ten seconds, then scan again with a new key. Automatic direction must be exit and both subjects become outside.
4. Change the payload under the original key. Expect `409` and no extra movement or presence change.

**Edges:** Check a new-key scan within the cooldown, unregistered/restricted/inactive/expired subjects, a future validity start, missing zone permission, unregistered or restricted hardware, duplicate carried assets, and custody mismatch. Denied decisions must not move anyone inside/outside. Exercise explicit API direction separately from the terminal's automatic flow.

**Automation:** [Access-policy tests](../backend/tests/test_access_policy.py) and scan/retry/hardware regressions in [PostgreSQL tests](../backend/tests/test_database.py). Simultaneous routed scans and exhaustive time boundaries remain gaps.

### 4. Register visitors for approval, then approve or deny

**Setup:** Operator assigned to Zone A checkpoint 1; admin session open in Permission Manager and Dashboard.

1. Use **Register visitor** above the terminal checkpoint display. Supply name, unique barcode, host, checkpoint, and ordered **Valid from** / **Valid to** dates within the next six calendar months; optionally supply company/purpose. Choose **Register & request approval**.
2. Register a second visitor through `POST /v1/registry/subjects` with kind `visitor` and a valid checkpoint/window. Both must display Pending approval in **Registry → Visitors** and appear in Permission Manager's pending permissions and the Dashboard pending decisions widget. Registration alone must not create an entry movement. The Registry Visitors tab lists records; direct administrator registration is available through **Permission Manager → New permission**.
3. Scan a pending visitor and expect denial with unchanged presence. Approve the first visitor through Permission Manager and deny the second with a reason.
4. Refresh Terminal and Registry. The approved visitor's requested zones/window must persist and admission becomes possible during that window; the denied visitor remains blocked. Approval itself must leave an outside visitor outside until scanned. Both completed decisions must leave the pending queue and appear in **Registry → Permissions**.

**Edges:** Reject duplicate/mixed-case barcodes, missing name/host, invalid dates/times, reversed or equal endpoints, expired ends, and values beyond the six-month calendar horizon. Client-supplied active/inside values must be overridden to pending/outside, rather than grant access. The requested window is retained, so waiting for approval consumes any part that has already started. Check approval near/after expiry, repeated decisions, and live-event/Temporal failure after persistence.

**Automation:** [Registration transaction tests](../backend/tests/test_registration_approvals.py), [real-session visitor registration and initial hardware custody](../backend/tests/test_registry_creation_workflows.py), visitor decision regressions in [PostgreSQL tests](../backend/tests/test_database.py), and [typed-request tests](../backend/tests/test_typed_permission_requests.py). [Frontend date tests](../tests/dateTimeValidation.test.ts) and [backend permission-window tests](../backend/tests/test_permission_windows.py) cover real dates/times, facility offsets, exact boundaries, ordering, month-end/leap-year clamping, and approval of saved windows. Helper tests do not constitute complete browser/HTTP coverage.

### 5. Manually admit an unknown barcode and complete its exit

**Setup:** Operator assigned to Zone A checkpoint 1; fresh unknown barcode; admin session with Dashboard's Pending Permissions and Permission Manager available. For expiry checks, use a disposable fixture or wait past the recorded expiry.

1. Scan the barcode. Expect a denied movement and no presence entry. Repeat with registered carried hardware: the denied event and review must preserve the exact hardware set and its presence/restriction context without moving the asset. Add the required operator note and submit manual review. A duplicate submission must reuse the pending request.
2. In Dashboard's **Pending Permissions**, confirm the operator note appears to the left of the checkpoint name. Choose **Valid for**: 15 minutes, 30 minutes, 1 hour, 2 hours, or 4 hours; 1 hour is the default. Approve with an optional decision note, and repeat through Permission Manager for another fixture. Expect an identity and audit record, with no presence change and the original denied event unchanged. Confirm the persisted window starts at `decidedAt` and ends exactly the selected number of minutes later, rather than starting at scan or request time.
3. Rescan the same barcode at the same checkpoint before expiry. Expect one new approved manual movement, inside presence, and a consumed approval; retrying the same idempotency key must not create a second scan. Confirm the matching exit remains allowed after the entry window expires and that a later entry is denied pending a fresh review.
4. Perform the matching exit, including exactly the hardware admitted with the approval if present. It must be allowed even after the selected window expires or when ordinary entry access is restricted, leave the subject outside, and consume the one-visit entitlement.
5. Retry the same approval, including a different allowed duration. Its original window must stay unchanged and it must not admit the visitor again. A later entry, even before that original expiry, requires a fresh approval; the completed visit's grant cannot be reused.
6. Repeat with a second unknown barcode and deny its review with a reason. Confirm the completed approval and denial notices each have an optional **×** close control. Close either notice, refresh Terminal, and confirm the notice stays hidden while its decision remains in Terminal Activity and Registry's Permissions history. Closing a denied notice must not grant access, and closing an approved notice must not admit the subject again. Pending requests have no dismissal control.
7. Approve another denied scan but leave its grant unused. Before rescanning, revoke the person's access, restrict the asset, or replace zones/validity/custody. The old grant must not override the new policy or become consumed. Reverting the access edit must not revive that grant; obtain a fresh review for a new exception. A cosmetic name/note edit must preserve the grant. Repeat after a manually approved entry: its already-admitted matching exit must remain possible despite later entry restrictions. Legacy approvals without a reviewed access snapshot require a fresh review.

Manual denials reclassify the original denied event as **Manual**. Manual approvals leave the original denied scan unchanged; a later rescan consumes the one-time approval and creates a separate **Manual** movement. These classifications appear in Auto vs Manual and movement filters. With one automatic denial followed by manual denial, expect Auto **0**, Manual **1**, and total/denied counts **1**. Check this while Dashboard remains open, then refresh and retry the decision; no extra movement should appear. Migration `q5r6s7t8u9` corrects older reviewed records too.

[Manual access snapshot regressions](../backend/tests/test_manual_access_snapshots.py) cover later employee/hardware restrictions, reviewed zones/windows, identical regrants, custody transfers and reverts, cosmetic edits, legacy approvals, admitted exits and a scan waiting for an administrator's revocation lock. These use disposable PostgreSQL records; no schema migration is required for the server-owned JSON revisions.

**Edges:** Reject empty operator/decision notes where required, stale or mismatched source events, and an opposite decision after a final decision (`409`). The decision API must reject arbitrary or coerced durations such as 45, 14, 241, `"60"`, fractions, or booleans without changing saved state; omitted manual-approval duration defaults to 60 minutes from decision time. Test two administrators deciding concurrently, a timeout arriving after a decision, rollback during approval, and additional hardware not covered by the grant. `POST /v1/permission-requests/{req_id}/dismiss` must reject pending requests (`409`), non-manual requests (`422`), and missing requests (`404`). An operator assigned to the other checkpoint must receive `403` without changing the request; administrators may dismiss across checkpoints. Repeat dismissal of a completed notice must preserve its original dismissal time and leave decisions, presence, scan totals, movements, and audit history unchanged.

**Automation:** Manual admission, matching exit, race/rollback/stale-timeout regressions and routed `test_terminal_notification_dismissal_preserves_decision_and_history` / `test_terminal_notification_dismissal_requires_assigned_checkpoint` in [PostgreSQL tests](../backend/tests/test_database.py). The routed duration regressions check all five choices/default, persisted decision-time windows, changed-duration retries, invalid-input state preservation, and consumed grants after matching exit; the late-exit case patches server clocks past the saved expiry. [Frontend contracts](../tests/contracts.test.ts) check that every selected duration reaches the approval command intact, denial commands omit duration, and the duration policy rejects arbitrary/coerced values; they also check repeated dismissal commands and request-only live updates without decision, presence, scan-total, or history changes. These contracts do not exercise browser dropdown interaction or note placement. [Workflow unit tests](../backend/tests/test_approval_workflows.py) mock Temporal execution; real signals/replay/timeouts and browser controls still need integration testing. Migration `r6s7t8u9v0` converts legacy closed-notice metadata to optional dismissal fields; administrator alert acknowledgement is unchanged.

### 6. Grant scheduled access and inspect completed permission history

**Setup:** Registered subject currently allowed only Zone A; admin session.

1. Open **Permission Manager → New permission → Zone access**. Select the subject, Zone A and Zone B, ordered Starts/Ends dates, and a reason. Confirm the form shows current access and warns that the complete zone set will be replaced. Choose **Grant permission**; expect immediate persistence of exactly the selected zones/window and an approved history record.
2. Grant a replacement containing only Zone B. Confirm Zone A access is removed. Scan from operators assigned to each zone to verify the resulting policy and validity boundaries.
3. Choose **New permission → Visitor access → Register a new visitor…**. Enter identity/host, checkpoint, zones, dates, and a reason. Grant once and verify the visitor, approved decision, access, and audit evidence are saved together, with no pending request or admission movement. For an existing pending visitor, grant access and verify the existing pending request is decided once rather than left to expire later.
4. In **Access directory**, find the subject by name or zone label. Confirm all registered people/assets appear, including those without a separate manually managed permission row. Review the card's entry zones, Starts/Ends in local time or No end date, current access state, and custody where applicable.
5. Open the card's **Permission history** link or **Registry → Permissions**. Confirm approvals, denials, and direct grants remain searchable after completed rows leave the pending queue. Follow a completed decision link and verify the specific history row is focused.
6. For an approval-based zone request submitted through the API, deny it from the pending queue and confirm current access remains unchanged while its denial appears in history. A critical restriction must continue to display effective Restricted state even after an otherwise active grant.

**Edges:** Reject empty/unknown zone sets, equal or reversed endpoints, expired ends, dates outside the six-calendar-month horizon, duplicate visitor barcodes, and manual-review types sent to the direct-grant route. Simulate grant-effect failure and verify no partial new identity/history is left. Check a concurrent pending visitor creation/decision and grant, future-start/expiry boundaries, typed input, and month-end dates. Approval-based zone and custody requests bind the state when requested. A later state change makes approval return 409; deny and recreate the request using current state.

**Automation:** Direct-grant tests in [PostgreSQL tests](../backend/tests/test_database.py) exercise atomic new visitors, existing pending visitor reuse, late timeout protection, creator/decision lock races, custody effects, invalid payloads, and effect-failure rollback through the grant route. [Typed-request tests](../backend/tests/test_typed_permission_requests.py) check replacement dates/zones through helpers. Full browser grant/history interaction and the complete routed approval-based zone/custody decision matrix remain gaps.

### 7. Transfer hardware custody without changing access

**Setup:** Registered laptop assigned to employee A; employee B registered; record the asset's zones, status, and validity.

1. Open **New permission → Hardware custody** for B. The form must show A → B and omit a generic validity-duration control.
2. Choose **Grant permission**. Confirm the stored custodian ID/name are B's authoritative registry values, the asset's zones/status/window are unchanged, and the completed grant appears in Registry's Permissions history.
3. Scan A carrying the laptop: expect custody denial. Scan B carrying it: admission depends on B and the laptop independently meeting zone/status/validity/presence policy.
4. For a second approval-based transfer submitted through the request API, deny it from the pending queue and confirm ownership remains B.

**Edges:** Reject a visitor/unknown employee as custodian, the existing custodian, and a duplicate pending asset+employee request. Check forged carrier names, employee deletion between request and decision, and competing transfers approved concurrently. Approval must not create a movement, grant zone access, or schedule automatic custody expiry.

**Automation:** [Typed-request helpers](../backend/tests/test_typed_permission_requests.py), the custody approval regression, and `test_direct_custody_grant_changes_carrier_without_expiring_or_changing_zones` in [PostgreSQL tests](../backend/tests/test_database.py). Full routed approval-based transfer/denial, browser actions, and competing custody decisions remain partial.

### 8. Queue scans offline, reconnect, and change assignment

**Setup:** Same operator/browser/device loads Terminal online once; a subject with ordinary access; record starting history and presence.

1. Disconnect the browser's network and scan. Expect a queued result, persistent queue entry, and no claimed access approval. Reload only after restoring connectivity; offline first-load support is not guaranteed.
2. Reconnect and choose **Retry queued scans**. Verify the original payload, originating account, checkpoint, captured transport fields, and UUID are retained. The backend decides; a recorded decision removes the queue item only after the response succeeds.
3. Simulate losing the response after the backend commits, then retry. Verify there is one movement and the original decision is returned.
4. Queue another scan, reassign the account before retry, and verify the browser holds the old-checkpoint record. A direct API retry under the changed assignment must return `403`. Do not rewrite that scan to the new checkpoint. Use **Export held scans** to retain the original payload, key and reason for administrator reconciliation; export must leave the original record on the device.
5. Place a permanently rejected record before a valid scan. The first must remain held while the second reaches the server. Restore the original account/checkpoint and use **Retry held scans** to retry eligible records with their original payload/key. Records without a known owner remain held for administrator reconciliation.
6. Switch accounts in the same browser. The second account must neither display nor submit the first account's queue. Switch back and verify it remains. Changing accounts or checkpoint during a retry must stop further submissions.
7. In a disposable fixture, rehearse a queued record at the current receipt-retention boundary (default 30 days), a lost response whose receipt was removed, missing legacy server capture evidence, and an unavailable policy refresh. Automatic and explicit retries must hold the evidence without changing/deleting its original input or key. Export and reload it to verify preservation. Retention zero disables age expiry; identity and verifiable timestamp checks remain.

**Edges:** Test `401` requiring sign-in, retryable upstream/network failure, duplicate retries, storage unavailable, ownerless legacy entries, and cached configuration belonging to another account. Transient failures pause retries; permanent validation/conflict errors are retained for explicit recovery without blocking later valid records. The backend must reject an originating-account mismatch before replaying or writing a scan.

**Automation:** [Offline queue regressions](../tests/offlineQueue.test.ts), [receipt-retention regressions](../backend/tests/test_offline_replay_retention.py), [hardware and queue-owner backend regressions](../backend/tests/test_terminal_hardware_context.py), [frontend contracts](../tests/contracts.test.ts), [HTTP authentication harness](../scripts/test-keycloak-http.mjs), and checkpoint/offline payload regressions in [PostgreSQL tests](../backend/tests/test_database.py). Queue tests exercise persistent storage through a stub; real browser IndexedDB/network/account-switch checks remain manual.

### 9. Inspect history, analytics, notes, exports, and sync flags

**Setup:** Produce approved/denied employee, hardware, and manual-review events through preceding workflows.

1. In Movement Logs, filter by subject/type, result, direction, checkpoint, date range, and scan type; change sort/page/page size. Compare matching totals with analytics and inspect events at date boundaries.
2. Open an old event using its complete event ID while unrelated default filters are active. It must resolve. Add a note, refresh, and verify note text/order persist; whitespace-only notes must reject.
3. Generate a report for a known window/source set and verify rows, timestamps, totals, references, and CSV escaping against the API. CSV reports currently omit movement notes; verify notes separately in step 2. Equipment must not inflate people occupancy; paper records affect history rather than current occupancy.
4. In isolated API fixtures only, mark selected queued rows synced with `POST /v1/movements/sync` and selected conflict rows with `POST /v1/movements/conflicts/resolve`. Both require `{"eventIds":["movement-id"]}` with 1–200 unique IDs. Missing/null/empty/duplicate/oversized batches return `422`. Check unrelated states/IDs remain unchanged, retries return only newly changed rows, and no-op retries enqueue no event. An oversized response must reject before any change commits; select fewer IDs and retry.

**Edges:** Literal `%`, `_`, and backslash search; invalid dates/sorts/page bounds; empty/out-of-range pages; more than 500 analytics samples; missing event/note targets; note length boundaries; large exports. Sync/conflict routes change flags only: they do not replay scans, recalculate presence, or reconcile competing movement versions.

**Automation:** Movement filter/reference/note tests in [PostgreSQL tests](../backend/tests/test_database.py), [maintenance bounds/rollback/concurrency tests](../backend/tests/test_movement_batches.py), and [search migration/query-plan tests](../backend/tests/test_movement_search_index.py). Full-browser export acceptance remains manual.

### 10. Trigger critical entry restrictions, review warnings, reset counts, and restore entry

**Setup:** Disposable attendance fixtures within the evaluator's last-48-hours input window: an active employee's unbroken approved work exceeding six hours and another active employee with no approved entry on the current Asia/Kolkata date. Historical paper records can supply the work history. Irregularity evaluates only when the actual clock is at/after 18:00 in Asia/Kolkata; before then, expect no irregularity alert and use the clock-controlled unit tests for that boundary. The HTTP endpoint has no clock override.

For the restriction branch, use a rule configured with critical severity through the rule API in the disposable installation. Bind the resulting alert to a registered subject ID or unique barcode. A name alone, or a forged/missing supplied subject ID, must not bind a restriction to a different subject.

1. Invoke `POST /v1/alerts/evaluate` as admin, or observe the five-minute scheduled evaluation. Expect only the applicable attendance alerts. Evaluate again: do not create duplicate alerts for the same rule/subject/day.
2. In Alert Command, verify the sidebar dot appears only while an active open/warned alert exists. For a pending warning, choose **Accept alert** and optionally add a note; it becomes a confirmed warning and remains active. Choose **Excuse mistake** on another warning with a required reason; it becomes resolved and does not increase the warning count. A confirmed critical hold remains active after either review.
3. In **Confirmed warnings**, select the employee, verify the confirmed count and hold, enter a reset reason, and choose **Reset warnings**. The count must become zero, the critical hold must become inactive, ordinary zones and validity must remain unchanged, and the reviewed alert must move out of active results without being deleted. Open **Registry → Alerts** and verify the title, barcode, level, decision, reviewer, reset time, reset actor, and reset reason. `GET /v1/alerts?status=acknowledged` and the paginated Registry view must still include the record after source-alert retention.
4. Read `/v1/audit-events` with category/date/page filters and match permission changes/decisions, checkpoint assignments, and paper visits to their evidence. Registry CRUD and request creation do not currently append audit events; do not assume a complete audit of those actions. Unknown barcode/manual review alone must not produce retired attendance alerts.
5. Grant ordinary access to the restricted subject and confirm entry remains denied. In **Access directory**, expect effective Restricted state and the critical reference. An approved manual review must still wait for explicit restriction release before entry. A subject already inside must retain a safe matching exit. Repeat with a carried asset's own restriction.
6. Add a nonblank **Reason to lift restriction** and choose **Lift critical restriction**, or call `POST /v1/alerts/{alert_id}/release-entry-restriction` as admin. Verify the saved actor/reason/time and audit evidence, unchanged current presence, and normal zones/window/cooldown policy after release. A repeated release must retain the first release evidence.
7. Re-evaluate/replay the old alert ID and confirm it cannot reapply the restriction. Generate a new distinct critical trigger after release and verify entry is restricted again; releasing using the old ID must not clear the new restriction. In a disposable retention fixture, remove the original alert row and confirm its restriction/evidence survive and explicit release remains possible.

**Edges:** Missing/unbound alert IDs, operator review/reset attempts, blank/coerced/extra review/reset fields, contradictory final decisions, repeated reviews/resets, count-zero reset with an active hold, retained source alerts, literal search characters, invalid statuses/dates/limits, publication failure after commit, and concurrent activation versus scan. Check backfill of acknowledged critical alerts under migration `s7t8u9v0w1`. Global rule definitions are read-only; scope, schedule, and threshold fields are descriptive and are not exposed as configurable evaluator behavior.

**Automation:** [Critical restriction tests](../backend/tests/test_critical_entry_restrictions.py) exercise routed acknowledgement, scan/release authorization and validation, reviewed visit/exit, stale/idempotent release, replay/offline scans, hardware holds, source-row deletion, directories, identity binding, and migration backfill against PostgreSQL. [Alert review tests](../backend/tests/test_alert_reviews.py) cover strict payloads, immutable accept/excuse decisions, warning epochs, count-zero reset, critical-hold release, retained history, search/pagination, lock ordering, rollback, and publication failure. [Rule-assignment tests](../backend/tests/test_alert_rule_assignments.py) cover employee defaults, explicit empty selections, hardware/visitor rejection, revision conflicts, audited no-op retries, worker filtering, deduplication, and assignment/evaluation ordering. Activation rollback and scan locking use database helpers; real scheduled execution and the complete browser lifecycle still need integration tests.

### 11. Verify sessions, profile isolation, live updates, and failure recovery

**Setup:** Two admin identities and one operator in separate browser profiles; a disposable running stack.

1. Signed-out page visits must redirect to sign-in and protected API calls return `401`. Verify admin/operator page boundaries. Inspect the public session response: it must not expose access/refresh/ID tokens.
2. Change admin A's avatar/preferences and confirm admin B remains separate. Sign in as an admin without email and save preferences successfully. Delay or fail the initial profile load: saving must remain disabled until a successful load; errors and the retry control must be visible. Operator review notes and denial notes are required; approval notes are optional, matching the displayed policy.
3. Set a future return time at sign-out and check terminal availability; sign in again and verify it clears. Test past/naive/out-of-range availability. App-form sign-out must clear the local session and revoke its provider refresh token. Account-action previews do not create sessions. Stall the availability service: logout must continue after its five-second timeout. The provider callback must not perform another availability write.
4. Keep the admin Dashboard open while the operator enters/exits. Expect committed live updates, no occupancy change for denied scans, and snapshot recovery after reconnect. An expired stream token must close the stream.
5. Run the isolated HTTP-auth suite for refresh/revoked-grant/cookie forwarding and the gateway suite for spoofed headers, certificates, body limits, `429`, and streaming. Run `npm run test:auth:account` separately for the real local account integration.
6. On the disposable stack, stop Redis, then Temporal, then PostgreSQL one at a time, restore each, and poll probes directly inside the API container if Kong cannot route an unhealthy upstream. Use a bounded client timeout and record both statuses and elapsed time. Readiness is bounded by a four-second overall deadline (`_READINESS_TIMEOUT_SECONDS` in `backend/main.py`): dependency failure or deadline expiry should return `503`, while liveness stays `200`. Verify both outcomes and record elapsed time; a client-side timeout alone is not evidence of the server response. Check committed scans/decisions survive post-commit publication failure.

**Edges:** Wrong issuer/audience/signature/kid, expired token, revoked refresh, cross-origin/non-JSON mutations, large/chunked bodies, certificate/body/assignment mismatch, Redis reconnect, and actual Temporal signal/retry/replay. Presence requires an application role; operator visibility across checkpoint boundaries still needs a defined data-scope policy. Keep gateway fixture results separate from real application integration.

**Automation:** [JWT tests](../backend/tests/test_auth.py), [robustness tests](../backend/tests/test_robustness.py), [profile PostgreSQL regressions](../backend/tests/test_profile_preferences.py), [profile and independent-save UI regressions](../tests/buttonWorkflows.test.ts), [HTTP auth harness](../scripts/test-keycloak-http.mjs), [live account harness](../scripts/test-keycloak-account.mjs), and [gateway tests](../gateway/tests/check_gateway.py). Real multi-service failure/replay/browser scenarios are not fully automated.

### 12. Select, extend, and lock a user-management window

**Setup:** An administrator and an operator in separate browser profiles; a disposable running stack. Use a clock-controlled test for exact expiry boundaries rather than changing production clocks.

1. Open **Manage users** while locked. Reauthenticate with the application's own sign-in form and verify the default five-minute countdown. The unlocked duration selector must offer exactly 5, 10, 15, 20, and 30 minutes, plus 1 hour.
2. Reload while unlocked and confirm the selected duration and original expiry remain. For a longer selection, user management must still work after five minutes and lock when that selection expires. Token refresh must not restart the countdown.
3. Choose a duration without pressing **Extend**. The current countdown must continue unchanged. Press **Extend**: the current window becomes locked while fresh app-form sign-in is pending. Cancel sign-in and reload; it must stay locked. Complete the fresh sign-in: the selected duration is added to an existing active window, or starts a fresh window when the old one expired or was manually locked.
4. During a 1-hour window, press **Lock**, reload, and attempt an identity command. The page must remain locked and the command must return `403` without reaching the identity upstream. Reopening it requires another completed fresh login.
5. Submit unsupported/coerced duration values, extra fields, or malformed JSON to `POST /api/auth/step-up`: expect `400`. A non-JSON content type returns `415`; missing/cross-origin requests and operator access are rejected. Missing, altered, inconsistent, or expired signed-session fields must not unlock identity commands. An invalid supplied backend proof must be rejected even when the bearer is otherwise freshly authenticated.
6. Repeat unlock and extension with an administrator whose role/group claims produce a chunked session cookie. The callback and `/admin/users` must load without `431` even when the complete Cookie header exceeds 16 KiB. After completed reauthentication, temporary intent and lock cookies must be cleared; repeated extensions must replace session chunks rather than grow them.

**Automation:** [Frontend session tests](../tests/keycloak.test.ts) cover the signed duration intent, fixed authentication-time expiry, exact bearer binding and refresh without renewal. [Callback tests](../tests/authRequestBoundary.test.ts) require a same-origin `/admin/users` redirect and a newly issued, decrypted Auth.js session containing the same administrator subject, unique signed intent ID, fresh provider authentication and exact selected window before clearing its lock. An ordinary login, another account, altered/partial cookies or an older intent retains the lock. [Backend selected-window tests](../backend/tests/test_user_management_step_up.py) cover all six durations, expiry/signature/claim validation, proof age, and the five-minute direct-bearer fallback. The [HTTP harness](../scripts/test-keycloak-http.mjs) exercises built-app rendering and commands, all six choices, signed proof forwarding, lock/reload, canceled renewal and cookie tampering. It completes real Auth.js OIDC callbacks with a local signed identity stub and chunked cookies above 16 KiB, checks rejected state and another-account completion, and confirms the 64 KiB request bound. Browser interaction remains a separate acceptance step.

### 13. Configure alert assignments without changing global rules

**Setup:** An administrator with a disposable employee and, optionally, a hardware asset. The selectable employee attendance rules are **No break recorded** and **Attendance irregularity**. Building-scan and visitor-overstay rules apply automatically. Hardware rule assignment remains unavailable until a hardware evaluator exists.

1. Open **Alert Command → Automated rules**. Confirm the catalog shows the rule name, severity, scope, enabled state, and recent trigger count as read-only. Attempts to edit a global rule through `PATCH /v1/alert-rules/{id}` must return `403` and leave the stored rule unchanged.
2. In **Rule assignments**, select an employee. A subject without an assignment must show both eligible rules through default inheritance. Select one rule and save; reload and confirm the row is `custom` with revision `1`. Clear every checkbox and save; reload and confirm the row remains `custom` with no rules, rather than inheriting the defaults.
3. Select a hardware asset. Show the unavailable state and ensure no hardware rule checkbox or save action is offered. Attempting to assign an employee attendance rule to hardware through `PUT /v1/alert-rule-assignments/{id}` must return `422`; visitors and unknown subjects must be rejected too.
4. Open two administrator sessions, save different selections for the same employee, and submit the stale revision from the first session. Expect `409`, no partial change, and a reload action that discards the stale draft. Repeating the same selection with the current revision must not create another revision or audit event.
5. Run rules now and wait for the scheduled worker. A custom empty selection must suppress that employee's alerts, a selected rule must generate at most one alert per subject/rule/day, and a disabled global rule must remain unevaluated even if assigned. Verify the rule assignment audit record and live refresh in the second admin session.

6. Change a rule and stage a valid skip date before saving either section. Choose **Save rules**: only the rules must persist, while the date remains an unsaved draft. Then choose **Save dates** and verify it keeps the saved rules. Repeat in the opposite order. Type a past, impossible, or more-than-six-month date: **Add date** must not stage it.

**Automation:** [Rule-assignment tests](../backend/tests/test_alert_rule_assignments.py) exercise schema coercion/extra fields, defaults, explicit empty custom selections, ineligible subject types, stale revisions, audited idempotent retries, rollback/publication failure, evaluation filtering/deduplication, critical activation, and assignment/evaluation lock ordering. [Independent-save and date-control tests](../tests/buttonWorkflows.test.ts) verify separate drafts and calendar boundaries. These tests do not replace the browser workflow.

### 14. Recover account saves and load the complete user directory

**Setup:** A disposable identity provider and database, with an administrator's fresh user-management window. Simulate provider failures through the isolated recovery tests; never inject failures into operational identity administration.

1. Create an operator with a checkpoint. Confirm provisioning keeps the account disabled until password, assignment and roles are ready, then enables it according to the form.
2. Fail password, assignment, role or final enablement during creation. Confirm the newly created account is removed and its assignment is cleared. If compensation fails, the error must identify the account requiring recovery; inspect the actual provider state before retrying. A duplicate username must leave the pre-existing account untouched.
3. Change an existing account's profile, checkpoint and roles using one **Save**. Fail a later provider step: previous provider settings and the database assignment must be restored. A failed restoration must report recovery required; the UI must reload actual state or require reloading before another edit.
4. Reject an operator role without a checkpoint before provider mutations. Simulate a provider that returns success without saving roles: verification must detect the mismatch and invoke recovery.
5. Seed at least 205 temporary accounts. Load and search Manage users: all matching pages must be included without duplicate rows or a 100-user ceiling. A provider ignoring paging must produce a visible failure rather than an endless request loop.

**Automation:** [Stateful identity-provider and PostgreSQL recovery tests](../backend/tests/test_keycloak_admin_recovery.py) and [account service regressions](../tests/accountWorkflows.test.ts). These exercise simulated failures and persisted assignment rollback; they do not imply a completed live provider failure exercise.

### 15. Verify complete dashboard and employee-profile periods

**Setup:** Synthetic movement history exceeding 500 records in a chosen period, a populated prior period, more than ten alert triggers, and employee history outside the Registry's most recent 1,000 site-wide rows. Keep fixture presence separate from historical paper records.

1. Open Dashboard and select Today, This Week, This Month, This Year and a custom range. Compare totals with complete database counts by result, direction, scan type and subject group. The initial range must load aggregates, rather than rely on the preview history.
2. Compare KPI changes with the equally long previous window. With no prior records, display a meaningful new/empty comparison. Confirm reviewed or retained alert history remains counted once in its trigger period.
3. Click Restricted, Expired and Other denial segments, including automatic/manual leaves. Movement Logs must preserve the exact dates, subject group and category; its matching total must equal the clicked segment. Old source-event links must still resolve after reviewed legacy duplicates are excluded from ordinary totals.
4. Open an employee profile and select 1W, 1M and 1Y. Confirm hours and trend use that employee's complete selected and prior periods, including older history. Check overnight shifts, an entry before the range, a still-open session, breaks and facility-midnight boundaries.
5. Fail either aggregate request. The page must show a loading/error state and never present a capped preview as the complete result. Restore the service and reload; totals must recover.

**Automation:** [Aggregate and activity PostgreSQL regressions](../backend/tests/test_analytics.py) and [frontend query/drilldown regressions](../tests/analyticsQueries.test.ts). Correctness on synthetic fixtures is separate from representative load benchmarking.

### 16. Enforce data and behavior limits and recover safely

**Setup:** A disposable installation with its own database, Redis and identity realm; two administrator accounts A/B, an assigned operator, and synthetic subjects/history. Record starting movement, retry-receipt, permission and presence values. For replica checks, use two Kong/API instances sharing the same Redis and issuer configuration; retain the stable service IDs from the declarative gateway configuration. Use real valid access tokens and retain secrets outside command history/logs. Keep requests below Kong's independent request-frequency quotas while testing data or behavior. Smaller valid configuration values can make these checks faster; apply them consistently to the disposable replicas and record the values used.

1. **Data allowance and identity sharing.** Repeatedly load complete fixture pages as A, measuring response body bytes. Before the allowance is exhausted, expect complete `200` bodies; the first response that would exceed the allowance must return `429`, a positive `Retry-After`, and no fixture records. Retry immediately with A's refreshed token, a second browser session, and the other API replica: the same account must remain limited. Spoofed identity/forwarded-address headers must not change this. B must still load the same authorized page successfully. Wait for the reported window, retry A, and verify complete reads resume.
2. **Response and source capacity.** Produce an authorized read larger than `MAX_DATA_RESPONSE_BYTES`: expect `413` before any successful headers or records reach the client. Test both declared-length and chunked JSON through the response-guard tests. Use cap-plus-one fixtures for complete registry/permission/rule directories, presence, terminal hardware and activity sources; expect `422` rather than an incomplete directory or hours total. Exceed the movement-bucket cap, then narrow its date filter and confirm an exact successful result. Paginated history and SQL dashboard totals must remain exact. Generate a report that fails a page, byte or row limit; it must display failure and produce no partial successful CSV. A narrower report must export the complete expected set.
3. **Live data delivery and admission.** Open a presence stream as A and produce fixture events until its byte allowance is exhausted. Already admitted events may be present, but the over-budget chunk must be absent; expect a `throttled` event, retry delay, connection closure and lease cleanup. B's stream must remain unaffected. After the window, reconnect A and verify fresh snapshot reconciliation. Run the gated-debit admission regression: a pending JSON debit must keep its HTTP slot and withhold `200` headers, while a live SSE connection must not occupy an ordinary HTTP slot.
4. **Kong request rates and operation groups.** In fresh fixed calendar windows, submit disposable actions in each group: permission/registry/review, identity management with a fresh user-management window, and alert evaluation/reset/release/assignment. Defaults allow 10 permission actions or 5 user/alert actions per calendar second, and 60/20/20 per calendar minute. The next action in that window must return `429` and `Retry-After` from Kong before business mutation. Alternate matching endpoints, gateway replicas, browser sessions and refreshed tokens for A: the shared group allowance must remain exhausted; B must remain independent despite the same socket peer. Test ordinary API reads/writes separately against their 300/minute allowance. Invalid or expired tokens must be rejected by identity verification before a business handler runs. Wait the reported delay and retry; Kong frequency limits do not create a backend behavior cooldown or suspend an account. Check the gateway rejection log and confirm authorization, checkpoints, warnings and presence are unchanged by rejected mutations.
   Test anonymous browser and public OIDC requests separately against their 1,800/600-per-minute IP allowances, using lower fixture limits when practical. Exhaust one listener across both gateways; the other listener and authenticated API budgets must remain available. Forging `Host`, `InoutListener` or forwarded-IP headers must not restore an exhausted allowance. In the isolated Redis fixture, confirm service users receive `NOPERM` for `CLIENT PAUSE 0 ALL`, `CLIENT KILL ID 0` and `CLIENT UNBLOCK 0 TIMEOUT`; use these harmless arguments rather than interrupting real clients.
5. **Failure signal and actor isolation.** Send 20 authenticated requests producing `400`, `403`, `409` or `422` within a minute, using validation-only reads to avoid another action quota. The threshold request must retain its original error; subsequent writes must return `429`. Anonymous failures, `404`, existing `429` responses, and ordinary denied scans returning `200` must not spend this failure budget. B must remain writable. Wait out the cooldown and confirm A recovers with unchanged permissions and presence.
6. **Unknown barcode retries without extra mutation.** Before triggering cooldown, scan an unknown fixture barcode with one UUID, retain its denied receipt, and retry the identical payload/key. Expect a replay receipt with `authorizeMovement: false`, one movement/receipt, unchanged presence, and no additional distinct-barcode charge. Fresh keys for the same normalized barcode must not count as new distinct barcodes. Start a fresh quota window for the threshold branch, or include that first barcode in the counted set. Submit distinct fresh unknown barcodes as the assigned operator: the first 30 may record ordinary denials; the 31st must return `429` with no movement, receipt or presence change for that rejected scan. Test the trusted physical-terminal path separately. During cooldown, scans and retries are paused; after expiry, retry queued records with their original payloads, account, checkpoint and keys. Do not rewrite queued records to bypass the limit.
7. **Audit evidence and outage recovery.** As B, inspect `GET /v1/audit-events?category=security` and the structured API logs for data/behavior signals. Confirm one event per actor/limit kind within the retry window, remaining delay, and no token, body, query string or raw unknown barcode. Inspect Kong access logs separately for frequency rejections. In the disposable installation only, interrupt gateway Redis and submit protected requests: expect `500` from Kong and no upstream mutation. Interrupt only the API quota store with gateway Redis still available: expect `503`, no disclosed successful read and no new mutation; an already-open stream must safely close on its next failed debit. Fail audit database persistence separately and confirm structured-log evidence remains without flooding repeated DB attempts. Restore connectivity, wait for surviving quota windows, and verify normal requests and streams recover. Redis quotas are in-memory: restarting Redis resets allowances/cooldowns; business and audit records in PostgreSQL must remain intact.

**Automation:** [Data delivery tests](../backend/tests/test_data_limits.py), [query-bound unit/PostgreSQL tests](../backend/tests/test_data_query_bounds.py), [behavior and distinct-barcode tests](../backend/tests/test_behavior_limits.py), [security audit tests](../backend/tests/test_limit_events.py), [HTTP integration tests](../backend/tests/test_security_limit_http.py), and [buffered-response admission tests](../backend/tests/test_data_admission.py) cover byte accounting, sentinel bounds, complete-response rejection, actor isolation, atomic Redis admission, retries, cooldown expiry, audit fallback and stream cleanup. [Real gateway tests](../gateway/tests/check_gateway.py) cover shared request quotas across two Kong instances and Redis, account/listener isolation, forwarded-header spoofing and anonymous rejection before body reads. [Infrastructure ACL tests](../infrastructure/tests/check_infrastructure.py) cover denied cross-service client control and normal pool/pubsub/counter behavior. Full browser acceptance and representative load remain separate checks; this workflow is a procedure, not a claim that every manual step has been executed.

8. **Stored metadata and cumulative patches.** Create an employee, visitor or hardware record with extra metadata exceeding 16 KiB: expect `422`, no registry/permission/approval rows and no workflow publication. Submit individually small, different metadata patches to an existing subject until the merged document would exceed the cap. The rejected patch must preserve barcode, metadata, zones and permission status. Count UTF-8 bytes, including server-owned fields; a short unicode document may have more bytes than characters. Small unknown metadata and normal form submissions must still work. The [metadata size tests](../backend/tests/test_subject_metadata_limits.py) cover exact boundaries, malformed nested values, cumulative growth and transaction preservation.

**Report and browser automation:** [Shared report-budget tests](../tests/reportReadBudget.test.ts) cover row/byte caps, deadlines, failed pages and inconsistent totals. The [built-app HTTP harness](../scripts/test-keycloak-http.mjs) verifies that data/profile reads, scan writes, identity/reauthentication reads and initial stream errors preserve the upstream throttle status, message and `Retry-After`.

## Benchmark workflow

The historical local dashboard comparison used **126 movements, five warmups, 60 samples, and concurrency one**, measuring the backend handler only. Direct PostgreSQL reads measured median **11.347 ms** and p95 **13.650 ms**; HTTP/authentication/rendering and simultaneous scanning were excluded. There is no committed repeatable load harness, no all-endpoint benchmark, and no agreed performance acceptance threshold. Gateway body-limit and streaming tests, plus backend quota tests, are functional checks, not capacity measurements.

Use this procedure for a future reproducible benchmark; these larger-data runs have **not been performed**:

1. Create a separate benchmark project/database and disposable synthetic Keycloak realm. Migrate it, load a deterministic fixture seed, and run `ANALYZE`. Suggested tiers are 10,000 / 100,000 / 1,000,000 movements with 100 / 1,000 / 10,000 people and proportional assets, requests, alerts, notes, and audits. Include both checkpoints and realistic history/status distributions. Keep generation and write tests away from operational data and identity realms.
2. Benchmark reads after at least ten warmups, at concurrency 1, 5, 15, and 30, with at least three runs of 1,000 measured requests per case. Cover dashboard; shallow/deep movement pages, search/reference/date filters and analytics; registry/permissions/terminal bundles; presence; alert count/history; and audit pages. Measure BFF requests separately, including chart loading and all-page alert loading.
3. Use fresh fixture copies for scan and approval scenarios. Measure approved versus denied scans, carried hardware, identical-key contention, different-key contention for the same subject, competing decisions, rollback, locks, and queue replay. Verify resulting row/presence counts as well as timing. Measure real Keycloak user-management/refresh, Temporal delivery, SSE fan-out/reconnect, and browser rendering separately.
4. Record p50/p95/p99, throughput, response bytes, status/error/timeout counts, CPU/RAM, connection-pool wait, and database time. Save raw samples with revision, runtime/image versions, machine/resource limits, seed/counts, query parameters, concurrency, and the measured boundary (handler, direct HTTP, gateway/BFF, or browser). Pace traffic and report data/behavior/authentication `429`, capacity `413`/`422`, and admission `503` separately; these protections otherwise distort successful-request latency. Retain the configured budgets and any intentional disposable overrides with the samples.
5. Capture `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for representative SQL on synthetic data. Inspect movement search (its expression differs from the trigram index), lowercased event-ID lookup, dashboard history/review joins, open-alert partial-index applicability, bounded bundle/bucket/activity reads and grouped rule-trigger counts. Measure both accepted ranges and explicit cap-overflow rejection. An index migration alone does not prove that a query uses the index.
6. Agree explicit p95/error/throughput/resource budgets before evaluating acceptance. Compare before/after under the same seed, resources, arrival rate, and query set, and retain failures rather than reporting only successful timings. A passing correctness suite or a fast small fixture does not complete this benchmark workflow.

### 17. Verify application sign-in, temporary-password setup, account previews, MFA, and logout

**Setup:** A disposable realm and application using the exact registered callback/origin and pinned custom extension. Apply `keycloak:interactions:apply` and its `:check` through the fixture maintenance gateway; the authenticated status probe must pass before any client writes. Use the matching confidential frontend secret and private lease API. Use synthetic administrator/operator accounts and an account whose only action is `UPDATE_PASSWORD`. Configure a disposable SMTP sink and `keycloak:recovery:apply` for the separate provider recovery workflow. The provider fixture uses its own temporary database; see [the isolated extension recipe](app-managed-password-plan.md#validation).

1. Visit the signed-out application. `/login` must display its own username/password form immediately and stay on the application origin. Check desktop and narrow mobile widths, keyboard focus, error messages and password visibility. Sign-in credentials must go only to the same-origin `/api/auth/callback/credentials` endpoint; the confidential Keycloak exchange happens on the server. Public session responses must exclude passwords, client secrets and provider tokens. Successful sign-in must return only to a permitted local page.
2. Enter an incorrect password and an unknown account. Both must show the same generic error. Separately, open the provider's built-in recovery page through a valid code/S256 login request in the disposable fixture. Use **Forgot password**, submit the synthetic account to the SMTP sink and complete its expiring reset link. Reuse or alter the reset link: Keycloak must reject it. The application does not show a general forgot-password control; the automated fixture verifies the provider recovery rendering, and real email delivery requires the SMTP sink.
3. An account with a temporary password must not receive a login code/session until setup is complete. **Change temporary password** must open the inline app form; submit the temporary password, new password/confirmation and configured OTP. Only same-origin `/api/auth/password/update` receives this JSON. Setup must show completion and return to ordinary sign-in with the username preserved; sign in with the new password afterward. No browser redirect or automatic session should occur. Incorrect credentials/OTP, disabled accounts, extra actions and policy failures must leave credentials unchanged. From the account page, change a password with the real username/email; another account must be rejected and success must preserve the current identity and administrator window. Other preview controls must not change provider state. Both frontend and Postman password grants must fail; the custom interaction must reject missing/wrong secrets, public/different clients and a disabled client gate.
4. Exercise all six Manage users unlock durations. Cancel a renewal or sign in as a different admin while an intent is pending: neither may unlock the initiating account's window or clear its lock. A fresh same-account completion must unlock exactly the selected duration; extension adds to the captured old expiry. Refresh/reload must preserve that deadline. Tokens with a wrong signature, issuer, audience, subject, expiry or authorized client must fail closed.
5. Submit duplicate auth parameters, unsafe return URLs, forged CSRF tokens, cross-origin/missing-origin POSTs, oversized bodies and a stalled form. Reject them before provider work. Password updates must conflict through the shared lease; outages fail closed. A lost mutation response must retain the lease with an unconfirmed result and no automatic second write. Redeem a login code twice/concurrently, after expiry, with a wrong S256 verifier, with another client, and after account/credential changes: reject it without creating another session. Keep the previous native reset client disabled after cutover. Across two Kong replicas, app sign-in and password-update POSTs share 10/minute and 3/second per socket IP; Keycloak form POSTs share 60/minute and 5/second across realms/actions. Forged identities, Host, forwarded addresses and query values must not reset quotas. Rejections return `429` and `Retry-After`; ordinary GET/discovery/assets/code callbacks retain independent allowances. Interaction endpoints must not be reachable from public identity listeners. Use synthetic fixtures and wait out each reported window.
6. Sign out during API failure and after bearer refresh failure. The local browser session must clear; a reachable provider must reject reuse of the revoked refresh token. An unavailable provider must not trap the user in a local session. Establish a new session or pending reauthentication in another tab before a delayed old return arrives: the newer session, intent and lock must survive.
7. Reset a synthetic operator's password as master-admin while its old session is active. A confirmed reset must end provider sessions and revoke its issued application tokens. If the reset response is lost, the API must attempt both protections and report the write as unconfirmed without automatically retrying it; try the new password before deciding whether another reset is needed. If cleanup is incomplete, use **End sessions** after recovery. Definitive password-policy or authorization rejections must leave the existing session unchanged. Reject short, whitespace-only, username/email, and denylisted new passwords; preserve legitimate leading/trailing passphrase spaces. Verify `UPDATE_CREDENTIAL` and `UPDATE_CREDENTIAL_ERROR` events include `credential_type=password` and never contain a password. Unsupported account actions must show a contact-administrator message without minting a token or retrying the password.

**Automation:** `npm test`, `npm run test:auth:http` and `npm run test:auth:password-updates` after a build use isolated identity/lease stubs. The real extension fixture is `keycloak/compose.test.yaml` plus `keycloak/compose.interactions-test.yaml`; `keycloak/tests/check_interactions.py` checks provider wire behavior and `scripts/test-keycloak-interactions.mjs` checks the compiled app bridge. Run the two-replica gateway fixture separately. Real-provider checks, browser acceptance and SMTP delivery are separate evidence; stubs do not establish them. The normal stack and Daybreak are unnecessary for these isolated checks.

### 18. Verify focused Registry, Alerts, and profile reads

1. Use a disposable fixture with more than 50 employees, alerts and movement records. Open browser Network tools and clear the request log.
2. Open Registry. Its selected subject kind loads 25 records plus exact global summary/trend data. Change pages and sort order: the next read must not request the overview again. Search must cancel superseded reads and search the complete directory, including records beyond the first page.
3. Open an employee profile. It loads that subject's permissions, seven initial movements and the selected activity range. Open alert history to load its next page. A scan for another employee must not reload this employee's movement history.
4. Open Alerts. Its command view loads the first 50 actionable alerts, global warning count and upcoming leave assignments. Selecting an employee loads only their settings/warnings; searching employees reads a paginated directory. The sidebar uses the count projection without loading alert documents or employee metadata.
5. Compare the global totals with the corresponding complete API reads. Retained confirmed/excused reviews remain available in history. Check the same screens at desktop and narrow widths.

### 19. Verify complete one-request CSV exports

1. Seed at least 220 matching movements, including a carried asset and a parent movement note. Select filters in Generate report, export an employee's movement history, and export each Registry kind.
2. Each operation makes one `/api/data?resource=export` request and one authenticated `/v1/exports` read. CSV formatting happens locally from that consistent JSON snapshot, preserving the existing columns, date formatting and spreadsheet-formula escaping.
3. Compare all exported IDs/counts with the filtered canonical history, including projected hardware events. Registry averages must use the selected period. An export must include every matching record, including records beyond public API page limits.
4. Exceed the configured row/byte cap: expect an explicit error and no successful partial download. Limits remain at most 10,000 records, the configured response byte cap (16 MiB by default), and a 60-second backend deadline; account data quotas still apply. The CSV itself is also bounded to 16 MiB.
5. Cancel/navigate away during generation. The browser signal reaches the BFF and the backend cancels the read. Existing public pagination caps remain unchanged.

### 20. Verify durable delivery and recovery

1. In a disposable stack, pause only its existing Temporal worker. Keep authentication, database and quota Redis available. Complete a scan, visitor registration and administrator decision.
2. Verify each business transaction and its `event_outbox` records commit together. A failed transaction must leave neither a business mutation nor its delivery records. A repeated scan idempotency key must not create another event.
3. Resume the worker. Redis events and existing Temporal starts/signals must retry; workflow IDs remain stable. A delayed start uses the original database approval deadline rather than granting a new timeout window.
4. Rehearse worker interruption after claiming a record and after publication. Expired leases recover, duplicate events do not double-count UI state, and an old worker cannot acknowledge a new owner's lease. Test event publication failure separately from the quota store: a complete quota-store outage still rejects requests as designed.
5. Inspect `attempts`, `available_at`, `lease_until` and `delivered_at` in the isolated outbox. Delivered technical events expire after seven days in bounded cleanup batches; pending deliveries and domain audit/review history are preserved.

6. In the isolated Temporal fixture, keep an approval activity's database collaborator unavailable beyond its original three attempts. Verify its persisted recovery timer survives worker restart, retries back off, and recovery persists only one timeout decision. Commit an administrator approval during the outage and verify recovered expiry cannot reverse it. Replay pre-recovery and older signal histories using [real-history tests](../backend/tests/test_approval_recovery_temporal.py); do not reset production workflows for this check.

### 21. Verify live-stream snapshot gaps and checkpoint privacy

1. Load a page snapshot, commit a scan before its stream subscribes, then connect with that snapshot's revision. The stream must replay the committed event before `ready`.
2. Disconnect/reconnect and deliver duplicate or out-of-order notifications. Each revision applies once; missing predecessors are read from the database. An excessive/expired backlog triggers `snapshot_required` and a fresh snapshot.
3. Repeat as an operator. Responses contain checkpoint refresh hints and cursor controls, never administrator notes, private subject documents or another operator's assignment details.
4. Reassign/revoke that operator's checkpoint. Their stream and bootstrap must reconcile the change. Heartbeats recheck assignments; every scan still validates the current database assignment.
5. Run `test_presence_replay`, `test_presence_privacy`, `test_resource_admission` and `test_event_outbox` against isolated PostgreSQL/Redis to cover subscription acknowledgement, lease cleanup and recovery.

### 22. Verify scan batching, warning backfill, and alert concurrency

1. Scan an employee with zero and then three carried assets. Missing presence creation plus locked presence lookup must remain two SQL statements. Normal materialized scans must not reconstruct the warning ledger.
2. On an isolated pre-migration copy, include confirmed legacy warnings, a reset epoch and an explicitly released hold. Migrate: eligible holds are backfilled without reviving reset/released restrictions, and review/audit history remains intact. Conflicting trigger identities must roll the migration back.
3. Race scans carrying overlapping assets. Verify deterministic lock order, idempotent receipts and atomic employee/asset presence.
4. Hold a scan lock for an employee without an alert candidate: evaluation must not wait on that unrelated employee. For a candidate, change the attendance inputs before its lock is acquired: evaluation must re-read/recompute and avoid a stale alert.
5. Run `test_scan_query_budget`, `test_critical_entry_restrictions`, `test_security_workflows` and the existing rule/visitor tests. Restrictions, resets, releases, expiry and access decisions must retain their existing behavior.

### Repeatable performance measurements

The implementation and measured results are documented in [application latency records](unofficial/application-latency-records.md). This command benchmarks retained complete reads against focused reads on the same synthetic fixture; it creates and removes its own schema and refuses databases whose name does not end in `_test`:

```powershell
docker compose -p inout-performance-check --profile test run --build --rm -e PYTHONPATH=/app:/app/tests backend-tests python benchmark_performance.py --subjects 1000 --movements 5000 --alerts 500 --samples 12 --concurrency 4
docker compose -p inout-performance-check --profile test down --volumes
```

Run measurements without concurrent tests/builds. Output includes p50/p95/p99, SQL counts, serialized response bytes, errors, sample sizes and explicit scope. These handler timings exclude HTTP, TLS, Kong, identity-provider latency and rendering; they do not replace the larger end-to-end benchmark procedure above. All existing services, including Temporal, remain in use.


## Latency regression workflows

The approved implementation and measurement boundaries are recorded in
[the latency remediation plan](unofficial/latency-remediation-plan.md). Interactive
permission views and CSV clients explicitly
select bounded or lean contracts. No service was removed and no schema migration
is required. Deploy the worker replicas on the same revision to apply ordered
presence/workflow delivery consistently.

Run `npm test`, `npm run build`, and `npm run test:python`. PostgreSQL cases require
the existing dedicated test database configuration. The October 16 benchmark
records the historical handler baseline.

1. **Continuous scans and slow reads.** Keep Dashboard, Logs, Registry, and an
   employee profile open. Generate fixture scans while delaying snapshot reads
   beyond one second. Reads must finish and queue a bounded follow-up. The
   terminal stream stays connected across ordinary
   snapshots. Force a replay gap, then verify snapshot recovery and event deduplication.
2. **Permission pagination and deep links.** Use more than 25 directory records and
   pending requests of every type. Search names/barcodes, switch access states and
   people/hardware, page both queues, and open links to records outside the first
   page. Inspect current zones/custody, approve/deny, and verify the card disappears
   and updated access remains scoped. Search literal `%`, `_`, and backslashes too.
3. **Account pagination and assignment.** Use multiple provider pages, including a
   page whose accounts are all outside a zone administrator's scope. Load more must
   remain available when the raw provider has another page. Search and edit an
   account, assign a checkpoint, and verify role and step-up/window revocation checks.
4. **Slow workflow delivery.** Use the outbox test fixture to stall a workflow RPC.
   Presence must continue independently. Retry and cancel deliveries, expire a
   lease, and restart the worker. Verify that revisions follow lane order and
   workflow starts precede signals. Repeat during Temporal startup failure.
5. **Sign-in availability ordering.** Hold the synthetic availability response open
   while completing sign-in. Authentication must finish independently. Set a newer
   offline return time before releasing the delayed reset and verify it survives.
   Ordinary logout still clears the app session and attempts required provider revocation.
6. **Large CSV exports.** Export fixture rows with Unicode, quoted multiline text,
   and spreadsheet-formula prefixes. Check unchanged columns, order, escaping, and
   BOM/newlines. Cancel while formatting and exceed the UTF-8 byte cap. The UI must
   remain responsive and canceled/oversized exports must not download a partial file.
7. **Bounded retention and evaluator parity.** In the database test fixture, seed
   501 expired eligible records plus recent records and alert/manual-review evidence.
   A dry run counts candidates. Applied maintenance uses multiple bounded transactions
   and preserves evidence. Compare projected evaluator input with legacy rich documents
   for attendance, breaks, denied scans, visitors, and deduplicated existing alerts.
