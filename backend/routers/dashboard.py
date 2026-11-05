"""
GET /v1/dashboard — returns aggregated analytics, recent movements, open alerts,
and presence counts.
"""

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from auth import verify_admin_request
from database import get_read_db
from event_outbox import read_event_revision
from zone_access import admin_zone_ids

router = APIRouter(prefix="/v1/dashboard", tags=["dashboard"])


def _iso_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()


@router.get("")
async def get_dashboard(
    db: AsyncSession = Depends(get_read_db),
    actor: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """
    Returns the dashboard data groups from one consistent read session:
    - analytics: aggregate scan counters
    - recentMovements: up to 100 newest movements
    - openAlerts: up to 10 open alerts
    - presenceCounts: inside/outside counts
    """

    event_revision = await read_event_revision(db)
    zone_ids = await admin_zone_ids(db, actor)
    has_zone_scope = bool(zone_ids)
    zone_ids = list(zone_ids) or ["__no_active_zone__"]
    dashboard_sql = text("""
        WITH visible_subjects AS MATERIALIZED (
            SELECT s.id, s.kind
            FROM subjects s
            WHERE :has_zone_scope AND (
                EXISTS (
                    SELECT 1 FROM people p
                    WHERE p.subject_id = s.id AND (
                        p.data->'allowedZones' ?| CAST(:zone_ids AS text[])
                        OR p.data->>'allowedZone' = ANY(CAST(:zone_ids AS text[]))
                    )
                )
                OR EXISTS (
                    SELECT 1 FROM hardware_assets h
                    WHERE h.subject_id = s.id AND (
                        h.data->'allowedZones' ?| CAST(:zone_ids AS text[])
                        OR h.data->>'allowedZone' = ANY(CAST(:zone_ids AS text[]))
                    )
                )
                OR EXISTS (
                    SELECT 1 FROM access_permissions ap
                    WHERE ap.subject_id = s.id
                      AND ap.data->'zones' ?| CAST(:zone_ids AS text[])
                )
                OR s.id IN (
                    SELECT pr.subject_id FROM permission_requests pr
                    WHERE pr.subject_id IS NOT NULL
                      AND pr.data->>'status' = 'pending'
                      AND pr.data->'requestedZones' ?| CAST(:zone_ids AS text[])
                )
            )
        ), duplicate_review_sources AS MATERIALIZED (
            SELECT DISTINCT pr.data->>'eventId' AS source_event_id
            FROM permission_requests pr
            JOIN movements review_event
              ON review_event.data->>'overrideRequestId' = pr.id
            WHERE pr.data->>'type' = 'manual_override'
              AND pr.data->>'eventId' IS NOT NULL
              AND review_event.data->>'overrideRequestId' IS NOT NULL
              AND review_event.id <> pr.data->>'eventId'
        ), analytics AS (
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
                        'hardware_restricted','zone_not_permitted','cross_building_access','expired_pass'
                    )
                )                                                                  AS restricted,
                count(*) FILTER (
                    WHERE result = 'denied'
                    AND (denial_code IS NULL OR denial_code NOT IN (
                        'asset_restricted','access_restricted',
                        'hardware_restricted','zone_not_permitted','cross_building_access',
                        'expired_pass'
                    ))
                )                                                                  AS other_denied
            FROM movements
            WHERE :has_zone_scope
              AND id NOT IN (SELECT source_event_id FROM duplicate_review_sources)
              AND checkpoint_id IN (
                  SELECT id FROM checkpoints WHERE zone_id = ANY(:zone_ids)
              )
        ), recent_movements AS (
            SELECT id, subject_id, checkpoint_id, occurred_at, result, direction,
                   scan_type, subject_type, sync_state, denial_code, data
            FROM movements
            WHERE :has_zone_scope
              AND id NOT IN (SELECT source_event_id FROM duplicate_review_sources)
              AND checkpoint_id IN (
                  SELECT id FROM checkpoints WHERE zone_id = ANY(:zone_ids)
              )
            ORDER BY occurred_at DESC
            LIMIT 100
        ), open_alerts AS (
            SELECT id, created_at, data
            FROM alerts
            WHERE :has_zone_scope
              AND COALESCE(data->>'status', 'open') IN ('open', 'warned')
              AND COALESCE(data->>'title', '') NOT ILIKE 'Access decision denied'
              AND COALESCE(data->>'manualReview', 'false') <> 'true'
              AND COALESCE(data->>'ruleId', '') <> 'rule-manual-review'
              AND COALESCE(data->>'ruleId', '') <> 'rule-unknown-barcode'
              AND COALESCE(data->>'title', '') NOT ILIKE 'Unknown barcode%'
              AND (data->>'zoneId' = ANY(:zone_ids)
                OR data->>'checkpointId' IN (
                    SELECT id FROM checkpoints WHERE zone_id = ANY(:zone_ids)
                )
                OR data->>'subjectId' IN (SELECT id FROM visible_subjects))
            ORDER BY created_at DESC
            LIMIT 10
        ), pending_decisions AS (
            SELECT data, created_at
            FROM permission_requests
            WHERE :has_zone_scope
              AND data->>'status' = 'pending'
              AND ((data->'requestedZones') ?| CAST(:zone_ids AS text[])
                OR data->>'checkpointId' IN (
                    SELECT id FROM checkpoints WHERE zone_id = ANY(:zone_ids)
                )
                OR subject_id IN (SELECT id FROM visible_subjects))
            ORDER BY created_at DESC
            LIMIT 20
        ), presence_counts AS (
            SELECT p.state, count(*) AS cnt
            FROM presence_state p JOIN visible_subjects s ON s.id = p.subject_id
            WHERE s.kind IN ('employee', 'visitor')
            GROUP BY p.state
        )
        SELECT
            (SELECT to_jsonb(analytics) FROM analytics) AS analytics,
            COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', id,
                    'subject_id', subject_id,
                    'checkpoint_id', checkpoint_id,
                    'occurred_at', occurred_at,
                    'result', result,
                    'direction', direction,
                    'scan_type', scan_type,
                    'subject_type', subject_type,
                    'sync_state', sync_state,
                    'denial_code', denial_code,
                    'data', data
                ) ORDER BY occurred_at DESC)
                FROM recent_movements
            ), '[]'::jsonb) AS recent_movements,
            COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', id, 'created_at', created_at, 'data', data
                ) ORDER BY created_at DESC)
                FROM open_alerts
            ), '[]'::jsonb) AS open_alerts,
            COALESCE((
                SELECT jsonb_agg(data ORDER BY created_at DESC)
                FROM pending_decisions
            ), '[]'::jsonb) AS pending_decisions,
            COALESCE((
                SELECT jsonb_object_agg(state, cnt) FROM presence_counts
            ), '{}'::jsonb) AS presence_counts
    """)

    query_params = {
        "zone_ids": zone_ids,
        "has_zone_scope": has_zone_scope,
    }
    dashboard_result = await db.execute(dashboard_sql, query_params)
    row = dashboard_result.mappings().one()

    # --- Analytics ---
    metrics = row["analytics"]
    analytics = {
        "totalScans":       int(metrics["total"]       or 0),
        "totalApproved":    int(metrics["approved"]    or 0),
        "totalDenied":      int(metrics["denied"]      or 0),
        "totalEntries":     int(metrics["entries"]     or 0),
        "totalExits":       int(metrics["exits"]       or 0),
        "totalAutomatic":   int(metrics["automatic"]   or 0),
        "totalManual":      int(metrics["manual"]      or 0),
        "totalRestricted":  int(metrics["restricted"]  or 0),
        "totalOtherDenied": int(metrics["other_denied"] or 0),
    }

    # --- Recent movements ---
    recent_movements = row["recent_movements"]
    for m in recent_movements:
        m["occurred_at"] = _iso_timestamp(m["occurred_at"])

    # --- Open alerts ---
    open_alerts = row["open_alerts"]
    for alert in open_alerts:
        alert["created_at"] = _iso_timestamp(alert["created_at"])
    pending_decisions = row["pending_decisions"]

    # --- Presence counts ---
    counts = row["presence_counts"]
    presence_counts = {
        "inside": int(counts.get("inside", 0) or 0),
        "outside": int(counts.get("outside", 0) or 0),
    }

    # Embed activeInside into analytics so the frontend ScanAnalytics shape is complete
    analytics["activeInside"] = presence_counts["inside"]

    payload = {
        "eventRevision": event_revision,
        "analytics":       analytics,
        "recentMovements": recent_movements,
        "openAlerts":      open_alerts,
        "pendingDecisions": pending_decisions,
        "presenceCounts":  presence_counts,
    }
    return payload
