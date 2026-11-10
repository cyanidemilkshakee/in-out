"""Build a complete, local-only five-zone InOut walkthrough dataset.

This script is intentionally opt-in and destructive to application data. It
preserves PostgreSQL schema/migration metadata, Keycloak's schema, and Temporal's
databases. The Compose demo-seed profile supplies credentials only to this
one-shot container and writes test login credentials to a gitignored volume.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from event_outbox import enqueue_changed, enqueue_workflow_start
from rule_engine import default_alert_rules, evaluate_visitor_permission_overstay_rules
from seed import seed_reference_rows
from terminal_assignments import enqueue_checkpoint_assignment


DATABASE_URL = os.getenv("DATABASE_URL", "")
KEYCLOAK_BASE = os.getenv("KEYCLOAK_ADMIN_BASE", "http://keycloak:1022").rstrip("/")
KEYCLOAK_ADMIN_USERNAME = os.getenv("KEYCLOAK_ADMIN_USERNAME", "")
KEYCLOAK_ADMIN_PASSWORD = os.getenv("KEYCLOAK_ADMIN_PASSWORD", "")
CREDENTIALS_PATH = Path(os.getenv("DEMO_CREDENTIALS_PATH", "/output/full-demo-accounts.csv"))

ZONE_SPECS = (
    ("a", "North Campus"),
    ("b", "South Campus"),
    ("c", "East Campus"),
    ("d", "West Campus"),
    ("e", "Central Campus"),
)
CHECKPOINT_SPECS = (
    (1, "front_gate", True, "Front Gate"),
    (2, "back_gate", False, "Back Gate"),
    (3, "custom", False, "Staff Entrance"),
    (4, "custom", False, "Loading Bay"),
)
FIRST_NAMES = (
    "Aarav", "Aditi", "Ananya", "Arjun", "Diya", "Ishaan", "Kavya", "Meera", "Rohan", "Vivaan",
    "Ira", "Kabir", "Mira", "Neel", "Riya", "Sana", "Dev", "Tara", "Vihaan", "Zoya",
    "Advik", "Avni", "Ishita", "Reyansh", "Saanvi",
)
LAST_NAMES = (
    "Rao", "Shah", "Iyer", "Nair", "Patel", "Menon", "Kapoor", "Das", "Reddy", "Verma",
    "Joshi", "Bose", "Khan", "Mehta", "Pillai", "Saxena", "Sen", "Malik", "Kulkarni", "Gupta",
)
COMPANIES = (
    "Meridian Systems", "Northstar Logistics", "BluePeak Services", "Cedar Manufacturing",
    "Harborline Facilities", "Summit Field Operations",
)
JOB_TITLES = (
    "Operations associate", "Site coordinator", "Quality analyst", "Team lead",
    "Facilities technician", "Inventory specialist", "Security supervisor", "Project engineer",
)
HARDWARE_TYPES = (
    ("Laptop", "Operations laptop"), ("Tablet", "Field tablet"), ("Scanner", "Barcode scanner"),
    ("Radio", "Security radio"), ("Camera", "Inspection camera"), ("Badge printer", "Badge printer"),
)
VISITOR_PURPOSES = (
    "Supplier meeting", "Facilities inspection", "Project review", "Equipment delivery",
    "Contractor work", "Candidate interview", "Safety audit", "Client demonstration",
)
APP_ROLES = frozenset({"master-admin", "zone-admin", "operator"})


def as_iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def display_name(index: int, *, offset: int = 0) -> str:
    value = index + offset
    return f"{FIRST_NAMES[value % len(FIRST_NAMES)]} {LAST_NAMES[(value // len(FIRST_NAMES)) % len(LAST_NAMES)]}"


def json_text(value: dict[str, Any]) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def checkpoint_document(zone_id: str, zone_name: str, spec: tuple[int, str, bool, str], now: datetime) -> dict[str, Any]:
    number, gate_type, required, label = spec
    checkpoint_id = f"{zone_id}-{number}"
    return {
        "id": checkpoint_id,
        "name": label if gate_type == "custom" else str(number),
        "mode": "auto",
        "zone": zone_id,
        "zoneId": zone_id,
        "zoneName": zone_name,
        "buildingId": zone_id,
        "checkpointNumber": number,
        "gateType": gate_type,
        "gateLabel": label,
        "required": required,
        "active": True,
        "online": True,
        "createdAt": now.isoformat(),
    }


def make_scan(
    *, event_id: str, subject_id: str | None, subject_name: str, subject_type: str, barcode: str,
    checkpoint: dict[str, Any], zone_name: str, direction: str, result: str, reason: str,
    happened_at: datetime, operator_identity: str, hardware: list[dict[str, Any]] | None = None,
    denial_code: str | None = None,
) -> dict[str, Any]:
    from movement_logic import _current_date, _current_time

    hardware = hardware or []
    data = {
        "id": event_id,
        "date": _current_date(happened_at),
        "time": _current_time(happened_at),
        "checkpointId": checkpoint["id"],
        "checkpoint": f"{zone_name} · {checkpoint['gateLabel']}",
        "direction": direction,
        "subjectId": subject_id or "",
        "subjectName": subject_name,
        "subjectType": subject_type,
        "barcode": barcode,
        "result": result,
        "reason": reason,
        "scanType": "auto",
        "captureMethod": "scanner",
        "operatorIdentity": operator_identity,
        "syncState": "synced",
        "hardwareIds": [asset["id"] for asset in hardware],
        "hardwareSnapshots": [{"id": asset["id"], "name": asset["name"], "barcode": asset["barcode"]}
                              for asset in hardware],
        "createdAt": happened_at.isoformat(),
    }
    if denial_code:
        data["denialCode"] = denial_code
    return data


def movement_row(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": event["id"],
        "subject_id": event.get("subjectId") or None,
        "checkpoint_id": event["checkpointId"],
        "occurred_at": datetime.fromisoformat(event["createdAt"]),
        "result": event["result"],
        "direction": event["direction"],
        "denial_code": event.get("denialCode"),
        "scan_type": event.get("scanType", "auto"),
        "subject_type": event["subjectType"],
        "sync_state": event.get("syncState", "synced"),
        "data": json_text(event),
    }


async def _kc_request(client: httpx.AsyncClient, method: str, path: str, **kwargs):
    response = await client.request(method, path, **kwargs)
    if response.is_error:
        # Keep credentials and token data out of logs and exception messages.
        raise RuntimeError(f"Keycloak test-account provisioning failed: {method} {path} returned HTTP {response.status_code}")
    return response


async def _keycloak_user(client: httpx.AsyncClient, username: str) -> dict[str, Any] | None:
    response = await _kc_request(client, "GET", "/admin/realms/inout/users",
        params={"username": username, "exact": "true"})
    matches = [row for row in response.json() if row.get("username") == username]
    if len(matches) > 1:
        raise RuntimeError(f"Keycloak returned duplicate demo username {username}")
    return matches[0] if matches else None


async def ensure_demo_account(
    client: httpx.AsyncClient, role_reps: dict[str, dict[str, Any]], *, username: str, role: str,
    first_name: str, last_name: str, email: str, zone_id: str = "", checkpoint_id: str = "",
) -> dict[str, str]:
    current = await _keycloak_user(client, username)
    attributes = {
        "inout_demo_seed": ["full-demo-v1"],
        "inout_demo_role": [role],
        "inout_demo_zone": [zone_id] if zone_id else [],
        "inout_demo_checkpoint": [checkpoint_id] if checkpoint_id else [],
    }
    body = {
        "username": username,
        "firstName": first_name,
        "lastName": last_name,
        "email": email,
        "enabled": True,
        "emailVerified": True,
        "attributes": attributes,
        "requiredActions": [],
    }
    if current:
        current_attributes = current.get("attributes") if isinstance(current.get("attributes"), dict) else {}
        marked_demo_user = current_attributes.get("inout_demo_seed") in (["full-demo-v1"], "full-demo-v1")
        exact_demo_profile = (
            current.get("email") == email
            and current.get("firstName") == first_name
            and current.get("lastName") == last_name
            and email.endswith("@example.test")
        )
        if not (marked_demo_user or exact_demo_profile):
            raise RuntimeError(f"Refusing to overwrite Keycloak account {username!r}: it does not match the generated demo profile")
        await _kc_request(client, "PUT", f"/admin/realms/inout/users/{quote(current['id'], safe='')}", json=body)
        user_id = current["id"]
    else:
        await _kc_request(client, "POST", "/admin/realms/inout/users", json=body)
        created = await _keycloak_user(client, username)
        if not created or not isinstance(created.get("id"), str):
            raise RuntimeError(f"Keycloak did not return the new demo account {username!r}")
        user_id = created["id"]

    existing_roles = (await _kc_request(client, "GET",
        f"/admin/realms/inout/users/{quote(user_id, safe='')}/role-mappings/realm")).json()
    remove_roles = [item for item in existing_roles if item.get("name") in APP_ROLES and item.get("name") != role]
    if remove_roles:
        await _kc_request(client, "DELETE",
            f"/admin/realms/inout/users/{quote(user_id, safe='')}/role-mappings/realm", json=remove_roles)
    if not any(item.get("name") == role for item in existing_roles):
        await _kc_request(client, "POST",
            f"/admin/realms/inout/users/{quote(user_id, safe='')}/role-mappings/realm",
            json=[role_reps[role]])

    password = secrets.token_urlsafe(32) + "aA1!"
    await _kc_request(client, "PUT",
        f"/admin/realms/inout/users/{quote(user_id, safe='')}/reset-password",
        json={"type": "password", "value": password, "temporary": False})
    return {"id": user_id, "username": username, "password": password, "role": role,
            "zoneId": zone_id, "checkpointId": checkpoint_id, "email": email}


async def provision_keycloak_identities() -> dict[str, Any]:
    if not KEYCLOAK_ADMIN_USERNAME or not KEYCLOAK_ADMIN_PASSWORD:
        raise RuntimeError("Set KEYCLOAK_ADMIN_USERNAME and KEYCLOAK_ADMIN_PASSWORD in .env before provisioning demo operators")
    async with httpx.AsyncClient(base_url=KEYCLOAK_BASE, timeout=20.0) as unauthenticated:
        token_response = await unauthenticated.post("/realms/master/protocol/openid-connect/token", data={
            "grant_type": "password",
            "client_id": "admin-cli",
            "username": KEYCLOAK_ADMIN_USERNAME,
            "password": KEYCLOAK_ADMIN_PASSWORD,
        })
        if token_response.is_error or not token_response.json().get("access_token"):
            raise RuntimeError(f"Could not authenticate the configured Keycloak bootstrap administrator (HTTP {token_response.status_code}); application data was not reset")
        headers = {"Authorization": "Bearer " + token_response.json()["access_token"]}

    accounts: list[dict[str, str]] = []
    identities: dict[str, Any] = {"masterAdmin": {}, "zoneAdmins": [], "operators": []}
    async with httpx.AsyncClient(base_url=KEYCLOAK_BASE, headers=headers, timeout=20.0) as client:
        role_reps = {}
        for role in APP_ROLES:
            role_reps[role] = (await _kc_request(client, "GET", f"/admin/realms/inout/roles/{quote(role, safe='')}")).json()

        master = await ensure_demo_account(client, role_reps, username="demo-master-admin", role="master-admin",
            first_name="Demo", last_name="Master Admin", email="demo-master-admin@example.test")
        identities["masterAdmin"] = {key: master[key] for key in ("id", "username", "role")}
        accounts.append(master)

        for zone_index, (zone_id, zone_name) in enumerate(ZONE_SPECS):
            zone_label = zone_id.upper()
            admin = await ensure_demo_account(client, role_reps,
                username=f"demo-zone-{zone_id}-admin", role="zone-admin",
                first_name=zone_name, last_name="Zone Administrator",
                email=f"demo-zone-{zone_id}-admin@example.test", zone_id=zone_id)
            identities["zoneAdmins"].append({key: admin[key] for key in ("id", "username", "role", "zoneId")})
            accounts.append(admin)

            for operator_number in range(1, 8):
                checkpoint_number = (operator_number - 1) % 4 + 1
                checkpoint_id = f"{zone_id}-{checkpoint_number}"
                display_number = zone_index * 7 + operator_number
                operator = await ensure_demo_account(client, role_reps,
                    username=f"demo-operator-{zone_id}-{operator_number:02d}", role="operator",
                    first_name="Demo", last_name=f"Operator {display_number:02d}",
                    email=f"demo-operator-{zone_id}-{operator_number:02d}@example.test",
                    zone_id=zone_id, checkpoint_id=checkpoint_id)
                identities["operators"].append({key: operator[key] for key in ("id", "username", "role", "zoneId", "checkpointId")})
                accounts.append(operator)

    CREDENTIALS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CREDENTIALS_PATH.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=("username", "password", "role", "zoneId", "checkpointId", "email", "keycloakUserId"))
        writer.writeheader()
        for account in accounts:
            writer.writerow({"username": account["username"], "password": account["password"],
                "role": account["role"], "zoneId": account["zoneId"],
                "checkpointId": account["checkpointId"], "email": account["email"],
                "keycloakUserId": account["id"]})
    print(f"✓ Provisioned {len(accounts)} demo Keycloak identities; credentials saved to {CREDENTIALS_PATH}.")
    return identities


async def reset_application_rows(db) -> None:
    """Clear app-owned public-schema records while keeping migrations and other schemas."""
    await db.execute(text("""
        DO $reset$
        DECLARE item record;
        BEGIN
            FOR item IN
                SELECT tablename FROM pg_tables
                WHERE schemaname = 'public' AND tablename <> 'alembic_version'
            LOOP
                EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', item.tablename);
            END LOOP;
        END
        $reset$;
    """))


def identity_maps(identities: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    zone_admins = {row["zoneId"]: row for row in identities.get("zoneAdmins", [])}
    operators_by_checkpoint: dict[str, list[dict[str, Any]]] = {}
    for operator in identities.get("operators", []):
        operators_by_checkpoint.setdefault(operator["checkpointId"], []).append(operator)
    expected_zones = {zone_id for zone_id, _ in ZONE_SPECS}
    if set(zone_admins) != expected_zones:
        raise RuntimeError("The Keycloak identity set does not contain exactly one zone administrator per demo zone")
    if len(identities.get("operators", [])) != 35 or any(
        len(operators_by_checkpoint.get(f"{zone_id}-{number}", [])) < 1
        for zone_id, _ in ZONE_SPECS for number, *_ in CHECKPOINT_SPECS
    ):
        raise RuntimeError("The Keycloak identity set must contain 7 checkpoint-assigned operators per zone")
    if not identities.get("masterAdmin", {}).get("id"):
        raise RuntimeError("The Keycloak identity set is missing the demo master administrator")
    return zone_admins, operators_by_checkpoint


def fixture_records(now: datetime, identities: dict[str, Any]):
    zone_admins, operators_by_checkpoint = identity_maps(identities)
    zone_names = dict(ZONE_SPECS)
    checkpoint_by_id: dict[str, dict[str, Any]] = {}
    zones = [{"id": zone_id, "name": name, "active": True, "created_by": identities["masterAdmin"]["id"]}
             for zone_id, name in ZONE_SPECS]
    checkpoints = []
    for zone_id, zone_name in ZONE_SPECS:
        for spec in CHECKPOINT_SPECS:
            data = checkpoint_document(zone_id, zone_name, spec, now)
            checkpoint_by_id[data["id"]] = data
            checkpoints.append({"id": data["id"], "zone_id": zone_id, "number": spec[0],
                "gate_type": spec[1], "required": spec[2], "active": True, "data": json_text(data)})

    zone_assignment_rows = []
    admin_profile_rows = []
    operator_assignment_rows = []
    for zone_id, zone_name in ZONE_SPECS:
        admin = zone_admins[zone_id]
        zone_assignment_rows.append({"admin_subject": admin["id"], "zone_id": zone_id,
            "assigned_by": identities["masterAdmin"]["id"]})
        admin_profile_rows.append({"id": str(uuid.uuid5(uuid.NAMESPACE_URL, "inout-demo-profile:" + admin["id"])),
            "keycloak_subject": admin["id"], "name": f"{zone_name} Zone Administrator",
            "nickname": f"{zone_name.split()[0]} Admin", "email": f"demo-zone-{zone_id}-admin@example.test",
            "avatar_data_url": "", "offline_until": now + timedelta(hours=2), "settings": "{}", "created_at": now})
    master = identities["masterAdmin"]
    admin_profile_rows.append({"id": str(uuid.uuid5(uuid.NAMESPACE_URL, "inout-demo-profile:" + master["id"])),
        "keycloak_subject": master["id"], "name": "Demo Master Administrator", "nickname": "Master Admin",
        "email": "demo-master-admin@example.test", "avatar_data_url": "", "offline_until": None,
        "settings": "{}", "created_at": now})

    for zone_id, _ in ZONE_SPECS:
        for number, *_ in CHECKPOINT_SPECS:
            cp_id = f"{zone_id}-{number}"
            for operator in operators_by_checkpoint[cp_id]:
                # Checkpoint 4 has a deliberate stale heartbeat in each zone;
                # the other terminals appear connected for offline-alert testing.
                last_seen = now - timedelta(minutes=20) if number == 4 else now - timedelta(seconds=30)
                operator_assignment_rows.append({"terminal_identity": "browser:" + operator["id"],
                    "checkpoint_id": cp_id, "last_heartbeat_at": last_seen, "updated_at": last_seen})

    subjects: list[dict[str, Any]] = []
    people: list[dict[str, Any]] = []
    hardware_assets: list[dict[str, Any]] = []
    permissions: list[dict[str, Any]] = []
    presence: list[dict[str, Any]] = []
    employees: list[dict[str, Any]] = []
    hardware_by_employee: dict[str, dict[str, Any]] = {}
    visitors: list[dict[str, Any]] = []
    visitor_requests: list[dict[str, Any]] = []
    audit_rows: list[dict[str, Any]] = []
    rule_assignment_rows: list[dict[str, Any]] = []
    movement_rows: list[dict[str, Any]] = []
    movement_events: dict[str, dict[str, Any]] = {}
    note_rows: list[dict[str, Any]] = []
    alert_rows: list[dict[str, Any]] = []
    pending_visitor_request_ids: list[str] = []
    pending_manual_request_ids: list[str] = []

    def add_movement(event: dict[str, Any]) -> None:
        movement_events[event["id"]] = event
        movement_rows.append(movement_row(event))

    def operator_identity(checkpoint_id: str, ordinal: int = 0) -> str:
        assigned = operators_by_checkpoint[checkpoint_id]
        return "browser:" + assigned[ordinal % len(assigned)]["id"]

    # 500 employees: 100 anchored in each zone. Some receive adjacent-zone or
    # all-zone grants; others are restricted to one or two explicit gates.
    for zone_index, (zone_id, zone_name) in enumerate(ZONE_SPECS):
        adjacent = ZONE_SPECS[(zone_index + 1) % len(ZONE_SPECS)][0]
        for offset in range(100):
            number = zone_index * 100 + offset + 1
            subject_id = f"demo-employee-{number:04d}"
            barcode = f"DEMO-EMP-{number:04d}"
            name = display_name(number - 1)
            status = "active" if offset < 10 or offset >= 20 else ("restricted" if offset < 15 else "inactive")
            inside = offset < 10
            if offset >= 90:
                allowed_zones = [value for value, _ in ZONE_SPECS]
            elif offset >= 70:
                allowed_zones = [zone_id, adjacent]
            else:
                allowed_zones = [zone_id]
            explicit_checkpoints = ([f"{zone_id}-1"] if offset % 4 == 0 else
                [f"{zone_id}-1", f"{zone_id}-2"] if offset % 4 == 1 else None)
            created_at = now - timedelta(days=120 - (number % 120))
            employee = {
                "id": subject_id, "barcode": barcode, "name": name, "type": "employee",
                "email": f"employee-{number:04d}@example.test", "phone": f"+919700{number:06d}",
                "employeeNumber": f"EMP-{number:04d}", "company": COMPANIES[number % len(COMPANIES)],
                "jobTitle": JOB_TITLES[number % len(JOB_TITLES)], "status": status,
                "allowedZones": allowed_zones, "inside": inside,
                "validFrom": (now - timedelta(days=365)).isoformat(), "validTo": "",
                "createdAt": created_at.isoformat(),
            }
            if explicit_checkpoints:
                employee["allowedCheckpoints"] = explicit_checkpoints
            employees.append(employee)
            subjects.append({"id": subject_id, "kind": "employee", "barcode": barcode})
            people.append({"subject_id": subject_id, "data": json_text(employee)})
            grant = {"id": f"demo-permission-employee-{number:04d}", "subjectId": subject_id,
                "subjectName": name, "subjectType": "employee", "assignment": "Employee",
                "state": "active" if status == "active" else "restricted", "zones": allowed_zones,
                "validFrom": employee["validFrom"], "validTo": "", "source": "seed"}
            if explicit_checkpoints is not None:
                grant["checkpoints"] = explicit_checkpoints
            permissions.append({"id": grant["id"], "subject_id": subject_id, "data": json_text(grant)})
            presence.append({"subject_id": subject_id, "state": "inside" if inside else "outside",
                "entry_building_id": zone_id if inside else None,
                "last_scan_timestamp": now - timedelta(days=1) if inside else now - timedelta(days=1),
                "entry_started_at": now - timedelta(days=1) if inside else None,
                "alerted_valid_to": None})
            if offset % 10 == 0:
                rule_assignment_rows.append({"subject_id": subject_id,
                    "rule_ids": json_text(["rule-no-break", "rule-irregularity"]),
                    "revision": 1, "updated_by": zone_admins[zone_id]["id"]})

    employee_by_id = {row["id"]: row for row in employees}

    # 500 assets, including assigned custody, unassigned inventory, and
    # non-active states. Each zone gets 80 assigned and 20 unassigned items.
    for zone_index, (zone_id, zone_name) in enumerate(ZONE_SPECS):
        for offset in range(100):
            number = zone_index * 100 + offset + 1
            subject_id = f"demo-hardware-{number:04d}"
            barcode = f"DEMO-HW-{number:04d}"
            category, label = HARDWARE_TYPES[number % len(HARDWARE_TYPES)]
            assigned_employee = employee_by_id[f"demo-employee-{zone_index * 100 + offset + 1:04d}"] if offset < 80 else None
            status = "active" if assigned_employee or offset % 4 else ("maintenance" if offset % 2 else "retired")
            allowed_zones = list(assigned_employee["allowedZones"]) if assigned_employee else [zone_id]
            allowed_checkpoints = list(assigned_employee["allowedCheckpoints"]) if assigned_employee and assigned_employee.get("allowedCheckpoints") else None
            inside = bool(assigned_employee and assigned_employee["inside"] and status == "active")
            created_at = now - timedelta(days=30 + number % 180)
            asset = {
                "id": subject_id, "barcode": barcode, "type": "hardware", "name": f"{label} {number:04d}",
                "category": category, "owner": assigned_employee["name"] if assigned_employee else "Unassigned",
                "assignedEmployeeId": assigned_employee["id"] if assigned_employee else "",
                "assignedEmployeeName": assigned_employee["name"] if assigned_employee else "",
                "status": status, "allowedZones": allowed_zones, "inside": inside,
                "createdAt": created_at.isoformat(),
            }
            if allowed_checkpoints:
                asset["allowedCheckpoints"] = allowed_checkpoints
            if assigned_employee is not None and status == "active":
                hardware_by_employee[assigned_employee["id"]] = asset
            subjects.append({"id": subject_id, "kind": "hardware", "barcode": barcode})
            hardware_assets.append({"subject_id": subject_id, "data": json_text(asset)})
            grant = {"id": f"demo-permission-hardware-{number:04d}", "subjectId": subject_id,
                "subjectName": asset["name"], "subjectType": "hardware", "assignment": "Hardware",
                "state": "active" if status == "active" else "restricted", "zones": allowed_zones,
                "validFrom": "", "validTo": "", "source": "seed"}
            if allowed_checkpoints is not None:
                grant["checkpoints"] = allowed_checkpoints
            permissions.append({"id": grant["id"], "subject_id": subject_id, "data": json_text(grant)})
            presence.append({"subject_id": subject_id, "state": "inside" if inside else "outside",
                "entry_building_id": zone_id if inside else None,
                "last_scan_timestamp": now - timedelta(days=1) if inside else now - timedelta(days=1),
                "entry_started_at": now - timedelta(days=1) if inside else None, "alerted_valid_to": None})

    for event_number, employee in enumerate(employees, start=1):
        zone_id = employee["allowedZones"][0]
        zone_index = next(index for index, (candidate, _) in enumerate(ZONE_SPECS) if candidate == zone_id)
        zone_name = zone_names[zone_id]
        checkpoint_scope = employee.get("allowedCheckpoints")
        entry_checkpoint = checkpoint_by_id[checkpoint_scope[0]] if checkpoint_scope else checkpoint_by_id[f"{zone_id}-1"]
        exit_checkpoint = checkpoint_by_id[checkpoint_scope[0]] if checkpoint_scope else checkpoint_by_id[f"{zone_id}-2"]
        next_zone = ZONE_SPECS[(zone_index + 1) % len(ZONE_SPECS)][0]
        wrong_checkpoint = checkpoint_by_id[f"{next_zone}-1"] if next_zone not in employee["allowedZones"] else entry_checkpoint
        hardware = [hardware_by_employee[employee["id"]]] if employee["id"] in hardware_by_employee else []
        base = now - timedelta(days=45) + timedelta(seconds=event_number * 11)
        second = now - timedelta(days=30) + timedelta(minutes=event_number)
        third = now - timedelta(days=14) + timedelta(minutes=event_number * 2)
        recent = now - timedelta(days=1) + timedelta(minutes=event_number)
        is_active = employee["status"] == "active"
        is_inside = employee["inside"]
        history = [
            (base, "entry", "approved", entry_checkpoint, None, "-"),
            (base + timedelta(minutes=2), "entry", "denied", entry_checkpoint, "already_inside", "Already inside"),
            (base + timedelta(hours=9), "exit", "approved", exit_checkpoint, None, "-"),
            (second, "entry", "approved", entry_checkpoint, None, "-"),
            (second + timedelta(minutes=3), "entry", "denied", wrong_checkpoint,
             "zone_not_permitted" if wrong_checkpoint["zoneId"] != zone_id else "already_inside",
             "Checkpoint zone not permitted" if wrong_checkpoint["zoneId"] != zone_id else "Already inside"),
            (second + timedelta(hours=9), "exit", "approved", exit_checkpoint, None, "-"),
            (third, "entry", "approved", entry_checkpoint, None, "-"),
            (third + timedelta(hours=9), "exit", "approved", exit_checkpoint, None, "-"),
        ]
        if is_active:
            history.append((recent, "entry", "approved", entry_checkpoint, None, "-"))
            if is_inside:
                history.append((recent + timedelta(minutes=2), "entry", "denied", entry_checkpoint,
                    "already_inside", "Already inside"))
            else:
                history.append((recent + timedelta(hours=8), "exit", "approved", exit_checkpoint, None, "-"))
        else:
            denial = "Employee access restricted" if employee["status"] == "restricted" else "Employee access inactive"
            denial_code = "access_restricted" if employee["status"] == "restricted" else "employee_inactive"
            history.extend([
                (recent, "entry", "denied", entry_checkpoint, denial_code, denial),
                (recent + timedelta(minutes=2), "entry", "denied", entry_checkpoint, denial_code, denial),
            ])
        for scan_number, (happened_at, direction, result, checkpoint, denial_code, reason) in enumerate(history, start=1):
            event_id = f"DEMO-EMP-MOVE-{event_number:04d}-{scan_number:02d}"
            event = make_scan(event_id=event_id, subject_id=employee["id"], subject_name=employee["name"],
                subject_type="employee", barcode=employee["barcode"], checkpoint=checkpoint,
                zone_name=zone_names[checkpoint["zoneId"]], direction=direction, result=result,
                reason=reason, happened_at=happened_at, operator_identity=operator_identity(checkpoint["id"], event_number),
                hardware=hardware, denial_code=denial_code)
            add_movement(event)
        # Leave the latest successful attendance timestamp authoritative.
        employee_presence = next(row for row in presence if row["subject_id"] == employee["id"])
        employee_presence["last_scan_timestamp"] = recent if is_active else third + timedelta(hours=9)

    # Fifty recent denied attempts (10 per zone) create real scan-burst input
    # without changing the inside/outside snapshots of the already-present staff.
    burst_source_by_zone: dict[str, dict[str, Any]] = {}
    for zone_id, zone_name in ZONE_SPECS:
        insiders = [employee for employee in employees if employee["allowedZones"][0] == zone_id and employee["inside"]]
        cp = checkpoint_by_id[f"{zone_id}-1"]
        for attempt, employee in enumerate(insiders, start=1):
            happened_at = now - timedelta(seconds=50) + timedelta(seconds=(attempt - 1) * 5)
            hardware = [hardware_by_employee[employee["id"]]] if employee["id"] in hardware_by_employee else []
            event_id = f"DEMO-BURST-{zone_id.upper()}-{attempt:02d}"
            event = make_scan(event_id=event_id, subject_id=employee["id"], subject_name=employee["name"],
                subject_type="employee", barcode=employee["barcode"], checkpoint=cp, zone_name=zone_name,
                direction="entry", result="denied", reason="Already inside", happened_at=happened_at,
                operator_identity=operator_identity(cp["id"], attempt), hardware=hardware, denial_code="already_inside")
            add_movement(event)
            burst_source_by_zone[zone_id] = event

    # Add an explicit cross-zone attempt for a present employee in every zone.
    # It is denied and does not modify presence, while giving alert/audit pages
    # a realistic cross-building example.
    cross_zone_events = []
    for zone_index, (zone_id, zone_name) in enumerate(ZONE_SPECS):
        employee = next(row for row in employees if row["allowedZones"][0] == zone_id and row["inside"])
        other_zone = ZONE_SPECS[(zone_index + 1) % len(ZONE_SPECS)][0]
        cp = checkpoint_by_id[f"{other_zone}-1"]
        event_id = f"DEMO-CROSS-ZONE-{zone_id.upper()}"
        event = make_scan(event_id=event_id, subject_id=employee["id"], subject_name=employee["name"],
            subject_type="employee", barcode=employee["barcode"], checkpoint=cp,
            zone_name=zone_names[other_zone], direction="entry", result="denied",
            reason="Exit the current zone before entering another zone", happened_at=now - timedelta(hours=2),
            operator_identity=operator_identity(cp["id"]), denial_code="cross_building_access")
        add_movement(event)
        cross_zone_events.append((zone_id, employee, event))

    # 500 visitors (100 per zone): active visits, pending approvals, denied and
    # expired passes, plus one current overstay per zone for alert evaluation.
    overstay_visits: list[dict[str, Any]] = []
    visitor_scan_number = 0
    for zone_index, (zone_id, zone_name) in enumerate(ZONE_SPECS):
        local_employees = [row for row in employees if row["allowedZones"][0] == zone_id]
        for offset in range(100):
            number = zone_index * 100 + offset + 1
            subject_id = f"demo-visitor-{number:04d}"
            barcode = f"DEMO-VIS-{number:04d}"
            name = display_name(number - 1, offset=8)
            checkpoint_number = offset % 4 + 1
            cp = checkpoint_by_id[f"{zone_id}-{checkpoint_number}"]
            overstay = offset < 5
            approved = offset < 55
            pending = 55 <= offset < 70
            denied = 70 <= offset < 85
            status = "pre_approved" if approved else "pending_approval" if pending else "restricted" if denied else "expired"
            permission_state = "active" if approved else "pending_approval" if pending else "restricted"
            if overstay:
                valid_from = now - timedelta(days=2)
                valid_to = now - timedelta(minutes=30 + offset)
            elif pending:
                valid_from = now
                valid_to = now + timedelta(hours=8)
            elif denied:
                valid_from = now - timedelta(days=1)
                valid_to = now + timedelta(hours=6)
            elif not approved:
                valid_from = now - timedelta(days=5)
                valid_to = now - timedelta(days=2)
            else:
                valid_from = now - timedelta(days=20)
                valid_to = now + timedelta(days=1 + (offset % 20), hours=3)
            visitor_entry = now - timedelta(days=1) if overstay else now - timedelta(days=10 + offset % 20)
            created_at = now - timedelta(days=offset % 18 + 1)
            host = local_employees[(offset * 7) % len(local_employees)]
            purpose = VISITOR_PURPOSES[number % len(VISITOR_PURPOSES)]
            visitor = {
                "id": subject_id, "barcode": barcode, "name": name, "type": "visitor",
                "email": f"visitor-{number:04d}@example.test", "phone": f"+919800{number:06d}",
                "company": COMPANIES[(number + 1) % len(COMPANIES)], "host": host["name"],
                "purpose": purpose, "status": status, "allowedZones": [zone_id],
                "allowedCheckpoints": [cp["id"]], "inside": overstay,
                "validFrom": valid_from.isoformat(), "validTo": valid_to.isoformat(),
                "createdAt": created_at.isoformat(),
            }
            visitors.append(visitor)
            subjects.append({"id": subject_id, "kind": "visitor", "barcode": barcode})
            people.append({"subject_id": subject_id, "data": json_text(visitor)})
            grant = {"id": f"demo-permission-visitor-{number:04d}", "subjectId": subject_id,
                "subjectName": name, "subjectType": "visitor", "assignment": "Temporary visitor",
                "state": permission_state, "zones": [zone_id], "checkpoints": [cp["id"]],
                "validFrom": visitor["validFrom"], "validTo": visitor["validTo"],
                "source": "seed" if approved else "request"}
            permissions.append({"id": grant["id"], "subject_id": subject_id, "data": json_text(grant)})
            entry_at = visitor_entry
            if overstay:
                presence.append({"subject_id": subject_id, "state": "inside", "entry_building_id": zone_id,
                    "last_scan_timestamp": entry_at, "entry_started_at": entry_at,
                    "alerted_valid_to": valid_to})
                overstay_visits.append({"subjectId": subject_id, "subjectType": "visitor", "state": "inside",
                    "subjectName": name, "barcode": barcode, "buildingId": zone_id, "buildingName": zone_name,
                    "entryStartedAt": entry_at, "permissionValidTo": visitor["validTo"],
                    "alertedPermissionValidTo": None, "checkpointId": cp["id"]})
            else:
                presence.append({"subject_id": subject_id, "state": "outside", "entry_building_id": None,
                    "last_scan_timestamp": entry_at + timedelta(hours=6) if approved else created_at,
                    "entry_started_at": None, "alerted_valid_to": None})

            request_id = f"REQ-DEMO-VIS-{number:04d}"
            request_status = "approved" if approved else "pending" if pending else "denied"
            request_time = now - timedelta(minutes=3 + offset) if pending else created_at
            request_data = {
                "id": request_id, "subjectId": subject_id, "subjectName": name,
                "subjectType": "visitor", "barcode": barcode, "type": "visitor", "purpose": purpose,
                "checkpointId": cp["id"], "checkpoint": cp["gateLabel"], "requester": "Reception",
                "requestedZones": [zone_id], "requestedCheckpoints": [cp["id"]],
                "validFrom": visitor["validFrom"], "validTo": visitor["validTo"],
                "status": request_status, "createdAt": request_time.isoformat(),
                "origin": "full_demo_seed", "zoneId": zone_id,
            }
            if request_status != "pending":
                decision_at = request_time + timedelta(minutes=20 + offset)
                request_data.update(decidedAt=decision_at.isoformat(),
                    decidedBy=zone_admins[zone_id]["id"],
                    decisionReason=("Visit verified by the host." if approved else
                        "Access was not approved for this visit."), appliedAt=decision_at.isoformat())
            else:
                request_data["workflowId"] = "visitor-" + request_id
                pending_visitor_request_ids.append(request_id)
            visitor_requests.append({"id": request_id, "subject_id": subject_id,
                "created_at": request_time, "data": json_text(request_data)})
            if request_status != "pending":
                audit_id = f"AUD-DEMO-VIS-{number:04d}"
                audit_data = {"id": audit_id, "category": "permission",
                    "action": f"Visitor {request_status}", "subjectId": subject_id,
                    "subjectName": name, "barcode": barcode,
                    "actor": zone_admins[zone_id]["id"], "role": "zone-admin",
                    "decision": "granted" if approved else "denied",
                    "reason": request_data["decisionReason"], "relatedId": request_id,
                    "zoneId": zone_id, "createdAt": request_data["decidedAt"]}
                audit_rows.append({"id": audit_id, "created_at": datetime.fromisoformat(request_data["decidedAt"]),
                    "data": json_text(audit_data)})

            visitor_scan_number += 1
            if approved:
                entry_event = make_scan(event_id=f"DEMO-VIS-MOVE-{visitor_scan_number:06d}-IN",
                    subject_id=subject_id, subject_name=name, subject_type="visitor", barcode=barcode,
                    checkpoint=cp, zone_name=zone_name, direction="entry", result="approved", reason="-",
                    happened_at=entry_at, operator_identity=operator_identity(cp["id"], offset))
                add_movement(entry_event)
                if not overstay:
                    exit_event = make_scan(event_id=f"DEMO-VIS-MOVE-{visitor_scan_number:06d}-OUT",
                        subject_id=subject_id, subject_name=name, subject_type="visitor", barcode=barcode,
                        checkpoint=cp, zone_name=zone_name, direction="exit", result="approved", reason="-",
                        happened_at=entry_at + timedelta(hours=6), operator_identity=operator_identity(cp["id"], offset + 1))
                    add_movement(exit_event)
            else:
                if pending:
                    reason, denial_code, scan_at = "Temporary visitor approval pending", "approval_pending", now - timedelta(minutes=8)
                elif denied:
                    reason, denial_code, scan_at = "Not pre-approved", "not_preapproved", now - timedelta(days=2)
                else:
                    reason, denial_code, scan_at = "Temporary barcode expired", "expired_pass", now - timedelta(days=1)
                denied_event = make_scan(event_id=f"DEMO-VIS-MOVE-{visitor_scan_number:06d}-DENIED",
                    subject_id=subject_id, subject_name=name, subject_type="visitor", barcode=barcode,
                    checkpoint=cp, zone_name=zone_name, direction="entry", result="denied", reason=reason,
                    happened_at=scan_at, operator_identity=operator_identity(cp["id"], offset), denial_code=denial_code)
                add_movement(denied_event)

    # Ten unknown-barcode reviews exercise the bounded, timed manual-review
    # workflow. Visitor permission requests above remain unlimited-time waits.
    manual_requests = []
    from movement_logic import _current_date, _current_time
    for zone_index, (zone_id, zone_name) in enumerate(ZONE_SPECS):
        for checkpoint_number in (1, 2):
            cp = checkpoint_by_id[f"{zone_id}-{checkpoint_number}"]
            number = zone_index * 2 + checkpoint_number
            barcode = f"UNKNOWN-DEMO-{zone_id.upper()}-{checkpoint_number}"
            event_id = f"DEMO-UNKNOWN-MOVE-{zone_id.upper()}-{checkpoint_number}"
            happened_at = now - timedelta(minutes=2) + timedelta(seconds=number)
            event = make_scan(event_id=event_id, subject_id=None, subject_name="Unregistered barcode",
                subject_type="visitor", barcode=barcode, checkpoint=cp, zone_name=zone_name,
                direction="entry", result="denied", reason="Barcode not registered", happened_at=happened_at,
                operator_identity=operator_identity(cp["id"]), denial_code="barcode_not_registered")
            add_movement(event)
            request_id = f"REQ-DEMO-MANUAL-{zone_id.upper()}-{checkpoint_number}"
            request_data = {
                "id": request_id, "subjectId": "", "subjectType": "visitor", "subjectName": "Unregistered barcode",
                "barcode": barcode, "requester": operator_identity(cp["id"]),
                "purpose": "Unregistered badge requires a one-entry review.",
                "requestedZones": [zone_id], "validFrom": now.isoformat(),
                "validTo": (now + timedelta(minutes=5)).isoformat(), "status": "pending",
                "type": "manual_override", "direction": "entry", "checkpointId": cp["id"],
                "checkpoint": cp["gateLabel"], "eventId": event_id,
                "date": _current_date(happened_at), "time": _current_time(happened_at),
                "createdAt": now.isoformat(), "origin": "full_demo_seed",
                "operatorNote": "Demo request for manual-review testing.",
            }
            manual_requests.append({"id": request_id, "subject_id": None, "created_at": now,
                "data": json_text(request_data)})
            pending_manual_request_ids.append(request_id)

    # Build a real visitor-overstay alert from the same evaluator the scheduled
    # Temporal activity uses, then store its dedupe timestamp with the visit.
    visitor_alerts = evaluate_visitor_permission_overstay_rules(
        default_alert_rules(), overstay_visits, now=now)
    for alert in visitor_alerts:
        zone_id = alert["entryBuildingId"]
        visitor = next(row for row in visitors if row["id"] == alert["subjectId"])
        data = {**alert, "zoneId": zone_id, "checkpointId": visitor["allowedCheckpoints"][0],
            "createdAt": now.isoformat()}
        alert_rows.append({"id": data["id"], "source_event_id": None, "created_at": now,
            "data": json_text(data)})

    rules = {rule["conditionKey"]: rule for rule in default_alert_rules()}
    # One open scan-burst, cross-zone, denial-rate, and offline example per zone.
    for zone_id, zone_name in ZONE_SPECS:
        burst_event = burst_source_by_zone[zone_id]
        burst_id = f"AL-DEMO-BURST-{zone_id.upper()}"
        burst_data = {"id": burst_id, "severity": "high", "status": "open",
            "title": rules["scan_burst"]["name"], "reason": f"10 scan attempts were recorded at {burst_event['checkpoint']} within 60 seconds.",
            "subjectName": "Checkpoint activity", "subjectId": "", "subjectType": "system", "barcode": "",
            "checkpoint": burst_event["checkpoint"], "checkpointId": burst_event["checkpointId"], "zoneId": zone_id,
            "scanCount": 10, "windowSeconds": 60, "date": burst_event["date"], "time": burst_event["time"],
            "category": "operational", "ruleId": "rule-scan-burst", "conditionKey": "scan_burst",
            "sourceEventId": burst_event["id"], "explanation": "Ten denied attempts occurred inside a 60-second window.",
            "createdAt": burst_event["createdAt"]}
        alert_rows.append({"id": burst_id, "source_event_id": burst_event["id"],
            "created_at": datetime.fromisoformat(burst_event["createdAt"]), "data": json_text(burst_data)})

        _, employee, cross_event = next(row for row in cross_zone_events if row[0] == zone_id)
        cross_id = f"AL-DEMO-CROSS-{zone_id.upper()}"
        cross_data = {"id": cross_id, "severity": "high", "status": "open",
            "title": rules["cross_building_scan"]["name"],
            "reason": f"{employee['name']} attempted to enter another zone while still inside {zone_name}.",
            "subjectId": employee["id"], "subjectName": employee["name"], "subjectType": "employee",
            "barcode": employee["barcode"], "checkpoint": cross_event["checkpoint"],
            "checkpointId": cross_event["checkpointId"], "zoneId": zone_id,
            "category": "presence_anomaly", "ruleId": "rule-cross-building-scan",
            "conditionKey": "cross_building_scan", "sourceEventId": cross_event["id"],
            "createdAt": cross_event["createdAt"]}
        alert_rows.append({"id": cross_id, "source_event_id": cross_event["id"],
            "created_at": datetime.fromisoformat(cross_event["createdAt"]), "data": json_text(cross_data)})

        denial_event = next(event for event in movement_events.values()
            if event.get("checkpointId") == f"{zone_id}-1" and event.get("result") == "denied")
        denial_id = f"AL-DEMO-DENIAL-RATE-{zone_id.upper()}"
        denial_data = {"id": denial_id, "severity": "high", "status": "acknowledged",
            "title": rules["checkpoint_denial_rate"]["name"],
            "reason": "The recent denial rate exceeded the configured threshold compared with this checkpoint's baseline.",
            "subjectId": "", "subjectName": "Checkpoint activity", "subjectType": "system", "barcode": "",
            "checkpoint": denial_event["checkpoint"], "checkpointId": f"{zone_id}-1", "zoneId": zone_id,
            "scanCount": 20, "deniedCount": 14, "denialRate": 0.7, "baselineRate": 0.2,
            "category": "operational", "ruleId": "rule-checkpoint-denial-rate",
            "conditionKey": "checkpoint_denial_rate", "sourceEventId": denial_event["id"],
            "createdAt": (now - timedelta(minutes=10)).isoformat(),
            "resolvedBy": "Demo Zone Administrator", "resolutionReason": "Checked the access schedule."}
        alert_rows.append({"id": denial_id, "source_event_id": denial_event["id"],
            "created_at": now - timedelta(minutes=10), "data": json_text(denial_data)})

        offline_id = f"AL-DEMO-OFFLINE-{zone_id.upper()}"
        offline_cp = checkpoint_by_id[f"{zone_id}-4"]
        offline_data = {"id": offline_id, "severity": "high", "status": "open",
            "title": rules["checkpoint_offline"]["name"],
            "reason": f"No heartbeat has been received from the terminal assigned to {zone_name} · {offline_cp['gateLabel']} for at least 5 minutes.",
            "subjectId": "", "subjectName": "Checkpoint terminal", "subjectType": "system", "barcode": "",
            "checkpoint": f"{zone_name} · {offline_cp['gateLabel']}", "checkpointId": offline_cp["id"],
            "zoneId": zone_id, "terminalCount": len(operators_by_checkpoint[offline_cp["id"]]),
            "lastHeartbeatAt": (now - timedelta(minutes=20)).isoformat(), "timeoutSeconds": 300,
            "category": "operational", "ruleId": "rule-checkpoint-offline", "conditionKey": "checkpoint_offline",
            "explanation": "No assigned operator terminal has sent a recent heartbeat.",
            "createdAt": (now - timedelta(minutes=20)).isoformat()}
        alert_rows.append({"id": offline_id, "source_event_id": None,
            "created_at": now - timedelta(minutes=20), "data": json_text(offline_data)})

    # A small history sample exercises movement annotations without inflating
    # all 5,000 staff scans with artificial comments.
    for employee_number in range(1, 51, 5):
        event_id = f"DEMO-EMP-MOVE-{employee_number:04d}-01"
        note_rows.append({"event_id": event_id, "note": "Showcase history: scheduled morning arrival."})

    return {
        "zones": zones, "checkpoints": checkpoints, "zone_assignments": zone_assignment_rows,
        "admin_profiles": admin_profile_rows, "operator_assignments": operator_assignment_rows,
        "subjects": subjects, "people": people, "hardware": hardware_assets,
        "permissions": permissions, "presence": presence, "movements": movement_rows,
        "permission_requests": visitor_requests + manual_requests, "visitor_requests": visitor_requests,
        "pending_visitor_request_ids": pending_visitor_request_ids,
        "pending_manual_request_ids": pending_manual_request_ids,
        "audits": audit_rows, "rule_assignments": rule_assignment_rows,
        "notes": note_rows, "alerts": alert_rows,
    }


async def write_fixture(db, now: datetime, identities: dict[str, Any]) -> dict[str, int]:
    await reset_application_rows(db)
    await seed_reference_rows(db)
    records = fixture_records(now, identities)
    zone_names = dict(ZONE_SPECS)

    await db.execute(text("""
        INSERT INTO organization_zones (id, name, active, created_by)
        VALUES (:id, :name, true, :created_by)
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, active=true, created_by=EXCLUDED.created_by
    """), records["zones"])
    await db.execute(text("""
        INSERT INTO checkpoints (id, zone_id, number, gate_type, required, active, data)
        VALUES (:id, :zone_id, :number, :gate_type, :required, :active, CAST(:data AS jsonb))
        ON CONFLICT (id) DO UPDATE SET zone_id=EXCLUDED.zone_id, number=EXCLUDED.number,
            gate_type=EXCLUDED.gate_type, required=EXCLUDED.required, active=EXCLUDED.active, data=EXCLUDED.data
    """), records["checkpoints"])
    await db.execute(text("""
        INSERT INTO zone_admin_assignments (admin_subject, zone_id, assigned_by)
        VALUES (:admin_subject, :zone_id, :assigned_by)
    """), records["zone_assignments"])
    await db.execute(text("""
        INSERT INTO admin_accounts (id, keycloak_subject, name, nickname, email, avatar_data_url,
            offline_until, settings, created_at)
        VALUES (:id, :keycloak_subject, :name, :nickname, :email, :avatar_data_url,
            :offline_until, CAST(:settings AS jsonb), :created_at)
    """), records["admin_profiles"])
    await db.execute(text("""
        INSERT INTO terminal_checkpoint_assignments (terminal_identity, checkpoint_id, last_heartbeat_at, updated_at)
        VALUES (:terminal_identity, :checkpoint_id, :last_heartbeat_at, :updated_at)
    """), records["operator_assignments"])
    await db.execute(text("""
        INSERT INTO subjects (id, kind, barcode) VALUES (:id, :kind, :barcode)
    """), records["subjects"])
    await db.execute(text("""
        INSERT INTO people (subject_id, data) VALUES (:subject_id, CAST(:data AS jsonb))
    """), records["people"])
    await db.execute(text("""
        INSERT INTO hardware_assets (subject_id, data) VALUES (:subject_id, CAST(:data AS jsonb))
    """), records["hardware"])
    await db.execute(text("""
        INSERT INTO presence_state
            (subject_id, state, entry_building_id, last_scan_timestamp, entry_started_at,
             visitor_overstay_alerted_entry_at)
        VALUES (:subject_id, :state, :entry_building_id, :last_scan_timestamp, :entry_started_at, :alerted_valid_to)
    """), records["presence"])
    await db.execute(text("""
        INSERT INTO access_permissions (id, subject_id, data)
        VALUES (:id, :subject_id, CAST(:data AS jsonb))
    """), records["permissions"])
    await db.execute(text("""
        INSERT INTO movements
            (id, subject_id, checkpoint_id, occurred_at, result, direction, denial_code,
             scan_type, subject_type, sync_state, data)
        VALUES (:id, :subject_id, :checkpoint_id, :occurred_at, :result, :direction, :denial_code,
                :scan_type, :subject_type, :sync_state, CAST(:data AS jsonb))
    """), records["movements"])
    await db.execute(text("""
        INSERT INTO permission_requests (id, subject_id, created_at, data)
        VALUES (:id, :subject_id, :created_at, CAST(:data AS jsonb))
    """), records["permission_requests"])
    if records["audits"]:
        await db.execute(text("""
            INSERT INTO audit_events (id, created_at, data)
            VALUES (:id, :created_at, CAST(:data AS jsonb))
        """), records["audits"])
    if records["rule_assignments"]:
        await db.execute(text("""
            INSERT INTO alert_rule_assignments (subject_id, rule_ids, revision, rules_customized, updated_by)
            VALUES (:subject_id, CAST(:rule_ids AS jsonb), :revision, true, :updated_by)
        """), records["rule_assignments"])
    if records["notes"]:
        await db.execute(text("""
            INSERT INTO movement_notes (event_id, note)
            VALUES (:event_id, :note)
        """), records["notes"])
    await db.execute(text("""
        INSERT INTO alerts (id, source_event_id, created_at, data)
        VALUES (:id, :source_event_id, :created_at, CAST(:data AS jsonb))
    """), records["alerts"])
    await db.execute(text("""
        INSERT INTO event_stream_state (id, revision, presence_revision, previous_presence_revision)
        VALUES (1, 0, 0, 0)
    """))

    # Queue assignments, pending visitor approvals, and manual reviews only
    # after their rows exist in the same transaction. Visitor workflows wait
    # indefinitely; manual unknown-badge reviews retain their short deadline.
    await enqueue_changed(db)
    for assignment in records["operator_assignments"]:
        await enqueue_checkpoint_assignment(db, assignment["terminal_identity"])
    for request_id in records["pending_visitor_request_ids"]:
        await enqueue_workflow_start(db, request_id, visitor=True)
    for request_id in records["pending_manual_request_ids"]:
        await enqueue_workflow_start(db, request_id)

    counts = {
        "zones": len(records["zones"]), "checkpoints": len(records["checkpoints"]),
        "zoneAdmins": len(records["zone_assignments"]), "operators": len(records["operator_assignments"]),
        "employees": sum(1 for row in records["subjects"] if row["kind"] == "employee"),
        "visitors": sum(1 for row in records["subjects"] if row["kind"] == "visitor"),
        "hardware": sum(1 for row in records["subjects"] if row["kind"] == "hardware"),
        "scans": len(records["movements"]), "visitorRequests": len(records["visitor_requests"]),
        "pendingVisitorApprovals": len(records["pending_visitor_request_ids"]),
        "manualReviews": len(records["pending_manual_request_ids"]), "alerts": len(records["alerts"]),
    }
    return counts


async def main() -> None:
    parser = argparse.ArgumentParser(description="Reset app-owned records and load the full local demo dataset")
    parser.add_argument("--reset", action="store_true", help="Required: truncate application tables, preserving migrations/Keycloak/Temporal")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--provision-keycloak", action="store_true", help="Create or refresh local test identities through the Keycloak Admin API")
    source.add_argument("--identities", type=Path, help="Use a JSON identity map already provisioned in Keycloak")
    args = parser.parse_args()
    if not args.reset:
        parser.error("--reset is required because this full fixture replaces all application records")
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not configured")

    identities = await provision_keycloak_identities() if args.provision_keycloak else json.loads(args.identities.read_text(encoding="utf-8"))
    identity_maps(identities)
    engine = create_async_engine(DATABASE_URL, hide_parameters=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    now = datetime.now(timezone.utc)
    try:
        async with session_factory() as db:
            async with db.begin():
                counts = await write_fixture(db, now, identities)
        print("✓ Full demo dataset committed:")
        for name, count in counts.items():
            print(f"  {name}: {count:,}")
        print("  Zone access: 100 employee, visitor, and hardware records per zone.")
        print("  Operators: 7 real Keycloak operator identities per zone, assigned across all 4 checkpoints.")
        print("  Zone administrators: 1 real Keycloak zone-admin identity per zone; demo profiles start offline.")
        print("  Login passwords are in the private full-demo-accounts.csv file, never printed to logs.")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
