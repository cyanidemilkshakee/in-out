# IN / OUT — Stakeholder Feedback and Requirements

## Executive summary

The next version should move from a movement-recording prototype to a security operations system with four strong foundations:

1. A rule-driven alert engine with categories, severity, ownership, and feedback.
2. Granular permissions and approval workflows for visitors, gates, people, and hardware.
3. Immutable barcode, custody, movement, and audit histories.
4. Time-first search, reporting, and operational views for both operators and administrators.

## Current alert behavior

Alerts are currently seeded mock records. Their `critical`, `high`, or `medium` severity is manually assigned in the sample data. The application can acknowledge or resolve an existing alert, but it does not yet create alerts from scan events or calculate severity.

This means the next phase needs an alert-rule engine, not only an alert form.

---

## 1. Security and alert system design

### 1.1 Where alerts should live

Do **not** move operational alerts entirely into Permission Management. These are separate concepts:

- **Permission Management** defines who or what is allowed, at which checkpoint, during which time window, and who may approve exceptions.
- **Alert Policies** define which security conditions create alerts and how severity is calculated. Only authorized administrators should configure these policies.
- **Alert Center** is the live operational queue where operators and administrators investigate, acknowledge, assign, escalate, and resolve alerts.

Recommended navigation:

- **Operations:** Dashboard, People Movements, Hardware Movements, Alert Center
- **Access & Permissions:** Roles, Checkpoints/Gates, Visitor Approvals, Hardware Approvals
- **Security Configuration:** Alert Policies, Notification Rules
- **Audit & Reports:** Audit Log, Calendar, Scheduled Reports

### 1.2 Alert categories

Every alert must have a category so it can be routed, filtered, reported, and assigned correctly.

| Category | Examples |
|---|---|
| Access violation | Unknown barcode, restricted person, expired visitor, unauthorized zone |
| Presence anomaly | Scan-in while already inside, scan-out without a recorded entry, possible missed scan |
| Tailgating | Person count and scan count mismatch, turnstile/sensor event without a matching scan |
| Volume anomaly | 100 entries in 30 minutes, unusual denial burst, activity outside normal hours |
| Hardware custody | Unauthorized carrier, unapproved exit, restricted asset, missing return |
| Credential/barcode | Duplicate barcode attempt, revoked barcode use, lost credential use |
| Checkpoint/system | Scanner offline, sync conflict, clock mismatch, device tampering |
| Operational | Manual review, policy override, approval SLA breached |

### 1.3 Severity model

Severity should be calculated from **impact, confidence, and urgency**, with an optional policy override.

| Severity | Definition | Example response |
|---|---|---|
| Critical | Active or highly probable threat with major safety/security impact | Immediate operator action and security escalation |
| High | Strong policy violation or high-value risk requiring rapid investigation | Assign and acknowledge within a short SLA |
| Medium | Suspicious or inconsistent activity that needs review | Review during the current shift |
| Low/Informational | Operational issue or weak signal with limited immediate risk | Track for trend analysis or routine follow-up |

Example scoring inputs:

- Subject risk: restricted, expired, unknown, or previously flagged.
- Asset risk: restricted asset, high-value hardware, or overdue return.
- Checkpoint sensitivity: public entrance versus server room.
- Event pattern: one denial versus repeated attempts or a sudden volume spike.
- Time context: normal hours versus unusual or closed hours.
- Evidence confidence: logical scan inconsistency versus confirmed sensor/turnstile mismatch.

Severity must be explainable. Each alert should store the triggered rule and the factors that produced its score.

### 1.4 Automatic alert rules

Initial rule set:

| Rule | Suggested behavior |
|---|---|
| Entry-volume spike | Alert when a configurable checkpoint threshold is exceeded within a rolling time window; for example, 100 entries in 30 minutes |
| Repeated denial | Alert after multiple denied attempts by the same barcode, subject, checkpoint, or device |
| Presence mismatch | Alert when a person scans in while already marked inside, or scans out without an active entry |
| Possible tailgate | Alert on a sensor/turnstile count mismatch or an occupancy change without a scan |
| Restricted/expired access | Alert when a restricted person, expired visitor, revoked barcode, or restricted hardware is scanned |
| Unauthorized hardware exit | Alert when the carrier is not the current custodian or no exit approval exists |
| Offline risk | Alert when a checkpoint remains offline too long, accumulates too many queued events, or produces sync conflicts |
| After-hours activity | Alert on movement outside the subject’s or checkpoint’s allowed schedule |

The `100 entries in 30 minutes` example should be configurable by checkpoint, day, shift, and subject type. Later versions can compare live traffic to a historical baseline instead of relying only on a fixed global threshold.

