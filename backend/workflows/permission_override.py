"""
PermissionOverrideWorkflow — Human-in-the-loop override approval.

Lifecycle:
  1. Started when POST /v1/permission-requests (type=manual_override) is received.
  2. Waits up to 10 minutes for an `admin_decision` Signal.
  3a. Signal received → observes an authenticated HTTP decision in the database.
  3b. Timeout → denies only after the database's trusted deadline has elapsed.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from typing import Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from manual_review_policy import MANUAL_REVIEW_TIMEOUT_MINUTES
    from workflows.approval_recovery import execute_approval_activity
    from workflows.activities import (
        approve_override,
        deny_override,
        auto_deny_override,
    )

_RETRY = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=5))


@workflow.defn
class PermissionOverrideWorkflow:
    def __init__(self) -> None:
        self._decision: Optional[dict] = None  # {"decision": "approved"|"denied", "admin_id": ..., "reason": ...}
        self._status: str = "pending"

    @workflow.run
    async def run(self, request_id: str, deadline_at: str | None = None) -> str:
        if not workflow.patched("database-authoritative-approval-signals-v1"):
            return await self._legacy_notification_sequence(request_id)
        # An outbox retry can start late. Its trusted database deadline must
        # not become another full approval window after delivery recovers.
        deadline = (datetime.fromisoformat(deadline_at) if deadline_at is not None
                    else workflow.now() + timedelta(minutes=MANUAL_REVIEW_TIMEOUT_MINUTES))
        while True:
            timed_out = workflow.now() >= deadline
            if not timed_out:
                try:
                    await workflow.wait_condition(lambda: self._decision is not None,
                        timeout=max(timedelta(0), deadline - workflow.now()))
                except asyncio.TimeoutError:
                    timed_out = True
                # A ready predicate can win against a zero-duration timer.
                # Notifications never extend the trusted expiry schedule.
                timed_out = timed_out or workflow.now() >= deadline
            if timed_out:
                persisted = await execute_approval_activity(auto_deny_override, request_id,
                    start_to_close_timeout=timedelta(seconds=30), retry_policy=_RETRY)
            else:
                notification, self._decision = self._decision, None
                approved = notification.get("decision") == "approved"
                persisted = await execute_approval_activity(approve_override if approved else deny_override,
                    args=([request_id, notification.get("admin_id", ""), notification.get("reason", "")]
                        if approved else [request_id, notification.get("reason", "")]),
                    start_to_close_timeout=timedelta(seconds=60 if approved else 30), retry_policy=_RETRY)
            # A forged or premature signal cannot grant access, complete this
            # workflow, or suppress its eventual database-checked timeout.
            status = persisted.get("status")
            if status in {"approved", "denied"}:
                self._status = "auto_denied" if timed_out and status == "denied" else status
                return self._status
            if timed_out:
                await workflow.sleep(timedelta(seconds=30))

    async def _legacy_notification_sequence(self, request_id: str) -> str:
        """Keep old history commands while activities enforce database authority."""
        try:
            await workflow.wait_condition(lambda: self._decision is not None,
                timeout=timedelta(minutes=MANUAL_REVIEW_TIMEOUT_MINUTES))
        except asyncio.TimeoutError:
            persisted = await execute_approval_activity(auto_deny_override, request_id,
                start_to_close_timeout=timedelta(seconds=30), retry_policy=_RETRY)
            status = persisted.get("status") if isinstance(persisted, dict) else "pending"
            self._status = "auto_denied" if status == "denied" else status
            return self._status
        notification = self._decision
        approved = notification.get("decision") == "approved"
        persisted = await execute_approval_activity(approve_override if approved else deny_override,
            args=([request_id, notification.get("admin_id", "unknown"), notification.get("reason", "")]
                if approved else [request_id, notification.get("reason", "")]),
            start_to_close_timeout=timedelta(seconds=60 if approved else 30), retry_policy=_RETRY)
        self._status = persisted.get("status", "pending") if isinstance(persisted, dict) else "pending"
        return self._status

    @workflow.signal
    async def admin_decision(self, decision: str, admin_id: str = "", reason: str = "") -> None:
        """Wake the workflow to observe a decision already committed by the API."""
        if self._decision is None:
            self._decision = {"decision": decision, "admin_id": admin_id, "reason": reason}

    @workflow.query
    def current_status(self) -> str:
        """Query the current workflow status without interrupting it."""
        return self._status
