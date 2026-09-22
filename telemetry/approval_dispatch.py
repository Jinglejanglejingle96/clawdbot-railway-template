"""Bounded, request-specific access to OpenClaw's unified approval queue."""

from __future__ import annotations

from contextlib import closing
import json
import re
import sqlite3
import subprocess
import time
from typing import Any

import triage_dispatch


DB_PATH = triage_dispatch.DB_PATH
MAX_APPROVALS = 5
MAX_ID_BYTES = 256
COMMAND_TIMEOUT_SECONDS = 10


def _valid_transaction_id(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{16}", value) is not None


def _valid_approval_id(value: Any) -> bool:
    if not isinstance(value, str) or value in {"", ".", ".."} or any(ch in value for ch in "\x00\r\n"):
        return False
    try:
        return len(value.encode("utf-8")) <= MAX_ID_BYTES
    except UnicodeEncodeError:
        return False


def _run_openclaw(arguments: list[str]) -> dict[str, Any]:
    completed = subprocess.run(
        ["openclaw", *arguments, "--json", "--timeout", "8000"],
        capture_output=True,
        text=True,
        timeout=COMMAND_TIMEOUT_SECONDS,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "OpenClaw command failed"
        raise RuntimeError(detail)
    payload = json.loads(completed.stdout)
    if not isinstance(payload, dict):
        raise ValueError("OpenClaw returned a non-object JSON value")
    return payload


def _display_text(value: Any, fallback: str, limit: int) -> str:
    if not isinstance(value, str):
        return fallback
    clean = " ".join(value.replace("\x00", " ").split())
    return clean[:limit] or fallback


def _load_pending_entries(now_ms: int | None = None) -> list[dict[str, Any]]:
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    raw = _run_openclaw(["approvals", "pending"]).get("approvals")
    if not isinstance(raw, list):
        raise ValueError("OpenClaw approval list is unavailable")
    entries: list[dict[str, Any]] = []
    for value in raw:
        if not isinstance(value, dict) or not _valid_approval_id(value.get("id")):
            continue
        created = value.get("createdAtMs")
        expires = value.get("expiresAtMs")
        if not isinstance(created, (int, float)) or not isinstance(expires, (int, float)):
            continue
        created, expires = int(created), int(expires)
        if expires <= now_ms:
            continue
        kind = _display_text(value.get("kind"), "approval", 20)
        agent = _display_text(value.get("agentId"), "", 24)
        session = _display_text(value.get("sessionKey"), "", 48)
        description = agent or (session.rsplit(":", 1)[-1] if session else kind)
        entries.append(
            {
                "id": value["id"],
                "title": _display_text(value.get("summary"), "OpenClaw request", 52),
                "description": _display_text(description, kind, 52),
                "risk": kind,
                "createdAtMs": created,
                "expiresAtMs": expires,
            }
        )
    entries.sort(key=lambda entry: (-entry["createdAtMs"], entry["id"]))
    return entries


def list_pending(request_id: Any) -> tuple[int, dict[str, Any]]:
    if not _valid_transaction_id(request_id):
        return 400, {"error": "invalid id"}
    now_ms = int(time.time() * 1000)
    return 200, {
        "id": request_id,
        "ok": True,
        "serverNowMs": now_ms,
        "approvals": _load_pending_entries(now_ms)[:MAX_APPROVALS],
    }


def _ensure_tables(db: sqlite3.Connection) -> None:
    db.execute(
        "CREATE TABLE IF NOT EXISTS approval_decisions "
        "(id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, decision TEXT NOT NULL, "
        "state TEXT NOT NULL, created REAL NOT NULL)"
    )
    db.execute(
        "CREATE TABLE IF NOT EXISTS approval_claims "
        "(approval_id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, state TEXT NOT NULL, created REAL NOT NULL)"
    )


def resolve(request_id: Any, approval_id: Any, decision: Any) -> tuple[int, dict[str, Any]]:
    if not _valid_transaction_id(request_id):
        return 400, {"error": "invalid id"}
    if not _valid_approval_id(approval_id):
        return 400, {"error": "invalid approval id"}
    if decision not in {"approve", "deny"}:
        return 400, {"error": "invalid decision"}

    def response(state: str) -> tuple[int, dict[str, Any]]:
        return 200, {
            "id": request_id,
            "approvalId": approval_id,
            "ok": state in {"approved", "denied"},
            "result": state,
        }

    with closing(sqlite3.connect(DB_PATH, timeout=5)) as db, db:
        _ensure_tables(db)
        db.execute("BEGIN IMMEDIATE")
        previous = db.execute(
            "SELECT approval_id, decision, state FROM approval_decisions WHERE id=?", (request_id,)
        ).fetchone()
        if previous:
            if previous[0] != approval_id or previous[1] != decision:
                return 409, {"error": "transaction conflict"}
            return response(previous[2])
        claimed = db.execute(
            "SELECT transaction_id FROM approval_claims WHERE approval_id=?", (approval_id,)
        ).fetchone()
        if claimed:
            return response("expired")

        now_ms = int(time.time() * 1000)
        pending = next((entry for entry in _load_pending_entries(now_ms) if entry["id"] == approval_id), None)
        if pending is None or pending["expiresAtMs"] <= now_ms:
            db.execute(
                "INSERT INTO approval_decisions VALUES (?, ?, ?, ?, ?)",
                (request_id, approval_id, decision, "expired", time.time()),
            )
            return response("expired")
        db.execute(
            "INSERT INTO approval_claims VALUES (?, ?, ?, ?)",
            (approval_id, request_id, "unknown", time.time()),
        )
        db.execute(
            "INSERT INTO approval_decisions VALUES (?, ?, ?, ?, ?)",
            (request_id, approval_id, decision, "unknown", time.time()),
        )

    state = "unknown"
    try:
        openclaw_decision = "allow-once" if decision == "approve" else "deny"
        result = _run_openclaw(["approvals", "resolve", approval_id, openclaw_decision])
        approval = result.get("approval")
        expected_status = "allowed" if decision == "approve" else "denied"
        if (
            result.get("applied") is True
            and result.get("alreadyResolved") is not True
            and isinstance(approval, dict)
            and approval.get("id") == approval_id
            and approval.get("status") == expected_status
            and approval.get("decision") == openclaw_decision
        ):
            state = "approved" if decision == "approve" else "denied"
        elif isinstance(approval, dict) and approval.get("status") in {"expired", "cancelled"}:
            state = "expired"
    except RuntimeError as error:
        message = str(error).casefold()
        if "not found" in message or "expired" in message or "already resolved" in message:
            state = "expired"
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass

    with closing(sqlite3.connect(DB_PATH, timeout=5)) as db, db:
        _ensure_tables(db)
        db.execute("UPDATE approval_decisions SET state=? WHERE id=?", (state, request_id))
        db.execute("UPDATE approval_claims SET state=? WHERE approval_id=?", (state, approval_id))
    return response(state)

