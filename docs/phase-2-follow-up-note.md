# Phase 2 follow-up changes

**Comparison baseline:** Phase 2 branch commit `ee79c2c` (9 October 2026) versus the current working tree. This note excludes the organization zone and checkpoint redesign. The listed workspace changes are not all committed.

## Authentication and gateway

- Added an app-hosted sign-in form and recovery flow integrated with Keycloak, and strengthened session refresh, logout, callback, and step-up authentication handling.
- Expanded delegated Keycloak user administration and made administrator reauthentication windows persistently lockable and revocable.
- Extended Kong with Redis-backed ingress and identity-aware rate-limit plugins, stricter route and request boundaries, correlation IDs, and terminal certificate identity handling.

## Backend reliability and policy

- Added a durable outbox so committed application changes can reliably dispatch Redis notifications and Temporal commands; added recovery and diagnostics for pending delivery.
- Strengthened visitor and manual-review approval workflows around deadlines, retries, late decisions, and database-authoritative outcomes.
- Added continuous visitor-overstay evaluation and cross-building scan alerts. Strengthened persisted alert reviews, warning resets, and critical entry holds.
- Expanded request admission, behavior cooldowns, query and response bounds, database timeouts, and live-stream capacity controls.

## Data, reporting, and operations

- Expanded movement search, analytics, pagination, and CSV exports, with supporting indexes and bounded read budgets.
- Added PostgreSQL provisioning and migration work, separate Redis access controls, and hardened Compose service/network configuration.
- Added Keycloak setup, recovery, and audit tooling; Temporal schema and namespace initialization; and optional Prometheus-based observability configuration.

## Frontend and verification coverage

- Refined the terminal, registry creation flows, employee profiles, alerts, permissions, user management, analytics, logs, and report builder.
- Improved offline scan queue handling and live-update refresh behavior.
- Added or expanded focused tests across authentication, gateway limits, workflows, outbox delivery, access decisions, reporting, data bounds, and recovery paths.

This is a summary of the repository changes relative to the stated baseline; it does not claim that every added test or operational procedure has been run.
