# Release evidence — 2026-11-12

## Scope and release status

This evidence describes the local `phase3` working tree based on `127d659839a02916b63c3be1fa5887190862359c`, with uncommitted files. It is not tied to a clean, immutable commit. Verification host: Windows/PowerShell, Node `v22.14.0`, Docker Desktop `4.99.0`, Engine `29.9.3` (API `1.56`), Compose `5.7.0`. No GitHub Actions run is attached to this snapshot.

**Decision: not release-ready.** Configured Trivy gates reject several current images, no hosted CI run is attached to a clean candidate, and browser acceptance has not been recorded. Local checks below are reproducible evidence, not an overall release approval.

## Check results

| Check | Result | Details |
| --- | --- | --- |
| Clean dependency install (`npm ci`) | Pass | 57 packages installed; the lockfile was used and npm reported zero vulnerabilities. |
| Frontend and app-owned auth tests (`npm test`) | Pass | 258 passed, 0 failed, 0 skipped. |
| TypeScript (`npm run typecheck`) | Pass | Completed successfully. |
| Production frontend build (`npm run build`) | Pass | Next.js 15.5.29 build completed. |
| npm dependency audit (`npm audit --audit-level=moderate`) | Pass | Zero reported vulnerabilities. |
| App auth HTTP/security checks | Pass | `npm run test:auth:http`, `npm run test:auth:password-updates`, and `node scripts/test-security-http.mjs` passed with synthetic fixtures. |
| PostgreSQL provisioning/infrastructure suite | Pass on PostgreSQL 17 | 15 tests passed in 11.431 seconds in a disposable project using a temporary static-subnet overlay. |
| Kong gateway suite | Pass | 27 tests passed. |
| Keycloak provider suite | Pass on Keycloak 26.8.2 | All 21 real-provider tests passed. |
| Temporal compatibility and recovery checks | Pass with current locked SDK | All 3 replay/recovery tests passed in 93.915 seconds with Temporal Python SDK 1.36.0 against the isolated Temporal Server 1.32.2 fixture. The separate schema guard/self-test/resume/verification and UI proxy checks also passed. |
| Live network boundary | Pass | Positive controls worked; the web-facing probe could not reach isolated internal services. |
| Current-tree full backend PostgreSQL/Redis suite | Pass with skips | 700 tests ran in 1,101.587 seconds: 697 passed, 0 failed, 0 errors, and 3 skipped because `TEST_TEMPORAL_HOST` was unset. All three skipped Temporal cases passed separately against the isolated Temporal Server 1.32.2 fixture with SDK 1.36.0. |
| Current-tree zone-scope regression module | Pass | 7 tests passed in 19.597 seconds using a fresh disposable PostgreSQL/Redis Compose project. It exercises scoped alert list, subject history, alert export, registry bundle, master-admin visibility, and the affected analytics paths. |
| Current-tree API container build | Pass | `docker compose build python-api` completed using locked Temporal Python SDK 1.36.0. The running `in-out` API container remains on a different image revision. |
| Current-tree app image build | Pass with warning | `docker build -t inout-app-security .` completed. Next.js reports a `jose` Edge Runtime `CompressionStream` compatibility warning; the build succeeds. |
| Redis security-limit tests | Pass | All 6 `SecurityLimitHTTPTests` passed with the isolated revocation Redis client and no resource warnings. |
| Core workflow evidence | Pass in backend integration tests | Synthetic employee/visitor scans, visitor approval and rescan, hardware custody, scope enforcement, restrictions, retries, exports and workflow recovery have existing integration cases. See the scenario/test-reference table below. This is API/database integration evidence, not a live browser run. |
| Live browser acceptance | Not run | A signed-in synthetic browser session has not been used to record the acceptance matrix. |
| GitHub Actions on the final clean candidate | Not attached | This local dirty tree has no corresponding workflow run URL. |

The test stacks use isolated Compose project names and disposable data. The normal `in-out` and `tokens` stacks are not reset by these checks. The full backend suite skips `test_outage_recovery_survives_worker_restart_and_preserves_committed_decisions`, `test_pre_authority_signal_histories_replay_without_new_markers`, and `test_pre_recovery_success_and_terminal_failure_histories_replay` when `TEST_TEMPORAL_HOST` is unset. All three cases pass separately against the disposable Temporal fixture with SDK 1.36.0. The database test fixture assigns its visible synthetic alert to `cp-main`. The focused zone-scope, Temporal, infrastructure, and Keycloak projects use isolated data and do not access operational app data.

### Current alert scope and analytics behavior