### 1.5 Tailgating limitation and handling

Barcode scans alone cannot prove physical tailgating. They can detect a **logical presence anomaly**, such as someone scanning in while the system already considers them inside because they previously forgot to scan out.

Confirmed tailgating requires at least one physical signal, such as:

- Turnstile passage count
- Door sensor event
- People-counting sensor
- Access-control controller event
- CCTV/video analytics event

Until that integration exists, the UI should label these cases **Possible tailgating / presence mismatch**, request operator confirmation, and preserve the correction as an audited action.

### 1.6 Alert feedback and lifecycle

Operators and administrators need to provide feedback on each alert:

- Confirmed incident
- False positive
- Expected activity
- Duplicate alert
- Policy exception
- Needs escalation

Required lifecycle:

`Open → Acknowledged → Assigned → Investigating → Resolved`  
Alternative terminal states: `Dismissed as false positive` or `Merged as duplicate`.

Each update must capture actor, timestamp, comment, resolution code, and linked evidence. Feedback should first improve reports and rule tuning; automatic machine-learning changes should not be made without controlled review.

---

## 2. Permissions, approvals, and checkpoint management

### 2.1 Visitor workflow

Recommended flow:

1. The operator creates a visitor request with identity, host, purpose, validity window, and allowed zones.
2. The visitor remains `Pending approval`; the barcode is created but cannot grant entry.
3. An authorized administrator or host approves, rejects, or requests changes.
4. Approval activates the barcode only for the approved time and zones.
5. Entry, exit, expiry, revocation, and all approval decisions remain in the audit history.

Emergency overrides must require a reason and should create a security event or alert.

### 2.2 Granular operator and gate management

Permissions should be scoped by:

- Operator role and individual operator
- Assigned facility, gate, checkpoint, and zone
- Shift or time window
- Allowed subject types: employees, visitors, hardware
- Allowed actions: scan, create visitor request, correct presence, perform manual review, approve, override, synchronize
- Maximum approval level or asset value
- Terminal/device assignment

An operator should see only the gates and queues relevant to their assignment. Administrators should have an organization-wide view based on their role.

### 2.3 People and hardware association

Use an explicit **movement manifest** and **chain of custody**:

- One person movement may include multiple hardware items.
- Each item records current custodian, owner, source location, destination, purpose, expected return, and approval status.
- The association applies to that movement; ownership and permanent assignment are separate records.

Example: Santhosh brings in 10 switches. If Raju later tries to take them out, the system detects that Raju is not the current custodian. The exit should be blocked or placed in `Pending approval`, depending on policy. An authorized owner, security administrator, or asset manager must approve the custody transfer. The approval and resulting movement must be linked in the audit trail.

---

## 3. Barcode lifecycle and data integrity

### 3.1 Barcode uniqueness

- A barcode must be globally unique across people, visitors, and individual hardware within the organization/tenant.
- Every individual hardware item must have its own barcode; a model, batch, or category code cannot serve as the item identity.
- Creation must use a database uniqueness constraint, not only a frontend validation check.
- Prefixes such as `EMP-`, `VIS-`, and `HW-` improve readability, but the system must still enforce global uniqueness.

### 3.2 Barcode lifecycle

Recommended states:

`Pending → Active → Suspended / Expired / Revoked / Lost → Archived`

- Never hard-delete a barcode that has movement or approval history.
- Never silently reassign an old barcode to another subject.
- Replacement creates a new credential linked to the retired credential.
- Store issue date, issuer, activation, expiry, revocation reason, replacement, and last use.

### 3.3 Hardware after it leaves the building

An approved exit does not end hardware management. The system should retain:

- Off-site status and current custodian
- Exit event and approving authority
- Destination and purpose
- Expected return date/time
- Overdue status and reminder/escalation history
- Return scan and condition, when applicable
- Complete immutable movement history

Hardware records and barcodes should be archived, never deleted, so audits remain complete.

---

## 4. Time, logs, auditing, and reports

### 4.1 Time-first design

Time is a primary security dimension and should be present throughout the application:

- Record event time, server-received time, sync time, and correction time separately.
- Store timestamps consistently and display them in the facility’s timezone.
- Preserve the original scan time for offline events.
- Show approval deadlines, visitor validity, expected hardware return, alert age, and response SLA.
- Provide quick filters such as Today, Current shift, Last 30 minutes, Last 24 hours, and Last 7 days.
- Provide a calendar/date-time range picker on all operational pages.

### 4.2 Operator and administrator logs

Logs should be append-only and sufficiently detailed for investigations.

Operator view:

- Scans and decisions at assigned checkpoints
- Pending approvals and manual reviews
- Offline queue and sync status
- Corrections, overrides, and operator notes
- Alert actions performed during the shift

