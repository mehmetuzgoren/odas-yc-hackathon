from __future__ import annotations
import json
import sqlite3
import time
from pathlib import Path
from typing import Any

class Store:
    def __init__(self, directory: str):
        Path(directory).mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(Path(directory) / 'device.sqlite'))
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS values_store(key TEXT PRIMARY KEY,data TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL)')
        self.db.commit()

    def get(self, key: str, default: Any = None) -> Any:
        row = self.db.execute('SELECT data FROM values_store WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def put(self, key: str, value: Any) -> None:
        self.db.execute('INSERT INTO values_store(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data', (key, json.dumps(value)))
        self.db.commit()

    def sequence(self, key: str) -> int:
        value = max(self.get(f'seq:{key}', 0) + 1, time.time_ns() // 1000)
        self.put(f'seq:{key}', value)
        return value

    def claim(self, command_id: str, room_id: str, kind: str) -> dict | None:
        row = self.db.execute('SELECT room_id,kind,status,data FROM commands WHERE id=?', (command_id,)).fetchone()
        if row:
            if row[0] != room_id or row[1] != kind:
                raise ValueError('Command ID already belongs to a different action')
            # If a worker died after dispatch intent, never blindly resend the command.
            return json.loads(row[3]) if row[2] == 'done' else {'accepted': False, 'uncertain': True, 'message': 'Previous dispatch is unresolved; reconcile observed robot telemetry.'}
        self.db.execute("INSERT INTO commands(id,room_id,kind,status,data) VALUES(?,?,?,'dispatching','{}')", (command_id, room_id, kind))
        self.db.commit()
        return None

    def finish(self, command_id: str, result: dict) -> dict:
        self.db.execute("UPDATE commands SET status='done',data=? WHERE id=?", (json.dumps(result), command_id))
        self.db.commit()
        return result