Zone-admin alert access is scoped by the alert's explicit zone or checkpoint when one is present. Subject visibility is used only for alerts without a location, and alerts without a location or subject are limited to master-admins. The same scope applies to `/v1/alerts`, subject history, `/v1/exports?source=alerts`, and `/v1/registry/bundle`. The test uses synthetic zone-admin `only-a`, zones A/B, shared subject `p1`, checkpoints `cp-main`/`server-room`, and alert IDs `local-checkpoint`, `foreign-checkpoint`, `foreign-zone`, `foreign-subject`, `retained-local`, `retained-foreign`, and `unbound`. Test reference: `test_analytics_zone_security.AnalyticsZoneDatabaseTests.test_zone_admin_alert_lists_and_exports_respect_explicit_checkpoint_scope`.

The dashboard aggregate query explicitly cross-joins its independent totals CTEs; the focused analytics tests pass without a cartesian-product warning. The locked Temporal Python SDK is 1.36.0. All three workflow replay tests pass against Temporal Server 1.32.2, using the existing workflow protocol.

### Synthetic API acceptance references

These are existing integration tests, not a new test framework. Each uses fixture identities and checks durable state/history after API calls. Movement and request IDs are generated during the tests and asserted by the test code; the test runner does not emit those runtime IDs into its log.

| Scenario | Status | Test reference | Synthetic identity, role and record reference |
| --- | --- | --- | --- |
| Employee entry, retry, exit, presence and history | Pass | `test_database.DatabaseTests.test_browser_scan_retry_hardware_and_movement_filters` | Employee `p1` / Alice; operator `test-operator`; checkpoint `cp-main`; generated movement IDs are asserted in history/counts. |
| Visitor pending/denied scan, admin approval, one rescan, exit and expiry | Pass | `test_database.DatabaseTests.test_manual_approval_requires_denied_scan_and_rescan_leaves_first_denial_intact`; `test_manual_approval_durations_gate_one_rescan_and_retries_do_not_extend_the_window`; `test_expired_manual_approval_cannot_start_entry_but_allows_exit_after_a_valid_rescan` | Barcode `visitor-rescan-proof` and generated `duration-*` / `expired-manual-window`; operator `test-operator`, admin `test-admin`; request and movement IDs are asserted at runtime. |
| Unknown barcode, required operator note, admin decision, retry deduplication | Pass | `test_database.DatabaseTests.test_manual_unknown_entry_persists_and_exits_once`; `test_manual_denial_reclassifies_original_scan_in_history_and_analytics` | Barcode `new-visitor` / `unknown-manual-denial`; operator `test-operator`, admin `test-admin`; original denied event and review request IDs are asserted. |
| Hardware with matching carrier and wrong-carrier rejection | Pass | `test_database.DatabaseTests.test_direct_hardware_scan_and_custody_denial`; `test_security_workflows.SecurityWorkflowTests.test_matching_exit_still_rejects_wrong_custody_or_new_hardware` | Hardware `h1`, employee `p1` / Alice; zone admin `test-admin`; generated request/event references are asserted in responses and persisted state. |
| Operator checkpoint spoofing and admin-only routes | Pass | `test_database.DatabaseTests.test_account_checkpoint_rejects_spoofing_before_scan_or_review`; `test_terminal_assignments.TerminalAssignmentTests.test_physical_certificate_identity_cannot_select_another_checkpoint` | Operator `operator`; registered `server-room`, forged `cp-main`; unauthorized writes are rejected before movement/review creation. |
| Zone-admin cross-zone read protection | Pass | `test_analytics_zone_security.AnalyticsZoneDatabaseTests.test_scoped_details_summaries_and_aggregates_exclude_other_zone`; `test_zone_admin_alert_lists_and_exports_respect_explicit_checkpoint_scope` | Zone admin `only-a` is limited to zone A; foreign subject and location records are absent or return 404. Alert export and alert subject history are separately tested below. |
| Critical restriction, acknowledgement, explicit reset | Pass | `test_critical_entry_restrictions.CriticalEntryRestrictionDatabaseTests.test_acknowledgement_keeps_hold_and_manual_pass_waits_for_explicit_release` | Employee `p1`, operator `test-operator`, admin `test-admin`; acknowledgement does not release the hold; authorized release requires a reason and is audited. |
| Offline capture, retry and reassignment boundaries | Pass | `test_database.DatabaseTests.test_missing_offline_receipt_is_reconciled_without_movement_history`; `test_deleted_subject_identity_cannot_rebind_an_offline_scan`; terminal assignment cases | Operator `test-operator`; subject `p1` and barcode `reused-offline-barcode`; no offline authorization or duplicate movement is created. |
| Invalid windows, duplicate barcode and expired session | Pass | `test_database.DatabaseTests.test_invalid_manual_durations_leave_pending_and_applied_requests_unchanged`; `test_registration_approvals.RegistrationApprovalTests.test_duplicate_barcode_rolls_back_registration_without_publication`; `test_auth.AuthenticationTests.test_invalid_issuer_audience_expiry_and_id_token_are_rejected` | Synthetic visitor/duplicate-barcode and expired-token fixtures; failures leave no partial identity or grant. |
| Zone-admin alert reads, subject history, exports and registry bundle | Pass in current-tree focused module | `test_analytics_zone_security.AnalyticsZoneDatabaseTests.test_zone_admin_alert_lists_and_exports_respect_explicit_checkpoint_scope` | Zone-admin `only-a` (zone A); shared subject `p1`; `local-checkpoint` and `retained-local` remain visible; B/server-room, foreign-subject, and unbound alerts are hidden. Master-admin retains cross-zone and unbound visibility. Synthetic fixture IDs are asserted; no production records were used. |
| Export filtering, row caps and record parity | Pass | `test_exports.ExportTests.test_virtual_hardware_history_and_parent_notes_have_export_parity`; `test_exports.ExportTests.test_registry_export_is_complete_and_row_and_byte_caps_reject_before_success`; zone-admin alert export covered by the current-tree test above. | Synthetic `h1` hardware and employee registry rows; selected export matches stored history and limits fail before success. |
| Restart/recovery | Pass against isolated Temporal fixture | `test_approval_recovery_temporal.ApprovalRecoveryTemporalTests.test_outage_recovery_survives_worker_restart_and_preserves_committed_decisions`; `test_pre_authority_signal_histories_replay_without_new_markers`; `test_pre_recovery_success_and_terminal_failure_histories_replay` | Synthetic workflow/request history; the durable decision survives a worker restart and the two older histories replay. These cases are skipped by the broad backend suite when no Temporal endpoint is configured. |

