"""Registered-subject rule selection, independent of global rule activation."""
from __future__ import annotations

import re
import uuid
from calendar import monthrange
from datetime import date, datetime, timezone
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select

from models import AlertRule, AlertRuleAssignment, AuditEvent, HardwareAsset, Person, Subject
from rule_engine import eligible_alert_subject_types, with_default_alert_rules

RuleId = Annotated[str, Field(strict=True, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")]
_RESERVED_IDS = frozenset({"__proto__", "constructor", "prototype"})
_FACILITY_TIME_ZONE = ZoneInfo("Asia/Kolkata")


def irregularity_skip_date_window(today=None):
    today = today or datetime.now(_FACILITY_TIME_ZONE).date()
    month_index = today.month - 1 + 6
    year = today.year + month_index // 12
    month = month_index % 12 + 1
    maximum = date(year, month, min(today.day, monthrange(year, month)[1]))
    return today, maximum


class AlertRuleAssignmentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ruleIds: list[RuleId] = Field(max_length=100)
    irregularitySkipDates: list[date] | None = Field(default=None, max_length=366)
    expectedRevision: Annotated[int, Field(strict=True, ge=0)] | None = None

    @field_validator("ruleIds")
    @classmethod
    def distinct_canonical_ids(cls, value):
        if len(set(value)) != len(value) or any(rule_id in _RESERVED_IDS for rule_id in value):
            raise ValueError("Choose each registered alert rule once")
        return value

    @field_validator("irregularitySkipDates")
    @classmethod
    def distinct_skip_dates(cls, value):
        if value is not None and len(set(value)) != len(value):
            raise ValueError("Choose each irregularity skip date once")
        return sorted(value) if value is not None else None


async def lock_scheduled_alert_evaluation(db):
    # Every assignment mutation and scheduled/manual evaluation takes this
    # transaction lock before subject locks, so a worker cannot commit a
    # result calculated from an assignment that has already been replaced.
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended("scheduled-alert-evaluation", 0))))


async def assignment_rule_catalog(db):
    rows = (await db.scalars(select(AlertRule).order_by(AlertRule.id))).all()
    rules = []
    for row in rows:
        if not isinstance(row.data, dict) or not isinstance(row.id, str):
            continue
        rule = {**row.data, "id": row.id}
        rule.pop("ruleId", None)  # Serialized evidence must not override the rule row's identity.
        if (row.id not in _RESERVED_IDS and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", row.id)
                and eligible_alert_subject_types(rule)):
            rules.append(rule)
    return [{**rule, "eligibleSubjectTypes": list(eligible_alert_subject_types(rule))}
            for rule in with_default_alert_rules(rules) if eligible_alert_subject_types(rule)]


def effective_rule_ids(subject_type, rules, assignment=None):
    eligible = {rule["id"] for rule in rules if subject_type in rule["eligibleSubjectTypes"]}
    if assignment is None or not getattr(assignment, "rules_customized", True):
        return sorted(eligible)
    selected = assignment.rule_ids if isinstance(assignment.rule_ids, list) else []
    return sorted({rule_id for rule_id in selected if isinstance(rule_id, str) and rule_id in eligible})


