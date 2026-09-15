"""Remove the retired unknown-barcode alert rule."""

from alembic import op


revision = "g5h6i7j8k9l0"
down_revision = "f4a5b6c7d8e9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        DELETE FROM alert_rules
        WHERE id = 'rule-unknown-barcode'
           OR data ->> 'conditionKey' = 'unknown_barcode'
        """
    )


def downgrade() -> None:
    # The rule was intentionally retired and is not restored on downgrade.
    pass