## Current HIGH/CRITICAL image scan results — 12 November 2026

Image scans use Trivy 0.69.3 with the workflow policy `HIGH,CRITICAL`, `ignore-unfixed=false`, and failure on any finding. The scanner database was current for the 12 November 2026 scan. Counts are package/advisory occurrences in the listed local image tags; `fixed` means the scanner database lists a patched version. These results describe the local images, not necessarily the currently running containers.

| Image | Result | High | Critical | Fixed available | No fix listed |
| --- | --- | ---: | ---: | ---: | ---: |
| `inout-app-security:latest` | Pass | 0 | 0 | 0 | 0 |
| `inout-redis:7` | Pass | 0 | 0 | 0 | 0 |
| `inout-kong:3.9.3` | Pass | 0 | 0 | 0 | 0 |
| `inout-postgres:17` | Pass | 0 | 0 | 0 | 0 |
| `quay.io/keycloak/keycloak:26.8.2` and `inout-keycloak:26.8.2` | Fail | 6 | 0 | 1 | 5 |
| `temporalio/server:1.32.2` | Fail | 1 | 0 | 1 | 0 |
| `temporalio/ui:2.56.1` | Fail | 20 | 0 | 20 | 0 |
| `inout-temporal-maintenance:1.32.2` and `inout-temporal-maintenance-fixture:latest` | Fail | 48 | 0 | 1 | 47 |
| `in-out-python-api:latest` and freshly built backend test image | Fail | 47 | 0 | 0 | 47 |

