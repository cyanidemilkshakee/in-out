"""
VisitorApprovalWorkflow — Waits 30 minutes for admin to approve a new visitor.
"""
from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from workflows.activities import approve_visitor, deny_visitor, auto_deny_visitor

_RETRY = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=5))


@workflow.defn
class VisitorApprovalWorkflow:
    def __init__(self) -> None:
        self._decision: Optional[dict] = None
        self._status: str = "pending"

    @workflow.run
    async def run(self, request_id: str) -> str:
        try:
            await workflow.wait_condition(
                lambda: self._decision is not None,
                timeout=timedelta(minutes=30),
            )
        except asyncio.TimeoutError:
            self._status = "auto_denied"
            await workflow.execute_activity(
                auto_deny_visitor,
                request_id,
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=_RETRY,
            )
            return "auto_denied"

        decision = self._decision["decision"]
        reason = self._decision.get("reason", "")
        if decision == "approved":
            self._status = "approved"
            await workflow.execute_activity(
                approve_visitor,
                args=[request_id, reason],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=_RETRY,
            )
        else:
            self._status = "denied"
            await workflow.execute_activity(
                deny_visitor,
                args=[request_id, reason],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=_RETRY,
            )
        return self._status

    @workflow.signal
    async def admin_decision(self, decision: str, reason: str = "") -> None:
        if self._decision is None:
            self._decision = {"decision": decision, "reason": reason}

    @workflow.query
    def current_status(self) -> str:
        return self._status
