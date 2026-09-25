#!/usr/bin/env python3
"""Read-only Jeeves telemetry sidecar for the Artemis watch integration."""

from __future__ import annotations

import hmac
import json
import os
import subprocess
import threading
import time
import urllib.parse
import approval_dispatch
import triage_dispatch
from http import HTTPStatus
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


REFRESH_SECONDS = 15
# Anthropic's usage-quota endpoint enforces a much tighter rate limit than OpenAI's - polling
# this often (previously 45s, barely above the command's own 40s worst-case runtime) kept it
# permanently 429'd. openai/status calls stayed independent and were never affected.
USAGE_REFRESH_SECONDS = 180
COMMAND_TIMEOUT_SECONDS = 10

# Anthropic usage is read directly from Anthropic rather than through OpenClaw.
#
# OpenClaw 2026.9.4 resolves the Anthropic usage credential as
# `resolveOAuthToken({ excludeProfileIds: [CLAUDE_CLI_PROFILE_ID] })` - it deliberately
# refuses the `anthropic:claude-cli` profile. On this host that is the ONLY credential
# that can read the usage endpoint: verified 2026-09-17 from this container, the
# Claude Code OAuth token returns HTTP 200 with real figures while every alternative
# returns 429 (a stale pasted token, and a freshly minted `claude setup-token`) or 401.
# So `openclaw status --usage` reports anthropic with an `error` and no windows, forever,
# and claude5h/claudeWeek froze at whatever they last read (2026-09-15).
#
# The 429 is misleading: it is a credential Anthropic won't serve, not real throttling.
# Reading `.credentials.json` ourselves uses the token Claude Code keeps refreshed, so it
# cannot go stale the way a pasted token does. OpenAI still comes from OpenClaw as before.
CLAUDE_CONFIG_DIR = os.environ.get("CLAUDE_CONFIG_DIR", "/data/claude-config")
ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
ANTHROPIC_USAGE_TIMEOUT_SECONDS = 10

# The access token in .credentials.json lives about 8 hours and is refreshed only when
# Claude Code itself runs - which, now that Anthropic sits low in the model fallback order,
# can be a long time. An expired token does NOT fail honestly: Anthropic answers it with
# HTTP 429 "rate_limit_error", indistinguishable from real throttling, which is what made
# this whole class of problem so hard to diagnose in the first place.
#
# So when the token is stale we ask Claude Code to refresh it, by running the cheapest
# possible prompt. Deliberately NOT done by driving the refresh token ourselves: Anthropic
# may rotate it on use, and mishandling that would break the credential Jeeves depends on
# for Claude inference. Letting Claude Code own its own credential costs a few hundred
# tokens roughly three times a day and cannot corrupt anything.
#
# --safe-mode disables hooks/skills/MCP/CLAUDE.md (auth still works normally) so this is as
# close to a no-op as the CLI allows. Not --bare, which changes how auth is resolved and
# would skip the OAuth refresh entirely.
CLAUDE_REFRESH_COMMAND = ["claude", "-p", "ok", "--model", "claude-haiku-4-5", "--safe-mode"]
CLAUDE_REFRESH_COMMAND_TIMEOUT_SECONDS = 60
# Never poke the CLI more than once a quarter-hour, so a persistently broken login degrades
# to a stale gauge rather than a subprocess every 3 minutes.
CLAUDE_REFRESH_MIN_INTERVAL_SECONDS = 900
# Treat a token about to expire as already stale - the usage call must not lose a race.
CLAUDE_TOKEN_EXPIRY_MARGIN_SECONDS = 120
# `status --usage` runs a real update/gateway probe before it prints anything (observed
# 12-17s on the live service) - far more than the fast JSON-only status/nodes commands.
USAGE_COMMAND_TIMEOUT_SECONDS = 40

_snapshot_lock = threading.Lock()
_snapshot: dict[str, Any] | None = None
_usage_lock = threading.Lock()
_usage_snapshot: dict[str, int | None] | None = None
_usage_refreshed_at = 0.0
_claude_lock = threading.Lock()
_claude_snapshot: dict[str, Any] | None = None
_claude_refreshed_at = 0.0
_claude_refresh_attempted_at = 0.0


