"""Recover exhausted approval activities without changing recorded commands."""
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, RetryState

RECOVERY_PATCH = "approval-activity-outage-recovery-v1"
RECOVERY_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=30),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(minutes=5),
    maximum_attempts=0,
    non_retryable_error_types=["HTTPException", "ValueError", "TypeError"],
)


async def execute_approval_activity(activity, *args, **options):
    """Keep the original attempt, then durably retry transient dependency outages.

    Placing the patch after exhaustion preserves timers, activity IDs, arguments,
    and retry options already recorded by both generations of approval workflow.
    Old terminal failures replay unchanged; an in-flight activity which exhausts
    after this worker is deployed can enter the new recovery branch.
    """
    try:
        return await workflow.execute_activity(activity, *args, **options)
    except ActivityError as error:
        if error.retry_state != RetryState.MAXIMUM_ATTEMPTS_REACHED:
            raise
        cause = error.cause
        if isinstance(cause, ApplicationError) and (
            cause.non_retryable or cause.type in RECOVERY_RETRY.non_retryable_error_types
        ):
            raise
        if not workflow.patched(RECOVERY_PATCH):
            raise
        # This timer and the recovery activity are persisted by Temporal. No
        # worker process or HTTP request needs to stay alive during the outage.
        await workflow.sleep(RECOVERY_RETRY.initial_interval)
        return await workflow.execute_activity(
            activity, *args, **{**options, "retry_policy": RECOVERY_RETRY}
        )
