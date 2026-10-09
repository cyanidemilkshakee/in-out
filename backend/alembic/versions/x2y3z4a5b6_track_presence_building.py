"""Track the building for an active presence state."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


revision = "x2y3z4a5b6"
down_revision = "w1x2y3z4a5"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("presence_state", sa.Column("entry_building_id", sa.String(), nullable=True))
    op.execute(text("""
        UPDATE presence_state AS presence
        SET entry_building_id = (
            SELECT COALESCE(checkpoint.data->>'buildingId',
                CASE movement.checkpoint_id
                    WHEN 'cp-main' THEN 'main-building'
                    WHEN 'main-gate' THEN 'main-building'
                    WHEN 'server-room' THEN 'server-room-building'
                    ELSE NULL
                END)
            FROM movements AS movement
            LEFT JOIN checkpoints AS checkpoint ON checkpoint.id = movement.checkpoint_id
            WHERE movement.subject_id = presence.subject_id
              AND movement.result = 'approved'
              AND movement.direction = 'entry'
            ORDER BY movement.occurred_at DESC, movement.id DESC
            LIMIT 1
        )
        WHERE presence.state = 'inside'
    """))


def downgrade():
    op.drop_column("presence_state", "entry_building_id")
