"""One allowlisted watch command; no arbitrary message or recipient supplied by callers."""
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time
from contextlib import closing

MESSAGE = 'phone LIBRARIAN triage'
CONFIG_PATH = Path('/data/artemis-bridge.json')
DB_PATH = '/data/artemis-commands.sqlite'

def config():
    return json.loads(CONFIG_PATH.read_text())

def authorized(header):
    try:
        token = config()['commandToken']
        return bool(token) and hmac.compare_digest(header, 'Bearer ' + token)
    except (OSError, ValueError, KeyError):
        return False

def dispatch(request_id):
    if not isinstance(request_id, str) or not re.fullmatch('[a-f0-9]{16}', request_id):
        return 400, {'error': 'invalid id'}
    cfg = config()
    session = cfg['sessionKey']
    if not re.fullmatch(r'agent:main:telegram:direct:[0-9]+', session):
        return 503, {'error': 'routing unavailable'}
    with closing(sqlite3.connect(DB_PATH, timeout=5)) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, state TEXT NOT NULL, created REAL NOT NULL)')
        db.execute('BEGIN IMMEDIATE')
        previous = db.execute('SELECT state FROM requests WHERE id=?', (request_id,)).fetchone()
        if previous:
            return 200, {'id': request_id, 'ok': previous[0] == 'accepted', 'result': previous[0]}
        if db.execute('SELECT 1 FROM requests WHERE created>?', (time.time()-10,)).fetchone():
            return 429, {'error': 'busy'}
        # Persist before delivery. A crash/timeout is ambiguous, never permission to resend.
        db.execute('INSERT INTO requests VALUES (?, ?, ?)', (request_id, 'unknown', time.time()))
    state = 'unknown'
    try:
        gateway = json.loads(Path(os.environ.get('OPENCLAW_CONFIG_PATH', '/data/.openclaw/openclaw.json')).read_text())
        token = os.environ.get('OPENCLAW_GATEWAY_TOKEN') or gateway.get('gateway', {}).get('auth', {}).get('token')
        params = {'message': MESSAGE, 'sessionKey': session, 'idempotencyKey': 'artemis-' + request_id,
                  'deliver': True, 'channel': 'telegram', 'to': session.rsplit(':', 1)[1]}
        command = ['openclaw', 'gateway', 'call', 'agent', '--params', json.dumps(params), '--json', '--timeout', '8000']
        if isinstance(token, str) and token:
            command += ['--token', token]
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        payload = json.loads(result.stdout)
        if result.returncode == 0 and payload.get('status') == 'accepted' and payload.get('runId'):
            state = 'accepted'
        elif payload.get('ok') is False:
            state = 'error'
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    with closing(sqlite3.connect(DB_PATH, timeout=5)) as db, db:
        db.execute('UPDATE requests SET state=? WHERE id=?', (state, request_id))
    return 200, {'id': request_id, 'ok': state == 'accepted', 'result': state}

