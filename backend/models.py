from sqlalchemy import Column, String, Boolean, ForeignKey, DateTime, Integer, func
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
    permissions = relationship("AccessPermission", back_populates="subject")
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


class PresenceState(Base):
    __tablename__ = "presence_state"

    subject_id: str = Column(
        String, ForeignKey("subjects.id", ondelete="CASCADE"), primary_key=True
    )
    state: str = Column(String, nullable=False)  # 'inside' | 'outside'
    last_scan_timestamp = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    subject = relationship("Subject", back_populates="presence_state")


class ScanRequest(Base):
    __tablename__ = "scan_requests"

    idempotency_key = Column(UUID(as_uuid=True), primary_key=True)
    subject_id: str = Column(String, ForeignKey("subjects.id"), nullable=False)
    terminal_id: str = Column(String, nullable=False)
    status_code: int = Column(Integer, nullable=False)
    response_body = Column(JSONB, nullable=False)
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
    subject_id: str = Column(String, ForeignKey("subjects.id"), nullable=False)
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
    subject_id: str = Column(String, ForeignKey("subjects.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    data = Column(JSONB, nullable=False)