def _positive_integer(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _run_openclaw_json(arguments: list[str]) -> dict[str, Any]:
    completed = subprocess.run(
        ["openclaw", *arguments, "--json"],
        check=True,
        capture_output=True,
        text=True,
        timeout=COMMAND_TIMEOUT_SECONDS,
    )
    value = json.loads(completed.stdout)
    if not isinstance(value, dict):
        raise ValueError("OpenClaw returned a non-object JSON value")
    return value


def _run_openclaw_pty_json(arguments: list[str]) -> dict[str, Any]:
    """Run an openclaw subcommand that refuses to produce any output unless its stdout is
    an interactive terminal (an upstream requirement of this CLI version for `status
    --usage`, not something this sidecar controls), then parse its --json output.

    A pseudo-tty satisfies the terminal check without a human present or changing what
    data comes back. A real window size is set explicitly: left at 0x0, the CLI's table
    renderer wraps into a pathologically narrow, extremely slow layout. Output is drained
    on a separate thread so a chatty command can never fill the pty's buffer and deadlock
    the subprocess. (fcntl/termios are POSIX-only, imported lazily here so this module
    still imports cleanly for local/Windows dev - only this function is Linux-only.)
    """
    import fcntl
    import struct
    import termios

    controller_fd, follower_fd = os.openpty()
    fcntl.ioctl(follower_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
    chunks: list[bytes] = []

    def _drain() -> None:
        try:
            while True:
                chunk = os.read(controller_fd, 4096)
                if not chunk:
                    break
                chunks.append(chunk)
        except OSError:
            pass  # the pty closes once the child exits; that's expected, not a failure

    reader = threading.Thread(target=_drain, daemon=True)
    reader.start()
    process = subprocess.Popen(
        ["openclaw", *arguments, "--json"], stdout=follower_fd, stderr=follower_fd, stdin=follower_fd
    )
    os.close(follower_fd)  # only the child's inherited copy keeps the pty open now
    try:
        returncode = process.wait(timeout=USAGE_COMMAND_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        os.close(controller_fd)
        reader.join(timeout=1)
        raise
    reader.join(timeout=USAGE_COMMAND_TIMEOUT_SECONDS)
    os.close(controller_fd)
    output = b"".join(chunks).decode("utf-8", errors="replace")
    if returncode != 0:
        raise subprocess.CalledProcessError(returncode, ["openclaw", *arguments], output=output)
    value = json.loads(output)
    if not isinstance(value, dict):
        raise ValueError("OpenClaw returned a non-object JSON value")
    return value


def _percent_from_utilization(value: Any) -> int | None:
    """Anthropic reports utilization as a float percentage (e.g. 93.0). The watch protocol
    carries whole percents, and every other field here is already an int 0-100."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    percent = round(float(value))
    return percent if 0 <= percent <= 100 else None


def parse_claude_oauth_usage(payload: dict[str, Any]) -> dict[str, Any]:
    """Map Anthropic's /api/oauth/usage response onto the watch's claude* fields.

    Real shape (captured from the live endpoint, not docs):
      {"five_hour": {"utilization": 32.0, "resets_at": "...+00:00"},
       "seven_day": {"utilization": 93.0, "resets_at": "..."}, ...}
    Unknown windows stay None so a partial response degrades per-field rather than
    poisoning the snapshot with zeros.
    """
    result: dict[str, Any] = {
        "claude5h": None,
        "claudeWeek": None,
        "claude5hResetAt": None,
        "claudeWeekResetAt": None,
    }
    if not isinstance(payload, dict):
        return result
    for key, percent_field, reset_field in (
        ("five_hour", "claude5h", "claude5hResetAt"),
        ("seven_day", "claudeWeek", "claudeWeekResetAt"),
    ):
        window = payload.get(key)
        if not isinstance(window, dict):
            continue
        result[percent_field] = _percent_from_utilization(window.get("utilization"))
        resets_at = window.get("resets_at")
        if isinstance(resets_at, str) and resets_at.strip():
            result[reset_field] = resets_at
    return result


def _read_claude_oauth() -> dict[str, Any] | None:
    try:
        with open(os.path.join(CLAUDE_CONFIG_DIR, ".credentials.json"), encoding="utf-8") as handle:
            oauth = json.load(handle).get("claudeAiOauth")
    except (OSError, ValueError):
        return None
    return oauth if isinstance(oauth, dict) else None


def _read_claude_oauth_token() -> str | None:
    oauth = _read_claude_oauth()
    if oauth is None:
        return None
    token = oauth.get("accessToken")
    return token if isinstance(token, str) and token.strip() else None


def claude_token_is_fresh(oauth: dict[str, Any] | None, now_ms: float | None = None) -> bool:
    """expiresAt is epoch milliseconds. Anything unparseable counts as stale: a refresh we
    did not need is cheap, whereas a usage call on a dead token returns a 429 that reads
    exactly like throttling."""
    if not isinstance(oauth, dict):
        return False
    expires_at = oauth.get("expiresAt")
    if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)):
        return False
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    return expires_at > now_ms + CLAUDE_TOKEN_EXPIRY_MARGIN_SECONDS * 1000


def _refresh_claude_token() -> None:
    """Ask Claude Code to refresh its own OAuth token by running a trivial prompt. Best
    effort and never raises - if it fails, the caller simply proceeds with whatever token
    is on disk and the gauge goes stale, which the dashboard renders honestly."""
    global _claude_refresh_attempted_at
    now = time.monotonic()
    if _claude_refresh_attempted_at and now - _claude_refresh_attempted_at < CLAUDE_REFRESH_MIN_INTERVAL_SECONDS:
        return
    _claude_refresh_attempted_at = now
    try:
        completed = subprocess.run(
            CLAUDE_REFRESH_COMMAND,
            check=False,
            capture_output=True,
            text=True,
            timeout=CLAUDE_REFRESH_COMMAND_TIMEOUT_SECONDS,
            # Without this the CLI waits 3s for piped stdin that will never arrive.
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as error:
        print(f"[jeeves-telemetry] claude token refresh failed: {type(error).__name__}", flush=True)
        return
    fresh = claude_token_is_fresh(_read_claude_oauth())
    print(
        f"[jeeves-telemetry] claude token refresh: exit={completed.returncode} "
        f"token_now={'fresh' if fresh else 'still stale'}",
        flush=True,
    )


def _fetch_claude_usage() -> dict[str, Any] | None:
    """One uncached call to Anthropic's usage endpoint. Returns None on any failure, so
    callers keep their last-good numbers rather than blanking them."""
    import urllib.error
    import urllib.request

    oauth = _read_claude_oauth()
    if oauth is not None and not claude_token_is_fresh(oauth):
        _refresh_claude_token()
        oauth = _read_claude_oauth()
    token = oauth.get("accessToken") if isinstance(oauth, dict) else None
    if not isinstance(token, str) or not token.strip():
        print("[jeeves-telemetry] anthropic usage unavailable: no usable claude credential", flush=True)
        return None
    request = urllib.request.Request(
        ANTHROPIC_USAGE_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "jeeves-telemetry",
            "anthropic-version": "2023-06-01",
            # Required for OAuth-token access to this endpoint; without it the call is rejected.
            "anthropic-beta": "oauth-2025-04-20",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=ANTHROPIC_USAGE_TIMEOUT_SECONDS) as response:
            return parse_claude_oauth_usage(json.loads(response.read().decode("utf-8")))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as error:
        print(f"[jeeves-telemetry] anthropic usage unavailable: {type(error).__name__}", flush=True)
        return None


def read_claude_usage_cached() -> dict[str, Any] | None:
    """Shared by the watch snapshot and the usage-tracker push so the two of them never
    make separate calls - this endpoint is genuinely rate-limited, unlike the 429 that
    sent us down this path in the first place."""
    global _claude_refreshed_at, _claude_snapshot
    now = time.monotonic()
    with _claude_lock:
        if _claude_snapshot is not None and now - _claude_refreshed_at < USAGE_REFRESH_SECONDS:
            return dict(_claude_snapshot)
        fresh = _fetch_claude_usage()
        _claude_refreshed_at = now
        if fresh is not None:
            _claude_snapshot = fresh
        return dict(_claude_snapshot) if _claude_snapshot is not None else None


def parse_provider_usage(status: dict[str, Any]) -> dict[str, int | None]:
    """Read percent-used windows straight from `openclaw status --usage --json`'s
    usage.providers list - structured data, no text-table scraping."""
    result: dict[str, int | None] = {
        "openai5h": None,
        "openaiWeek": None,
        "claude5h": None,
        "claudeWeek": None,
    }
    field_prefix = {"anthropic": "claude", "openai": "openai"}
    providers = status.get("usage", {}).get("providers") if isinstance(status.get("usage"), dict) else None
    if not isinstance(providers, list):
        return result

    for entry in providers:
        if not isinstance(entry, dict):
            continue
        prefix = field_prefix.get(entry.get("provider"))
        if prefix is None:
            continue
        windows = entry.get("windows")
        if not isinstance(windows, list):
            continue
        for window in windows:
            if not isinstance(window, dict):
                continue
            label = str(window.get("label", "")).casefold()
            suffix = "5h" if label == "5h" else "Week" if label == "week" else None
            if suffix is None:
                continue
            used = window.get("usedPercent")
            if isinstance(used, bool) or not isinstance(used, int) or not (0 <= used <= 100):
                continue
            result[f"{prefix}{suffix}"] = used

    return result


def _read_provider_usage() -> dict[str, int | None]:
    global _usage_refreshed_at, _usage_snapshot
    now = time.monotonic()
    with _usage_lock:
        if _usage_snapshot is not None and now - _usage_refreshed_at < USAGE_REFRESH_SECONDS:
            return dict(_usage_snapshot)
        # OpenAI comes from OpenClaw; Anthropic comes straight from Anthropic. These are two
        # separate upstreams reached two different ways, so neither may block or blank the
        # other - an OpenClaw/pty failure must still leave Anthropic numbers flowing, which
        # is why this is computed before (and outside) the OpenClaw call's try block.
        claude = read_claude_usage_cached()
        try:
            fresh = parse_provider_usage(_run_openclaw_pty_json(["status", "--usage"]))
        except Exception:
            fresh = {"openai5h": None, "openaiWeek": None, "claude5h": None, "claudeWeek": None}
        try:
            # OpenClaw cannot read Anthropic usage on this host (see CLAUDE_CONFIG_DIR note
            # above), so it always returns None for these two. Fill them from Anthropic
            # directly. Deliberately authoritative rather than a fallback: if OpenClaw ever
            # starts returning an anthropic figure again it will be from the credential we
            # already know is wrong, and a stale-but-plausible number is worse than none.
            if claude is not None:
                # Reset times ride along for Mission Control; the watch bridge reads fields by name.
                for field in ("claude5h", "claudeWeek", "claude5hResetAt", "claudeWeekResetAt"):
                    if claude.get(field) is not None:
                        fresh[field] = claude[field]
            # Providers are independent (e.g. Anthropic's usage endpoint can be transiently
            # rate-limited while OpenAI's keeps succeeding within the same CLI call) - a field
            # coming back None here means "this provider had nothing new to report", not "this
            # provider's last known-good value is now wrong". Only overwrite fields we actually
            # got fresh data for, so one provider's outage can't blank out another's numbers,
            # or freeze its own last-good number forever instead of going silently stale.
            if _usage_snapshot is None:
                _usage_snapshot = fresh
            else:
                _usage_snapshot = {
                    key: (value if value is not None else _usage_snapshot.get(key))
                    for key, value in fresh.items()
                }
        except Exception:
            # A transient failure must not erase the last known-good numbers - only report
            # unknown if we have genuinely never had a successful read.
            if _usage_snapshot is None:
                _usage_snapshot = {
                    "openai5h": None,
                    "openaiWeek": None,
                    "claude5h": None,
                    "claudeWeek": None,
                }
        _usage_refreshed_at = now
        return dict(_usage_snapshot)


def _read_gateway_health() -> tuple[bool, int]:
    try:
        status = _run_openclaw_json(["status"])
        gateway = status.get("gateway")
        if not isinstance(gateway, dict) or not isinstance(gateway.get("reachable"), bool):
            raise ValueError("gateway health is unavailable")
        latency_ms = _positive_integer(gateway.get("connectLatencyMs"))
        if latency_ms is None:
            raise ValueError("gateway connection latency is unavailable")
        return gateway["reachable"], latency_ms
    except Exception:
        return False, 0


def _read_windows_node() -> bool:
    try:
        node_status = _run_openclaw_json(["nodes", "status"])
        nodes = node_status.get("nodes")
        if not isinstance(nodes, list):
            raise ValueError("node health is unavailable")
        return any(
            isinstance(node, dict)
            and str(node.get("platform", "")).lower() == "windows"
            and node.get("paired") is True
            and node.get("connected") is True
            for node in nodes
        )
    except Exception:
        return False


def collect_snapshot() -> dict[str, Any]:
    # Provider usage, gateway health, and node status are independent facts pulled from
    # separate commands. None of the three may block or wipe out either of the others -
    # each degrades to its own "unknown"/"unavailable" value on failure, on its own.
    gateway_ok, latency_ms = _read_gateway_health()
    windows_node = _read_windows_node()

    return {
        **_read_provider_usage(),
        "gatewayOk": gateway_ok,
        "windowsNode": windows_node,
        "latencyMs": latency_ms,
    }


def build_quota_rows(claude: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Shape the cached Anthropic reading into POST /api/quota rows for the LLM usage
    tracker. Windows are emitted only when a percentage is actually known, so the tracker
    keeps its last-good gauge rather than being handed a null."""
    if not isinstance(claude, dict):
        return []
    rows: list[dict[str, Any]] = []
    for percent_field, reset_field, window in (
        ("claude5h", "claude5hResetAt", "5h"),
        ("claudeWeek", "claudeWeekResetAt", "week"),
    ):
        used = claude.get(percent_field)
        if used is None:
            continue
        rows.append(
            {
                "provider": "anthropic",
                "window": window,
                "usedPercent": used,
                "resetAt": claude.get(reset_field),
            }
        )
    return rows


def _push_quota_once() -> int:
    """POST the Anthropic gauge to the usage tracker. The tracker's own poller reads this
    provider through OpenClaw and therefore cannot see it at all - this is the only path
    by which its Anthropic row is ever populated."""
    import urllib.error
    import urllib.request

    base_url = os.environ.get("USAGE_TRACKER_URL", "").rstrip("/")
    token = os.environ.get("USAGE_TRACKER_TOKEN", "")
    if not base_url or not token:
        return 0
    posted = 0
    for row in build_quota_rows(read_claude_usage_cached()):
        request = urllib.request.Request(
            f"{base_url}/api/quota",
            method="POST",
            data=json.dumps(row).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=ANTHROPIC_USAGE_TIMEOUT_SECONDS):
                posted += 1
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            print(f"[jeeves-quota-push] {row['window']} failed: {type(error).__name__}", flush=True)
    return posted


def _push_quota_forever() -> None:
    # Its own thread so a tracker outage can never stall or crash the watch's telemetry
    # refresh, which is this process's actual job.
    if not os.environ.get("USAGE_TRACKER_URL") or not os.environ.get("USAGE_TRACKER_TOKEN"):
        print("[jeeves-quota-push] disabled (USAGE_TRACKER_URL/TOKEN not set)", flush=True)
        return
    while True:
        try:
            posted = _push_quota_once()
            print(f"[jeeves-quota-push] posted {posted} anthropic window(s)", flush=True)
        except Exception as error:
            print(f"[jeeves-quota-push] unavailable: {type(error).__name__}", flush=True)
        time.sleep(USAGE_REFRESH_SECONDS)


def _refresh_forever() -> None:
    global _snapshot
    while True:
        try:
            fresh = collect_snapshot()
        except Exception as error:
            with _snapshot_lock:
                _snapshot = None
            print(f"[jeeves-telemetry] refresh unavailable: {type(error).__name__}", flush=True)
        else:
            with _snapshot_lock:
                _snapshot = fresh
            print("[jeeves-telemetry] snapshot refreshed", flush=True)
        time.sleep(REFRESH_SECONDS)


OBSERVABILITY_CLI = Path(os.environ.get("OPENCLAW_WORKSPACE_DIR", "/data/workspace")) / "scripts" / "observability_cli.py"


def read_observability(query: str) -> tuple[HTTPStatus, dict[str, Any]]:
    """Mission Control's read-only view of the workspace (Memory OS, skills, Jev, git).

    The logic lives in J33V35 next to the schemas it reads; this is only the authenticated door.
    """
    request = {key: values[0] for key, values in urllib.parse.parse_qs(query).items()}
    if not OBSERVABILITY_CLI.is_file():
        return HTTPStatus.SERVICE_UNAVAILABLE, {"error": "observability adapter not installed"}
    try:
        completed = subprocess.run(
            ["python3", str(OBSERVABILITY_CLI)],
            input=json.dumps(request), capture_output=True, text=True, timeout=25,
            cwd=OBSERVABILITY_CLI.parent.parent,
        )
        return HTTPStatus.OK, json.loads(completed.stdout)
    except (subprocess.TimeoutExpired, ValueError, OSError) as error:
        return HTTPStatus.SERVICE_UNAVAILABLE, {"error": f"observability read failed: {type(error).__name__}"}


ARTEMIS_LINK_PATH = Path(os.environ.get("ARTEMIS_LINK_PATH", "/data/artemis-link.json"))
_last_link_write = 0.0


def _note_watch_fetch(user_agent: str) -> None:
    """Device Fabric heartbeat for the watch. ArtemisBridge only fetches telemetry while the watch's
    BLE link is up, so its fetches are the watch's presence. Mission Control polls the same route with
    httpx, so only the bridge's OkHttp client counts.
    ponytail: User-Agent is a presence hint from token holders, not auth; a bridge header if it ever matters."""
    global _last_link_write
    now = time.time()
    if not user_agent.lower().startswith("okhttp") or now - _last_link_write < 10:
        return
    _last_link_write = now
    try:
        tmp = ARTEMIS_LINK_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps({"last_fetch_ms": int(now * 1000)}), encoding="utf-8")
        os.replace(tmp, ARTEMIS_LINK_PATH)
    except OSError as error:
        print(f"[jeeves-telemetry] artemis link write failed: {type(error).__name__}", flush=True)


class TelemetryHandler(BaseHTTPRequestHandler):
    server_version = "JeevesTelemetry/1"

    def log_message(self, format_string: str, *arguments: Any) -> None:
        # The request path is safe; authorization headers are never logged.
        print(f"[jeeves-telemetry] {self.address_string()} {format_string % arguments}", flush=True)

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        expected_token = os.environ.get("JEEVES_TELEMETRY_TOKEN", "")
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {expected_token}" if expected_token else ""
        return bool(expected) and hmac.compare_digest(supplied, expected)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = self.path.partition("?")[0]
        if path == "/health":
            self._send_json(HTTPStatus.OK, {"ok": True})
            return
        if path == "/obs":
            if not self._authorized():
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            status, payload = read_observability(self.path.partition("?")[2])
            self._send_json(status, payload)
            return
        if path != "/telemetry":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        if not self._authorized():
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        _note_watch_fetch(self.headers.get("User-Agent", ""))

        with _snapshot_lock:
            payload = dict(_snapshot) if _snapshot is not None else None
        if payload is None:
            self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "telemetry unavailable"})
            return
        self._send_json(HTTPStatus.OK, payload)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = self.path.partition("?")[0]
        if path != "/command":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        # The new command credential is separate from the old read-only telemetry key.
        can_command = triage_dispatch.authorized(self.headers.get("Authorization", ""))
        if not self._authorized() and not can_command:
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
            if length < 1 or length > 1024:
                raise ValueError("invalid body length")
            payload = json.loads(self.rfile.read(length))
        except (TypeError, ValueError, json.JSONDecodeError):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "malformed JSON"})
            return
        if isinstance(payload, dict) and payload.get("command") == "notification_triage" and set(payload) == {"command", "id"}:
            if not can_command:
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            try:
                status, response = triage_dispatch.dispatch(payload["id"])
                self._send_json(status, response)
            except Exception as error:
                print(f"[jeeves-command] unavailable: {type(error).__name__}", flush=True)
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "delivery unavailable"})
            return
        if isinstance(payload, dict) and payload.get("command") == "approval_list" and set(payload) == {"command", "id"}:
            if not can_command:
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            try:
                status, response = approval_dispatch.list_pending(payload["id"])
                self._send_json(status, response)
            except Exception as error:
                print(f"[jeeves-approval] list unavailable: {type(error).__name__}", flush=True)
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "approval list unavailable"})
            return
        if (
            isinstance(payload, dict)
            and payload.get("command") == "approval_resolve"
            and set(payload) == {"command", "id", "approvalId", "decision"}
        ):
            if not can_command:
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            try:
                status, response = approval_dispatch.resolve(
                    payload["id"], payload["approvalId"], payload["decision"]
                )
                self._send_json(status, response)
            except Exception as error:
                print(f"[jeeves-approval] resolution unavailable: {type(error).__name__}", flush=True)
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "approval resolution unavailable"})
            return
        if not self._authorized() or not isinstance(payload, dict) or payload.get("command") != "ping" or set(payload) != {"command"}:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "unsupported command"})
            return
        self._send_json(
            HTTPStatus.OK,
            {"command": "ping", "ok": True, "result": "pong"},
        )


def main() -> None:
    port = int(os.environ.get("JEEVES_TELEMETRY_PORT", "8765"))
    threading.Thread(target=_refresh_forever, name="telemetry-refresh", daemon=True).start()
    threading.Thread(target=_push_quota_forever, name="quota-push", daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", port), TelemetryHandler)
    print(f"[jeeves-telemetry] listening on :{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
