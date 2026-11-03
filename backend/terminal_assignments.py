"""Checkpoint identity comes from an administrator's assignment, never a scan body."""
import argparse
import asyncio
from datetime import datetime, timezone
import uuid
import logging

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from access_validation import require_registered_checkpoint
from database import AsyncSessionLocal, engine
from models import AuditEvent, Checkpoint, TerminalCheckpointAssignment
from event_outbox import enqueue_presence

logger = logging.getLogger(__name__)


async def enqueue_checkpoint_assignment(db, identity):
    return await enqueue_presence(db, {"type": "terminal_assignment", "terminalIdentity": identity})


def browser_identity(actor):
    subject = actor.get("sub")
    if not isinstance(subject, str) or not subject:
        raise HTTPException(401, "Authenticated operator identity required")
    return "browser:" + subject


async def assigned_checkpoint(db, identity):
    # A scan holds the shared row lock until commit so a simultaneous reassignment
    # cannot change the checkpoint halfway through an access decision.
    assignment = await db.scalar(select(TerminalCheckpointAssignment)
        .where(TerminalCheckpointAssignment.terminal_identity == identity)
        .with_for_update(read=True))
    return assignment.checkpoint_id if assignment else None


async def require_checkpoint(db, identity, requested):
    checkpoint_id = await assigned_checkpoint(db, identity)
    if not checkpoint_id:
        raise HTTPException(403, "No checkpoint assigned. Ask an administrator to assign a checkpoint before scanning.")
    requested_checkpoint_id = await require_registered_checkpoint(db, requested)
    if requested_checkpoint_id != checkpoint_id:
        raise HTTPException(403, "Checkpoint does not match this account or terminal's assigned checkpoint")
    return checkpoint_id


async def set_checkpoint_assignment(db, identity, checkpoint_id, actor):
    assigned_checkpoint = None
    if checkpoint_id is not None:
        checkpoint_id = await require_registered_checkpoint(db, checkpoint_id)
        assigned_checkpoint = await db.get(Checkpoint, checkpoint_id)
        await db.execute(insert(TerminalCheckpointAssignment).values(
            terminal_identity=identity, checkpoint_id=checkpoint_id).on_conflict_do_update(
                index_elements=["terminal_identity"],
                set_={"checkpoint_id": checkpoint_id, "updated_at": datetime.now(timezone.utc)}))
    else:
        assignment = await db.get(TerminalCheckpointAssignment, identity, with_for_update=True)
        if assignment:
            assigned_checkpoint = await db.get(Checkpoint, assignment.checkpoint_id)
            await db.delete(assignment)
    now = datetime.now(timezone.utc)
    event_id = str(uuid.uuid4())
    db.add(AuditEvent(id=event_id, created_at=now, data={
        "id": event_id, "category": "permission", "action": "terminal_checkpoint_assigned" if checkpoint_id else "terminal_checkpoint_removed",
        "subjectId": identity, "subjectName": identity, "actor": actor, "role": "admin",
        "checkpointId": checkpoint_id or (assigned_checkpoint.id if assigned_checkpoint else None),
        "zoneId": assigned_checkpoint.zone_id if assigned_checkpoint else None,
        "reason": "Terminal checkpoint assignment updated",
        "relatedId": identity, "date": now.date().isoformat(), "time": now.strftime("%H:%M:%S"), "createdAt": now.isoformat(),
    }))


async def _bind_physical_terminal(terminal_id, checkpoint_id):
    try:
        async with AsyncSessionLocal() as db:
            await set_checkpoint_assignment(db, "mtls:" + terminal_id, checkpoint_id, "Local database administrator")
            await enqueue_checkpoint_assignment(db, "mtls:" + terminal_id)
            await db.commit()
    finally:
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Assign a verified physical terminal certificate CN to a checkpoint.")
    parser.add_argument("--terminal", required=True, help="Exact certificate CN")
    parser.add_argument("--checkpoint", required=True, help="Registered checkpoint ID")
    arguments = parser.parse_args()
    asyncio.run(_bind_physical_terminal(arguments.terminal, arguments.checkpoint))
