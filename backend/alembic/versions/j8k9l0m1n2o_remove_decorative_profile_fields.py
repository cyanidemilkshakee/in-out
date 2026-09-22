"""Remove obsolete profile flags and the unused current-account column."""
from alembic import op
import sqlalchemy as sa


revision = "j8k9l0m1n2o"
down_revision = "i7j8k9l0m1n2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        UPDATE admin_accounts
        SET settings = jsonb_build_object(
            'requireReviewNote',
            CASE
                WHEN jsonb_typeof(settings->'requireReviewNote') = 'boolean'
                    THEN settings->'requireReviewNote'
                ELSE 'true'::jsonb
            END
        )
    """)
    op.drop_column("admin_accounts", "is_current")


def downgrade() -> None:
    op.add_column(
        "admin_accounts",
        sa.Column("is_current", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
