"""
Checkpoint endpoints.

GET /v1/checkpoints — list all checkpoints ordered by id
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_read_db
from models import Checkpoint

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/checkpoints", tags=["checkpoints"])


@router.get("")
async def list_checkpoints(
    db: AsyncSession = Depends(get_read_db),
) -> list[dict[str, Any]]:
    """Return all checkpoints ordered by id."""
    result = await db.execute(select(Checkpoint).order_by(Checkpoint.id))
    checkpoints = result.scalars().all()
    return [{**c.data, "id": c.id} for c in checkpoints]
