"""Focused alert command-center reads; history remains in the paginated alert API."""
from sqlalchemy import select, func, or_, cast
from sqlalchemy.dialects.postgresql import JSONPATH

from alert_rule_assignments import assignment_document, irregularity_skip_date_window
from data_limits import bounded_rows
from models import AlertReview, AlertRuleAssignment, Person, Subject, WarningReset
from alert_reviews import review_document


async def focused_alert_people(db, subject_ids):
    """Only people actually displayed on this page, not the complete directory."""
    if not subject_ids:
        return []
    rows = await bounded_rows(db, select(Subject, Person.data)
        .join(Person, Person.subject_id == Subject.id)
        .where(Subject.id.in_(subject_ids), Subject.kind.in_(("employee", "visitor")))
        .order_by(Subject.id))
    return [{**(data or {}), "id": subject.id, "barcode": subject.barcode,
        "type": subject.kind, "status": (data or {}).get("status", "active")}
        for subject, data in rows]


async def confirmed_people_warning_total(db, subject_ids=None):
    """Count the authoritative review ledger without disclosing subject directories."""
    return int(await db.scalar(select(func.count()).select_from(AlertReview)
        .join(Subject, Subject.id == AlertReview.subject_id)
        .outerjoin(WarningReset, WarningReset.subject_id == AlertReview.subject_id)
        .where(Subject.kind.in_(("employee", "visitor")), AlertReview.decision == "confirmed",
            *([AlertReview.subject_id.in_(subject_ids)] if subject_ids is not None else []),
            or_(WarningReset.reset_at.is_(None), AlertReview.reviewed_at > WarningReset.reset_at))) or 0)


async def current_subject_warning_documents(db, subject_id, summary):
    """At most three current warnings; review snapshots survive alert retention."""
    reviews = (await db.scalars(select(AlertReview)
        .outerjoin(WarningReset, WarningReset.subject_id == AlertReview.subject_id)
        .where(AlertReview.subject_id == subject_id, AlertReview.decision == "confirmed",
            or_(WarningReset.reset_at.is_(None), AlertReview.reviewed_at > WarningReset.reset_at))
        .order_by(AlertReview.reviewed_at.desc(), AlertReview.alert_id.asc()).limit(3))).all()
    documents = []
    for review in reviews:
        data = {**(review.alert_data or {}), "id": review.alert_id, "status": "warned",
            "createdAt": review.alert_created_at.isoformat(), "review": review_document(review),
            "subjectId": subject_id, "warningCount": (summary or {}).get("count", 0),
            "entryRestriction": (summary or {}).get("entryRestriction")}
        if summary:
            data.update(subjectName=summary["subjectName"], barcode=summary["barcode"], subjectType=summary["subjectType"])
        documents.append(data)
    return documents


async def command_center_assignments(db, rules, *, subject_id=None, subject_ids=None):
    """Return one employee's settings, or only employees with upcoming skip dates."""
    today, maximum = irregularity_skip_date_window()
    query = (select(Subject, Person.data, AlertRuleAssignment)
        .join(Person, Person.subject_id == Subject.id)
        .outerjoin(AlertRuleAssignment, AlertRuleAssignment.subject_id == Subject.id)
        .where(Subject.kind == "employee").order_by(Subject.id))
    if subject_id is not None:
        query = query.where(Subject.id == subject_id)
    else:
        future_dates = f'$[*] ? (@ >= "{today.isoformat()}" && @ <= "{maximum.isoformat()}")'
        query = query.where(func.jsonb_path_exists(AlertRuleAssignment.irregularity_skip_dates,
            cast(future_dates, JSONPATH)))
        if subject_ids is not None:
            query = query.where(Subject.id.in_(subject_ids))
    attendance_rules = [rule for rule in rules if rule.get("conditionKey") in {"no_break", "irregularity"}]
    rows = await bounded_rows(db, query)
    documents = [assignment_document(subject, metadata, attendance_rules, assignment)
        for subject, metadata, assignment in rows]
    if subject_id is None:
        for document in documents:
            document["irregularitySkipDates"] = [day for day in document["irregularitySkipDates"]
                if today.isoformat() <= day <= maximum.isoformat()]
    return documents
