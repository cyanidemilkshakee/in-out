"""
Alert & AlertRule endpoints.

GET  /v1/alerts              — list alerts with optional status filter
PATCH /v1/alerts/{id}        — acknowledge an alert (auth-protected)
POST /v1/alerts/evaluate     — placeholder rule evaluation
PATCH /v1/alert-rules/{id}   — toggle enabled on alert rule (auth-protected)
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from auth import verify_admin_request
from database import get_db, get_read_db
from dashboard_cache import invalidate_dashboard_cache
from models import Alert, AlertRule

router = APIRouter(tags=["alerts"])


# ---------------------------------------------------------------------------
# GET /v1/alerts
# ---------------------------------------------------------------------------

@router.get("/v1/alerts")
async def list_alerts(
    status: Optional[str] = Query(None, pattern="^(open|acknowledged|warned|resolved)$"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_read_db),
) -> dict[str, Any]:
    """
    Return paginated alerts and all alert rules.
    Optional ?status= filters alerts by data->>'status'.
    """
    # -- Alerts query --
    excluded_alert = or_(
        (Alert.data["manualReview"].astext == "true")
        | (Alert.data["ruleId"].astext == "rule-manual-review")
        | (Alert.data["ruleId"].astext == "rule-unknown-barcode")
        | Alert.data["title"].astext.ilike("Unknown barcode%")
        | Alert.data["title"].astext.ilike("Access decision denied")
    )
    alerts_q = select(Alert).where(~func.coalesce(excluded_alert, False)).order_by(Alert.created_at.desc())
    count_q = select(func.count()).select_from(Alert).where(~func.coalesce(excluded_alert, False))

    if status:
        alerts_q = alerts_q.where(Alert.data["status"].astext == status)
        count_q = count_q.where(Alert.data["status"].astext == status)

    total_res = await db.execute(count_q)
    total = total_res.scalar_one()

    alerts_res = await db.execute(alerts_q.limit(limit).offset(offset))
    alerts = alerts_res.scalars().all()

    recent_cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    recent_res = await db.execute(
        select(Alert.data).where(Alert.created_at >= recent_cutoff)
    )
    recent_triggers: dict[str, int] = {}
    for data in recent_res.scalars().all():
        rule_id = str((data or {}).get("ruleId") or "")
        if rule_id:
            recent_triggers[rule_id] = recent_triggers.get(rule_id, 0) + 1

    # -- Rules query (all) --
    rules_res = await db.execute(select(AlertRule).order_by(AlertRule.id))
    rules = rules_res.scalars().all()
    if not rules:
        from rule_engine import default_alert_rules
        rule_data = default_alert_rules()
    else:
        from rule_engine import with_default_alert_rules
        rule_data = with_default_alert_rules([r.data for r in rules])
    rule_data = [
        {**rule, "recentTriggers": recent_triggers.get(str(rule.get("id")), 0)}
        for rule in rule_data
    ]

    return {
        "items":  [a.data for a in alerts],
        "rules":  rule_data,
        "total":  total,
    }


# ---------------------------------------------------------------------------
# PATCH /v1/alerts/{id}
# ---------------------------------------------------------------------------

@router.patch("/v1/alerts/{alert_id}")
async def update_alert(
    alert_id: str,
    payload: dict[str, Any],
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """Acknowledge an alert while preserving its stored record."""
    if payload != {"status": "acknowledged"}:
        raise HTTPException(status_code=422, detail="Alerts can only be acknowledged")
    result = await db.execute(select(Alert).where(Alert.id == alert_id).with_for_update())
    alert = result.scalar_one_or_none()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    merged = {**(alert.data or {}), **payload, "id": alert.id}
    alert.data = merged
    await db.commit()
    await db.refresh(alert)
    await invalidate_dashboard_cache()
    return alert.data


# ---------------------------------------------------------------------------
# POST /v1/alerts/evaluate  (placeholder)
# ---------------------------------------------------------------------------

@router.post("/v1/alerts/evaluate")
async def evaluate_alerts(
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """Run the same rule evaluation used by the scheduled worker."""
    from workflows.activities import run_alert_rule_evaluation
    triggered = await run_alert_rule_evaluation()
    return {"triggered": triggered, "message": "Alert rules evaluated"}


# ---------------------------------------------------------------------------
# PATCH /v1/alert-rules/{id}
# ---------------------------------------------------------------------------

@router.patch("/v1/alert-rules/{rule_id}")
async def update_alert_rule(
    rule_id: str,
    payload: dict[str, Any],
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """Update a single alert rule''s data JSONB — specifically the ''enabled'' flag."""
    result = await db.execute(select(AlertRule).where(AlertRule.id == rule_id))
    rule = result.scalar_one_or_none()
    from rule_engine import is_retired_alert
    if rule and is_retired_alert(rule.data or {}):
        raise HTTPException(status_code=404, detail="Alert rule not found")
    if not rule:
        from rule_engine import default_alert_rules
        default = next((item for item in default_alert_rules() if item["id"] == rule_id), None)
        if not default:
            raise HTTPException(status_code=404, detail="Alert rule not found")
        rule = AlertRule(id=rule_id, data=default)
        db.add(rule)

    unknown = set(payload) - {"enabled", "severity", "scope", "description", "name"}
    if unknown or ("enabled" in payload and not isinstance(payload["enabled"], bool)):
        raise HTTPException(status_code=422, detail="Unsupported alert rule update")
    merged = {**(rule.data or {}), **payload}
    rule.data = merged
    await db.commit()
    await db.refresh(rule)
    return rule.data
