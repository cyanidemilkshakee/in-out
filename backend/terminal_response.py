"""Explicitly project scan receipts onto the fields a terminal may receive."""


SUBJECT_FIELDS = frozenset({
    "id", "name", "type", "barcode", "status", "inside", "allowedZones",
    "validFrom", "validTo", "createdAt", "category",
})
EVENT_FIELDS = frozenset({
    "id", "date", "time", "checkpointId", "checkpoint", "direction",
    "subjectId", "subjectName", "subjectType", "barcode", "result", "reason",
    "denialCode", "scanType", "captureMethod", "syncState", "hardwareIds",
    "sourceEventId", "createdAt", "capturedOfflineAt", "source", "paperReference",
    "loggedAt", "historicalVisitId", "manualReviewedAt", "overrideRequestId",
    "manualApprovalRequestId", "hardwareSnapshots",
})
REQUEST_FIELDS = frozenset({
    "id", "type", "subjectId", "subjectName", "subjectType", "requester",
    "purpose", "requestedZones", "validFrom", "validTo", "status", "createdAt",
    "barcode", "checkpointId", "checkpoint", "direction", "eventId",
    "operatorNote", "decisionReason", "notificationDismissedAt",
    "notificationDismissedBy", "decidedAt", "consumedAt", "consumedMovementId",
    "consumedBy",
})
RESTRICTION_FIELDS = frozenset({"subjectId", "active", "triggeredAt", "triggerAlertId"})


def _project(value, fields):
    if not isinstance(value, dict):
        return {}
    return {key: value[key] for key in fields if key in value}


def _project_subject(value):
    return _project(value, SUBJECT_FIELDS)


def _project_request(value):
    return _project(value, REQUEST_FIELDS)


def project_terminal_scan_response(response):
    """Drop arbitrary subject JSON, custody metadata and internal fields."""
    if not isinstance(response, dict):
        return response
    result = {key: response[key] for key in (
        "allowed", "reason", "subject_id", "replayed", "authorizeMovement"
    ) if key in response}
    decision = response.get("decision")
    if isinstance(decision, dict):
        projected_decision = {key: decision[key] for key in ("replayed", "authorizeMovement") if key in decision}
        event = decision.get("event")
        if isinstance(event, dict):
            projected_event = _project(event, EVENT_FIELDS)
            snapshots = event.get("hardwareSnapshots")
            if isinstance(snapshots, list):
                projected_event["hardwareSnapshots"] = [
                    _project(item, {"id", "name", "barcode"}) for item in snapshots if isinstance(item, dict)
                ]
            projected_decision["event"] = projected_event
        if isinstance(decision.get("subject"), dict):
            projected_decision["subject"] = _project_subject(decision["subject"])
        if isinstance(decision.get("carriedHardware"), list):
            projected_decision["carriedHardware"] = [
                _project_subject(item) for item in decision["carriedHardware"] if isinstance(item, dict)
            ]
        if isinstance(decision.get("entryRestrictions"), list):
            projected_decision["entryRestrictions"] = [
                _project(item, RESTRICTION_FIELDS) for item in decision["entryRestrictions"] if isinstance(item, dict)
            ]
        result["decision"] = projected_decision
    for key in ("updatedPeople", "updatedHardwareAssets"):
        if isinstance(response.get(key), list):
            result[key] = [_project_subject(item) for item in response[key] if isinstance(item, dict)]
    if isinstance(response.get("manualApprovalRequest"), dict):
        result["manualApprovalRequest"] = _project_request(response["manualApprovalRequest"])
    return result
