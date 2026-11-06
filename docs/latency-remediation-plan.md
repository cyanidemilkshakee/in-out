# Latency remediation

## Scope and safeguards

Preserve the current visual design, authorization, quota enforcement, scan evidence,
manual-review semantics, event replay, Temporal, and every existing service. Do not
access Daybreak or send test traffic to the running application. Use isolated tests
and dedicated test fixtures. Existing working-tree documentation is unrelated.

## Already authorized implementation

- Preserve unchanged state references for metadata-only live events and remove quadratic
  occupancy lookup work without changing manual finalization or replay guards.
- Use bounded refresh scheduling and stable terminal SSE connections, including
  explicit recovery after snapshot-required frames.
- Remove redundant reads/authorization calculations within a request, preserving one
  authoritative check and all necessary transaction locks.
- Add opt-in lean read flags alongside the default contracts.
- Improve frontend reference lookups, request cancellation, catalog reuse, and timer
  isolation while retaining layout and accessible controls.
- Keep synchronous authentication/session/revocation checks and remove redundant BFF
  preflights only where the operation independently enforces the same condition.
- Validate with frontend tests/build and backend tests. Run PostgreSQL fixtures only
  in the dedicated test environment if available.

## A. Focused interactive reads (approved and implemented)

Replace the Permission Manager's all-subject/all-permission snapshot with independently
paginated directory and pending-permission sections. Use bounded server-side search
for subject pickers and direct subject lookup for links outside the current page.
Preserve the existing paragraph layout and every request type. Old read contracts
remain available while callers migrate. Administrative user management uses its
existing backend paging to show the first results promptly.

Alerts retain global totals and rule controls while loading subject warning details
on demand. Chart consumers request aggregate-only responses. Export consumers keep
the existing columns, completeness checks, authorization, and byte/row limits.

Verify bounded reads for the first results, complete search across the authorized
scope, and correct pagination, deep links, decisions, and subject pickers.

## B. Independent durable delivery (approved and implemented)

Keep the database outbox, worker service, Redis, and Temporal. Separate presence
delivery from workflow delivery so a slow Temporal RPC cannot block live updates.
Retain bounded concurrency, durable leases/retries, revision replay, and workflow
start-before-signal ordering. Dispatcher startup must not depend on a successful
Temporal connection. A wake-up hint can supplement polling, with the durable outbox
as the recovery source.

Verify that presence dispatch proceeds during a Temporal outage, retries recover
failed delivery, starts precede workflow signals, and clients replay events through
snapshot refreshes and reconnects.

## Implementation notes

- Permission directory and pending queues page independently at 25 rows. Selected
  subjects/requests resolve outside the current page. User management loads 25
  provider records at a time with explicit continuation, including empty scoped
  pages. Server-side scope checks still precede presentation.
- Metadata-only events preserve array/analytics references. Refresh scheduling has
  a maximum wait and queues a follow-up without invalidating every slow in-flight
  read. Terminal SSE keeps its connection across ordinary snapshots and reconnects
  when recovery requires a fresh cursor. Master-only screens omit the alert stream.
- Ordinary alert lists opt out of the global directory. Aggregate chart reads skip
  raw samples. CSV clients opt into lean reads and chunked, cancellable formatting
  with exact UTF-8 limits, existing columns, and spreadsheet formula escaping.
- Registry pages reuse joined relationships and the employee overview's activity
  read. The page retains the final pre-window transition for overnight shifts and
  breaks. Permission decisions, registration, checkpoint validation, and user
  management avoid redundant work.
- Presence and workflow delivery have independent ordered lanes. An unavailable
  Temporal worker retries independently. Pending heads cannot be bypassed during
  lease/backoff, preserving revision and workflow ordering.
- Sign-in availability reset uses Next.js post-response work. A private ordering
  timestamp in existing profile settings prevents a delayed reset from undoing a
  newer explicit offline choice. Authentication,
  step-up checks, and logout revocation remain synchronous.
- Retention application uses 500-row transactions and rechecks evidence exclusions.
  Scheduled evaluation projects canonical movement columns without loading full
  scan JSON. Rule semantics and the evaluation cadence remain unchanged.
- Server-Timing reports cumulative upstream work and overlapping wall time
  separately. Repeated date formatting reuses fixed-locale/time-zone formatters.

Only source and isolated test fixtures were changed. No deployed data was migrated,
no cleanup was executed, and no running deployment or Daybreak was accessed.
HTTP regression fixtures use isolated applications with synthetic upstreams.

## Conditional changes requiring evidence before a further proposal

Daily activity/analytics summaries, a movement-asset projection, typed manual-grant
fields, removal of duplicate JSON presence storage, distributed refresh coordination,
additional API workers, larger database pools, and cursor replacements require
current measurements and a concrete migration/capacity plan. Do not add these solely
because they appeared as growth recommendations in the audit.

Measure initial navigation and gateway timing before changing the Registry or
dashboard rendering sequence, or pooling identity callback connections. A change
to live-event payloads or offline configuration storage needs separate review of
scope, replay, and compatibility.

## Measurement

The committed October 16 results measured synthetic PostgreSQL handlers. Track
query counts and bounded payloads in tests. Measure p50/p95/p99, connection/lock
waits, browser long tasks, request fanout,
and commit-to-visible-update latency before claiming runtime speedups. Keep parallel
upstream work distinguishable from wall-clock request duration.

## Verification

- The production Next.js build passed.
- All 257 frontend regression tests passed.
- The backend suite on isolated Python 3.14.7 with the locked dependencies found
  679 tests. It passed 404 and skipped 275 integration tests.
- The synthetic sign-in/step-up HTTP suite passed, including sign-in while
  the availability response is held open and persisted-window denial at the
  operation endpoint.
- The synthetic password-update and HTTP security suites passed.
- Scoped `git diff --check` passed.

Docker was stopped. PostgreSQL/Redis/Temporal integration tests and fresh database
or end-to-end benchmarks remain unexecuted. The live local Keycloak account check
stopped at connection refusal on port 1009 before creating any fixture account.
