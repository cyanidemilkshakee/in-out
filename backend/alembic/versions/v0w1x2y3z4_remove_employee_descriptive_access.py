"""Remove retired descriptive employee fields from current registry metadata."""
from alembic import op

revision = "v0w1x2y3z4"
down_revision = "u9v0w1x2y3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The subject row owns the kind; an editable JSON type must not decide cleanup.
    # Audit records, review history and scan replay snapshots remain unchanged.
    op.execute("""
        UPDATE people AS person
        SET data = person.data - 'department' - 'accessLevel'
        FROM subjects AS subject
        WHERE subject.id = person.subject_id
          AND subject.kind = 'employee'
          AND (person.data ? 'department' OR person.data ? 'accessLevel')
    """)


def downgrade() -> None:
    # Descriptive values cannot be recovered; rollback must not invent replacements.
    pass