Administrator view:

- Organization-wide movement events
- Authentication and session events
- Permission, rule, checkpoint, and configuration changes
- Visitor and hardware approvals
- Alert creation, assignment, feedback, escalation, and resolution
- Barcode issue, suspension, expiry, revocation, and replacement
- Data exports and report generation

Each audit entry should contain actor, role, timestamp, terminal/device, checkpoint, action, reason, related record, and before/after values where applicable.

### 4.3 Reports

Required reports:

- Weekly and monthly movement summary
- Access denials and alert response performance
- Visitor approvals, expiries, and overstays
- Hardware exits, current off-site inventory, overdue returns, and custody transfers
- Checkpoint traffic and offline/sync health
- Operator activity and manual overrides
- Restricted and expired credential activity

Reports should support scheduled delivery, CSV/PDF export, saved filters, and drill-down to the source events.

---

## 5. UI and navigation changes

### 5.1 Movement pages

Replace a single overloaded movement table with separate sub-tabs:

- **People movements** — employees and visitors
- **Hardware movements** — asset custody, carrier, approval, and return status
- **Combined timeline** — optional investigation view linking a person and carried assets

Each tab should still support checkpoint, status, alert category, approval state, and custom date-time filters.

### 5.2 Calendar and filtering

- Add a reusable date-time range picker to dashboards, movements, alerts, people, visitors, hardware, and reports.
- Add a calendar view for audit investigation and daily/shift activity.
- Show active filter chips and provide a clear-all action.
- Allow administrators to save common filter sets.

### 5.3 Mobile tables

- Preserve complete table data on mobile using horizontal scrolling.
- Keep the first identifying column sticky where practical.
- Show a clear visual cue that more columns are available horizontally.
- Do not silently hide audit-critical columns.

### 5.4 Notifications

Improve notifications by separating them from alerts:

- **Alerts** are security cases requiring investigation and lifecycle management.
- **Notifications** inform a user about an assignment, approval request, status change, SLA, sync problem, or report completion.

The notification center should support unread counts, priority, categories, assignment, deep links to the related record, mark-as-read, and user preferences. Critical alerts should not depend only on temporary toast messages.

---

## 6. Analytics changes

Add a comparison chart with four series or segments:

- People — automatic scans
- People — manual scans
- Hardware — automatic scans
- Hardware — manual scans

The chart must respect the global date-time, checkpoint, facility, and gate filters. It should allow drill-down to the underlying movement events.

Additional useful metrics:

- Alert volume by category and severity
- False-positive rate by alert rule
- Acknowledgement and resolution time
- Presence mismatches and possible tailgating events
- Hardware custody-transfer approvals and denials
- Checkpoint traffic against configured capacity or historical baseline

---

## 7. Domain definitions

### Restricted person

A person is **restricted** when an authorized security or administrative policy intentionally blocks or limits access, even if the barcode has not expired. Restrictions may apply globally or to specific facilities, zones, checkpoints, dates, or times. Every restriction needs a reason, authority, effective window, and audit history.

### Expired person/credential

A person or credential is **expired** when a previously valid, time-bound access period has ended automatically. Typical examples are a visitor pass after its approved end time or a temporary employee credential after contract completion.

The distinction is important:

- **Restricted** means deliberately blocked by policy or decision.
- **Expired** means the approved validity period has ended.

Both should deny access by default, but they should create different alert categories, messages, workflows, and reports.

---

## 8. Recommended delivery priority

### Priority 0 — Security and data foundation

- Global barcode uniqueness and non-deletion lifecycle
- Immutable movement and audit events
- Visitor request and administrator approval workflow
- Alert categories, severity calculation, lifecycle, and feedback
- Granular operator/checkpoint permissions
- Time model and custom date-time filtering

### Priority 1 — Detection and custody workflows

- Presence mismatch and volume-anomaly rules
- Hardware manifests, custody transfer, exit approval, and return tracking
- Operator/admin audit views
- Alert and approval notifications
- Weekly/monthly reports

### Priority 2 — Advanced operations and UX

- Sensor/turnstile/CCTV integration for stronger tailgating detection
- People and hardware movement sub-tabs
- Mobile horizontal table behavior
- Calendar investigation view
- Automatic/manual comparison analytics and rule-quality dashboards

## Definition of success

The next release is successful when every access decision can answer:

1. **Who or what moved?**
2. **Where and when did it move?**
3. **Which permission and rule produced the decision?**
4. **Who approved, overrode, or corrected it?**
5. **What alert or follow-up was created?**
6. **Can the full history be reconstructed without deleting or rewriting evidence?**
