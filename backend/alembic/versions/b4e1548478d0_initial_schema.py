"""initial_schema

Revision ID: b4e1548478d0
Revises: 
Create Date: 2026-08-18 13:14:04.257352

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b4e1548478d0'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    statements = [
        "CREATE TABLE IF NOT EXISTS app_metadata (key text PRIMARY KEY, value text NOT NULL);",
        "CREATE TABLE IF NOT EXISTS subjects (id text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('employee', 'visitor', 'hardware')), barcode text NOT NULL);",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_subjects_barcode_ci ON subjects (lower(barcode));",
        "CREATE TABLE IF NOT EXISTS people (subject_id text PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE, data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'));",
        "CREATE TABLE IF NOT EXISTS hardware_assets (subject_id text PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE, data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'));",
        "CREATE TABLE IF NOT EXISTS checkpoints (id text PRIMARY KEY, data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'));",
        """CREATE TABLE IF NOT EXISTS movements (
            id text PRIMARY KEY,
            subject_id text NOT NULL REFERENCES subjects(id),
            checkpoint_id text NOT NULL REFERENCES checkpoints(id),
            occurred_at timestamptz NOT NULL,
            denial_code text,
            result text NOT NULL CHECK (result IN ('approved', 'denied')),
            direction text NOT NULL CHECK (direction IN ('entry', 'exit')),
            scan_type text NOT NULL CHECK (scan_type IN ('auto', 'manual')),
            subject_type text NOT NULL CHECK (subject_type IN ('employee', 'visitor', 'hardware')),
            sync_state text NOT NULL CHECK (sync_state IN ('synced', 'queued', 'conflict')),
            data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
        );""",
        "CREATE INDEX IF NOT EXISTS idx_movements_occurred_at ON movements (occurred_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_movements_subject ON movements (subject_id, occurred_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_movements_checkpoint ON movements (checkpoint_id, occurred_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_movements_filters ON movements (result, direction, scan_type, subject_type, occurred_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_movements_sync_pending ON movements (sync_state, occurred_at DESC) WHERE sync_state <> 'synced';",
        "CREATE INDEX IF NOT EXISTS idx_movements_checkpoint_name ON movements ((data ->> 'checkpoint'));",
        "CREATE TABLE IF NOT EXISTS alerts (id text PRIMARY KEY, source_event_id text REFERENCES movements(id), created_at timestamptz NOT NULL, data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'));",
        "CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts (created_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_alerts_source_event ON alerts (source_event_id);",
        "CREATE INDEX IF NOT EXISTS idx_alerts_open_rule ON alerts ((data ->> 'ruleId')) WHERE data ->> 'status' = 'open' AND data ? 'ruleId';",
        "CREATE TABLE IF NOT EXISTS access_permissions (id text PRIMARY KEY, subject_id text NOT NULL REFERENCES subjects(id), data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'));",
        "CREATE INDEX IF NOT EXISTS idx_access_permissions_subject ON access_permissions (subject_id);",
        "CREATE TABLE IF NOT EXISTS permission_requests (id text PRIMARY KEY, subject_id text NOT NULL REFERENCES subjects(id), created_at timestamptz NOT NULL, data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'));",
        "CREATE INDEX IF NOT EXISTS idx_permission_requests_subject ON permission_requests (subject_id, created_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_permission_requests_pending_custody ON permission_requests ((data ->> 'hardwareId'), (data ->> 'carrierId')) WHERE data ->> 'type' = 'hardware_custody' AND data ->> 'status' = 'pending';",
        "CREATE TABLE IF NOT EXISTS notifications (id text PRIMARY KEY, created_at timestamptz NOT NULL, data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'));",
        "CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC);",
        "CREATE TABLE IF NOT EXISTS alert_rules (id text PRIMARY KEY, data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'));",
        "CREATE INDEX IF NOT EXISTS idx_alert_rules_scheduled ON alert_rules ((data ->> 'conditionKey')) WHERE data ->> 'enabled' = 'true';",
        "CREATE TABLE IF NOT EXISTS audit_events (id text PRIMARY KEY, created_at timestamptz NOT NULL, data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'));",
        "CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events (created_at DESC);",
        "CREATE TABLE IF NOT EXISTS movement_notes (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, event_id text NOT NULL REFERENCES movements(id) ON DELETE CASCADE, note text NOT NULL, created_at timestamptz NOT NULL);",
        "CREATE INDEX IF NOT EXISTS idx_movement_notes_event ON movement_notes (event_id, id);",
        """CREATE TABLE IF NOT EXISTS admin_accounts (
            id text PRIMARY KEY,
            name text NOT NULL,
            nickname text NOT NULL,
            email text NOT NULL,
            password_hash text NOT NULL,
            avatar_data_url text NOT NULL,
            auto_lock text NOT NULL,
            settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
            is_current boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL
        );""",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_accounts_email_ci ON admin_accounts (lower(email));",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_accounts_current ON admin_accounts (is_current) WHERE is_current;",
        """CREATE TABLE IF NOT EXISTS presence_state (
            subject_id text PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
            state text NOT NULL CHECK (state IN ('inside', 'outside')),
            last_scan_timestamp timestamptz,
            updated_at timestamptz NOT NULL DEFAULT now()
        );""",
        """CREATE TABLE IF NOT EXISTS scan_requests (
            idempotency_key uuid PRIMARY KEY,
            subject_id text NOT NULL REFERENCES subjects(id),
            terminal_id text NOT NULL,
            status_code integer NOT NULL,
            response_body jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        );"""
    ]
    for stmt in statements:
        op.execute(sa.text(stmt))

def downgrade() -> None:
    """Downgrade schema."""
    statements = [
        "DROP TABLE IF EXISTS scan_requests CASCADE;",
        "DROP TABLE IF EXISTS presence_state CASCADE;",
        "DROP TABLE IF EXISTS admin_accounts CASCADE;",
        "DROP TABLE IF EXISTS movement_notes CASCADE;",
        "DROP TABLE IF EXISTS audit_events CASCADE;",
        "DROP TABLE IF EXISTS alert_rules CASCADE;",
        "DROP TABLE IF EXISTS notifications CASCADE;",
        "DROP TABLE IF EXISTS permission_requests CASCADE;",
        "DROP TABLE IF EXISTS access_permissions CASCADE;",
        "DROP TABLE IF EXISTS alerts CASCADE;",
        "DROP TABLE IF EXISTS movements CASCADE;",
        "DROP TABLE IF EXISTS checkpoints CASCADE;",
        "DROP TABLE IF EXISTS hardware_assets CASCADE;",
        "DROP TABLE IF EXISTS people CASCADE;",
        "DROP TABLE IF EXISTS subjects CASCADE;",
        "DROP TABLE IF EXISTS app_metadata CASCADE;"
    ]
    for stmt in statements:
        op.execute(sa.text(stmt))
