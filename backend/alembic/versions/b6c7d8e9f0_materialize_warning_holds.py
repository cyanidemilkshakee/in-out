"""Materialize legacy warning holds before removing ledger reads from scans."""
from alembic import op
import sqlalchemy as sa

revision = "b6c7d8e9f0"
down_revision = "a5b6c7d8e9"
branch_labels = None
depends_on = None


def upgrade():
    # The table lock retained by ALTER TABLE serializes this entire backfill
    # with scans, warning reviews and resets. A failed migration publishes no
    # true gate and no partial restriction/audit state.
    op.add_column("subjects", sa.Column("warning_hold_materialized", sa.Boolean(), nullable=False,
        server_default=sa.false()))
    op.execute(sa.text("""
        CREATE TEMP TABLE warning_hold_backfill_b6c7d8e9f0 ON COMMIT DROP AS
        WITH ranked AS (
            SELECT r.subject_id, r.alert_id, r.reviewed_at,
                row_number() OVER (PARTITION BY r.subject_id ORDER BY r.reviewed_at, r.alert_id) AS ordinal,
                row_number() OVER (PARTITION BY r.subject_id ORDER BY r.reviewed_at DESC, r.alert_id DESC) AS reverse_ordinal
            FROM alert_reviews r LEFT JOIN warning_resets w ON w.subject_id = r.subject_id
            WHERE r.decision = 'confirmed' AND r.subject_id IS NOT NULL
                AND (w.reset_at IS NULL OR r.reviewed_at > w.reset_at)
        ), thresholds AS (
            SELECT subject_id, max(reviewed_at) FILTER (WHERE ordinal = 3) AS threshold_at,
                max(alert_id) FILTER (WHERE reverse_ordinal = 1) AS latest_alert_id
            FROM ranked GROUP BY subject_id HAVING count(*) >= 3
        )
        SELECT t.subject_id, t.latest_alert_id FROM thresholds t
        LEFT JOIN critical_entry_restrictions c ON c.subject_id = t.subject_id
        WHERE c.subject_id IS NULL OR (NOT c.active AND
            (c.released_at IS NULL OR c.released_at < t.threshold_at))
    """))
    op.execute(sa.text("""
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM warning_hold_backfill_b6c7d8e9f0 b
                JOIN critical_alert_triggers t ON t.alert_id = b.latest_alert_id
                WHERE t.subject_id IS NOT NULL AND t.subject_id <> b.subject_id)
            THEN RAISE EXCEPTION 'Warning trigger belongs to another subject; repair ledger before migrating';
            END IF;
        END $$
    """))
    op.execute(sa.text("""
        INSERT INTO critical_alert_triggers (alert_id, subject_id, triggered_at)
        SELECT latest_alert_id, subject_id, now() FROM warning_hold_backfill_b6c7d8e9f0
        ON CONFLICT (alert_id) DO UPDATE SET subject_id = EXCLUDED.subject_id
            WHERE critical_alert_triggers.subject_id IS NULL
    """))
    op.execute(sa.text("""
        INSERT INTO critical_entry_restrictions (subject_id, active, triggered_at, trigger_alert_id)
        SELECT subject_id, TRUE, now(), latest_alert_id FROM warning_hold_backfill_b6c7d8e9f0
        ON CONFLICT (subject_id) DO UPDATE SET active = TRUE, triggered_at = EXCLUDED.triggered_at,
            trigger_alert_id = EXCLUDED.trigger_alert_id, released_at = NULL, released_by = NULL, release_reason = NULL
    """))
    op.execute(sa.text("""
        INSERT INTO audit_events (id, created_at, data)
        SELECT 'AUD-WARNING-BACKFILL-' || b.subject_id, now(), jsonb_build_object(
            'id', 'AUD-WARNING-BACKFILL-' || b.subject_id, 'category', 'permission',
            'action', 'Three confirmed warnings entry restricted', 'subjectId', b.subject_id,
            'barcode', s.barcode, 'actor', 'migration', 'role', 'System', 'decision', 'denied',
            'reason', 'Three confirmed warnings require administrator release.',
            'relatedId', b.latest_alert_id, 'createdAt', now())
        FROM warning_hold_backfill_b6c7d8e9f0 b JOIN subjects s ON s.id = b.subject_id
    """))
    op.execute(sa.text("UPDATE subjects SET warning_hold_materialized = TRUE"))
    op.alter_column("subjects", "warning_hold_materialized", server_default=sa.true())


def downgrade():
    # Durable holds, trigger identity and history survive a code rollback.
    op.drop_column("subjects", "warning_hold_materialized")
