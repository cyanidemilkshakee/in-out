from sqlalchemy import Column, String, ForeignKey, DateTime, Integer, Boolean, CheckConstraint, Index, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
import uuid

from database import Base


class Subject(Base):
    __tablename__ = "subjects"

    id: str = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    kind: str = Column(String, nullable=False)
    barcode: str = Column(String, nullable=False, unique=True)

    presence_state = relationship("PresenceState", back_populates="subject", uselist=False)
    permissions = relationship("AccessPermission", back_populates="subject", uselist=False)
    person = relationship("Person", back_populates="subject", uselist=False, cascade="all, delete-orphan")
    hardware = relationship("HardwareAsset", back_populates="subject", uselist=False, cascade="all, delete-orphan")


class Person(Base):
    __tablename__ = "people"

    subject_id: str = Column(
        String, ForeignKey("subjects.id", ondelete="CASCADE"), primary_key=True
    )
    data = Column(JSONB, nullable=False)

    subject = relationship("Subject", back_populates="person")


class HardwareAsset(Base):
    __tablename__ = "hardware_assets"

    subject_id: str = Column(
        String, ForeignKey("subjects.id", ondelete="CASCADE"), primary_key=True
    )
    data = Column(JSONB, nullable=False)

    subject = relationship("Subject", back_populates="hardware")



class Checkpoint(Base):
    __tablename__ = "checkpoints"

    id: str = Column(String, primary_key=True)
    data = Column(JSONB, nullable=False)


class TerminalCheckpointAssignment(Base):
    __tablename__ = "terminal_checkpoint_assignments"

    # Namespaces distinguish a verified Keycloak subject from a certificate CN.
    terminal_identity: str = Column(String, primary_key=True)
    checkpoint_id: str = Column(String, ForeignKey("checkpoints.id"), nullable=False)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class PresenceState(Base):
    __tablename__ = "presence_state"

    subject_id: str = Column(
        String, ForeignKey("subjects.id", ondelete="CASCADE"), primary_key=True
    )
    state: str = Column(String, nullable=False)  # 'inside' | 'outside'
    entry_building_id: str | None = Column(String, nullable=True)
    last_scan_timestamp = Column(DateTime(timezone=True), nullable=True)
    # One admitted visit, consumed by the matching exit. Never grants re-entry.
    entry_override = Column(JSONB, nullable=True)
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    subject = relationship("Subject", back_populates="presence_state")


class ScanRequest(Base):
    __tablename__ = "scan_requests"

    idempotency_key = Column(UUID(as_uuid=True), primary_key=True)
    subject_id: str | None = Column(String, ForeignKey("subjects.id"), nullable=True)
    terminal_id: str = Column(String, nullable=False)
    status_code: int = Column(Integer, nullable=False)
    response_body = Column(JSONB, nullable=False)
    request_fingerprint: str | None = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AccessPermission(Base):
    __tablename__ = "access_permissions"

    id: str = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    subject_id: str = Column(String, ForeignKey("subjects.id"), nullable=False)
    data = Column(JSONB, nullable=False)

    subject = relationship("Subject", back_populates="permissions")


class Movement(Base):
    __tablename__ = "movements"

    id: str = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    subject_id: str | None = Column(String, ForeignKey("subjects.id"), nullable=True)
    checkpoint_id: str = Column(String, nullable=False)
    occurred_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    denial_code: str | None = Column(String, nullable=True)
    result: str = Column(String, nullable=False)       # 'approved' | 'denied'
    direction: str = Column(String, nullable=False)    # 'entry' | 'exit'
    scan_type: str = Column(String, nullable=False)    # 'auto' | 'manual'
    subject_type: str = Column(String, nullable=False) # 'employee' | 'visitor' | 'hardware'
    sync_state: str = Column(String, nullable=False, default="queued")
    data = Column(JSONB, nullable=False)


