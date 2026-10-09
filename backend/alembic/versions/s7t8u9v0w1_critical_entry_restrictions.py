"""Critical entry restrictions survive acknowledgement, permission changes and retention."""
from alembic import op
import sqlalchemy as sa

revision = "s7t8u9v0w1"
down_revision = "r6s7t8u9v0"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("critical_entry_restrictions",
        sa.Column("subject_id", sa.String(), sa.ForeignKey("subjects.id", ondelete="RESTRICT"), primary_key=True),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("triggered_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("trigger_alert_id", sa.String(), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True)),
        sa.Column("released_by", sa.String()),
        sa.Column("release_reason", sa.String()),
    )
    op.create_table("critical_alert_triggers",
        sa.Column("alert_id", sa.String(), primary_key=True),
        sa.Column("subject_id", sa.String(), sa.ForeignKey("subjects.id", ondelete="SET NULL")),
        sa.Column("triggered_at", sa.DateTime(timezone=True), nullable=False),
    )
    # Acknowledgement is not release. Bind only an explicit identity or a unique
    # case-insensitive barcode; an invalid supplied ID never falls back to names.
    op.execute(sa.text("""
        INSERT INTO critical_alert_triggers (alert_id, subject_id, triggered_at)
        SELECT a.id, CASE WHEN count(s.id) = 1 THEN max(s.id) ELSE NULL END, a.created_at
        FROM alerts a LEFT JOIN subjects s ON
            (jsonb_typeof(a.data->'subjectId') = 'string'
                AND NULLIF(btrim(a.data->>'subjectId'), '') IS NOT NULL AND s.id = btrim(a.data->>'subjectId'))
            OR ((a.data->'subjectId' IS NULL OR a.data->'subjectId' = 'null'::jsonb OR a.data->>'subjectId' = '')
                AND jsonb_typeof(a.data->'barcode') = 'string'
                AND lower(s.barcode) = lower(btrim(a.data->>'barcode')))
        WHERE a.data->>'severity' = 'critical'
        GROUP BY a.id, a.created_at
    """))
    op.execute(sa.text("""
        INSERT INTO critical_entry_restrictions (subject_id, active, triggered_at, trigger_alert_id)
        SELECT DISTINCT ON (subject_id) subject_id, TRUE, triggered_at, alert_id
        FROM critical_alert_triggers WHERE subject_id IS NOT NULL
        ORDER BY subject_id, triggered_at DESC, alert_id DESC
    """))
    op.execute(sa.text("""
        UPDATE alerts a SET data = a.data || jsonb_build_object('subjectId', t.subject_id)
        FROM critical_alert_triggers t WHERE t.alert_id = a.id AND t.subject_id IS NOT NULL
    """))
    op.execute(sa.text("""
        INSERT INTO audit_events (id, created_at, data)
        SELECT 'AUD-CRITICAL-BACKFILL-' || r.subject_id, now(), jsonb_build_object(
            'id', 'AUD-CRITICAL-BACKFILL-' || r.subject_id, 'category', 'permission',
            'action', 'Critical alert entry restricted', 'subjectId', r.subject_id,
            'barcode', s.barcode, 'actor', 'migration', 'role', 'System', 'decision', 'denied',
            'reason', 'Existing critical alert requires explicit administrator release.',
            'relatedId', r.trigger_alert_id, 'createdAt', now())
        FROM critical_entry_restrictions r JOIN subjects s ON s.id = r.subject_id
        ON CONFLICT (id) DO NOTHING
    """))


def downgrade():
    op.drop_table("critical_alert_triggers")
    op.drop_table("critical_entry_restrictions")
