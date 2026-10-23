"""
VisitorApprovalWorkflow — Waits 30 minutes for admin to approve a new visitor.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from typing import Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from workflows.activities import approve_visitor, deny_visitor, auto_deny_visitor
    from workflows.approval_recovery import execute_approval_activity

_RETRY = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=5))


@workflow.defn
class VisitorApprovalWorkflow:
    def __init__(self) -> None:
        self._decision: Optional[dict] = None
        self._status: str = "pending"

    @workflow.run
    async def run(self, request_id: str, deadline_at: str | None = None) -> str:
        if not workflow.patched("database-authoritative-approval-signals-v1"):
            return await self._legacy_notification_sequence(request_id)
        deadline = (datetime.fromisoformat(deadline_at) if deadline_at is not None
                    else workflow.now() + timedelta(minutes=30))
        while True:
            timed_out = workflow.now() >= deadline
            if not timed_out:
                try:
                    await workflow.wait_condition(lambda: self._decision is not None,
                        timeout=max(timedelta(0), deadline - workflow.now()))
                except asyncio.TimeoutError:
                    timed_out = True
                timed_out = timed_out or workflow.now() >= deadline
            if timed_out:
                persisted = await execute_approval_activity(auto_deny_visitor, request_id,
                    start_to_close_timeout=timedelta(seconds=30), retry_policy=_RETRY)
            else:
                notification, self._decision = self._decision, None
                persisted = await execute_approval_activity(
                    approve_visitor if notification.get("decision") == "approved" else deny_visitor,
                    args=[request_id, notification.get("reason", "")],
                    start_to_close_timeout=timedelta(seconds=30), retry_policy=_RETRY)
            status = persisted.get("status")
            if status in {"approved", "denied"}:
                self._status = "auto_denied" if timed_out and status == "denied" else status
                return self._status
            if timed_out:
                await workflow.sleep(timedelta(seconds=30))

    async def _legacy_notification_sequence(self, request_id: str) -> str:
        """Old history ordering; signal activities are now read-only observers."""
        try:
            await workflow.wait_condition(lambda: self._decision is not None, timeout=timedelta(minutes=30))
        except asyncio.TimeoutError:
            persisted = await execute_approval_activity(auto_deny_visitor, request_id,
                start_to_close_timeout=timedelta(seconds=30), retry_policy=_RETRY)
            status = persisted.get("status") if isinstance(persisted, dict) else "pending"
            self._status = "auto_denied" if status == "denied" else status
            return self._status
        persisted = await execute_approval_activity(
            approve_visitor if self._decision.get("decision") == "approved" else deny_visitor,
            args=[request_id, self._decision.get("reason", "")],
            start_to_close_timeout=timedelta(seconds=30), retry_policy=_RETRY)
        self._status = persisted.get("status", "pending") if isinstance(persisted, dict) else "pending"
        return self._status

    @workflow.signal
    async def admin_decision(self, decision: str, reason: str = "") -> None:
        if self._decision is None:
            self._decision = {"decision": decision, "reason": reason}

    @workflow.query
    def current_status(self) -> str:
        return self._status
