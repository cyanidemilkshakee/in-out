"""
GET /v1/dashboard — returns aggregated analytics, recent movements, open alerts,
and presence counts.
"""

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_read_db

router = APIRouter(prefix="/v1/dashboard", tags=["dashboard"])


@router.get("")
async def get_dashboard(
    db: AsyncSession = Depends(get_read_db),
) -> dict[str, Any]:
    """
    Returns the dashboard data groups from one consistent read session:
    - analytics: aggregate scan counters
    - recentMovements: up to 100 newest movements
    - openAlerts: up to 10 open alerts
    - presenceCounts: inside/outside counts
    """

    analytics_sql = text("""
        WITH duplicate_review_sources AS (
            SELECT DISTINCT pr.data->>'eventId' AS source_event_id
            FROM permission_requests pr
            JOIN movements review_event
              ON review_event.data->>'overrideRequestId' = pr.id
            WHERE pr.data->>'type' = 'manual_override'
              AND pr.data->>'eventId' IS NOT NULL
              AND review_event.id <> pr.data->>'eventId'
        )
        SELECT
            count(*)                                                           AS total,
            count(*) FILTER (WHERE result = 'approved')                        AS approved,
            count(*) FILTER (WHERE result = 'denied')                          AS denied,
            count(*) FILTER (WHERE direction = 'entry' AND result = 'approved') AS entries,
            count(*) FILTER (WHERE direction = 'exit'  AND result = 'approved') AS exits,
            count(*) FILTER (WHERE scan_type = 'auto')                         AS automatic,
            count(*) FILTER (WHERE scan_type = 'manual')                       AS manual,
            count(*) FILTER (
                WHERE result = 'denied'
                AND denial_code IN (
                    'asset_restricted','access_restricted',
                    'hardware_restricted','zone_not_permitted','cross_building_access'
                )
            )                                                                  AS restricted,
            count(*) FILTER (
                WHERE result = 'denied'
                AND (denial_code IS NULL OR denial_code NOT IN (
                    'asset_restricted','access_restricted',
                    'hardware_restricted','zone_not_permitted','cross_building_access',
                    'expired_pass'
                ))
            )                                                                  AS other_denied,
            count(*) FILTER (
                WHERE result = 'denied' AND denial_code = 'expired_pass'
            )                                                                  AS expired
        FROM movements
        WHERE id NOT IN (SELECT source_event_id FROM duplicate_review_sources)
    """)

    recent_sql = text("""
        WITH duplicate_review_sources AS (
            SELECT DISTINCT pr.data->>'eventId' AS source_event_id
            FROM permission_requests pr
            JOIN movements review_event
              ON review_event.data->>'overrideRequestId' = pr.id
            WHERE pr.data->>'type' = 'manual_override'
              AND pr.data->>'eventId' IS NOT NULL
              AND review_event.id <> pr.data->>'eventId'
        )
        SELECT id, subject_id, checkpoint_id, occurred_at, result, direction,
               scan_type, subject_type, sync_state, denial_code, data
        FROM movements
        WHERE id NOT IN (SELECT source_event_id FROM duplicate_review_sources)
        ORDER BY occurred_at DESC
        LIMIT 100
    """)

    alerts_sql = text("""
        SELECT id, created_at, data
        FROM alerts
        WHERE COALESCE(data->>'status', 'open') IN ('open', 'warned')
          AND COALESCE(data->>'title', '') NOT ILIKE 'Access decision denied'
          AND COALESCE(data->>'manualReview', 'false') <> 'true'
          AND COALESCE(data->>'ruleId', '') <> 'rule-manual-review'
          AND COALESCE(data->>'ruleId', '') <> 'rule-unknown-barcode'
          AND COALESCE(data->>'title', '') NOT ILIKE 'Unknown barcode%'
        ORDER BY created_at DESC
        LIMIT 10
    """)

    pending_decisions_sql = text("""
        SELECT data
        FROM permission_requests
        WHERE data->>'status' = 'pending'
        ORDER BY created_at DESC
        LIMIT 20
    """)

    presence_sql = text("""
        SELECT p.state, count(*) AS cnt
        FROM presence_state p JOIN subjects s ON s.id = p.subject_id
        WHERE s.kind IN ('employee', 'visitor')
        GROUP BY p.state
    """)

    analytics_result = await db.execute(analytics_sql)
    recent_result = await db.execute(recent_sql)
    alerts_result = await db.execute(alerts_sql)
    pending_decisions_result = await db.execute(pending_decisions_sql)
    presence_result = await db.execute(presence_sql)

    # --- Analytics ---
    row = analytics_result.mappings().one()
    analytics = {
        "totalScans":       int(row["total"]       or 0),
        "totalApproved":    int(row["approved"]    or 0),
        "totalDenied":      int(row["denied"]      or 0),
        "totalEntries":     int(row["entries"]     or 0),
        "totalExits":       int(row["exits"]       or 0),
        "totalAutomatic":   int(row["automatic"]   or 0),
        "totalManual":      int(row["manual"]      or 0),
        "totalRestricted":  int(row["restricted"]  or 0),
        "totalExpired":     int(row["expired"]     or 0),
        "totalOtherDenied": int(row["other_denied"] or 0),
    }

    # --- Recent movements ---
    recent_movements = [dict(r) for r in recent_result.mappings().all()]
    for m in recent_movements:
        if "occurred_at" in m and m["occurred_at"] is not None:
            m["occurred_at"] = m["occurred_at"].isoformat()

    # --- Open alerts ---
    open_alerts = []
    for r in alerts_result.mappings().all():
        entry = {
            "id": r["id"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "data": r["data"],
        }
        open_alerts.append(entry)

    pending_decisions = [dict(row[0]) for row in pending_decisions_result.all()]

    # --- Presence counts ---
    presence_counts = {"inside": 0, "outside": 0}
    for r in presence_result.mappings().all():
        state = r["state"]
        if state in presence_counts:
            presence_counts[state] = int(r["cnt"] or 0)

    # Embed activeInside into analytics so the frontend ScanAnalytics shape is complete
    analytics["activeInside"] = presence_counts["inside"]

    payload = {
        "analytics":       analytics,
        "recentMovements": recent_movements,
        "openAlerts":      open_alerts,
        "pendingDecisions": pending_decisions,
        "presenceCounts":  presence_counts,
    }
    return payload