def assignment_document(subject, metadata, rules, assignment=None):
    metadata = metadata if isinstance(metadata, dict) else {}
    stored_skip_dates = assignment.irregularity_skip_dates if assignment is not None else []
    stored_skip_dates = stored_skip_dates if isinstance(stored_skip_dates, list) else []
    return {"subjectId": subject.id, "subjectName": metadata.get("name") or subject.barcode,
            "subjectType": subject.kind, "barcode": subject.barcode,
            "ruleIds": effective_rule_ids(subject.kind, rules, assignment),
            "irregularitySkipDates": sorted({day for day in stored_skip_dates
                if isinstance(day, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", day)}),
            "source": "custom" if assignment is not None and getattr(assignment, "rules_customized", True) else "default",
            "revision": assignment.revision if assignment is not None else 0}


async def list_alert_rule_assignments(db):
    rules = await assignment_rule_catalog(db)
    # Metadata and overrides are fetched in bulk; no relationship lazy loads
    # or per-subject rule queries are needed for this directory.
    subjects = (await db.execute(select(Subject, Person.data, HardwareAsset.data)
        .outerjoin(Person, Person.subject_id == Subject.id)
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
        .where(Subject.kind.in_(("employee", "hardware"))).order_by(Subject.id))).all()
    overrides = {row.subject_id: row for row in (await db.scalars(select(AlertRuleAssignment))).all()}
    return {"rules": rules, "subjects": [assignment_document(subject,
        hardware if subject.kind == "hardware" else person, rules, overrides.get(subject.id))
        for subject, person, hardware in subjects]}


def validate_selected_rules(subject_type, rule_ids, rules):
    if subject_type not in {"employee", "hardware"}:
        raise HTTPException(422, "Alert rules may be assigned to registered employees and hardware only")
    if (not isinstance(rule_ids, list) or len(rule_ids) > 100
            or any(not isinstance(rule_id, str) for rule_id in rule_ids)
            or len(set(rule_ids)) != len(rule_ids)):
        raise HTTPException(422, "Choose each registered alert rule once")
    catalog = {rule["id"]: rule for rule in rules}
    if any(rule_id not in catalog or subject_type not in catalog[rule_id]["eligibleSubjectTypes"] for rule_id in rule_ids):
        raise HTTPException(422, "Selected alert rules are not eligible for this subject")
    return sorted(rule_ids)


async def replace_alert_rule_assignment(db, subject_id, rule_ids, actor, expected_revision=None, irregularity_skip_dates=None):
    await lock_scheduled_alert_evaluation(db)
    result = await db.execute(select(Subject, Person.data, HardwareAsset.data)
        .outerjoin(Person, Person.subject_id == Subject.id)
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
        .where(Subject.id == subject_id).with_for_update(of=Subject))
    row = result.one_or_none()
    if row is None:
        raise HTTPException(404, "Subject not found")
    subject, person, hardware = row
    rules = await assignment_rule_catalog(db)
    selected = validate_selected_rules(subject.kind, rule_ids, rules)
    assignment = await db.scalar(select(AlertRuleAssignment).where(AlertRuleAssignment.subject_id == subject.id).with_for_update())
    revision = assignment.revision if assignment is not None else 0
    skip_dates = (assignment.irregularity_skip_dates if assignment is not None else []) if irregularity_skip_dates is None else [
        day.isoformat() if isinstance(day, date) else day for day in irregularity_skip_dates
    ]
    existing_skip_dates = {day for day in assignment.irregularity_skip_dates if isinstance(day, str)} if assignment is not None and isinstance(assignment.irregularity_skip_dates, list) else set()
    today, latest_allowed_date = irregularity_skip_date_window()
    try:
        valid_skip_dates = isinstance(skip_dates, list) and len(skip_dates) <= 366 and all(
            isinstance(day, str) and date.fromisoformat(day).isoformat() == day
            and date.fromisoformat(day) <= latest_allowed_date
            and (date.fromisoformat(day) >= today or day in existing_skip_dates)
            for day in skip_dates
        )
    except ValueError:
        valid_skip_dates = False
    if not valid_skip_dates:
        raise HTTPException(422, "Choose skip dates from today through the next six months")
    skip_dates = sorted(set(skip_dates))
    if subject.kind != "employee" and skip_dates:
        raise HTTPException(422, "Irregularity skip dates can be assigned to employees only")
    metadata = hardware if subject.kind == "hardware" else person
    default_rule_ids = effective_rule_ids(subject.kind, rules)
    rules_customized = selected != default_rule_ids
    if assignment is not None and getattr(assignment, "rules_customized", True):
        rules_customized = True
    if (assignment is not None and assignment.rule_ids == selected
            and getattr(assignment, "rules_customized", True) == rules_customized
            and (assignment.irregularity_skip_dates or []) == skip_dates):
        return assignment_document(subject, metadata, rules, assignment), False
    if expected_revision is not None and expected_revision != revision:
        raise HTTPException(409, "Alert rule assignments changed; reload before saving")
    previous = effective_rule_ids(subject.kind, rules, assignment)
    previous_skip_dates = assignment.irregularity_skip_dates if assignment is not None and isinstance(assignment.irregularity_skip_dates, list) else []
    previous_rules_customized = assignment is not None and getattr(assignment, "rules_customized", True)
    previous_source = "custom" if previous_rules_customized else "default"
    now = datetime.now(timezone.utc)
    if assignment is None:
        assignment = AlertRuleAssignment(subject_id=subject.id, rule_ids=selected, rules_customized=rules_customized,
            irregularity_skip_dates=skip_dates, revision=1, updated_by=actor, updated_at=now)
        db.add(assignment)
    else:
        assignment.rule_ids = selected
        assignment.rules_customized = rules_customized
        assignment.irregularity_skip_dates = skip_dates
        assignment.revision += 1
        assignment.updated_by = actor
        assignment.updated_at = now
    audit_id = "AUD-" + uuid.uuid4().hex
    document = assignment_document(subject, metadata, rules, assignment)
    db.add(AuditEvent(id=audit_id, created_at=now, data={
        "id": audit_id, "category": "alert", "action": "Alert rule assignments updated",
        "subjectId": subject.id, "subjectName": document["subjectName"], "barcode": subject.barcode,
        "actor": actor, "role": "Administrator", "decision": "logged",
        "reason": "Per-subject automated rule selections and irregularity skip dates saved.", "relatedId": subject.id,
        "previousRuleIds": previous, "previousSource": previous_source,
        "previousIrregularitySkipDates": previous_skip_dates, "irregularitySkipDates": skip_dates,
        "previousRulesCustomized": previous_rules_customized,
        "rulesCustomized": rules_customized,
        "ruleIds": selected, "assignmentRevision": assignment.revision, "createdAt": now.isoformat(),
    }))
    await db.flush()
    return document, True
