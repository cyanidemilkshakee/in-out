"""Bind authenticated terminal identities to server-controlled checkpoints."""
from alembic import op
import sqlalchemy as sa

revision = "p4q5r6s7t8"
down_revision = "o3p4q5r6s7"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("terminal_checkpoint_assignments",
        sa.Column("terminal_identity", sa.String(), primary_key=True),
        sa.Column("checkpoint_id", sa.String(), sa.ForeignKey("checkpoints.id"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade():
    op.drop_table("terminal_checkpoint_assignments")
