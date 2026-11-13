# Engineer handoff — 12 November 2026

## Snapshot and decision

Reviewed branch: `phase3`, base commit `127d659839a02916b63c3be1fa5887190862359c` (same as `origin/phase3` at review). The working tree contains uncommitted changes, so this snapshot is not a release candidate and has no matching hosted CI run.

**Deployment decision: not ready for shared production.** The local Compose installation is available, but the actual Nivetti host/DNS/TLS configuration has not been supplied or exercised. Image security gates have unresolved HIGH findings. Live browser acceptance, second-person onboarding, and a complete restore proof are also outstanding. Do not present these as passed.

## Run a fresh local installation

Prerequisites: Windows/macOS Docker Desktop or Linux Docker Engine with Compose **2.24+**, Node.js **22.12+** with npm, and enough disk/memory for the container images. From a fresh clone, run in PowerShell, Terminal, or a Linux shell:

```text
npm run setup:prepare
docker compose up --build -d --wait
npm run keycloak:prepare
```

`setup:prepare` runs the self-contained `scripts/setup-prepare.mjs`: it runs `npm ci`, creates `.env` from `.env.example` only when missing, and fills blank generated secrets without printing them. Review `.env` before starting services. It does not reset an existing Compose database volume; use a separate clone/folder and a unique `COMPOSE_PROJECT_NAME` for an onboarding rehearsal. Do not reuse an operational project to simulate a new install.

The bootstrap Keycloak administrator is created when the Keycloak database is first initialized and is the account used by maintenance scripts. Keep its credentials in `.env` and update them there if its Keycloak password changes. A human must create the first `inout` realm user, assign `master-admin`, and then sign in. To prepare scanning, use **Manage users** as master-admin to assign the operator an active checkpoint in an authorized zone; save, sign in as that operator, and verify `/terminal` displays the assigned checkpoint. Zoho setup requires the Zoho client credentials and matching redirect URI. Demo fixtures are optional; their manual destructive steps are in the README.

## Evidence map

| Area | Current evidence | Status / next proof |
| --- | --- | --- |
| Handoff docs and links | README and this handoff link to current setup, shared deployment, workflow, recovery, and release evidence docs. The stale readiness claim is corrected: the API uses a four-second overall deadline. | Recheck the links when editing these docs. |
| Clean install | Cross-platform manual steps, exact Node/Compose minimums, secret generation, first administrator creation, and checkpoint assignment are documented. | A separate clone can be run locally, but another engineer must perform and record the onboarding acceptance before claiming the “by someone other than the author” criterion. |
| Shared HTTPS deployment | `compose.shared.yaml` adds Caddy in front of the existing services; app, identity, callback/session origins and private service boundaries are documented. | Example hostnames only. Replace with the actual Nivetti names and verify HTTPS login, refresh, logout, temporary-password setup, scan, approval, and persistence on that host. Until then, shared deployment is pending. |
| Core workflows | The current-tree full backend suite passed 700 cases: 697 passed and 3 Temporal cases were skipped because no endpoint was configured; those three passed separately against a disposable Temporal fixture. The zone-scope regression module passed 7/7. | No signed-in browser/API acceptance record with literal movement/request IDs is available. See the [dated evidence](release-evidence-2026-11-12.md) for test identities and exact references. |
| Backup and restore | [Coordinated backup/restore procedure](backup-restore.md) includes stopped-writer capture, separate fresh restore storage, roles, all three databases, checksums, service replay, and rollback. | The 11 November rehearsal matched schema/table and aggregate counts and restored services. It did not prove app login or specific person/movement/permission/presence/pending-request continuity, and encrypted off-host retrieval was not tested. Repeat those checks before handoff sign-off. |
| CI and security | [Release evidence](release-evidence-2026-11-12.md) records current local checks, skips, preview controls, image findings, and owners/decisions. PostgreSQL, Redis, Kong and app images pass the refreshed local scan; the critical backend zip finding was removed by the SDK update. | No hosted run exists for a clean final commit. Keycloak, Temporal server/UI/maintenance and backend images still fail the configured Trivy threshold. |
| App-managed Keycloak authentication | [Extension notes](app-managed-password-plan.md) identify its source, Keycloak 26.8.2 coupling, protocol `inout-app-interactions-v1` version 1, build and real-provider compatibility commands. | All 21 provider tests passed on the refreshed 26.8.2 image. Temporal Python SDK 1.36.0 also passed the 3 existing replay/recovery tests against Server 1.32.2. Keep the Keycloak protocol unchanged this week. |

Account profile, email, MFA enrollment, passkeys, recovery codes, locale, and identity-provider account controls remain labelled previews. Password changes are implemented. Do not claim preview controls as completed identity features.

## Operations

For local service status and logs, use `docker compose ps -a` and `docker compose logs --tail=200`. Start/update with `docker compose up --build -d --wait`; stop without deleting data with `docker compose stop`. Do not use `down -v` on an operational project. For public HTTPS, recovery, or backup work, follow the linked specialist guides and retain the exact code/image/configuration revision with the evidence.

## Release gate

The receiver should treat a check as complete only when its result is attached to the exact final commit. Before release, obtain a clean hosted CI run, close or formally accept the image findings, record the named receiving owners, run the browser/API acceptance matrix with synthetic data, complete a fresh-clone onboarding by another engineer, and finish the isolated restore checks including login and the named synthetic records. Until then, the release decision remains **hold**.
