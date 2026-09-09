"""Allow a denied scan to be retained when its barcode has no subject.

Revision ID: c91b6d7e8f2a
Revises: b4e1548478d0
"""
from alembic import op

revision = "c91b6d7e8f2a"
down_revision = "b4e1548478d0"
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.execute("ALTER TABLE movements ALTER COLUMN subject_id DROP NOT NULL")
    op.execute("ALTER TABLE scan_requests ALTER COLUMN subject_id DROP NOT NULL")

def downgrade() -> None:
    op.execute("DELETE FROM scan_requests WHERE subject_id IS NULL")
    op.execute("DELETE FROM movements WHERE subject_id IS NULL")
    op.execute("ALTER TABLE scan_requests ALTER COLUMN subject_id SET NOT NULL")
    op.execute("ALTER TABLE movements ALTER COLUMN subject_id SET NOT NULL")
