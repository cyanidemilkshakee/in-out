"""Durable post-commit notifications and ordered live-event replay."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "a5b6c7d8e9"
down_revision = "z4a5b6c7d8"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("event_stream_state",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("presence_revision", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("previous_presence_revision", sa.BigInteger(), nullable=False, server_default="0"))
    op.execute("INSERT INTO event_stream_state(id) VALUES (1)")
    op.create_table("event_outbox",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column("event_key", sa.String(36), nullable=False, unique=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lease_owner", sa.String(36)), sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("delivered_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("kind IN ('presence', 'workflow_start', 'workflow_signal')", name="ck_event_outbox_kind"))
    op.create_index("idx_event_outbox_pending", "event_outbox", ["available_at", "id"], postgresql_where=sa.text("delivered_at IS NULL"))
    op.create_index("idx_event_outbox_replay", "event_outbox", ["id"], postgresql_where=sa.text("kind = 'presence'"))
    # Bridge pending requests without replacing/draining existing workflows.
    # Stable workflow IDs let the dispatcher treat AlreadyStarted as success.
    op.execute("""
        INSERT INTO event_outbox(id,event_key,kind,payload)
        SELECT row_number() OVER (ORDER BY created_at,id), gen_random_uuid()::text,
               'workflow_start', jsonb_build_object(
                 'workflow', CASE WHEN data->>'type'='visitor' THEN 'VisitorApprovalWorkflow' ELSE 'PermissionOverrideWorkflow' END,
                 'workflowId', CASE WHEN data->>'type'='visitor' THEN 'visitor-' ELSE 'override-' END || id,
                 'args', jsonb_build_array(id))
        FROM permission_requests WHERE data->>'status'='pending' AND data->>'type' IN ('manual_override','visitor')
    """)
    op.execute("UPDATE event_stream_state SET revision=COALESCE((SELECT max(id) FROM event_outbox),0) WHERE id=1")


def downgrade():
    op.drop_table("event_outbox")
    op.drop_table("event_stream_state")