The image threshold passes for PostgreSQL, Redis, Kong and the app runtime. It fails for Keycloak, Temporal server/UI/maintenance and backend API/test images. Keycloak 26.8.2 has 6 HIGH findings: one lists a Guava 33.7.2 fix, and five list no fix. Temporal Server 1.32.2 has one HIGH with a fix listed. UI 2.56.1 has 20 HIGH with fixes listed, but UI 2.57.0 and later require API v1.64 and are incompatible with OSS Server 1.32.x ([Temporal UI releases](https://github.com/temporalio/ui/releases), [Temporal CLI release notes](https://github.com/temporalio/cli/releases)). The maintenance image has 48 HIGH findings, one with a fix listed and 47 without; backend runtime/test images have 47 HIGH findings and no listed fixes. The backend images have 0 CRITICAL findings. This local scan is not a hosted CI result.

## Account features that remain previews

`frontend/components/account/AccountCenter.tsx` clearly labels non-password account controls as previews. Exclude these from claims of completed identity functionality:

- Profile edits, locale settings and required-action checklist use local/sample data.
- Email verification does not send a message.
- Authenticator/MFA enrollment and recovery codes do not create usable credentials.
- Security key/passkey registration does not create a browser credential.
- Credential naming/removal controls only change sample data.
- Identity-provider selection/linking is not implemented as an account control.

Password changes are implemented. The controls listed above remain previews.

## Custom Keycloak extension

The app-managed authentication provider source is `keycloak/providers/src/main/java/io/inout/keycloak/InteractionResource.java`, with factory/registration in `InteractionProviderFactory.java` and the service descriptor under `META-INF/services`. `keycloak/Dockerfile` compiles it against the JARs from the Keycloak runtime image. The provider is coupled to **Keycloak 26.8.2** and uses internal Authentication SPI APIs. Its protocol is `inout-app-interactions-v1`, version `1`.

Rebuild with `docker compose build keycloak` using `KEYCLOAK_VERSION=26.8.2`. Run the isolated real-provider compatibility suite and cleanup:

```powershell
docker compose -p inout-keycloak-test -f keycloak/compose.test.yaml run --build --rm tests
docker compose -p inout-keycloak-test -f keycloak/compose.test.yaml down --volumes
```

All 21 provider tests pass against Keycloak 26.8.2. Delegated Admin REST tokens use the built-in `kc-admin-api` scope and the realm Admin API audience required by Keycloak. See [the Keycloak 26.8.2 upgrade guide](https://www.keycloak.org/docs/26.8.2/upgrading/) and the [provider deployment notes](app-managed-password-plan.md).

## Open findings, owners and deployment decisions

The repository does not define named maintainers; accountable owners below are engineering roles. The release coordinator should assign individual names in the handoff.

| Finding | Owner | Decision |
| --- | --- | --- |
| Current-tree full backend suite passed locally, but this working tree is uncommitted and there is no matching hosted CI run. | Release coordinator | Attach a hosted run to the reviewed clean commit before release; do not treat this local suite as hosted CI evidence. |
| Keycloak 26.8.2 has 6 HIGH findings (1 fix listed, 5 without a fix). | Identity/security maintainer | Keep the extension on its tested 26.8.2 API. Hold identity rollout until a compatible vendor patch or documented risk acceptance; do not replace internal Keycloak libraries ad hoc. |
| Temporal Server 1.32.2 has 1 HIGH finding; maintenance has 48 HIGH, 1 fix listed and 47 without fixes. | Workflow/infrastructure maintainer | Hold workflow-image promotion until compatible patched vendor images are available or risk is formally accepted. Keep server 1.32.2 while UI 2.57+ requires a newer incompatible API. |
| Temporal UI 2.56.1 has 20 HIGH findings with fixes listed, but UI 2.57+ is incompatible with Server 1.32.x. | Workflow/infrastructure maintainer | Hold UI promotion pending a vendor-fixed UI compatible with the retained Server version; do not upgrade UI alone. |
| Backend API/test images have 47 HIGH findings with no fix listed and 0 CRITICAL findings. | Backend/security maintainer | Hold backend image promotion pending upstream fixes or documented risk acceptance. |
| A fresh-clone installation has not been performed and recorded by another engineer. | Receiving engineer / onboarding owner | Run the documented first-install flow in a separate clone and Compose project, then attach machine, revision, commands, and entry/exit result. |
| Backup/restore rehearsal has not proven login and named person, movement, permission, presence, and pending-workflow continuity; encrypted off-host retrieval is also unproven. | Database/recovery owner | Complete the remaining isolated restore checks and record synthetic references without credentials before handoff sign-off. |
| The actual Nivetti public DNS names and TLS host have not been supplied or verified. | Deployment owner | Keep shared production deployment pending; replace example hosts and verify the HTTPS flow on the agreed host before routing users. |
| Live browser acceptance has not been recorded; integration tests assert generated IDs but do not save literal runtime IDs in the evidence. | Application acceptance owner | Hold the browser-acceptance sign-off until a synthetic operator/admin browser run records the movement/request IDs requested by the acceptance checklist. |
| No GitHub Actions run is attached to a clean final candidate. | Release coordinator | Do not release from this dirty checkout. Attach the workflow URL and concise results for the reviewed clean commit before release. |

## Reproduction and handoff

The primary workflow is [.github/workflows/verify.yml](../.github/workflows/verify.yml). It includes frontend, backend, gateway, infrastructure/network, identity, Temporal, dependency-audit and image-scan jobs. Use its commands on a clean candidate checkout; retain the per-job output and attach the run URL. Include pass/fail/skip totals and these unresolved findings. This document is the local evidence record, not a substitute for that final CI run. The repository does not list individual maintainers, so the owners above are assigned by engineering responsibility; the release coordinator must map each role to a named receiving engineer.

Keep Keycloak client secrets, passwords, tokens and dump contents out of logs and handoff evidence. Do not count account-preview controls, unrun browser cases, skipped tests or failing image scans as passed functionality.
