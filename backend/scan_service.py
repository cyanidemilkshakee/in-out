import uuid
import json
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert as pg_insert

from models import Subject, PresenceState, ScanRequest, AccessPermission, Movement
from schemas import ScanPayload, ScanResponse
from redis_client import publish_presence_update

logger = logging.getLogger(__name__)

COOLDOWN_SECONDS = 10


class ScanProcessingService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def process_scan(
        self, idempotency_key: uuid.UUID, payload: ScanPayload
    ) -> ScanResponse:
        """
        Execute the physical access critical path inside a single transaction.

        Guarantees:
          1. Idempotency   — duplicate keys return the cached response atomically.
          2. Serializability — a pessimistic FOR UPDATE lock on the subject's
             presence_state row ensures no two concurrent scans can race.
          3. Cooldown      — at least COOLDOWN_SECONDS must elapse between scans.
          4. Audit trail   — every attempt (approved or denied) is permanently recorded.
        """
        stmt = select(Subject).where(Subject.barcode == payload.barcode)
        result = await self.db.execute(stmt)
        subject = result.scalar_one_or_none()

        if not subject:
            return ScanResponse(allowed=False, reason="Unknown barcode")

        cached = await self._get_cached_response(idempotency_key)
        if cached is not None:
            return cached

        upsert_stmt = (
            pg_insert(PresenceState)
            .values(subject_id=subject.id, state="outside")
            .on_conflict_do_nothing(index_elements=["subject_id"])
        )
        await self.db.execute(upsert_stmt)
        await self.db.flush()

        lock_stmt = (
            select(PresenceState)
            .where(PresenceState.subject_id == subject.id)
            .with_for_update()
        )
        result_lock = await self.db.execute(lock_stmt)
        presence = result_lock.scalar_one()

        cached_locked = await self._get_cached_response(idempotency_key)
        if cached_locked is not None:
            return cached_locked

        now = datetime.now(timezone.utc)

        if presence.last_scan_timestamp is not None:
            elapsed = (now - presence.last_scan_timestamp).total_seconds()
            if elapsed < COOLDOWN_SECONDS:
                response = ScanResponse(
                    allowed=False,
                    reason=f"Cooldown active — {COOLDOWN_SECONDS - elapsed:.1f}s remaining",
                    subject_id=subject.id,
                )
                await self._record_outcome(idempotency_key, subject, payload, response, 429)
                return response

        perm_stmt = select(AccessPermission).where(AccessPermission.subject_id == subject.id)
        result_perm = await self.db.execute(perm_stmt)
        permissions = result_perm.scalars().all()

        if not permissions:
            response = ScanResponse(
                allowed=False, reason="No access permissions configured", subject_id=subject.id
            )
            await self._record_outcome(idempotency_key, subject, payload, response, 403)
            return response

        new_state = "inside" if payload.direction == "entry" else "outside"
        if presence.state == new_state:
            response = ScanResponse(
                allowed=False,
                reason=f"Logical conflict — subject is already {presence.state}",
                subject_id=subject.id,
            )
            await self._record_outcome(idempotency_key, subject, payload, response, 422)
            return response

        presence.state = new_state
        presence.last_scan_timestamp = now

        response = ScanResponse(allowed=True, subject_id=subject.id)
        await self._record_outcome(idempotency_key, subject, payload, response, 200)

        await publish_presence_update(json.dumps({
            "subject_id": subject.id,
            "kind": subject.kind,
            "barcode": payload.barcode,
            "state": new_state,
            "timestamp": now.isoformat(),
        }))

        logger.info(
            "Scan approved: subject=%s direction=%s checkpoint=%s",
            subject.id,
            payload.direction,
            payload.checkpoint_id,
        )
        return response

    async def _get_cached_response(
        self, idempotency_key: uuid.UUID
    ) -> ScanResponse | None:
        """Return the cached ScanResponse if this key was already processed."""
        stmt = select(ScanRequest).where(ScanRequest.idempotency_key == idempotency_key)
        result = await self.db.execute(stmt)
        existing = result.scalar_one_or_none()
        if existing is not None:
            logger.info("Idempotent replay for key=%s", idempotency_key)
            return ScanResponse(**existing.response_body)
        return None

    async def _record_outcome(
        self,
        idempotency_key: uuid.UUID,
        subject: Subject,
        payload: ScanPayload,
        response: ScanResponse,
        status_code: int,
    ) -> None:
        """
        Atomically persist a Movement record and the idempotency ScanRequest.
        Both are written in the same transaction as the state transition so that
        if the commit fails, none of the records survive (no phantom entries).
        """
        movement = Movement(
            subject_id=subject.id,
            checkpoint_id=payload.checkpoint_id,
            result="approved" if response.allowed else "denied",
            denial_code=None if response.allowed else response.reason,
            direction=payload.direction,
            scan_type="auto",
            subject_type=subject.kind,
            data={"terminal_id": payload.terminal_id},
        )
        self.db.add(movement)

        scan_req = ScanRequest(
            idempotency_key=idempotency_key,
            subject_id=subject.id,
            terminal_id=payload.terminal_id,
            status_code=status_code,
            response_body=response.model_dump(),
        )
        self.db.add(scan_req)