class PermissionRequestModel(Base):
    __tablename__ = "permission_requests"

    id: str = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    # A manual review may be raised for an unregistered barcode, so it does
    # not always have a subject row yet. Known-subject requests still carry
    # the foreign key when one is available.
    subject_id: str | None = Column(String, ForeignKey("subjects.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    data = Column(JSONB, nullable=False)


class Alert(Base):
    __tablename__ = "alerts"
    id: str = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    source_event_id: str | None = Column(String, ForeignKey("movements.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    data = Column(JSONB, nullable=False, default=dict)


class AlertRule(Base):
    __tablename__ = "alert_rules"
    id: str = Column(String, primary_key=True)
    data = Column(JSONB, nullable=False, default=dict)


class CriticalEntryRestriction(Base):
    """Server-owned entry hold, independent of normal permissions and alert status."""
    __tablename__ = "critical_entry_restrictions"
    subject_id = Column(String, ForeignKey("subjects.id", ondelete="RESTRICT"), primary_key=True)
    active = Column(Boolean, nullable=False, default=True)
    triggered_at = Column(DateTime(timezone=True), nullable=False)
    # Alert retention must not implicitly release a subject's restriction.
    trigger_alert_id = Column(String, nullable=False)
    released_at = Column(DateTime(timezone=True), nullable=True)
    released_by = Column(String, nullable=True)
    release_reason = Column(String, nullable=True)


class CriticalAlertTrigger(Base):
    """Remember processed alert IDs, including releases and unbound legacy alerts."""
    __tablename__ = "critical_alert_triggers"
    alert_id = Column(String, primary_key=True)
    subject_id = Column(String, ForeignKey("subjects.id", ondelete="SET NULL"), nullable=True)
    triggered_at = Column(DateTime(timezone=True), nullable=False)


class AlertReview(Base):
    """Final alert decisions survive alert retention and preserve warning identity."""
    __tablename__ = "alert_reviews"
    # Deliberately no alerts FK: retention must not reduce confirmed warnings.
    alert_id = Column(String, primary_key=True)
    subject_id = Column(String, ForeignKey("subjects.id", ondelete="RESTRICT"), nullable=True)
    decision = Column(String, nullable=False)
    reason = Column(String, nullable=False, default="")
    reviewed_at = Column(DateTime(timezone=True), nullable=False)
    reviewed_by = Column(String, nullable=False)
    alert_created_at = Column(DateTime(timezone=True), nullable=False)
    alert_data = Column(JSONB, nullable=False)
    __table_args__ = (
        CheckConstraint("decision IN ('confirmed', 'excused')", name="ck_alert_reviews_decision"),
        CheckConstraint("decision <> 'confirmed' OR subject_id IS NOT NULL", name="ck_confirmed_alert_subject"),
        Index("idx_alert_reviews_subject_reviewed", "subject_id", "reviewed_at"),
    )


class WarningReset(Base):
    """The latest subject warning epoch; audit events retain earlier resets."""
    __tablename__ = "warning_resets"
    subject_id = Column(String, ForeignKey("subjects.id", ondelete="RESTRICT"), primary_key=True)
    reset_at = Column(DateTime(timezone=True), nullable=False)
    reset_by = Column(String, nullable=False)
    reason = Column(String, nullable=False)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: str = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    data = Column(JSONB, nullable=False, default=dict)


class MovementNote(Base):
    __tablename__ = "movement_notes"
    id = Column(Integer, primary_key=True, autoincrement=True)
    event_id: str = Column(String, ForeignKey("movements.id", ondelete="CASCADE"), nullable=False)
    note: str = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AdminAccount(Base):
    __tablename__ = "admin_accounts"
    id: str = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    keycloak_subject: str | None = Column(String, nullable=True, unique=True)
    name: str = Column(String, nullable=False)
    nickname: str = Column(String, nullable=False)
    email: str = Column(String, nullable=False)
    avatar_data_url: str = Column(String, nullable=False, default="")
    offline_until = Column(DateTime(timezone=True), nullable=True)
    settings = Column(JSONB, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AlertRuleAssignment(Base):
    """Per-subject rule overrides and dates that skip irregularity alerts."""
    __tablename__ = "alert_rule_assignments"
    subject_id = Column(String, ForeignKey("subjects.id", ondelete="CASCADE"), primary_key=True)
    rule_ids = Column(JSONB, nullable=False, default=list)
    rules_customized = Column(Boolean, nullable=False, default=True, server_default=text("true"))
    irregularity_skip_dates = Column(JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    revision = Column(Integer, nullable=False, default=1)
    updated_by = Column(String, nullable=False)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    __table_args__ = (
        CheckConstraint("jsonb_typeof(rule_ids) = 'array'", name="ck_alert_rule_assignments_array"),
        CheckConstraint("jsonb_typeof(irregularity_skip_dates) = 'array'", name="ck_alert_rule_assignments_skip_dates_array"),
        CheckConstraint("revision > 0", name="ck_alert_rule_assignments_revision"),
    )
