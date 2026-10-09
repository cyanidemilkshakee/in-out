"""
PermissionOverrideWorkflow — Human-in-the-loop override approval.

Lifecycle:
  1. Started when POST /v1/permission-requests (type=manual_override) is received.
  2. Waits up to 10 minutes for an `admin_decision` Signal.
  3a. Signal received → runs approve_override or deny_override activity.
  3b. Timeout → runs auto_deny_override activity.
"""
from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from workflows.activities import (
        approve_override,
        deny_override,
        auto_deny_override,
    )

_RETRY = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=5))
MANUAL_REVIEW_TIMEOUT_MINUTES = 10


@workflow.defn
class PermissionOverrideWorkflow:
    def __init__(self) -> None:
        self._decision: Optional[dict] = None  # {"decision": "approved"|"denied", "admin_id": ..., "reason": ...}
        self._status: str = "pending"

    @workflow.run
    async def run(self, request_id: str) -> str:
        # Wait up to 10 minutes for a Signal.
        try:
            await workflow.wait_condition(
                lambda: self._decision is not None,
                timeout=timedelta(minutes=MANUAL_REVIEW_TIMEOUT_MINUTES),
            )
        except asyncio.TimeoutError:
            self._status = "auto_denied"
            await workflow.execute_activity(
                auto_deny_override,
                request_id,
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=_RETRY,
            )
            return "auto_denied"

        # Process the admin decision.
        decision = self._decision["decision"]
        admin_id = self._decision.get("admin_id", "unknown")
        reason = self._decision.get("reason", "")

        if decision == "approved":
            self._status = "approved"
            await workflow.execute_activity(
                approve_override,
                args=[request_id, admin_id, reason],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=_RETRY,
            )
        else:
            self._status = "denied"
            await workflow.execute_activity(
                deny_override,
                args=[request_id, reason],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=_RETRY,
            )
        return self._status

    @workflow.signal
    async def admin_decision(self, decision: str, admin_id: str = "", reason: str = "") -> None:
        """Signal sent by the admin when they approve or deny the override."""
        if self._decision is None:  # only first signal counts
            self._decision = {"decision": decision, "admin_id": admin_id, "reason": reason}

    @workflow.query
    def current_status(self) -> str:
        """Query the current workflow status without interrupting it."""
        return self._status
