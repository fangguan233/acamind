from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from typing import Any, Iterable, Optional

import aiosqlite

from .schemas import JobRecord, utc_now_iso


def _json_loads(value: Any, default: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if not value:
        return default
    try:
        return json.loads(value)
    except Exception:
        return default


class DeepResearchStore:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._initialized = False

    async def initialize(self) -> None:
        if self._initialized:
            return
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        async with aiosqlite.connect(self.db_path) as db:
            await db.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA foreign_keys=ON;

                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    owner_key TEXT NOT NULL,
                    question TEXT NOT NULL,
                    status TEXT NOT NULL,
                    phase TEXT NOT NULL DEFAULT 'queued',
                    round INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    final_report_md TEXT,
                    final_message_id TEXT,
                    trace_message_id TEXT,
                    tasklist_element_id TEXT,
                    error TEXT,
                    settings_json TEXT,
                    waiting_kind TEXT,
                    waiting_payload_json TEXT,
                    waiting_until TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_jobs_thread_id
                    ON jobs(thread_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_jobs_status
                    ON jobs(status, updated_at DESC);

                CREATE TABLE IF NOT EXISTS events (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    role TEXT NOT NULL,
                    tool_name TEXT,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_events_job_id
                    ON events(job_id, event_id ASC);

                CREATE TABLE IF NOT EXISTS artifacts (
                    artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    paper_key TEXT NOT NULL,
                    path_or_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(job_id) REFERENCES jobs(job_id) ON DELETE CASCADE,
                    UNIQUE(job_id, kind, paper_key)
                );

                CREATE INDEX IF NOT EXISTS idx_artifacts_job_id
                    ON artifacts(job_id, artifact_id ASC);
                """
            )
            cursor = await db.execute("PRAGMA table_info(jobs)")
            columns = {
                str(row[1] or "").strip()
                for row in await cursor.fetchall()
                if len(row) > 1
            }
            migrations = {
                "waiting_kind": "ALTER TABLE jobs ADD COLUMN waiting_kind TEXT",
                "waiting_payload_json": "ALTER TABLE jobs ADD COLUMN waiting_payload_json TEXT",
                "waiting_until": "ALTER TABLE jobs ADD COLUMN waiting_until TEXT",
            }
            for column, statement in migrations.items():
                if column not in columns:
                    await db.execute(statement)
            await db.commit()
        self._initialized = True

    @asynccontextmanager
    async def _db(self):
        await self.initialize()
        db = await aiosqlite.connect(self.db_path)
        db.row_factory = aiosqlite.Row
        try:
            yield db
        finally:
            await db.close()

    def _job_from_row(self, row: aiosqlite.Row) -> JobRecord:
        return JobRecord(
            job_id=str(row["job_id"]),
            thread_id=str(row["thread_id"]),
            owner_key=str(row["owner_key"]),
            question=str(row["question"] or ""),
            status=str(row["status"] or "queued"),
            phase=str(row["phase"] or "queued"),
            round=int(row["round"] or 1),
            created_at=str(row["created_at"] or ""),
            updated_at=str(row["updated_at"] or ""),
            started_at=str(row["started_at"] or ""),
            finished_at=str(row["finished_at"] or ""),
            final_report_md=str(row["final_report_md"] or ""),
            final_message_id=str(row["final_message_id"] or ""),
            trace_message_id=str(row["trace_message_id"] or ""),
            tasklist_element_id=str(row["tasklist_element_id"] or ""),
            error=str(row["error"] or ""),
            settings_json=_json_loads(row["settings_json"], {}),
            waiting_kind=str(row["waiting_kind"] or ""),
            waiting_payload_json=_json_loads(row["waiting_payload_json"], {}),
            waiting_until=str(row["waiting_until"] or ""),
        )

    async def create_job(
        self,
        *,
        job_id: str,
        thread_id: str,
        owner_key: str,
        question: str,
        status: str,
        phase: str,
        round: int,
        trace_message_id: str,
        final_message_id: str,
        tasklist_element_id: str,
        settings_json: dict[str, Any],
    ) -> JobRecord:
        now = utc_now_iso()
        async with self._db() as db:
            await db.execute(
                """
                INSERT INTO jobs (
                    job_id, thread_id, owner_key, question, status, phase, round,
                    created_at, updated_at, started_at, finished_at, final_report_md,
                    final_message_id, trace_message_id, tasklist_element_id, error,
                    settings_json, waiting_kind, waiting_payload_json, waiting_until
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?, ?, '', ?, '', '{}', '')
                """,
                (
                    job_id,
                    thread_id,
                    owner_key,
                    question,
                    status,
                    phase,
                    round,
                    now,
                    now,
                    final_message_id,
                    trace_message_id,
                    tasklist_element_id,
                    json.dumps(settings_json, ensure_ascii=False),
                ),
            )
            await db.commit()
        job = await self.get_job(job_id)
        if not job:
            raise RuntimeError(f"Unable to load created job: {job_id}")
        return job

    async def get_job(self, job_id: str) -> Optional[JobRecord]:
        async with self._db() as db:
            cursor = await db.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,))
            row = await cursor.fetchone()
        return self._job_from_row(row) if row else None

    async def get_latest_job_for_thread(self, thread_id: str) -> Optional[JobRecord]:
        async with self._db() as db:
            cursor = await db.execute(
                """
                SELECT * FROM jobs
                WHERE thread_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (thread_id,),
            )
            row = await cursor.fetchone()
        return self._job_from_row(row) if row else None

    async def get_active_job_for_thread(self, thread_id: str) -> Optional[JobRecord]:
        async with self._db() as db:
            cursor = await db.execute(
                """
                SELECT * FROM jobs
                WHERE thread_id = ?
                  AND status IN ('queued', 'running', 'cancel_requested')
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (thread_id,),
            )
            row = await cursor.fetchone()
        return self._job_from_row(row) if row else None

    async def list_jobs_by_status(self, statuses: Iterable[str]) -> list[JobRecord]:
        values = [str(item).strip() for item in statuses if str(item).strip()]
        if not values:
            return []
        placeholders = ", ".join("?" for _ in values)
        async with self._db() as db:
            cursor = await db.execute(
                f"""
                SELECT * FROM jobs
                WHERE status IN ({placeholders})
                ORDER BY updated_at ASC
                """,
                tuple(values),
            )
            rows = await cursor.fetchall()
        return [self._job_from_row(row) for row in rows]

    async def update_job(self, job_id: str, **fields: Any) -> Optional[JobRecord]:
        if not fields:
            return await self.get_job(job_id)

        mutable = dict(fields)
        mutable["updated_at"] = mutable.get("updated_at") or utc_now_iso()
        if "settings_json" in mutable:
            mutable["settings_json"] = json.dumps(
                mutable.get("settings_json") or {}, ensure_ascii=False
            )
        if "waiting_payload_json" in mutable:
            mutable["waiting_payload_json"] = json.dumps(
                mutable.get("waiting_payload_json") or {}, ensure_ascii=False
            )

        assignments = ", ".join(f"{key} = ?" for key in mutable.keys())
        params = list(mutable.values()) + [job_id]
        async with self._db() as db:
            await db.execute(
                f"UPDATE jobs SET {assignments} WHERE job_id = ?",
                tuple(params),
            )
            await db.commit()
        return await self.get_job(job_id)

    async def reset_running_jobs_to_queued(self) -> None:
        now = utc_now_iso()
        async with self._db() as db:
            await db.execute(
                """
                UPDATE jobs
                SET status = 'queued',
                    phase = CASE
                        WHEN COALESCE(phase, '') = 'waiting_user' THEN phase
                        ELSE 'queued'
                    END,
                    updated_at = ?
                WHERE status IN ('queued', 'running', 'cancel_requested')
                  AND COALESCE(phase, '') <> 'waiting_user'
                """,
                (now,),
            )
            await db.commit()

    async def cancel_active_jobs(self) -> int:
        now = utc_now_iso()
        async with self._db() as db:
            cursor = await db.execute(
                """
                UPDATE jobs
                SET status = 'canceled',
                    phase = 'canceled',
                    updated_at = ?,
                    waiting_kind = '',
                    waiting_payload_json = '{}',
                    waiting_until = '',
                    finished_at = CASE
                        WHEN COALESCE(finished_at, '') = '' THEN ?
                        ELSE finished_at
                    END
                WHERE status IN ('queued', 'running', 'cancel_requested')
                """,
                (now, now),
            )
            await db.commit()
            return int(cursor.rowcount or 0)

    async def delete_all_jobs(self) -> dict[str, int]:
        async with self._db() as db:
            jobs_cursor = await db.execute("SELECT COUNT(*) AS count FROM jobs")
            jobs_row = await jobs_cursor.fetchone()
            events_cursor = await db.execute("SELECT COUNT(*) AS count FROM events")
            events_row = await events_cursor.fetchone()
            artifacts_cursor = await db.execute("SELECT COUNT(*) AS count FROM artifacts")
            artifacts_row = await artifacts_cursor.fetchone()

            counts = {
                "jobs": int((jobs_row["count"] if jobs_row else 0) or 0),
                "events": int((events_row["count"] if events_row else 0) or 0),
                "artifacts": int((artifacts_row["count"] if artifacts_row else 0) or 0),
            }

            await db.execute("DELETE FROM events")
            await db.execute("DELETE FROM artifacts")
            await db.execute("DELETE FROM jobs")
            await db.commit()
            return counts

    async def append_event(
        self,
        *,
        job_id: str,
        phase: str,
        role: str,
        payload: dict[str, Any],
        tool_name: str = "",
    ) -> int:
        created_at = utc_now_iso()
        async with self._db() as db:
            cursor = await db.execute(
                """
                INSERT INTO events (job_id, phase, role, tool_name, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    phase,
                    role,
                    tool_name,
                    json.dumps(payload or {}, ensure_ascii=False),
                    created_at,
                ),
            )
            await db.execute(
                "UPDATE jobs SET updated_at = ? WHERE job_id = ?",
                (created_at, job_id),
            )
            await db.commit()
            return int(cursor.lastrowid or 0)

    async def list_events(self, job_id: str) -> list[dict[str, Any]]:
        async with self._db() as db:
            cursor = await db.execute(
                """
                SELECT * FROM events
                WHERE job_id = ?
                ORDER BY event_id ASC
                """,
                (job_id,),
            )
            rows = await cursor.fetchall()
        return [
            {
                "event_id": int(row["event_id"]),
                "job_id": str(row["job_id"]),
                "phase": str(row["phase"] or ""),
                "role": str(row["role"] or ""),
                "tool_name": str(row["tool_name"] or ""),
                "payload": _json_loads(row["payload_json"], {}),
                "created_at": str(row["created_at"] or ""),
            }
            for row in rows
        ]

    async def upsert_artifact(
        self,
        *,
        job_id: str,
        kind: str,
        paper_key: str,
        payload: Any,
    ) -> None:
        if not paper_key:
            raise ValueError("paper_key is required for artifact upsert")
        created_at = utc_now_iso()
        serialized = (
            payload
            if isinstance(payload, str)
            else json.dumps(payload or {}, ensure_ascii=False)
        )
        async with self._db() as db:
            await db.execute(
                """
                INSERT INTO artifacts (job_id, kind, paper_key, path_or_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(job_id, kind, paper_key)
                DO UPDATE SET
                    path_or_json = excluded.path_or_json,
                    created_at = excluded.created_at
                """,
                (job_id, kind, paper_key, serialized, created_at),
            )
            await db.execute(
                "UPDATE jobs SET updated_at = ? WHERE job_id = ?",
                (created_at, job_id),
            )
            await db.commit()

    async def list_artifacts(self, job_id: str) -> list[dict[str, Any]]:
        async with self._db() as db:
            cursor = await db.execute(
                """
                SELECT * FROM artifacts
                WHERE job_id = ?
                ORDER BY artifact_id ASC
                """,
                (job_id,),
            )
            rows = await cursor.fetchall()
        return [
            {
                "artifact_id": int(row["artifact_id"]),
                "job_id": str(row["job_id"]),
                "kind": str(row["kind"] or ""),
                "paper_key": str(row["paper_key"] or ""),
                "payload": _json_loads(row["path_or_json"], row["path_or_json"]),
                "created_at": str(row["created_at"] or ""),
            }
            for row in rows
        ]
