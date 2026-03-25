from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
import traceback
import uuid
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from .render import build_tasklist_content, build_thread_snapshot
from .schemas import (
    TERMINAL_JOB_STATUSES,
    DeepResearchSettings,
    JobRecord,
    utc_now_iso,
)
from .store import DeepResearchStore

JsonLlmCallable = Callable[..., Awaitable[dict[str, Any]]]
TextLlmCallable = Callable[..., Awaitable[str]]
StreamTextLlmCallable = Callable[..., Awaitable[str]]
ReportPostprocessor = Callable[
    [str, list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]],
    str,
]
TasklistUrlBuilder = Callable[[str], str]

DISCUSSION_STREAM_THROTTLE_SECONDS = 0.35
DISCUSSION_STREAM_MIN_CHARS = 48
UPLOAD_WAIT_TIMEOUT_SECONDS = 600
ROUND_TOOL_CALL_CAP = 5
DEFAULT_JOB_RETRY_LIMIT = 2
DEFAULT_FINAL_REPORT_RETRY_LIMIT = 2
MAX_RETRY_LIMIT = 5
FINAL_REPORT_MAIN_FORBIDDEN_TERMS = (
    "证据不足",
    "需谨慎",
    "谨慎解读",
    "低证据",
    "摘要证据",
    "待用户上传原文",
    "用户未补充原文",
    "无法自动精读",
    "科学性",
    "样本偏差",
    "因果夸大",
    "外推过度",
    "争议点",
)
FINAL_REPORT_CITATION_RE = re.compile(r"\[(?:P\d+-S\d+|\d{1,3}|W\d{1,3})\]")
FINAL_REPORT_FORMULA_HINT_TERMS = (
    "公式",
    "推导",
    "原理",
    "理论",
    "机理",
    "方程",
    "算法",
    "模型",
    "dft",
    "fft",
    "hamilton",
    "hamiltonian",
    "density functional",
    "fourier",
    "量子",
    "泛函",
    "傅里叶",
    "统计",
    "优化",
    "能量",
)


class DeepResearchCancelled(Exception):
    pass


def _env_int(name: str, default: int, *, min_value: int = 0, max_value: int = MAX_RETRY_LIMIT) -> int:
    raw = str(os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except Exception:
        value = default
    return max(min_value, min(value, max_value))


def _clean_startup_policy(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"resume", "cancel"}:
        return normalized
    if normalized in {"close", "stop", "cancel_unfinished"}:
        return "cancel"
    return "cancel"


def _is_invalid_placeholder_paper(paper: dict[str, Any]) -> bool:
    if not isinstance(paper, dict):
        return True
    title = str(paper.get("title") or "").strip()
    doi = str(paper.get("doi") or "").strip()
    openalex_id = str(paper.get("openalex_id") or paper.get("id") or "").strip()
    source_url = str(paper.get("source_pdf_url") or paper.get("oa_url") or "").strip()
    paper_key = str(paper.get("paper_key") or "").strip().lower()
    upload_request = paper.get("upload_request") if isinstance(paper.get("upload_request"), dict) else {}
    identifier = upload_request.get("identifier") if isinstance(upload_request.get("identifier"), dict) else {}
    identifier_value = str(identifier.get("value") or "").strip()
    source_links = upload_request.get("source_links") if isinstance(upload_request.get("source_links"), list) else []
    has_signal = bool(
        title
        or doi
        or openalex_id
        or source_url
        or identifier_value
        or any(str(item).strip() for item in source_links)
    )
    return paper_key in {"", "paper"} and not has_signal


def _is_invalid_upload_wait_payload(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    paper = {
        "paper_key": payload.get("paper_key"),
        "title": payload.get("title"),
        "doi": payload.get("doi"),
        "openalex_id": payload.get("openalex_id"),
        "source_pdf_url": payload.get("source_url"),
        "upload_request": {
            "identifier": payload.get("identifier") if isinstance(payload.get("identifier"), dict) else {},
            "source_links": payload.get("source_links") if isinstance(payload.get("source_links"), list) else [],
        },
    }
    return _is_invalid_placeholder_paper(paper)


@dataclass(slots=True)
class _ResearchState:
    job: JobRecord
    settings: DeepResearchSettings
    followups: list[str] = field(default_factory=list)
    tool_history: list[dict[str, Any]] = field(default_factory=list)
    latest_synthesis: str = ""
    latest_mentor_review: dict[str, Any] = field(default_factory=dict)
    latest_student_discussion: str = ""
    latest_mentor_discussion: str = ""
    latest_round_plan: dict[str, Any] = field(default_factory=dict)
    papers: dict[str, dict[str, Any]] = field(default_factory=dict)
    webs: dict[str, dict[str, Any]] = field(default_factory=dict)
    tool_call_count: int = 0
    paper_read_count: int = 0
    student_discussion_count: int = 0
    mentor_discussion_count: int = 0

    @property
    def paper_list(self) -> list[dict[str, Any]]:
        return sorted(
            [paper for paper in self.papers.values() if not _is_invalid_placeholder_paper(paper)],
            key=lambda item: int(item.get("paper_number") or 10**9),
        )

    @property
    def web_list(self) -> list[dict[str, Any]]:
        return sorted(
            self.webs.values(),
            key=lambda item: int(item.get("web_number") or 10**9),
        )


class _McpToolClient:
    def __init__(self, cwd: str):
        self.cwd = cwd
        self._stack = AsyncExitStack()
        self._session: Optional[ClientSession] = None
        self._use_stdio = str(os.getenv("DEEP_RESEARCH_USE_STDIO_MCP") or "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }

    async def __aenter__(self) -> "_McpToolClient":
        if not self._use_stdio:
            self._session = None
            return self
        try:
            server_params = StdioServerParameters(
                command=sys.executable,
                args=["-m", "deep_research.mcp_bridge"],
                env=dict(os.environ),
                cwd=self.cwd,
            )
            transport = await self._stack.enter_async_context(stdio_client(server_params))
            read_stream, write_stream = transport[:2]
            self._session = await self._stack.enter_async_context(
                ClientSession(
                    read_stream=read_stream,
                    write_stream=write_stream,
                    sampling_callback=None,
                )
            )
            await self._session.initialize()
        except Exception:
            self._session = None
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self._stack.aclose()

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        from .mcp_bridge import call_tool_local

        if not self._session:
            return await call_tool_local(name, arguments)

        try:
            result = await self._session.call_tool(
                name,
                arguments=arguments,
                read_timeout_seconds=timedelta(seconds=20),
            )
            structured = getattr(result, "structuredContent", None)
            if isinstance(structured, dict):
                return structured
            content = getattr(result, "content", None)
            if isinstance(content, list):
                texts: list[str] = []
                for item in content:
                    if getattr(item, "type", "") == "text":
                        texts.append(str(getattr(item, "text", "") or ""))
                merged = "\n".join(texts).strip()
                if merged:
                    try:
                        parsed = json.loads(merged)
                        if isinstance(parsed, dict):
                            return parsed
                    except Exception:
                        return {
                            "ok": not bool(getattr(result, "isError", False)),
                            "text": merged,
                        }
            return {"ok": not bool(getattr(result, "isError", False))}
        except Exception:
            return await call_tool_local(name, arguments)


class DeepResearchManager:
    def __init__(
        self,
        *,
        store: DeepResearchStore,
        json_llm: JsonLlmCallable,
        text_llm: TextLlmCallable,
        stream_text_llm: Optional[StreamTextLlmCallable] = None,
        tasklist_url_builder: TasklistUrlBuilder,
        backend_cwd: str,
        report_postprocessor: Optional[ReportPostprocessor] = None,
        startup_policy: str = "",
    ):
        self.store = store
        self._json_llm = json_llm
        self._text_llm = text_llm
        self._stream_text_llm = stream_text_llm
        self._tasklist_url_builder = tasklist_url_builder
        self._backend_cwd = backend_cwd
        self._report_postprocessor = report_postprocessor
        self._startup_policy = _clean_startup_policy(
            startup_policy or os.getenv("DEEP_RESEARCH_STARTUP_POLICY", "cancel")
        )
        self._initialized = False
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._live_states: dict[str, _ResearchState] = {}
        self._wait_tasks: dict[str, asyncio.Task[None]] = {}
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        if self._initialized:
            return
        await self.store.initialize()
        if self._startup_policy == "resume":
            await self.store.reset_running_jobs_to_queued()
        else:
            await self.store.cancel_active_jobs()
        self._initialized = True
        if self._startup_policy == "resume":
            await self.resume_pending_jobs()
            await self._resume_waiting_jobs()

    async def resume_pending_jobs(self) -> None:
        for job in await self.store.list_jobs_by_status(["queued"]):
            await self._ensure_job_task(job.job_id)

    async def _resume_waiting_jobs(self) -> None:
        for job in await self.store.list_jobs_by_status(["running"]):
            if job.phase == "waiting_user" and job.waiting_kind == "upload":
                if await self._recover_invalid_upload_wait(job):
                    continue
                self._schedule_wait_timeout(job)

    async def _recover_invalid_upload_wait(self, job: JobRecord) -> bool:
        waiting_payload = job.waiting_payload_json if isinstance(job.waiting_payload_json, dict) else {}
        if job.phase != "waiting_user" or job.waiting_kind != "upload":
            return False
        if not _is_invalid_upload_wait_payload(waiting_payload):
            return False
        await self.store.append_event(
            job_id=job.job_id,
            phase="invalid_upload_request_skipped",
            role="system",
            payload={
                "round": job.round,
                "paper_key": str(waiting_payload.get("paper_key") or "").strip(),
                "summary": "检测到无效的补传原文占位请求，已自动跳过并继续研究。",
            },
        )
        updated = await self._clear_waiting_state(job.job_id, next_phase="student")
        await self._append_phase_update(
            job.job_id,
            round_number=job.round,
            summary="检测到无效的补传原文占位请求，已自动跳过并继续研究。",
        )
        if updated is not None:
            state = self._live_states.get(job.job_id)
            if state is not None:
                state.job = updated
        await self._ensure_job_task(job.job_id)
        return True

    async def start_or_continue_job(
        self,
        *,
        thread_id: str,
        owner_key: str,
        question: str,
        settings: DeepResearchSettings,
    ) -> tuple[JobRecord, bool]:
        await self.initialize()
        clean_question = question.strip()
        async with self._lock:
            active = await self.store.get_active_job_for_thread(thread_id)
            if active:
                if clean_question:
                    await self.store.append_event(
                        job_id=active.job_id,
                        phase="user_note",
                        role="user",
                        payload={"note": clean_question},
                    )
                if active.phase == "waiting_user" and active.waiting_kind == "upload":
                    recovered = await self._recover_invalid_upload_wait(active)
                    if recovered:
                        await asyncio.sleep(0)
                        active = await self.store.get_job(active.job_id) or active
                if active.phase != "waiting_user":
                    await self._ensure_job_task(active.job_id)
                    await asyncio.sleep(0)
                refreshed = await self.store.get_job(active.job_id)
                if not refreshed:
                    raise RuntimeError(f"Missing active research job: {active.job_id}")
                return refreshed, False

            job_id = str(uuid.uuid4())
            trace_message_id = f"deep-research-trace-{job_id}"
            final_message_id = f"deep-research-final-{job_id}"
            tasklist_element_id = f"deep-research-tasklist-{job_id}"
            created = await self.store.create_job(
                job_id=job_id,
                thread_id=thread_id,
                owner_key=owner_key,
                question=clean_question,
                status="queued",
                phase="queued",
                round=1,
                trace_message_id=trace_message_id,
                final_message_id=final_message_id,
                tasklist_element_id=tasklist_element_id,
                settings_json=settings.to_dict(),
            )
            await self.store.append_event(
                job_id=job_id,
                phase="job_created",
                role="system",
                payload={
                    "summary": "深度研究任务已创建，等待后端开始执行。",
                    "question": clean_question,
                    "settings": settings.to_dict(),
                },
            )
            await self._ensure_job_task(job_id)
            await asyncio.sleep(0)
            return created, True

    async def cancel_job(self, job_id: str, owner_key: str) -> Optional[JobRecord]:
        await self.initialize()
        job = await self.store.get_job(job_id)
        if not job or job.owner_key != owner_key:
            return None
        updated = await self.store.update_job(job_id, status="cancel_requested")
        await self.store.append_event(
            job_id=job_id,
            phase="cancel_requested",
            role="system",
            payload={"summary": "已收到取消请求，正在安全停止当前研究任务。"},
        )
        self._cancel_wait_task(job_id)
        cancel_event = self._cancel_events.get(job_id)
        if cancel_event:
            cancel_event.set()
        return updated

    async def regenerate_final_report(
        self,
        *,
        job_id: str,
        owner_key: str,
    ) -> Optional[dict[str, Any]]:
        await self.initialize()
        job = await self.store.get_job(job_id)
        if not job or job.owner_key != owner_key:
            return None
        if job.status in {"queued", "running", "cancel_requested"}:
            snapshot = await self.get_thread_snapshot(thread_id=job.thread_id, owner_key=owner_key)
            return {"job_id": job.job_id, "started": False, "snapshot": snapshot}

        updated = await self.store.update_job(
            job.job_id,
            status="queued",
            phase="writing",
            finished_at="",
            error="",
        )
        if updated is None:
            return None
        state = self._live_states.get(job.job_id)
        if state is not None:
            state.job = updated
        await self.store.append_event(
            job_id=job.job_id,
            phase="report_regeneration_requested",
            role="user",
            payload={
                "round": max(1, updated.round),
                "summary": "已收到重新生成综述请求，将基于当前证据重新撰写终稿。",
            },
        )
        await self._append_phase_update(
            job.job_id,
            round_number=max(1, updated.round),
            summary="已收到重新生成综述请求，正在基于现有证据重新撰写终稿。",
        )
        await self._ensure_job_task(job.job_id)
        snapshot = await self.get_thread_snapshot(thread_id=job.thread_id, owner_key=owner_key)
        return {"job_id": job.job_id, "started": True, "snapshot": snapshot}

    async def get_thread_snapshot(
        self,
        *,
        thread_id: str,
        owner_key: str,
    ) -> Optional[dict[str, Any]]:
        await self.initialize()
        job = await self.store.get_latest_job_for_thread(thread_id)
        if not job or job.owner_key != owner_key:
            return None
        events = await self.store.list_events(job.job_id)
        artifacts = await self.store.list_artifacts(job.job_id)
        return build_thread_snapshot(
            job=job,
            events=events,
            artifacts=artifacts,
            tasklist_url=self._tasklist_url_builder(job.job_id),
        )

    async def get_tasklist_payload(
        self,
        *,
        job_id: str,
        owner_key: str,
    ) -> Optional[dict[str, Any]]:
        job = await self.store.get_job(job_id)
        if not job or job.owner_key != owner_key:
            return None
        return build_tasklist_content(job)

    async def submit_uploads(
        self,
        *,
        thread_id: str,
        owner_key: str,
        uploaded_files: list[dict[str, Any]],
        note: str = "",
        target_paper_key: str = "",
    ) -> Optional[dict[str, Any]]:
        await self.initialize()
        job = await self.store.get_active_job_for_thread(thread_id)
        if not job or job.owner_key != owner_key:
            return None

        state = self._live_states.get(job.job_id)
        if state is None:
            state = await self._load_state(job.job_id)
            self._live_states[job.job_id] = state

        cleaned_note = str(note or "").strip()
        if cleaned_note:
            state.followups.append(cleaned_note)
            await self.store.append_event(
                job_id=job.job_id,
                phase="user_note",
                role="user",
                payload={"note": cleaned_note},
            )

        ingest_summary = await self._ingest_uploaded_files(
            state,
            uploaded_files=uploaded_files,
            target_paper_key=target_paper_key,
        )
        if not ingest_summary:
            return None

        await self._append_phase_update(
            job_id=job.job_id,
            round_number=state.job.round,
            summary=ingest_summary["phase_summary"],
        )
        await self._clear_waiting_state(state.job.job_id, next_phase="student")
        await self._wait_for_existing_task_to_settle(job.job_id)
        await self._ensure_job_task(job.job_id)
        snapshot = await self.get_thread_snapshot(thread_id=thread_id, owner_key=owner_key)
        return {
            "job_id": job.job_id,
            "matched": ingest_summary["matched"],
            "pending_count": ingest_summary["pending_count"],
            "snapshot": snapshot,
        }

    async def submit_clarification_answers(
        self,
        *,
        job_id: str,
        owner_key: str,
        request_id: str,
        answers: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        await self.initialize()
        job = await self.store.get_job(job_id)
        if not job or job.owner_key != owner_key:
            return None
        if job.phase != "waiting_user" or job.waiting_kind != "clarification":
            return None
        waiting_payload = job.waiting_payload_json if isinstance(job.waiting_payload_json, dict) else {}
        if request_id and request_id != str(waiting_payload.get("request_id") or "").strip():
            return None

        note = self._clarification_answers_to_note(answers)
        await self.store.append_event(
            job_id=job.job_id,
            phase="clarification_answered",
            role="user",
            payload={
                "round": job.round,
                "request_id": request_id,
                "answers": answers,
                "note": note,
            },
        )
        await self.store.upsert_artifact(
            job_id=job.job_id,
            kind="clarification_request",
            paper_key=request_id or "clarification",
            payload={
                **waiting_payload,
                "request_id": request_id,
                "answered": True,
                "answers": answers,
                "answered_at": utc_now_iso(),
            },
        )
        updated = await self.store.get_job(job.job_id)
        if updated is not None:
            state = self._live_states.get(job.job_id)
            if state is None:
                state = await self._load_state(job.job_id)
                self._live_states[job.job_id] = state
            if note:
                state.followups.append(note)
        await self._clear_waiting_state(job.job_id, next_phase="student")
        await self._append_phase_update(
            job_id=job.job_id,
            round_number=job.round,
            summary="已收到研究方向澄清，继续执行拆题与检索计划。",
        )
        await self._wait_for_existing_task_to_settle(job.job_id)
        await self._ensure_job_task(job.job_id)
        snapshot = await self.get_thread_snapshot(thread_id=job.thread_id, owner_key=owner_key)
        return {"job_id": job.job_id, "snapshot": snapshot}

    async def skip_upload_request(
        self,
        *,
        job_id: str,
        owner_key: str,
        request_id: str,
        paper_key: str,
        reason: str,
    ) -> Optional[dict[str, Any]]:
        await self.initialize()
        job = await self.store.get_job(job_id)
        if not job or job.owner_key != owner_key:
            return None
        state = self._live_states.get(job.job_id)
        if state is None:
            state = await self._load_state(job.job_id)
            self._live_states[job.job_id] = state
        paper = self._find_paper_by_key(state, paper_key)
        if paper is None:
            return None
        await self._mark_upload_skipped(
            state,
            paper=paper,
            request_id=request_id,
            reason=reason or "用户跳过该文献",
            timed_out=False,
        )
        await self._clear_waiting_state(job.job_id, next_phase="student")
        await self._append_phase_update(
            job_id=job.job_id,
            round_number=job.round,
            summary="已跳过无法获取原文的文献，研究将基于其余证据继续收束。",
        )
        await self._wait_for_existing_task_to_settle(job.job_id)
        await self._ensure_job_task(job.job_id)
        snapshot = await self.get_thread_snapshot(thread_id=job.thread_id, owner_key=owner_key)
        return {"job_id": job.job_id, "snapshot": snapshot}

    async def wait_for_job(
        self,
        job_id: str,
        *,
        timeout_seconds: Optional[float] = None,
        poll_interval_seconds: float = 0.1,
    ) -> Optional[JobRecord]:
        await self.initialize()

        async def _wait() -> Optional[JobRecord]:
            while True:
                task = self._tasks.get(job_id)
                if task and not task.done():
                    try:
                        await asyncio.wait_for(
                            asyncio.shield(task),
                            timeout=max(poll_interval_seconds, 0.05),
                        )
                    except asyncio.TimeoutError:
                        pass

                job = await self.store.get_job(job_id)
                if not job or job.status in TERMINAL_JOB_STATUSES:
                    return job
                await asyncio.sleep(max(poll_interval_seconds, 0.05))

        if timeout_seconds is not None:
            return await asyncio.wait_for(_wait(), timeout=timeout_seconds)
        return await _wait()

    def _cancel_wait_task(self, job_id: str) -> None:
        task = self._wait_tasks.pop(job_id, None)
        if task and not task.done():
            task.cancel()

    async def _wait_for_existing_task_to_settle(self, job_id: str, *, timeout_seconds: float = 1.0) -> None:
        task = self._tasks.get(job_id)
        if not task or task.done():
            return
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout_seconds)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            return

    def _schedule_wait_timeout(self, job: JobRecord) -> None:
        self._cancel_wait_task(job.job_id)
        if job.phase != "waiting_user" or job.waiting_kind != "upload":
            return
        if not str(job.waiting_until or "").strip():
            return

        async def _watch() -> None:
            while True:
                current = await self.store.get_job(job.job_id)
                if not current:
                    return
                if current.phase != "waiting_user" or current.waiting_kind != "upload":
                    return
                remaining = self._seconds_until(current.waiting_until)
                if remaining <= 0:
                    await self._handle_upload_timeout(job.job_id)
                    return
                await asyncio.sleep(min(max(remaining, 0.2), 5.0))

        self._wait_tasks[job.job_id] = asyncio.create_task(_watch())

    async def _clear_waiting_state(self, job_id: str, *, next_phase: str = "") -> Optional[JobRecord]:
        self._cancel_wait_task(job_id)
        fields: dict[str, Any] = {
            "waiting_kind": "",
            "waiting_payload_json": {},
            "waiting_until": "",
        }
        if next_phase:
            fields["phase"] = next_phase
        return await self.store.update_job(job_id, **fields)

    async def _set_waiting_state(
        self,
        job_id: str,
        *,
        waiting_kind: str,
        payload: dict[str, Any],
        waiting_until: str = "",
    ) -> Optional[JobRecord]:
        updated = await self.store.update_job(
            job_id,
            phase="waiting_user",
            waiting_kind=waiting_kind,
            waiting_payload_json=payload,
            waiting_until=waiting_until,
        )
        if updated is not None:
            self._schedule_wait_timeout(updated)
        return updated

    async def _ensure_job_task(self, job_id: str) -> None:
        job = await self.store.get_job(job_id)
        if not job:
            return
        if job.phase == "waiting_user" and job.waiting_kind:
            if job.waiting_kind == "upload" and await self._recover_invalid_upload_wait(job):
                return
            self._schedule_wait_timeout(job)
            return
        existing = self._tasks.get(job_id)
        if existing and not existing.done():
            return
        cancel_event = self._cancel_events.get(job_id)
        if cancel_event is None:
            cancel_event = asyncio.Event()
            self._cancel_events[job_id] = cancel_event
        task = asyncio.create_task(self._run_job(job_id, cancel_event))
        self._tasks[job_id] = task

        def _cleanup(_task: asyncio.Task[None]) -> None:
            self._tasks.pop(job_id, None)
            self._cancel_events.pop(job_id, None)
            self._live_states.pop(job_id, None)

        task.add_done_callback(_cleanup)

    async def _run_job(self, job_id: str, cancel_event: asyncio.Event) -> None:
        while True:
            job = await self.store.get_job(job_id)
            if not job:
                return
            try:
                await self._run_job_once(job, cancel_event)
                return
            except DeepResearchCancelled:
                self._cancel_wait_task(job_id)
                await self.store.update_job(
                    job_id,
                    status="canceled",
                    phase="canceled",
                    finished_at=utc_now_iso(),
                )
                await self.store.append_event(
                    job_id=job_id,
                    phase="canceled",
                    role="system",
                    payload={"summary": "研究任务已取消。"},
                )
                return
            except Exception as exc:
                if await self._schedule_retry_after_exception(job_id, exc):
                    continue
                await self._mark_job_failed(job_id, exc)
                return

    async def _run_job_once(self, job: JobRecord, cancel_event: asyncio.Event) -> None:
        job_id = job.job_id
        if job.phase == "waiting_user" and job.waiting_kind == "upload":
            if await self._recover_invalid_upload_wait(job):
                job = await self.store.get_job(job_id)
                if not job:
                    return
            if self._seconds_until(job.waiting_until) <= 0:
                await self._handle_upload_timeout(job_id)
                job = await self.store.get_job(job_id)
                if not job:
                    return
            else:
                self._schedule_wait_timeout(job)
                return
        if job.phase == "waiting_user" and job.waiting_kind == "clarification":
            return

        was_queued = job.phase == "queued" or job.status == "queued"
        resume_phase = "student" if job.phase in {"queued", "waiting_user"} else job.phase
        updated = await self.store.update_job(
            job_id,
            status="running",
            phase=resume_phase,
            started_at=job.started_at or utc_now_iso(),
        )
        if updated is None:
            raise RuntimeError(f"Unable to start research job: {job_id}")
        if was_queued:
            await self._append_phase_update(
                job_id,
                round_number=updated.round,
                summary=f"开始第 {updated.round} 轮研究：先判断是否需要澄清，再拆题并执行最小化工具计划。",
            )
        state = await self._load_state(job_id)
        self._live_states[job_id] = state
        current_phase = str(state.job.phase or "student").strip() or "student"

        async with _McpToolClient(self._backend_cwd) as mcp_client:
            while current_phase != "writing" and state.job.round <= state.settings.budget.max_rounds:
                await self._raise_if_cancelled(state.job.job_id, cancel_event)
                if current_phase == "mentor":
                    ready = await self._run_mentor_phase(state, cancel_event)
                    if ready or state.job.round >= state.settings.budget.max_rounds:
                        current_phase = "writing"
                        break
                    next_job = await self.store.update_job(
                        state.job.job_id,
                        round=state.job.round + 1,
                        phase="student",
                    )
                    if next_job is None:
                        raise RuntimeError(f"Unable to move to next round for {state.job.job_id}")
                    state.job = next_job
                    current_phase = "student"
                    await self._append_phase_update(
                        state.job.job_id,
                        round_number=state.job.round,
                        summary=f"进入第 {state.job.round} 轮补强：只围绕上一轮缺口补证据，并在本轮强制收尾。",
                    )
                    continue

                student_outcome = await self._run_student_phase(
                    state,
                    mcp_client,
                    cancel_event,
                )
                if student_outcome == "waiting":
                    return
                current_phase = "mentor"

            await self._raise_if_cancelled(state.job.job_id, cancel_event)
            final_report = await self._build_final_report(state)
            self._cancel_wait_task(state.job.job_id)
            await self.store.update_job(
                state.job.job_id,
                status="completed",
                phase="completed",
                finished_at=utc_now_iso(),
                final_report_md=final_report,
                error="",
            )
            await self.store.append_event(
                job_id=state.job.job_id,
                phase="final_report",
                role="system",
                payload={"summary": "最终综述已生成。"},
            )

    async def _load_state(self, job_id: str) -> _ResearchState:
        job = await self.store.get_job(job_id)
        if not job:
            raise RuntimeError(f"Research job not found: {job_id}")
        artifacts = await self.store.list_artifacts(job_id)
        events = await self.store.list_events(job_id)
        state = _ResearchState(job=job, settings=job.settings)
        for artifact in artifacts:
            payload = artifact.get("payload")
            if not isinstance(payload, dict):
                continue
            kind = str(artifact.get("kind") or "")
            if kind == "paper":
                key = str(payload.get("paper_key") or artifact.get("paper_key") or "").strip()
                if key:
                    state.papers[key] = payload
            elif kind == "web":
                key = str(payload.get("web_key") or artifact.get("paper_key") or "").strip()
                if key:
                    state.webs[key] = payload
            elif kind == "student_discussion":
                state.student_discussion_count = max(
                    state.student_discussion_count,
                    self._safe_int(payload.get("seq"), 0),
                )
                markdown = str(payload.get("markdown") or "").strip()
                if markdown:
                    state.latest_student_discussion = markdown
            elif kind == "mentor_discussion":
                state.mentor_discussion_count = max(
                    state.mentor_discussion_count,
                    self._safe_int(payload.get("seq"), 0),
                )
                markdown = str(payload.get("markdown") or "").strip()
                if markdown:
                    state.latest_mentor_discussion = markdown
            elif kind == "round_plan":
                state.latest_round_plan = payload
            elif kind == "round_summary":
                markdown = str(payload.get("markdown") or payload.get("content") or "").strip()
                if markdown:
                    state.latest_synthesis = markdown
            elif kind == "round_review":
                if payload:
                    state.latest_mentor_review = payload
        for event in events:
            phase = str(event.get("phase") or "")
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            if phase == "user_note":
                note = str(payload.get("note") or "").strip()
                if note:
                    state.followups.append(note)
            elif phase == "clarification_answered":
                note = str(payload.get("note") or "").strip()
                if note:
                    state.followups.append(note)
            elif phase == "tool_result":
                tool_name = str(event.get("tool_name") or payload.get("tool_name") or "").strip()
                if payload.get("count_towards_budget", True):
                    state.tool_call_count += 1
                    if tool_name == "paper_read":
                        state.paper_read_count += 1
                state.tool_history.append(payload)
            elif phase == "student_synthesis":
                state.latest_synthesis = str(payload.get("summary_md") or payload.get("summary") or "").strip()
            elif phase == "mentor_review":
                state.latest_mentor_review = payload
        return state

    async def _raise_if_cancelled(self, job_id: str, cancel_event: asyncio.Event) -> None:
        if cancel_event.is_set():
            raise DeepResearchCancelled()
        job = await self.store.get_job(job_id)
        if job and job.status == "cancel_requested":
            raise DeepResearchCancelled()

    async def _append_phase_update(
        self,
        job_id: str,
        *,
        round_number: int,
        summary: str,
    ) -> None:
        await self.store.append_event(
            job_id=job_id,
            phase="phase_update",
            role="system",
            payload={"round": round_number, "summary": summary.strip()},
        )

    def _job_retry_limit(self) -> int:
        return _env_int(
            "DEEP_RESEARCH_JOB_RETRIES",
            DEFAULT_JOB_RETRY_LIMIT,
            min_value=0,
            max_value=MAX_RETRY_LIMIT,
        )

    def _final_report_retry_limit(self) -> int:
        return _env_int(
            "DEEP_RESEARCH_FINAL_REPORT_RETRIES",
            DEFAULT_FINAL_REPORT_RETRY_LIMIT,
            min_value=0,
            max_value=MAX_RETRY_LIMIT,
        )

    @staticmethod
    def _retry_backoff_seconds(attempt: int) -> float:
        return float(min(6, max(1, attempt)))

    async def _count_events_by_phase(self, job_id: str, phase: str) -> int:
        events = await self.store.list_events(job_id)
        return sum(1 for event in events if str(event.get("phase") or "").strip() == phase)

    async def _mark_job_failed(self, job_id: str, exc: Exception) -> None:
        self._cancel_wait_task(job_id)
        error_text = f"{exc!s}\n{traceback.format_exc()}"
        await self.store.update_job(
            job_id,
            status="failed",
            phase="failed",
            finished_at=utc_now_iso(),
            error=error_text,
        )
        await self.store.append_event(
            job_id=job_id,
            phase="failed",
            role="system",
            payload={"summary": f"研究任务失败：{exc!s}"},
        )

    async def _schedule_retry_after_exception(self, job_id: str, exc: Exception) -> bool:
        job = await self.store.get_job(job_id)
        if not job or job.status in TERMINAL_JOB_STATUSES:
            return False
        max_retries = self._job_retry_limit()
        retry_count = await self._count_events_by_phase(job_id, "job_retry_scheduled")
        if retry_count >= max_retries:
            return False
        next_attempt = retry_count + 1
        delay_seconds = self._retry_backoff_seconds(next_attempt)
        resume_phase = job.phase if job.phase in {"student", "mentor", "writing"} else "queued"
        await self.store.update_job(
            job_id,
            status="queued",
            phase=resume_phase,
            finished_at="",
            error="",
        )
        await self.store.append_event(
            job_id=job_id,
            phase="job_retry_scheduled",
            role="system",
            payload={
                "round": max(1, job.round),
                "attempt": next_attempt,
                "max_retries": max_retries,
                "delay_seconds": delay_seconds,
                "resume_phase": resume_phase,
                "error": str(exc or ""),
                "summary": (
                    f"研究在 {resume_phase} 阶段发生异常，"
                    f"{int(delay_seconds)} 秒后自动重试（{next_attempt}/{max_retries}）。"
                ),
            },
        )
        await self._append_phase_update(
            job_id,
            round_number=max(1, job.round),
            summary=(
                f"{resume_phase} 阶段发生异常，"
                f"{int(delay_seconds)} 秒后自动重试（{next_attempt}/{max_retries}）。"
            ),
        )
        await asyncio.sleep(delay_seconds)
        return True

    def _budgets_left(self, state: _ResearchState) -> dict[str, int]:
        budget = state.settings.budget
        return {
            "rounds_left": max(0, budget.max_rounds - state.job.round + 1),
            "tool_calls_left": max(0, budget.max_tool_calls - state.tool_call_count),
            "paper_reads_left": max(0, budget.max_paper_reads - state.paper_read_count),
            "candidate_papers_left": max(0, budget.max_candidate_papers - len(state.papers)),
        }

    def _normalize_tool_arguments(
        self,
        state: _ResearchState,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        raw = arguments if isinstance(arguments, dict) else {}

        def _first_text(*keys: str) -> str:
            for key in keys:
                value = str(raw.get(key) or "").strip()
                if value:
                    return value
            return ""

        def _first_int(default: int, *keys: str) -> int:
            for key in keys:
                value = raw.get(key)
                if value is None or value == "":
                    continue
                try:
                    return int(value)
                except Exception:
                    continue
            return default

        def _paper_read_target_from_paper(paper: dict[str, Any]) -> Optional[dict[str, str]]:
            title = str(paper.get("title") or "").strip()
            identifier = (
                str(paper.get("doi") or "").strip()
                or str(paper.get("openalex_id") or "").strip()
                or str(paper.get("id") or "").strip()
            )
            paper_key = str(paper.get("paper_key") or "").strip()
            if not identifier and paper_key and paper_key.lower() != "paper":
                identifier = paper_key
            if not identifier and not title:
                return None
            return {"identifier": identifier, "title": title}

        def _next_paper_read_target() -> Optional[dict[str, str]]:
            for paper in state.paper_list:
                if paper.get("evidence_units"):
                    continue
                if self._paper_needs_user_upload(paper):
                    continue
                target = _paper_read_target_from_paper(paper)
                if target is not None:
                    return target
            return None

        if tool_name == "paper_search":
            return {
                "query": _first_text("query", "q", "question", "keywords"),
                "max_results": _first_int(
                    state.settings.openalex_per_query,
                    "max_results",
                    "top_k",
                    "k",
                ),
            }
        if tool_name == "web_search":
            return {
                "query": _first_text("query", "q", "question", "keywords"),
                "max_results": _first_int(
                    state.settings.websearch_per_query,
                    "max_results",
                    "top_k",
                    "k",
                ),
                "selected_model": str(state.settings.selected_model or "").strip(),
            }
        if tool_name == "paper_read":
            identifier = _first_text(
                "identifier",
                "doi",
                "openalex_id",
                "arxiv_id",
                "url",
                "paper_key",
            )
            title = _first_text("title")
            if not identifier and not title:
                target = _next_paper_read_target()
                if target is not None:
                    return target
                return {"identifier": "", "title": ""}
            if identifier and not title:
                candidate = self._find_paper_for_read_request(
                    state,
                    {"identifier": identifier, "title": ""},
                )
                if candidate is not None:
                    title = str(candidate.get("title") or "").strip()
            return {"identifier": identifier, "title": title}
        if tool_name == "web_read":
            return {
                "url": _first_text("url", "link"),
                "max_chars": _first_int(6000, "max_chars", "max_length"),
            }
        return raw

    def _paper_catalog_for_prompt(self, state: _ResearchState) -> str:
        if not state.paper_list:
            return "暂无论文证据。"
        blocks: list[str] = []
        for paper in state.paper_list[:30]:
            paper_number = self._safe_int(paper.get("paper_number"), 0)
            evidence_units = paper.get("evidence_units") if isinstance(paper.get("evidence_units"), list) else []
            evidence_preview: list[str] = []
            for item in evidence_units[:3]:
                if not isinstance(item, dict):
                    continue
                evidence_id = str(item.get("evidence_id") or "").strip()
                text = str(item.get("text") or "").strip()
                if evidence_id and text:
                    evidence_preview.append(f"[{evidence_id}] {text[:140]}")
            evidence_text = "\n".join(evidence_preview) if evidence_preview else "暂无句级证据。"
            access_status = self._paper_access_status_text(paper)
            upload_request = paper.get("upload_request") if isinstance(paper.get("upload_request"), dict) else {}
            upload_reason = str(
                paper.get("user_upload_reason")
                or upload_request.get("reason")
                or ""
            ).strip()
            source_links = upload_request.get("source_links") if isinstance(upload_request.get("source_links"), list) else []
            source_link_text = "；".join(
                str(item).strip() for item in source_links[:3] if str(item).strip()
            ) or "无"
            blocks.append(
                "\n".join(
                    [
                        f"[{paper_number}] {str(paper.get('title') or '').strip()}",
                        f"作者: {str(paper.get('authors') or '').strip() or '未知'}",
                        f"年份: {str(paper.get('year') or '').strip() or '未知'}",
                        f"来源: {str(paper.get('venue') or '').strip() or '未知'}",
                        f"DOI: {str(paper.get('doi') or '').strip() or 'N/A'}",
                        f"证据状态: {access_status}",
                        f"已精读: {'是' if evidence_units else '否'}",
                        f"摘要: {str(paper.get('abstract') or '').strip()[:360] or '无摘要'}",
                        f"证据片段: {evidence_text}",
                        f"待上传原因: {upload_reason or '无'}",
                        f"上传线索: {source_link_text}",
                    ]
                )
            )
        return "\n\n".join(blocks)

    def _web_catalog_for_prompt(self, state: _ResearchState) -> str:
        if not state.web_list:
            return "暂无网页来源。"
        blocks: list[str] = []
        for entry in state.web_list[:20]:
            web_number = self._safe_int(entry.get("web_number"), 0)
            blocks.append(
                "\n".join(
                    [
                        f"[W{web_number}] {str(entry.get('title') or '').strip() or '未命名网页'}",
                        f"URL: {str(entry.get('url') or '').strip()}",
                        f"摘要/正文: {str(entry.get('snippet') or entry.get('content') or '').strip()[:320] or '无可用正文'}",
                    ]
                )
            )
        return "\n\n".join(blocks)

    def _recent_tool_history_for_prompt(self, state: _ResearchState, limit: int = 6) -> str:
        if not state.tool_history:
            return "暂无工具返回结果。"
        lines: list[str] = []
        for item in state.tool_history[-limit:]:
            tool_name = str(item.get("tool_name") or "").strip() or "unknown_tool"
            round_number = self._safe_int(item.get("round"), 0)
            summary = str(item.get("summary") or "").strip()
            if summary:
                lines.append(f"- 第 {round_number} 轮 `{tool_name}`: {summary}")
        return "\n".join(lines) if lines else "暂无工具返回结果。"

    def _available_papers_for_read_prompt(self, state: _ResearchState) -> str:
        candidates: list[str] = []
        for paper in state.paper_list:
            if paper.get("evidence_units"):
                continue
            if self._paper_needs_user_upload(paper):
                continue
            paper_number = self._safe_int(paper.get("paper_number"), 0)
            title = str(paper.get("title") or "").strip()
            paper_key = str(paper.get("paper_key") or "").strip()
            if title or paper_key:
                candidates.append(f"- [{paper_number}] {title} ({paper_key})")
        return "\n".join(candidates[:10]) if candidates else "暂无尚未精读的候选论文。"

    def _papers_waiting_upload_prompt(self, state: _ResearchState) -> str:
        pending: list[str] = []
        for paper in state.paper_list:
            if not self._paper_needs_user_upload(paper):
                continue
            paper_number = self._safe_int(paper.get("paper_number"), 0)
            title = str(paper.get("title") or "").strip()
            upload_request = paper.get("upload_request") if isinstance(paper.get("upload_request"), dict) else {}
            reason = str(
                paper.get("user_upload_reason")
                or upload_request.get("reason")
                or "缺少可自动精读的全文"
            ).strip()
            pending.append(f"- [{paper_number}] {title}: {reason}")
        return "\n".join(pending[:10]) if pending else "暂无待用户上传原文的论文。"

    def _paper_needs_user_upload(self, paper: dict[str, Any]) -> bool:
        if not isinstance(paper, dict):
            return False
        if bool(paper.get("skipped_by_user")):
            return False
        upload_request = paper.get("upload_request") if isinstance(paper.get("upload_request"), dict) else {}
        if bool(upload_request.get("fulfilled")) or bool(upload_request.get("skipped")):
            return False
        if bool(paper.get("needs_user_upload")) or bool(paper.get("requires_user_upload")):
            return True
        return str(paper.get("access_status") or "").strip().lower() == "upload_required"

    def _paper_access_status_text(self, paper: dict[str, Any]) -> str:
        if bool(paper.get("skipped_by_user")):
            upload_request = paper.get("upload_request") if isinstance(paper.get("upload_request"), dict) else {}
            if bool(upload_request.get("timed_out")):
                return "补充原文超时跳过"
            return "已跳过补充原文"
        if self._paper_needs_user_upload(paper):
            return "待用户上传原文，当前无法自动精读"
        if paper.get("evidence_units"):
            return "已获取全文与句级证据"
        if bool(
            str(paper.get("fulltext") or "").strip()
            or str(paper.get("ocr_text") or "").strip()
            or str(paper.get("local_pdf_url") or "").strip()
            or bool(paper.get("can_auto_deep_read"))
        ):
            return "已获取全文或快照，但尚未形成句级证据"
        return "仅摘要或元数据"

    def _find_paper_for_read_request(
        self,
        state: _ResearchState,
        arguments: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        identifier = str(arguments.get("identifier") or "").strip().lower()
        title = str(arguments.get("title") or "").strip().lower()
        for paper in state.paper_list:
            keys = {
                str(paper.get("paper_key") or "").strip().lower(),
                str(paper.get("doi") or "").strip().lower(),
                str(paper.get("openalex_id") or "").strip().lower(),
                str(paper.get("id") or "").strip().lower(),
                str(paper.get("title") or "").strip().lower(),
            }
            keys.discard("")
            if identifier and identifier in keys:
                return paper
            if title and title == str(paper.get("title") or "").strip().lower():
                return paper
        return None

    def _find_paper_by_key(
        self,
        state: _ResearchState,
        paper_key: str,
    ) -> Optional[dict[str, Any]]:
        normalized = str(paper_key or "").strip().lower()
        if not normalized:
            return None
        for paper in state.paper_list:
            keys = {
                str(paper.get("paper_key") or "").strip().lower(),
                str(paper.get("doi") or "").strip().lower(),
                str(paper.get("openalex_id") or "").strip().lower(),
                str(paper.get("id") or "").strip().lower(),
            }
            if normalized in keys:
                return paper
        return None

    def _paper_source_links_for_upload(
        self,
        paper: dict[str, Any],
        upload_request: dict[str, Any],
    ) -> list[str]:
        source_links = (
            upload_request.get("source_links")
            if isinstance(upload_request.get("source_links"), list)
            else []
        )
        merged: list[str] = []
        seen: set[str] = set()
        for candidate in [
            *source_links,
            paper.get("source_pdf_url"),
            paper.get("oa_url"),
            paper.get("openalex_url"),
        ]:
            value = str(candidate or "").strip()
            if not value:
                continue
            lowered = value.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            merged.append(value)
        doi = str(paper.get("doi") or "").strip()
        if doi:
            doi_url = f"https://doi.org/{doi}"
            if doi_url.lower() not in seen:
                merged.append(doi_url)
        return merged

    def _merge_upload_request_paper(
        self,
        state: _ResearchState,
        *,
        paper: Optional[dict[str, Any]],
        arguments: dict[str, Any],
        result: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        result_paper = result.get("paper") if isinstance(result.get("paper"), dict) else {}
        upload_request = (
            result.get("upload_request") if isinstance(result.get("upload_request"), dict) else {}
        )
        payload = dict(paper or {})
        payload.update(result_paper)

        title = (
            str(payload.get("title") or "").strip()
            or str(upload_request.get("title") or "").strip()
            or str(arguments.get("title") or "").strip()
        )
        identifier = str(arguments.get("identifier") or "").strip()
        paper_key = (
            str(payload.get("paper_key") or "").strip()
            or str(upload_request.get("paper_key") or "").strip()
            or str(payload.get("doi") or "").strip()
            or str(payload.get("openalex_id") or "").strip()
            or str(payload.get("id") or "").strip()
        )
        if not paper_key:
            slug_seed = title or identifier
            slug = re.sub(r"[^a-z0-9]+", "-", slug_seed.lower()).strip("-")
            paper_key = f"manual:{slug}" if slug else f"manual:{uuid.uuid4().hex[:12]}"
        if not title and not paper_key:
            return None

        existing = self._find_paper_by_key(state, paper_key)
        if existing is None and title:
            lowered_title = title.lower()
            for candidate in state.paper_list:
                if lowered_title == str(candidate.get("title") or "").strip().lower():
                    existing = candidate
                    break
        if existing is not None:
            merged = dict(existing)
            merged.update(payload)
            payload = merged

        payload["paper_key"] = paper_key
        payload["title"] = title
        existing_number = self._safe_int(existing.get("paper_number"), 0) if existing else 0
        payload["paper_number"] = (
            self._safe_int(payload.get("paper_number"), 0)
            or existing_number
            or self._next_paper_number(state)
        )
        payload["access_status"] = str(
            result.get("access_status") or payload.get("access_status") or "resolution_failed"
        ).strip() or "resolution_failed"
        payload["can_auto_deep_read"] = False
        payload["requires_user_upload"] = True
        payload["needs_user_upload"] = True
        payload["skipped_by_user"] = False
        payload["user_upload_reason"] = str(
            upload_request.get("reason")
            or result.get("error")
            or payload.get("user_upload_reason")
            or "未能自动获取原文，请上传 PDF。"
        ).strip()
        payload["upload_request"] = {
            **(
                payload.get("upload_request")
                if isinstance(payload.get("upload_request"), dict)
                else {}
            ),
            **upload_request,
            "title": title,
            "paper_key": paper_key,
            "reason": payload["user_upload_reason"],
            "identifier": (
                upload_request.get("identifier")
                if isinstance(upload_request.get("identifier"), dict)
                else {}
            ),
            "source_links": self._paper_source_links_for_upload(payload, upload_request),
        }
        state.papers[paper_key] = payload
        return payload

    def _paper_requiring_upload_after_read(
        self,
        state: _ResearchState,
        arguments: dict[str, Any],
        result: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        paper = self._find_paper_for_read_request(state, arguments)
        result_paper = result.get("paper") if isinstance(result.get("paper"), dict) else {}
        if paper is None:
            for key_name in ("paper_key", "doi", "openalex_id", "id"):
                candidate = self._find_paper_by_key(
                    state,
                    str(result_paper.get(key_name) or "").strip(),
                )
                if candidate is not None:
                    paper = candidate
                    break
        if paper is None:
            result_title = str(result_paper.get("title") or "").strip().lower()
            if result_title:
                for candidate in state.paper_list:
                    if result_title == str(candidate.get("title") or "").strip().lower():
                        paper = candidate
                        break
        access_status = str(
            result.get("access_status") or result_paper.get("access_status") or ""
        ).strip().lower()
        requires_upload = bool(
            result.get("requires_user_upload")
            or result_paper.get("requires_user_upload")
            or result_paper.get("needs_user_upload")
            or access_status in {"upload_required", "resolution_failed"}
        )
        if paper is not None and (requires_upload or self._paper_needs_user_upload(paper)):
            return self._merge_upload_request_paper(
                state,
                paper=paper,
                arguments=arguments,
                result=result,
            )
        if paper is None and requires_upload:
            return self._merge_upload_request_paper(
                state,
                paper=None,
                arguments=arguments,
                result=result,
            )
        return None

    async def _ingest_uploaded_files(
        self,
        state: _ResearchState,
        *,
        uploaded_files: list[dict[str, Any]],
        target_paper_key: str = "",
    ) -> Optional[dict[str, Any]]:
        valid_files = [
            item
            for item in uploaded_files
            if isinstance(item, dict)
            and (
                str(item.get("text") or "").strip()
                or str(item.get("local_pdf_url") or "").strip()
            )
        ]
        if not valid_files:
            return None

        pending_papers = [paper for paper in state.paper_list if self._paper_needs_user_upload(paper)]
        target = self._find_paper_by_key(state, target_paper_key)
        if target is None and len(pending_papers) == 1:
            target = pending_papers[0]

        if target is None:
            names = [str(item.get("name") or "uploaded.pdf").strip() for item in valid_files]
            await self.store.append_event(
                job_id=state.job.job_id,
                phase="user_upload_unmatched",
                role="system",
                payload={
                    "round": state.job.round,
                    "summary": "收到用户上传的 PDF，但当前无法唯一匹配到待补充论文。",
                    "files": names,
                    "target_paper_key": target_paper_key,
                },
            )
            return {
                "matched": 0,
                "pending_count": len(pending_papers),
                "phase_summary": "已收到用户上传 PDF，但当前无法唯一匹配到待补充论文，请通过对应补充卡片再次上传。",
            }

        paper_key = str(target.get("paper_key") or "").strip()
        paper_number = self._safe_int(target.get("paper_number"), 0)
        import demo_openai_compatible_httpx as core

        matched = 0
        latest_payload = dict(target)
        for item in valid_files:
            file_name = str(item.get("name") or "uploaded.pdf").strip()
            upload_hash = str(item.get("hash") or "").strip()
            local_pdf_url = str(item.get("local_pdf_url") or "").strip()
            text = str(item.get("text") or "").strip()
            if not (text or local_pdf_url):
                continue

            payload = dict(latest_payload)
            payload["paper_key"] = paper_key
            payload["paper_number"] = paper_number
            payload["fulltext"] = text or str(payload.get("fulltext") or "").strip()
            payload["ocr_text"] = text or str(payload.get("ocr_text") or "").strip()
            if local_pdf_url:
                payload["local_pdf_url"] = local_pdf_url
            payload["source_pdf_url"] = str(payload.get("source_pdf_url") or f"upload://{file_name}").strip()
            payload["access_status"] = "user_uploaded_pdf"
            payload["can_auto_deep_read"] = True
            payload["requires_user_upload"] = False
            payload["needs_user_upload"] = False
            payload["skipped_by_user"] = False
            payload["user_upload_reason"] = ""
            upload_request = (
                payload.get("upload_request")
                if isinstance(payload.get("upload_request"), dict)
                else {}
            )
            upload_request = {
                **upload_request,
                "fulfilled": True,
                "skipped": False,
                "timed_out": False,
                "uploaded_name": file_name,
            }
            payload["upload_request"] = upload_request
            payload["user_uploaded_name"] = file_name
            payload["user_uploaded_hash"] = upload_hash
            payload["user_uploaded_at"] = utc_now_iso()

            evidence_units = core._build_deepread_evidence_units(
                paper_id=f"P{paper_number or 1}",
                fulltext=payload["ocr_text"] or payload["fulltext"],
                local_pdf_url=str(payload.get("local_pdf_url") or "").strip(),
                max_units=min(core._env_int("OPENALEX_DEEPREAD_MAX_EVIDENCE_UNITS", 500), 500),
            )
            payload["evidence_units"] = evidence_units

            await self.store.upsert_artifact(
                job_id=state.job.job_id,
                kind="paper",
                paper_key=paper_key,
                payload=payload,
            )
            await self.store.upsert_artifact(
                job_id=state.job.job_id,
                kind="uploaded_source",
                paper_key=upload_hash or file_name.lower(),
                payload={
                    "paper_key": paper_key,
                    "paper_number": paper_number,
                    "name": file_name,
                    "hash": upload_hash,
                    "local_pdf_url": local_pdf_url,
                    "uploaded_at": payload["user_uploaded_at"],
                },
            )
            summary = (
                f"已收到用户上传的 PDF《{file_name}》，并写入论文 [{paper_number}] "
                f"{str(payload.get('title') or '').strip()} 的证据池。"
            )
            event_payload = {
                "round": state.job.round,
                "paper_key": paper_key,
                "paper_number": paper_number,
                "title": str(payload.get("title") or "").strip(),
                "summary": summary,
                "file_name": file_name,
                "local_pdf_url": local_pdf_url,
            }
            await self.store.append_event(
                job_id=state.job.job_id,
                phase="user_upload_received",
                role="user",
                payload=event_payload,
            )
            latest_payload = payload
            matched += 1

        state.papers[paper_key] = latest_payload
        pending_count = len([paper for paper in state.paper_list if self._paper_needs_user_upload(paper)])
        if matched <= 0:
            return None
        return {
            "matched": matched,
            "pending_count": pending_count,
            "phase_summary": (
                f"已识别并吸收用户补充的 PDF，论文 [{paper_number}] "
                f"{str(latest_payload.get('title') or '').strip()} 已从“待上传原文”转为可精读证据。"
            ),
        }

    async def _run_student_phase(
        self,
        state: _ResearchState,
        mcp_client: _McpToolClient,
        cancel_event: asyncio.Event,
    ) -> str:
        updated = await self.store.update_job(state.job.job_id, phase="student")
        if updated is not None:
            state.job = updated
        await self._append_phase_update(
            state.job.job_id,
            round_number=state.job.round,
            summary=f"第 {state.job.round} 轮开始：判断是否需要澄清，并生成拆题与最小化工具计划。",
        )
        if state.job.round == 1:
            clarification = await self._maybe_request_clarification(state)
            if clarification:
                await self._append_phase_update(
                    state.job.job_id,
                    round_number=state.job.round,
                    summary="研究方向存在关键歧义，已暂停并等待用户澄清。",
                )
                return "waiting"

        await self._raise_if_cancelled(state.job.job_id, cancel_event)
        budgets = self._budgets_left(state)
        plan = await self._plan_round(state, budgets, cancel_event)
        state.latest_round_plan = plan
        await self._persist_round_plan(state, plan)

        planned_calls = plan.get("planned_calls") if isinstance(plan.get("planned_calls"), list) else []
        blocked_for_upload = await self._execute_round_plan(
            state,
            mcp_client,
            cancel_event,
            planned_calls=planned_calls,
        )
        if blocked_for_upload:
            await self._append_phase_update(
                state.job.job_id,
                round_number=state.job.round,
                summary="关键文献缺少可精读原文，已在研究卡中请求补充 PDF，等待后继续。",
            )
            return "waiting"

        summary_md = await self._generate_student_synthesis(state, cancel_event)
        state.latest_synthesis = summary_md
        await self._persist_round_summary(state, summary_md)
        await self.store.append_event(
            job_id=state.job.job_id,
            phase="student_synthesis",
            role="student",
            payload={
                "round": state.job.round,
                "summary_md": summary_md,
                "reason": "已按计划完成本轮证据采集，生成阶段总结并提交质量审查。",
            },
        )
        return "done"

    async def _run_mentor_phase(
        self,
        state: _ResearchState,
        cancel_event: asyncio.Event,
    ) -> bool:
        updated = await self.store.update_job(state.job.job_id, phase="mentor")
        if updated is not None:
            state.job = updated
        await self._append_phase_update(
            state.job.job_id,
            round_number=state.job.round,
            summary=f"第 {state.job.round} 轮质量审查开始：检查证据缺口、科学性风险和是否可以收尾。",
        )
        await self._raise_if_cancelled(state.job.job_id, cancel_event)
        review = await self._mentor_review(state)
        review["ready_to_conclude"] = bool(review.get("ready_to_conclude"))
        state.latest_mentor_review = review
        if state.job.round >= state.settings.budget.max_rounds:
            review["ready_to_conclude"] = True
            review.setdefault("next_questions", [])
            if "已达最大轮次，本轮强制收尾。" not in review["next_questions"]:
                review["next_questions"].append("已达最大轮次，本轮强制收尾。")
        await self.store.append_event(
            job_id=state.job.job_id,
            phase="mentor_review",
            role="mentor",
            payload={**review, "round": state.job.round},
        )
        await self._persist_round_review(state, review)
        budgets = self._budgets_left(state)
        return bool(review.get("ready_to_conclude")) or budgets["tool_calls_left"] <= 0

    async def _maybe_request_clarification(
        self,
        state: _ResearchState,
    ) -> Optional[dict[str, Any]]:
        if state.job.round != 1:
            return None
        if state.followups:
            return None
        prompt = (
            f"研究问题：{state.job.question}\n"
            "只在歧义会显著改变检索方向时提问。"
            "返回 JSON："
            '{"needs_clarification":false,"reason":"","questions":[{"id":"q1","prompt":"","options":[{"label":"","description":""}],"allow_other":false,"required":true}]}\n'
            "约束：\n"
            "- `reason` 不超过 60 个中文字符。\n"
            "- 最多 2 个问题，每题最多 3 个选项。\n"
            "- 若无需澄清，questions 返回空数组。"
        )
        try:
            result = await self._json_llm(
                messages=[
                    {
                        "role": "system",
                        "content": "你是深度研究前置澄清器，只判断是否必须先澄清研究方向。",
                    },
                    {"role": "user", "content": prompt},
                ],
                selected_model=state.settings.selected_model,
                max_tokens=320,
            )
        except Exception:
            result = {}
        if not isinstance(result, dict) or not bool(result.get("needs_clarification")):
            return None
        raw_questions = result.get("questions") if isinstance(result.get("questions"), list) else []
        questions: list[dict[str, Any]] = []
        for idx, item in enumerate(raw_questions[:2], start=1):
            if not isinstance(item, dict):
                continue
            prompt_text = str(item.get("prompt") or "").strip()
            raw_options = item.get("options") if isinstance(item.get("options"), list) else []
            options: list[dict[str, str]] = []
            for opt in raw_options[:3]:
                if not isinstance(opt, dict):
                    continue
                label = str(opt.get("label") or "").strip()
                if not label:
                    continue
                options.append(
                    {
                        "label": label,
                        "description": str(opt.get("description") or "").strip(),
                    }
                )
            if not prompt_text or not options:
                continue
            questions.append(
                {
                    "id": str(item.get("id") or f"q{idx}").strip() or f"q{idx}",
                    "prompt": prompt_text[:60],
                    "options": options,
                    "allow_other": bool(item.get("allow_other")),
                    "required": bool(item.get("required", True)),
                }
            )
        if not questions:
            return None
        request_id = str(uuid.uuid4())
        payload = {
            "request_id": request_id,
            "round": state.job.round,
            "reason": str(result.get("reason") or "").strip()[:60],
            "questions": questions,
        }
        await self.store.upsert_artifact(
            job_id=state.job.job_id,
            kind="clarification_request",
            paper_key=request_id,
            payload={**payload, "answered": False},
        )
        await self.store.append_event(
            job_id=state.job.job_id,
            phase="clarification_requested",
            role="system",
            payload=payload,
        )
        updated = await self._set_waiting_state(
            state.job.job_id,
            waiting_kind="clarification",
            payload=payload,
            waiting_until="",
        )
        if updated is not None:
            state.job = updated
        return payload

    async def _plan_round(
        self,
        state: _ResearchState,
        budgets: dict[str, int],
        cancel_event: asyncio.Event,
    ) -> dict[str, Any]:
        max_calls = min(ROUND_TOOL_CALL_CAP, max(0, budgets["tool_calls_left"]))
        prompt = (
            f"问题：{state.job.question}\n"
            f"轮次：第 {state.job.round} 轮\n"
            f"用户补充：{'; '.join(state.followups[-3:]) or '无'}\n"
            f"上一轮缺口：{json.dumps(state.latest_mentor_review or {}, ensure_ascii=False)}\n"
            f"论文目录：\n{self._compact_paper_catalog(state)}\n"
            f"网页目录：\n{self._compact_web_catalog(state)}\n"
            f"最近工具摘要：\n{self._recent_tool_history_for_prompt(state, limit=4)}\n\n"
            "只输出 JSON："
            '{"subquestions":[""],"evidence_plan":[""],"planned_calls":[{"tool_name":"paper_search","arguments":{},"reason":""}],"plan_summary":""}\n'
            "规则：\n"
            "- `subquestions` 最多 6 条，总体保持精炼。\n"
            "- `plan_summary` 不超过 220 中文字。\n"
            f"- `planned_calls` 最多 {max_calls} 条，只允许 `paper_search` `paper_read` `web_search` `web_read`。\n"
            "- 同一轮允许连续多次工具调用；若问题天然需要“检索 -> 精读/阅读 -> 补充核验”，应直接规划为 2-4 个连续调用。\n"
            "- 优先综述、survey、meta-analysis、OA 文献；能合并 query 就合并，但不要把本应连续完成的多步证据链强行压成 1 次调用。\n"
            "- 原理/定义类优先论文检索与 OA 精读；应用/背景类优先网页检索与阅读。\n"
            "- `paper_read` 必须指定具体论文目标：至少给出标题、DOI、OpenAlex ID、URL 或已有 paper_key 之一；如果目标尚未确定，就先规划 `paper_search`，不要放空参数占位调用。\n"
            "- 第 2 轮只能围绕上一轮缺口补强，不得扩题。"
        )
        fallback = self._fallback_round_plan(state, budgets)
        try:
            plan = await self._json_llm(
                messages=[
                    {
                        "role": "system",
                        "content": "你是深度研究拆题规划器，强调最少工具调用和短文本输出。",
                    },
                    {"role": "user", "content": prompt},
                ],
                selected_model=state.settings.selected_model,
                max_tokens=700,
            )
        except Exception:
            plan = {}
        if not isinstance(plan, dict):
            plan = {}
        subquestions = [
            str(item).strip()
            for item in (plan.get("subquestions") if isinstance(plan.get("subquestions"), list) else [])
            if str(item).strip()
        ][:6]
        evidence_plan = [
            str(item).strip()
            for item in (plan.get("evidence_plan") if isinstance(plan.get("evidence_plan"), list) else [])
            if str(item).strip()
        ][:6]
        planned_calls: list[dict[str, Any]] = []
        for call in (plan.get("planned_calls") if isinstance(plan.get("planned_calls"), list) else [])[:max_calls]:
            if not isinstance(call, dict):
                continue
            tool_name = str(call.get("tool_name") or "").strip()
            if tool_name not in {"paper_search", "paper_read", "web_search", "web_read"}:
                continue
            normalized_arguments = self._normalize_tool_arguments(
                state,
                tool_name,
                call.get("arguments") if isinstance(call.get("arguments"), dict) else {},
            )
            if tool_name == "paper_read" and not str(normalized_arguments.get("identifier") or "").strip() and not str(
                normalized_arguments.get("title") or ""
            ).strip():
                continue
            planned_calls.append(
                {
                    "tool_name": tool_name,
                    "arguments": normalized_arguments,
                    "reason": str(call.get("reason") or "").strip()[:100],
                }
            )
        has_explicit_plan = any(
            key in plan for key in ("subquestions", "evidence_plan", "planned_calls", "plan_summary")
        )
        if not planned_calls and budgets["tool_calls_left"] > 0 and not has_explicit_plan:
            planned_calls = fallback["planned_calls"]
        normalized = {
            "subquestions": subquestions or fallback["subquestions"],
            "evidence_plan": evidence_plan or fallback["evidence_plan"],
            "planned_calls": planned_calls,
            "plan_summary": str(plan.get("plan_summary") or "").strip()[:220]
            or fallback["plan_summary"],
        }
        await self._stream_generated_discussion(
            state=state,
            role="student",
            stage="planning",
            markdown=self._format_plan_markdown(normalized),
            cancel_event=cancel_event,
        )
        return normalized

    async def _execute_round_plan(
        self,
        state: _ResearchState,
        mcp_client: _McpToolClient,
        cancel_event: asyncio.Event,
        *,
        planned_calls: list[dict[str, Any]],
    ) -> bool:
        queue = list(planned_calls)
        executed = 0
        while queue:
            await self._raise_if_cancelled(state.job.job_id, cancel_event)
            budgets = self._budgets_left(state)
            if budgets["tool_calls_left"] <= 0:
                break
            current = queue.pop(0)
            tool_name = str(current.get("tool_name") or "").strip()
            if tool_name not in {"paper_search", "paper_read", "web_search", "web_read"}:
                continue
            arguments = self._normalize_tool_arguments(
                state,
                tool_name,
                current.get("arguments") if isinstance(current.get("arguments"), dict) else {},
            )
            if tool_name == "paper_read" and budgets["paper_reads_left"] <= 0:
                await self.store.append_event(
                    job_id=state.job.job_id,
                    phase="tool_result",
                    role="system",
                    tool_name=tool_name,
                    payload={
                        "tool_name": tool_name,
                        "round": state.job.round,
                        "summary": "已达到精读论文预算上限，本轮不再执行 `paper_read`。",
                        "count_towards_budget": False,
                    },
                )
                continue
            if tool_name == "paper_read":
                if not str(arguments.get("identifier") or "").strip() and not str(arguments.get("title") or "").strip():
                    await self.store.append_event(
                        job_id=state.job.job_id,
                        phase="tool_result",
                        role="system",
                        tool_name=tool_name,
                        payload={
                            "tool_name": tool_name,
                            "round": state.job.round,
                            "summary": "未指定具体论文目标，已跳过该次 `paper_read`，改为等待检索后自动选择候选文献。",
                            "count_towards_budget": False,
                        },
                    )
                    continue
                pending_upload_paper = self._find_paper_for_read_request(state, arguments)
                if pending_upload_paper and self._paper_needs_user_upload(pending_upload_paper):
                    await self._enter_upload_wait(state, pending_upload_paper)
                    return True
            await self.store.append_event(
                job_id=state.job.job_id,
                phase="tool_call",
                role="student",
                tool_name=tool_name,
                payload={
                    "tool_name": tool_name,
                    "round": state.job.round,
                    "query": json.dumps(arguments, ensure_ascii=False),
                    "summary": str(current.get("reason") or "").strip(),
                },
            )
            await self._append_phase_update(
                state.job.job_id,
                round_number=state.job.round,
                summary=f"执行 `{tool_name}`，采集与当前小问题直接相关的证据。",
            )
            result = await mcp_client.call_tool(tool_name, arguments)
            await self._ingest_tool_result(state, tool_name, result)
            executed += 1
            if tool_name == "paper_read":
                if state.job.phase == "waiting_user" and state.job.waiting_kind == "upload":
                    return True
                paper = self._paper_requiring_upload_after_read(state, arguments, result)
                if paper is not None:
                    await self._enter_upload_wait(state, paper)
                    return True
            if executed >= ROUND_TOOL_CALL_CAP:
                break
            if queue:
                continue
            auto_followup = self._auto_followup_tool_call(state, current_tool=tool_name)
            if auto_followup:
                queue.append(auto_followup)
                continue
            revision = await self._revise_after_tool(
                state,
                current_tool=tool_name,
                current_summary=str(state.tool_history[-1].get("summary") or "").strip() if state.tool_history else "",
                remaining_calls=len(queue),
            )
            if not revision.get("continue", True):
                break
            extra_call = revision.get("extra_call") if isinstance(revision.get("extra_call"), dict) else None
            if extra_call:
                extra_tool = str(extra_call.get("tool_name") or "").strip()
                if extra_tool in {"paper_search", "paper_read", "web_search", "web_read"}:
                    queue.append(
                        {
                            "tool_name": extra_tool,
                            "arguments": self._normalize_tool_arguments(
                                state,
                                extra_tool,
                                extra_call.get("arguments") if isinstance(extra_call.get("arguments"), dict) else {},
                            ),
                            "reason": str(extra_call.get("reason") or "").strip()[:100],
                        }
                    )
        return False

    def _auto_followup_tool_call(
        self,
        state: _ResearchState,
        *,
        current_tool: str,
    ) -> Optional[dict[str, Any]]:
        budgets = self._budgets_left(state)
        if budgets["tool_calls_left"] <= 0:
            return None

        if current_tool == "paper_search" and budgets["paper_reads_left"] > 0:
            for paper in state.paper_list:
                if paper.get("evidence_units"):
                    continue
                if self._paper_needs_user_upload(paper):
                    continue
                title = str(paper.get("title") or "").strip()
                identifier = (
                    str(paper.get("doi") or "").strip()
                    or str(paper.get("openalex_id") or "").strip()
                    or str(paper.get("paper_key") or "").strip()
                )
                if (not identifier and not title) or (identifier.lower() == "paper" and not title):
                    continue
                return {
                    "tool_name": "paper_read",
                    "arguments": {
                        "identifier": identifier,
                        "title": title,
                    },
                    "reason": "本轮已检索到关键候选论文，继续精读最相关且可自动获取全文的文献。",
                }

        if current_tool == "web_search":
            for entry in state.web_list:
                url = str(entry.get("url") or entry.get("web_key") or "").strip()
                if not url:
                    continue
                if str(entry.get("content") or "").strip():
                    continue
                return {
                    "tool_name": "web_read",
                    "arguments": {
                        "url": url,
                        "max_chars": 6000,
                    },
                    "reason": "本轮已检索到网页候选来源，继续阅读最相关页面正文。",
                }

        return None

    async def _revise_after_tool(
        self,
        state: _ResearchState,
        *,
        current_tool: str,
        current_summary: str,
        remaining_calls: int,
    ) -> dict[str, Any]:
        budgets = self._budgets_left(state)
        if budgets["tool_calls_left"] <= 0:
            return {"continue": False}
        prompt = (
            f"问题：{state.job.question}\n"
            f"轮次：第 {state.job.round} 轮\n"
            f"刚完成工具：{current_tool}\n"
            f"结果摘要：{current_summary}\n"
            f"剩余计划调用：{remaining_calls}\n"
            f"上一轮缺口：{json.dumps(state.latest_mentor_review or {}, ensure_ascii=False)}\n"
            "只输出 JSON："
            '{"continue":true,"extra_call":null,"reason":""}\n'
            "规则：\n"
            "- `reason` 不超过 60 个中文字符。\n"
            "- 除非当前结果暴露新缺口，否则不要新增 extra_call。\n"
            "- 若已有剩余计划足够，返回 `continue=true` 且 `extra_call=null`。"
        )
        try:
            result = await self._json_llm(
                messages=[
                    {
                        "role": "system",
                        "content": "你是工具后续决策器，只决定是否继续当前计划或追加 1 个必要调用。",
                    },
                    {"role": "user", "content": prompt},
                ],
                selected_model=state.settings.selected_model,
                max_tokens=220,
            )
        except Exception:
            result = {}
        if not isinstance(result, dict):
            return {"continue": True}
        return {
            "continue": bool(result.get("continue", True)),
            "extra_call": result.get("extra_call") if isinstance(result.get("extra_call"), dict) else None,
            "reason": str(result.get("reason") or "").strip()[:60],
        }

    async def _persist_round_plan(self, state: _ResearchState, plan: dict[str, Any]) -> None:
        payload = {**plan, "round": state.job.round, "content": self._format_plan_markdown(plan)}
        await self.store.upsert_artifact(
            job_id=state.job.job_id,
            kind="round_plan",
            paper_key=f"round-{state.job.round:02d}",
            payload=payload,
        )
        await self.store.append_event(
            job_id=state.job.job_id,
            phase="round_plan",
            role="student",
            payload={
                "round": state.job.round,
                "summary": str(plan.get("plan_summary") or "").strip(),
                "subquestions": plan.get("subquestions") if isinstance(plan.get("subquestions"), list) else [],
                "planned_calls": plan.get("planned_calls") if isinstance(plan.get("planned_calls"), list) else [],
            },
        )

    async def _persist_round_summary(self, state: _ResearchState, summary_md: str) -> None:
        await self.store.upsert_artifact(
            job_id=state.job.job_id,
            kind="round_summary",
            paper_key=f"round-{state.job.round:02d}",
            payload={"round": state.job.round, "markdown": summary_md},
        )

    async def _persist_round_review(self, state: _ResearchState, review: dict[str, Any]) -> None:
        review_text = self._format_review_markdown(review)
        await self.store.upsert_artifact(
            job_id=state.job.job_id,
            kind="round_review",
            paper_key=f"round-{state.job.round:02d}",
            payload={"round": state.job.round, "content": review_text, **review},
        )
        await self._stream_generated_discussion(
            state=state,
            role="mentor",
            stage="critique",
            markdown=review_text,
            cancel_event=asyncio.Event(),
        )

    async def _stream_generated_discussion(
        self,
        *,
        state: _ResearchState,
        role: str,
        stage: str,
        markdown: str,
        cancel_event: asyncio.Event,
    ) -> str:
        text = str(markdown or "").strip()
        if not text:
            return ""
        seq = self._next_discussion_seq(state, role)
        artifact_kind = f"{role}_discussion"
        artifact_key = f"round-{state.job.round:02d}-{stage}-{seq:02d}"
        await self._raise_if_cancelled(state.job.job_id, cancel_event)
        await self.store.upsert_artifact(
            job_id=state.job.job_id,
            kind=artifact_kind,
            paper_key=artifact_key,
            payload={
                "role": role,
                "round": state.job.round,
                "seq": seq,
                "stage": stage,
                "markdown": text,
                "streaming": False,
            },
        )
        if role == "student":
            state.latest_student_discussion = text
        else:
            state.latest_mentor_discussion = text
        return text

    async def _enter_upload_wait(self, state: _ResearchState, paper: dict[str, Any]) -> None:
        paper_number = self._safe_int(paper.get("paper_number"), 0)
        title = str(paper.get("title") or "").strip()
        upload_request = paper.get("upload_request") if isinstance(paper.get("upload_request"), dict) else {}
        request_id = str(upload_request.get("request_id") or "").strip() or str(uuid.uuid4())
        waiting_until = self._future_iso(UPLOAD_WAIT_TIMEOUT_SECONDS)
        identifier = upload_request.get("identifier") if isinstance(upload_request.get("identifier"), dict) else {}
        source_links = self._paper_source_links_for_upload(paper, upload_request)
        payload = {
            "request_id": request_id,
            "round": state.job.round,
            "paper_key": str(paper.get("paper_key") or "").strip(),
            "paper_number": paper_number,
            "title": title,
            "reason": str(
                paper.get("user_upload_reason")
                or upload_request.get("reason")
                or "未获取到可自动精读的全文"
            ).strip()[:80],
            "identifier": identifier,
            "source_links": source_links,
            "source_url": str(
                paper.get("source_pdf_url") or paper.get("oa_url") or ""
            ).strip(),
            "doi": str(paper.get("doi") or "").strip(),
            "openalex_id": str(
                paper.get("openalex_id") or paper.get("openalex_url") or ""
            ).strip(),
        }
        updated_paper = dict(paper)
        updated_upload_request = {
            **upload_request,
            "request_id": request_id,
            "identifier": identifier,
            "source_links": source_links,
            "fulfilled": False,
            "skipped": False,
        }
        updated_paper["upload_request"] = updated_upload_request
        updated_paper["needs_user_upload"] = True
        updated_paper["requires_user_upload"] = True
        state.papers[str(updated_paper.get("paper_key") or "").strip()] = updated_paper
        updated_job = await self._set_waiting_state(
            state.job.job_id,
            waiting_kind="upload",
            payload=payload,
            waiting_until=waiting_until,
        )
        if updated_job is not None:
            state.job = updated_job
        await self.store.upsert_artifact(
            job_id=state.job.job_id,
            kind="paper",
            paper_key=str(updated_paper.get("paper_key") or "").strip(),
            payload=updated_paper,
        )
        await self.store.append_event(
            job_id=state.job.job_id,
            phase="user_upload_requested",
            role="system",
            payload={**payload, "waiting_until": waiting_until},
        )

    async def _handle_upload_timeout(self, job_id: str) -> None:
        job = await self.store.get_job(job_id)
        if not job or job.phase != "waiting_user" or job.waiting_kind != "upload":
            return
        if await self._recover_invalid_upload_wait(job):
            return
        state = self._live_states.get(job.job_id)
        if state is None:
            state = await self._load_state(job.job_id)
            self._live_states[job.job_id] = state
        waiting_payload = job.waiting_payload_json if isinstance(job.waiting_payload_json, dict) else {}
        paper = self._find_paper_by_key(state, str(waiting_payload.get("paper_key") or "").strip())
        if paper is None:
            await self._clear_waiting_state(job.job_id, next_phase="student")
            await self._ensure_job_task(job.job_id)
            return
        await self._mark_upload_skipped(
            state,
            paper=paper,
            request_id=str(waiting_payload.get("request_id") or "").strip(),
            reason="用户未在 10 分钟内补充原文，已超时跳过。",
            timed_out=True,
        )
        await self._clear_waiting_state(job.job_id, next_phase="student")
        await self._append_phase_update(
            job_id=job.job_id,
            round_number=job.round,
            summary="补充原文等待超时，已跳过该文献并继续完成研究。",
        )
        await self._ensure_job_task(job.job_id)

    async def _mark_upload_skipped(
        self,
        state: _ResearchState,
        *,
        paper: dict[str, Any],
        request_id: str,
        reason: str,
        timed_out: bool,
    ) -> None:
        paper_key = str(paper.get("paper_key") or "").strip()
        paper_number = self._safe_int(paper.get("paper_number"), 0)
        payload = dict(paper)
        upload_request = payload.get("upload_request") if isinstance(payload.get("upload_request"), dict) else {}
        payload["needs_user_upload"] = False
        payload["requires_user_upload"] = False
        payload["skipped_by_user"] = True
        payload["access_status"] = "upload_timeout" if timed_out else "upload_skipped"
        payload["user_upload_reason"] = reason
        payload["upload_request"] = {
            **upload_request,
            "request_id": request_id or str(upload_request.get("request_id") or "").strip(),
            "skipped": True,
            "fulfilled": False,
            "timed_out": timed_out,
            "skip_reason": reason,
            "skipped_at": utc_now_iso(),
        }
        state.papers[paper_key] = payload
        await self.store.upsert_artifact(
            job_id=state.job.job_id,
            kind="paper",
            paper_key=paper_key,
            payload=payload,
        )
        await self.store.append_event(
            job_id=state.job.job_id,
            phase="user_upload_skipped",
            role="user" if not timed_out else "system",
            payload={
                "round": state.job.round,
                "paper_key": paper_key,
                "paper_number": paper_number,
                "title": str(payload.get("title") or "").strip(),
                "summary": reason,
                "timed_out": timed_out,
            },
        )

    def _clarification_answers_to_note(self, answers: dict[str, Any]) -> str:
        if not isinstance(answers, dict):
            return ""
        parts: list[str] = []
        for key, value in answers.items():
            if isinstance(value, dict):
                label = str(value.get("label") or value.get("value") or "").strip()
                other = str(value.get("other") or "").strip()
                text = label or other
                if other and other != label:
                    text = f"{label} / {other}" if label else other
            else:
                text = str(value or "").strip()
            if text:
                parts.append(f"{key}={text}")
        return "；".join(parts)

    def _compact_paper_catalog(self, state: _ResearchState, limit: int = 8) -> str:
        if not state.paper_list:
            return "无"
        lines: list[str] = []
        for paper in state.paper_list[:limit]:
            number = self._safe_int(paper.get("paper_number"), 0)
            title = str(paper.get("title") or "").strip() or "未命名论文"
            status = self._paper_access_status_text(paper)
            year = str(paper.get("year") or "").strip()
            lines.append(f"[{number}] {title} | {year or '年份未知'} | {status}")
        return "\n".join(lines)

    def _compact_web_catalog(self, state: _ResearchState, limit: int = 6) -> str:
        if not state.web_list:
            return "无"
        lines: list[str] = []
        for entry in state.web_list[:limit]:
            number = self._safe_int(entry.get("web_number"), 0)
            title = str(entry.get("title") or entry.get("url") or "").strip() or "未命名网页"
            lines.append(f"[W{number}] {title}")
        return "\n".join(lines)

    def _format_plan_markdown(self, plan: dict[str, Any]) -> str:
        subquestions = plan.get("subquestions") if isinstance(plan.get("subquestions"), list) else []
        calls = plan.get("planned_calls") if isinstance(plan.get("planned_calls"), list) else []
        lines = [
            "### 拆题与计划",
            str(plan.get("plan_summary") or "").strip(),
            "",
            "### 子问题",
        ]
        for item in subquestions[:6]:
            text = str(item).strip()
            if text:
                lines.append(f"- {text}")
        lines.extend(["", "### 工具计划"])
        for call in calls[:3]:
            if not isinstance(call, dict):
                continue
            tool_name = str(call.get("tool_name") or "").strip()
            reason = str(call.get("reason") or "").strip()
            if tool_name:
                lines.append(f"- `{tool_name}`：{reason or '按计划执行'}")
        return "\n".join(lines).strip()

    def _format_review_markdown(self, review: dict[str, Any]) -> str:
        gaps = review.get("support_gaps") if isinstance(review.get("support_gaps"), list) else []
        risks = review.get("scientificity_risks") if isinstance(review.get("scientificity_risks"), list) else []
        next_questions = review.get("next_questions") if isinstance(review.get("next_questions"), list) else []
        lines = ["### 质量审查与补强建议"]
        if gaps:
            lines.append("证据缺口：" + "；".join(str(item).strip() for item in gaps[:3] if str(item).strip()))
        if risks:
            lines.append("科学性风险：" + "；".join(str(item).strip() for item in risks[:3] if str(item).strip()))
        if next_questions:
            lines.append("补强建议：" + "；".join(str(item).strip() for item in next_questions[:3] if str(item).strip()))
        lines.append(f"是否可收尾：{'是' if bool(review.get('ready_to_conclude')) else '否'}")
        return "\n".join(lines).strip()

    def _fallback_round_plan(self, state: _ResearchState, budgets: dict[str, int]) -> dict[str, Any]:
        if state.job.round == 1:
            planned_calls = [
                {
                    "tool_name": "paper_search",
                    "arguments": {
                        "query": state.job.question,
                        "max_results": min(state.settings.openalex_per_query, max(1, budgets["candidate_papers_left"])),
                    },
                    "reason": "先用论文检索建立候选证据池。",
                }
            ]
        else:
            planned_calls = [
                {
                    "tool_name": "paper_read",
                    "arguments": {"identifier": str(state.paper_list[0].get("paper_key") or "").strip(), "title": str(state.paper_list[0].get("title") or "").strip()},
                    "reason": "优先补强最关键的候选论文。",
                }
            ] if state.paper_list and budgets["paper_reads_left"] > 0 else []
        return {
            "subquestions": [
                "核心概念/结论具体指什么",
                "哪些证据能直接支撑关键结论",
                "哪些问题仍需明确标注为证据不足",
            ],
            "evidence_plan": ["优先论文综述与 OA 文献，必要时再用网页做背景核验。"],
            "planned_calls": planned_calls[: min(ROUND_TOOL_CALL_CAP, max(0, budgets["tool_calls_left"]))],
            "plan_summary": "先收敛问题边界，再执行最少的论文/网页检索，并只对关键 OA 文献做精读。",
        }

    def _seconds_until(self, iso_value: str) -> float:
        raw = str(iso_value or "").strip()
        if not raw:
            return -1.0
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except Exception:
            return -1.0
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (dt - datetime.now(timezone.utc)).total_seconds()

    def _future_iso(self, seconds: int) -> str:
        return (datetime.now(timezone.utc) + timedelta(seconds=max(0, seconds))).isoformat()

    async def _student_discussion(
        self,
        state: _ResearchState,
        budgets: dict[str, int],
        stage: str,
        cancel_event: asyncio.Event,
    ) -> str:
        stage_instruction = (
            "先澄清问题、列出研究方向，并明确说明下一步应该调用什么工具以及为什么。"
            if stage == "planning"
            else "基于刚拿到的证据继续讨论：哪些结论可以保留，哪些仍然不够，下一步工具应该如何补强。"
        )
        fallback = self._fallback_student_discussion(state, budgets, stage)
        messages = [
            {
                "role": "system",
                "content": (
                    "你是深度研究任务中的学生。你的文本会实时展示给用户。"
                    "只能写当前真实思考，不要伪造不存在的论文或结果。"
                    "你要先讨论问题与研究方向，再决定下一步工具。"
                    "注意：非开放获取或未抓到全文的论文，通常无法通过 `paper_read` 自动精读。"
                    "如果某篇关键论文缺少全文，你必须明确标记“待用户上传原文”，暂时跳过，不要反复假装已读到全文。"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"研究问题：{state.job.question}\n"
                    f"当前轮次：第 {state.job.round} 轮\n"
                    f"阶段：{stage}\n"
                    f"任务要求：{stage_instruction}\n"
                    f"剩余预算：{json.dumps(budgets, ensure_ascii=False)}\n\n"
                    f"用户补充：{'; '.join(state.followups[-5:]) or '无'}\n\n"
                    f"论文证据目录：\n{self._paper_catalog_for_prompt(state)}\n\n"
                    f"待用户上传原文的论文：\n{self._papers_waiting_upload_prompt(state)}\n\n"
                    f"网页来源目录：\n{self._web_catalog_for_prompt(state)}\n\n"
                    f"最近工具结果：\n{self._recent_tool_history_for_prompt(state)}\n\n"
                    f"上一轮导师意见：{json.dumps(state.latest_mentor_review or {}, ensure_ascii=False)}\n\n"
                    "请输出 Markdown，尽量使用以下结构：\n"
                    "### 问题澄清\n"
                    "### 当前证据判断\n"
                    "### 研究方向\n"
                    "### 下一步动作\n"
                    "在“下一步动作”中必须明确写出你打算调用的工具名，或说明为什么现在应该进入阶段综述。"
                ),
            },
        ]
        return await self._stream_role_discussion(
            state=state,
            role="student",
            stage=stage,
            messages=messages,
            max_tokens=1200,
            fallback_text=fallback,
            cancel_event=cancel_event,
        )

    async def _mentor_discussion(
        self,
        state: _ResearchState,
        cancel_event: asyncio.Event,
    ) -> str:
        fallback = self._fallback_mentor_discussion(state)
        messages = [
            {
                "role": "system",
                "content": (
                    "你是深度研究任务中的导师。"
                    "请严格挑刺，专门寻找证据不足、科学性缺陷、因果夸大、样本偏差和对立证据缺失。"
                    "你的文字也会实时展示给用户，因此必须具体、可执行。"
                    "如果关键论文无法自动精读，你必须要求学生降低结论强度，并明确提示用户上传原文 PDF。"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"研究问题：{state.job.question}\n"
                    f"当前轮次：第 {state.job.round} 轮\n\n"
                    f"学生本轮讨论：\n{state.latest_student_discussion or '暂无'}\n\n"
                    f"学生阶段综述：\n{state.latest_synthesis or '暂无'}\n\n"
                    f"论文证据目录：\n{self._paper_catalog_for_prompt(state)}\n\n"
                    f"待用户上传原文的论文：\n{self._papers_waiting_upload_prompt(state)}\n\n"
                    f"网页来源目录：\n{self._web_catalog_for_prompt(state)}\n\n"
                    "请输出 Markdown，尽量使用以下结构：\n"
                    "### 当前结论是否站得住\n"
                    "### 证据缺口\n"
                    "### 科学性风险\n"
                    "### 下一轮要回答的问题\n"
                    "不要替学生补做检索，只指出需要补什么证据。"
                ),
            },
        ]
        return await self._stream_role_discussion(
            state=state,
            role="mentor",
            stage="critique",
            messages=messages,
            max_tokens=1200,
            fallback_text=fallback,
            cancel_event=cancel_event,
        )

    async def _stream_role_discussion(
        self,
        *,
        state: _ResearchState,
        role: str,
        stage: str,
        messages: list[dict[str, Any]],
        max_tokens: int,
        fallback_text: str,
        cancel_event: asyncio.Event,
    ) -> str:
        seq = self._next_discussion_seq(state, role)
        artifact_kind = f"{role}_discussion"
        artifact_key = f"round-{state.job.round:02d}-{stage}-{seq:02d}"
        pieces: list[str] = []
        last_saved_at = 0.0
        last_saved_len = 0

        async def _persist(markdown: str, *, streaming: bool) -> None:
            payload = {
                "role": role,
                "round": state.job.round,
                "seq": seq,
                "stage": stage,
                "markdown": markdown,
                "streaming": streaming,
            }
            await self.store.upsert_artifact(
                job_id=state.job.job_id,
                kind=artifact_kind,
                paper_key=artifact_key,
                payload=payload,
            )

        async def _on_update(token: Any) -> None:
            nonlocal last_saved_at, last_saved_len
            await self._raise_if_cancelled(state.job.job_id, cancel_event)
            chunk = str(token or "")
            if not chunk:
                return
            pieces.append(chunk)
            current_text = "".join(pieces).strip()
            if not current_text:
                return
            now = time.monotonic()
            if (
                len(current_text) - last_saved_len < DISCUSSION_STREAM_MIN_CHARS
                and now - last_saved_at < DISCUSSION_STREAM_THROTTLE_SECONDS
            ):
                return
            await _persist(current_text, streaming=True)
            last_saved_at = now
            last_saved_len = len(current_text)

        text = ""
        if self._stream_text_llm is not None:
            try:
                text = await self._stream_text_llm(
                    messages=messages,
                    selected_model=state.settings.selected_model,
                    max_tokens=max_tokens,
                    on_update=_on_update,
                )
            except TypeError:
                try:
                    text = await self._stream_text_llm(
                        messages=messages,
                        selected_model=state.settings.selected_model,
                        max_tokens=max_tokens,
                    )
                except Exception:
                    text = ""
            except Exception:
                text = ""

        if not str(text or "").strip():
            try:
                text = await self._text_llm(
                    messages=messages,
                    selected_model=state.settings.selected_model,
                    max_tokens=max_tokens,
                )
            except Exception:
                text = ""

        final_text = str(text or "").strip() or "".join(pieces).strip() or fallback_text.strip()
        await _persist(final_text, streaming=False)
        if role == "student":
            state.latest_student_discussion = final_text
        else:
            state.latest_mentor_discussion = final_text
        return final_text

    def _next_discussion_seq(self, state: _ResearchState, role: str) -> int:
        if role == "student":
            state.student_discussion_count += 1
            return state.student_discussion_count
        state.mentor_discussion_count += 1
        return state.mentor_discussion_count

    async def _student_action(
        self,
        state: _ResearchState,
        budgets: dict[str, int],
    ) -> dict[str, Any]:
        system_prompt = (
            "你是深度研究任务中的学生决策器。"
            "请根据当前真实证据决定下一步：调用一个工具，或者结束检索并提交阶段综述。"
            "你必须只输出 JSON，不得输出 JSON 之外的任何内容。"
            "对于已知缺少开放获取全文、已标记待用户上传的论文，不要再次调用 `paper_read`。"
        )
        user_prompt = (
            f"研究问题：{state.job.question}\n"
            f"当前轮次：第 {state.job.round} 轮\n"
            f"剩余预算：{json.dumps(budgets, ensure_ascii=False)}\n\n"
            f"刚刚的学生讨论：\n{state.latest_student_discussion or '暂无'}\n\n"
            f"上一轮导师意见：{json.dumps(state.latest_mentor_review or {}, ensure_ascii=False)}\n\n"
            f"论文目录：\n{self._paper_catalog_for_prompt(state)}\n\n"
            f"待用户上传原文的论文：\n{self._papers_waiting_upload_prompt(state)}\n\n"
            f"网页目录：\n{self._web_catalog_for_prompt(state)}\n\n"
            f"最近工具结果：\n{self._recent_tool_history_for_prompt(state)}\n\n"
            f"尚未精读的论文：\n{self._available_papers_for_read_prompt(state)}\n\n"
            "返回 JSON，格式如下：\n"
            "{"
            '"action":"tool_call|synthesis|finalize",'
            '"reason":"...",'
            '"tool_name":"paper_search|paper_read|web_search|web_read",'
            '"arguments":{}'
            "}\n"
            "规则：\n"
            "- 如果还缺少核心论文证据，优先 `paper_search`。\n"
            "- 只有当某篇论文明显关键时才使用 `paper_read`。\n"
            "- `paper_read` 只适合仍可能自动拿到全文的论文；对“待用户上传原文”的论文不要重试。\n"
            "- 如果关键论文无法自动精读，应转为在讨论或综述中明确请求用户上传 PDF，并继续搜集其他证据。\n"
            "- 如果论文以外的背景或政策信息需要核验，可使用 `web_search` / `web_read`。\n"
            "- 只有在足以提交阶段综述，或预算明显不够继续检索时，才返回 `synthesis` 或 `finalize`。"
        )
        try:
            action = await self._json_llm(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                selected_model=state.settings.selected_model,
                max_tokens=900,
            )
        except Exception:
            action = {}
        if isinstance(action, dict) and str(action.get("action") or "").strip():
            return action
        return self._fallback_student_action(state, budgets)

    def _fallback_student_action(
        self,
        state: _ResearchState,
        budgets: dict[str, int],
    ) -> dict[str, Any]:
        if budgets["tool_calls_left"] <= 0:
            return {"action": "synthesis", "reason": "工具预算已耗尽，必须收束为阶段综述。"}
        if not state.paper_list:
            return {
                "action": "tool_call",
                "reason": "当前还没有论文证据，先做论文检索。",
                "tool_name": "paper_search",
                "arguments": {
                    "query": state.job.question,
                    "max_results": min(state.settings.openalex_per_query, budgets["candidate_papers_left"] or 1),
                },
            }
        if budgets["paper_reads_left"] > 0:
            for paper in state.paper_list:
                if paper.get("evidence_units"):
                    continue
                if self._paper_needs_user_upload(paper):
                    continue
                title = str(paper.get("title") or "").strip()
                identifier = (
                    str(paper.get("doi") or "").strip()
                    or str(paper.get("openalex_id") or "").strip()
                    or str(paper.get("paper_key") or "").strip()
                )
                if (not identifier and not title) or (identifier.lower() == "paper" and not title):
                    continue
                return {
                    "action": "tool_call",
                    "reason": "已有候选论文，但缺少全文证据，优先精读最相关论文。",
                    "tool_name": "paper_read",
                    "arguments": {
                        "identifier": identifier,
                        "title": title,
                    },
                }
        if not state.web_list:
            return {
                "action": "tool_call",
                "reason": "补充背景信息或争议点，增加网页核验来源。",
                "tool_name": "web_search",
                "arguments": {
                    "query": state.job.question,
                    "max_results": state.settings.websearch_per_query,
                },
            }
        return {"action": "synthesis", "reason": "已有基础证据，先提交阶段综述给导师审阅。"}

    async def _generate_student_synthesis(
        self,
        state: _ResearchState,
        cancel_event: asyncio.Event,
    ) -> str:
        await self._raise_if_cancelled(state.job.job_id, cancel_event)
        fallback = self._fallback_synthesis(state)
        messages = [
            {
                "role": "system",
                "content": (
                    "你负责输出阶段总结。"
                    "核心目标是先回答研究问题本身，再补充证据强弱与待核验点。"
                    "不要把证据讨论写成主体，更不要把阶段总结写成审稿意见。"
                    "必须区分：已支持结论、低证据结论、未解决问题。"
                    "若关键论文待补原文或已跳过，必须明说，不能冒充已精读。"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"研究问题：{state.job.question}\n"
                    f"当前轮次：第 {state.job.round} 轮\n\n"
                    f"拆题与计划：\n{self._format_plan_markdown(state.latest_round_plan or self._fallback_round_plan(state, self._budgets_left(state)))}\n\n"
                    f"论文目录：\n{self._compact_paper_catalog(state, limit=10)}\n\n"
                    f"待用户上传原文的论文：\n{self._papers_waiting_upload_prompt(state)}\n\n"
                    f"网页目录：\n{self._compact_web_catalog(state, limit=6)}\n\n"
                    f"最近工具结果：\n{self._recent_tool_history_for_prompt(state, limit=6)}\n\n"
                    "请输出 Markdown，使用以下结构：\n"
                    "### 阶段结论\n"
                    "### 证据支撑\n"
                    "### 证据不足与待核验点\n"
                    "### 建议导师重点审查处\n"
                    "约束：\n"
                    "- `### 阶段结论` 应先正面回答当前已能回答的问题，不少于 180 中文字。\n"
                    "- 总字数尽量控制在 700 中文字以内。\n"
                    "- 引用要求：论文用 [1] [2]，网页用 [W1]，句级证据尽量用 [P1-S3]。\n"
                    "- 对只有摘要或未补原文的论文，必须明确降级表述。\n"
                    "- `### 证据不足与待核验点` 最多 3 条，简短即可，不要喧宾夺主。"
                ),
            },
        ]
        try:
            text = await self._text_llm(
                messages=messages,
                selected_model=state.settings.selected_model,
                max_tokens=1400,
            )
        except Exception:
            text = ""
        return str(text or "").strip() or fallback

    async def _mentor_review(self, state: _ResearchState) -> dict[str, Any]:
        system_prompt = (
            "你是研究质量审查器。"
            "请输出严格 JSON，指出证据缺口、科学性风险、补强问题，以及是否可以收尾。"
        )
        user_prompt = (
            f"研究问题：{state.job.question}\n"
            f"当前轮次：第 {state.job.round} 轮\n\n"
            f"学生阶段综述：\n{state.latest_synthesis or '暂无'}\n\n"
            f"论文目录：\n{self._compact_paper_catalog(state, limit=10)}\n\n"
            f"待用户上传原文的论文：\n{self._papers_waiting_upload_prompt(state)}\n\n"
            f"网页目录：\n{self._compact_web_catalog(state, limit=6)}\n\n"
            "返回 JSON，格式如下：\n"
            "{"
            '"support_gaps":["..."],'
            '"scientificity_risks":["..."],'
            '"next_questions":["..."],'
            '"ready_to_conclude":false'
            "}\n"
            "规则：\n"
            "- 如果网页只能提供背景，不能把它算作核心结论证据。\n"
            "- 要特别警惕样本偏差、因果夸大、只看摘要、缺少对立证据等问题。\n"
            "- 对无法自动精读的关键论文，要要求降低结论强度，并提示补原文。\n"
            "- 每个列表最多 3 条，单条尽量短。\n"
            "- 只有当关键结论已被论文支撑，或被明确标注为证据不足时，才可 `ready_to_conclude=true`。"
        )
        try:
            review = await self._json_llm(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                selected_model=state.settings.selected_model,
                max_tokens=420,
            )
        except Exception:
            review = {}
        if not isinstance(review, dict):
            review = {}
        review["support_gaps"] = [
            str(item).strip()
            for item in (review.get("support_gaps") if isinstance(review.get("support_gaps"), list) else [])
            if str(item).strip()
        ][:3]
        review["scientificity_risks"] = [
            str(item).strip()
            for item in (review.get("scientificity_risks") if isinstance(review.get("scientificity_risks"), list) else [])
            if str(item).strip()
        ][:3]
        review["next_questions"] = [
            str(item).strip()
            for item in (review.get("next_questions") if isinstance(review.get("next_questions"), list) else [])
            if str(item).strip()
        ][:3]
        review.setdefault("ready_to_conclude", False)
        if not review["support_gaps"] and not review["scientificity_risks"]:
            budgets = self._budgets_left(state)
            if state.paper_list or state.web_list:
                review["ready_to_conclude"] = bool(review.get("ready_to_conclude")) or budgets["tool_calls_left"] <= 0
        return review

    async def _ingest_tool_result(
        self,
        state: _ResearchState,
        tool_name: str,
        result: dict[str, Any],
    ) -> None:
        if tool_name == "paper_search":
            summary = await self._ingest_paper_search(state, result)
        elif tool_name == "paper_read":
            summary = await self._ingest_paper_read(state, result)
        elif tool_name == "web_search":
            summary = await self._ingest_web_search(state, result)
        elif tool_name == "web_read":
            summary = await self._ingest_web_read(state, result)
        else:
            summary = json.dumps(result, ensure_ascii=False)[:600]

        state.tool_call_count += 1
        if tool_name == "paper_read":
            state.paper_read_count += 1
        payload = {
            "tool_name": tool_name,
            "round": state.job.round,
            "summary": summary,
            "result_preview": self._result_preview(result),
            "count_towards_budget": True,
        }
        state.tool_history.append(payload)
        await self.store.append_event(
            job_id=state.job.job_id,
            phase="tool_result",
            role="student",
            tool_name=tool_name,
            payload=payload,
        )
        await self._append_phase_update(
            state.job.job_id,
            round_number=state.job.round,
            summary=f"`{tool_name}` 已返回结果，学生正在基于新证据继续讨论。",
        )

    def _next_paper_number(self, state: _ResearchState) -> int:
        numbers = [self._safe_int(item.get("paper_number"), 0) for item in state.paper_list]
        return (max(numbers) if numbers else 0) + 1

    def _next_web_number(self, state: _ResearchState) -> int:
        numbers = [self._safe_int(item.get("web_number"), 0) for item in state.web_list]
        return (max(numbers) if numbers else 0) + 1

    def _relabel_evidence_units(
        self,
        evidence_units: list[dict[str, Any]],
        paper_number: int,
    ) -> list[dict[str, Any]]:
        relabeled: list[dict[str, Any]] = []
        for item in evidence_units:
            if not isinstance(item, dict):
                continue
            copied = dict(item)
            evidence_id = str(copied.get("evidence_id") or "").strip()
            if evidence_id.startswith("P1-"):
                copied["evidence_id"] = f"P{paper_number}-{evidence_id[3:]}"
            relabeled.append(copied)
        return relabeled

    async def _ingest_paper_search(self, state: _ResearchState, result: dict[str, Any]) -> str:
        papers = result.get("papers") if isinstance(result.get("papers"), list) else []
        added = 0
        remaining = max(0, state.settings.budget.max_candidate_papers - len(state.papers))
        for item in papers[:remaining]:
            if not isinstance(item, dict):
                continue
            key = str(item.get("paper_key") or "").strip()
            title = str(item.get("title") or "").strip()
            external_id = (
                str(item.get("doi") or "").strip()
                or str(item.get("openalex_id") or "").strip()
                or str(item.get("id") or "").strip()
            )
            if (not key and not title and not external_id) or (key.lower() == "paper" and not title and not external_id):
                continue
            if not key or key in state.papers:
                continue
            payload = dict(item)
            payload["paper_key"] = key
            payload["paper_number"] = self._next_paper_number(state)
            state.papers[key] = payload
            await self.store.upsert_artifact(
                job_id=state.job.job_id,
                kind="paper",
                paper_key=key,
                payload=payload,
            )
            added += 1
        return f"论文检索返回 {len(papers)} 篇候选结果，新加入证据池 {added} 篇。"

    async def _ingest_paper_read(self, state: _ResearchState, result: dict[str, Any]) -> str:
        if not result.get("ok"):
            if bool(result.get("requires_user_upload")):
                upload_request = (
                    result.get("upload_request") if isinstance(result.get("upload_request"), dict) else {}
                )
                title = str(
                    upload_request.get("title")
                    or (
                        result.get("paper").get("title")
                        if isinstance(result.get("paper"), dict)
                        else ""
                    )
                    or "目标论文"
                ).strip()
                return f"未能自动定位或获取《{title}》，将转入补充原文流程。"
            return str(result.get("error") or "论文精读失败。").strip()
        paper = result.get("paper") if isinstance(result.get("paper"), dict) else {}
        key = str(paper.get("paper_key") or "").strip()
        if not key:
            return "论文精读结果缺少 paper_key。"
        existing = state.papers.get(key)
        if not existing and len(state.papers) >= state.settings.budget.max_candidate_papers:
            return "候选论文池已满，无法将新论文写入证据池。"
        payload = dict(existing or {})
        payload.update(paper)
        payload["paper_key"] = key
        payload["access_status"] = str(
            result.get("access_status") or payload.get("access_status") or ""
        ).strip()
        payload["can_auto_deep_read"] = bool(
            result.get("can_auto_deep_read")
            or payload.get("can_auto_deep_read")
        )
        requires_user_upload = bool(
            result.get("requires_user_upload")
            or payload.get("requires_user_upload")
            or str(result.get("access_status") or "").strip().lower() == "upload_required"
        )
        payload["requires_user_upload"] = requires_user_upload
        payload["needs_user_upload"] = bool(
            requires_user_upload
            or payload.get("needs_user_upload")
        )
        upload_request = (
            result.get("upload_request") if isinstance(result.get("upload_request"), dict) else {}
        )
        if upload_request:
            payload["upload_request"] = upload_request
            payload["user_upload_reason"] = str(upload_request.get("reason") or "").strip()
        paper_number = (
            self._safe_int(existing.get("paper_number"), 0)
            if existing
            else self._next_paper_number(state)
        )
        payload["paper_number"] = paper_number
        evidence_units = (
            payload.get("evidence_units") if isinstance(payload.get("evidence_units"), list) else []
        )
        payload["evidence_units"] = self._relabel_evidence_units(evidence_units, paper_number)
        state.papers[key] = payload
        if self._paper_needs_user_upload(payload):
            await self._enter_upload_wait(state, payload)
            return (
                f"论文 [{paper_number}] {str(payload.get('title') or '').strip()} 当前无法自动精读，"
                "已标记为待用户上传原文并暂时跳过；现阶段只能使用摘要或元数据。"
            )
        await self.store.upsert_artifact(
            job_id=state.job.job_id,
            kind="paper",
            paper_key=key,
            payload=payload,
        )
        return (
            f"已精读论文 [{paper_number}] {str(payload.get('title') or '').strip()}，"
            f"获得 {len(payload.get('evidence_units') or [])} 条句级证据。"
        )

    async def _ingest_web_search(self, state: _ResearchState, result: dict[str, Any]) -> str:
        if not result.get("ok", True):
            return str(result.get("error") or "网页检索失败。").strip()
        entries = result.get("results") if isinstance(result.get("results"), list) else []
        added = 0
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            url = str(entry.get("url") or "").strip()
            if not url or url in state.webs:
                continue
            payload = dict(entry)
            payload["web_key"] = url
            payload["web_number"] = self._next_web_number(state)
            state.webs[url] = payload
            await self.store.upsert_artifact(
                job_id=state.job.job_id,
                kind="web",
                paper_key=url,
                payload=payload,
            )
            added += 1
        backend = str(result.get("backend") or "").strip()
        prefix = f"网页检索（{backend}）" if backend else "网页检索"
        return f"{prefix}返回 {len(entries)} 条结果，新加入来源 {added} 条。"

    async def _ingest_web_read(self, state: _ResearchState, result: dict[str, Any]) -> str:
        if not result.get("ok"):
            return str(result.get("error") or "网页读取失败。").strip()
        url = str(result.get("url") or "").strip()
        if not url:
            return "网页读取结果缺少 URL。"
        existing = state.webs.get(url, {})
        payload = dict(existing)
        payload.update(result)
        payload["web_key"] = url
        payload["web_number"] = self._safe_int(existing.get("web_number"), self._next_web_number(state))
        state.webs[url] = payload
        await self.store.upsert_artifact(
            job_id=state.job.job_id,
            kind="web",
            paper_key=url,
            payload=payload,
        )
        return f"已读取网页 [W{payload['web_number']}] {str(payload.get('title') or url).strip()}。"

    def _result_preview(self, result: dict[str, Any]) -> dict[str, Any]:
        preview: dict[str, Any] = {}
        for key in (
            "query",
            "url",
            "error",
            "ok",
            "backend",
            "access_status",
            "can_auto_deep_read",
            "requires_user_upload",
        ):
            if key in result:
                preview[key] = result.get(key)
        if isinstance(result.get("warnings"), list):
            preview["warnings"] = [str(item).strip() for item in result.get("warnings")[:3] if str(item).strip()]
        if isinstance(result.get("upload_request"), dict):
            preview["upload_request"] = {
                "title": str(result["upload_request"].get("title") or "").strip(),
                "reason": str(result["upload_request"].get("reason") or "").strip(),
            }
        if isinstance(result.get("papers"), list):
            preview["papers"] = [
                {
                    "title": str(item.get("title") or "").strip(),
                    "paper_key": str(item.get("paper_key") or "").strip(),
                }
                for item in result.get("papers")[:5]
                if isinstance(item, dict)
            ]
        if isinstance(result.get("results"), list):
            preview["results"] = [
                {
                    "title": str(item.get("title") or "").strip(),
                    "url": str(item.get("url") or "").strip(),
                }
                for item in result.get("results")[:5]
                if isinstance(item, dict)
            ]
        return preview

    def _fallback_student_discussion(
        self,
        state: _ResearchState,
        budgets: dict[str, int],
        stage: str,
    ) -> str:
        lines = [
            "### 问题澄清",
            f"- 当前研究问题：{state.job.question}",
        ]
        if state.followups:
            lines.append(f"- 用户补充：{'; '.join(state.followups[-3:])}")
        lines.extend(["", "### 当前证据判断"])
        if state.paper_list:
            lines.append(f"- 已有论文候选 {len(state.paper_list)} 篇。")
        else:
            lines.append("- 还没有进入证据池的论文。")
        pending_uploads = [paper for paper in state.paper_list if self._paper_needs_user_upload(paper)]
        if pending_uploads:
            lines.append(f"- 其中有 {len(pending_uploads)} 篇论文缺少可自动精读的全文，需要用户上传 PDF。")
        if state.web_list:
            lines.append(f"- 已有网页来源 {len(state.web_list)} 条。")
        else:
            lines.append("- 还没有网页核验来源。")
        lines.extend(["", "### 研究方向"])
        if stage == "planning":
            lines.append("- 先确认核心术语、主要结局指标与潜在反例。")
        else:
            lines.append("- 基于新证据核查哪些结论可保留，哪些仍需全文或额外来源支持。")
        lines.extend(["", "### 下一步动作"])
        if budgets["tool_calls_left"] <= 0:
            lines.append("- 工具预算已耗尽，改为整理阶段综述并提交导师。")
        elif not state.paper_list:
            lines.append("- 建议调用 `paper_search`，先建立论文候选池。")
        elif budgets["paper_reads_left"] > 0:
            if any(not paper.get("evidence_units") and not self._paper_needs_user_upload(paper) for paper in state.paper_list):
                lines.append("- 建议调用 `paper_read` 精读仍可能自动获取全文的关键论文，争取拿到句级证据。")
            elif pending_uploads:
                lines.append("- 关键论文暂时无法自动精读，应提示用户上传 PDF，并改用其他论文或网页继续核验。")
            else:
                lines.append("- 现有论文暂时不适合继续精读，可先补充网页核验或收束为阶段综述。")
        else:
            lines.append("- 精读预算不足，改为基于现有材料形成阶段综述，并明确待用户上传原文的缺口。")
        return "\n".join(lines)

    def _fallback_mentor_discussion(self, state: _ResearchState) -> str:
        lines = [
            "### 当前结论是否站得住",
            "- 当前综述只能作为阶段性判断，不能自动视为最终结论。",
            "",
            "### 证据缺口",
        ]
        if not state.paper_list:
            lines.append("- 还没有论文证据进入证据池。")
        elif not any(paper.get("evidence_units") for paper in state.paper_list):
            lines.append("- 现有论文大多仍停留在摘要层面，缺少全文证据。")
        else:
            lines.append("- 需要确认关键结论是否已经覆盖了相反证据和适用边界。")
        pending_uploads = [paper for paper in state.paper_list if self._paper_needs_user_upload(paper)]
        if pending_uploads:
            lines.append("- 有关键论文无法自动精读，必须提示用户上传原文，且当前结论需要降级表述。")
        lines.extend(
            [
                "",
                "### 科学性风险",
                "- 需要警惕样本偏差、因果夸大、外推过度和只引用支持性文献。",
                "",
                "### 下一轮要回答的问题",
                "- 哪些关键结论已经有足够论文支持，哪些仍应明确标注为证据不足？",
            ]
        )
        return "\n".join(lines)

    def _fallback_synthesis(self, state: _ResearchState) -> str:
        lines = ["### 阶段结论"]
        if state.paper_list:
            lines.append("- 已建立初步证据池，但结论强度取决于是否拿到了全文和句级证据。")
        else:
            lines.append("- 目前仍缺少足够论文证据，无法给出强结论。")
        lines.extend(["", "### 证据支撑"])
        if state.paper_list:
            for paper in state.paper_list[:6]:
                paper_number = self._safe_int(paper.get("paper_number"), 0)
                title = str(paper.get("title") or "").strip()
                if self._paper_needs_user_upload(paper):
                    lines.append(f"- [{paper_number}] {title} 尚待用户上传原文，目前不能作为全文级证据。")
                elif paper.get("evidence_units"):
                    lines.append(f"- [{paper_number}] {title} 已提供句级证据，可作为较强支撑。")
                else:
                    lines.append(f"- [{paper_number}] {title} 目前仅有摘要或元数据，证据等级较低。")
        else:
            lines.append("- 暂无可引用论文。")
        if state.web_list:
            for entry in state.web_list[:4]:
                web_number = self._safe_int(entry.get("web_number"), 0)
                title = str(entry.get("title") or "").strip() or str(entry.get("url") or "").strip()
                lines.append(f"- [W{web_number}] {title} 仅可作为背景或补充核验。")
        lines.extend(["", "### 证据不足与待核验点"])
        review = state.latest_mentor_review or {}
        gaps = review.get("support_gaps") if isinstance(review.get("support_gaps"), list) else []
        risks = review.get("scientificity_risks") if isinstance(review.get("scientificity_risks"), list) else []
        if gaps or risks:
            for item in [*gaps, *risks]:
                text = str(item).strip()
                if text:
                    lines.append(f"- {text}")
        else:
            lines.append("- 仍需核验关键结论是否有全文支持，以及是否存在对立证据。")
        lines.extend(["", "### 建议导师重点审查处"])
        next_questions = review.get("next_questions") if isinstance(review.get("next_questions"), list) else []
        if next_questions:
            for item in next_questions:
                text = str(item).strip()
                if text:
                    lines.append(f"- {text}")
        else:
            lines.append("- 请重点审查哪些结论仍然依赖摘要证据。")
        return "\n".join(lines)

    async def _build_final_report(self, state: _ResearchState) -> str:
        updated = await self.store.update_job(state.job.job_id, phase="writing")
        if updated is not None:
            state.job = updated
        await self._append_phase_update(
            state.job.job_id,
            round_number=state.job.round,
            summary="开始撰写最终综述，整理结论、争议点、方法边界与参考来源。",
        )
        evidence_units: list[dict[str, Any]] = []
        for paper in state.paper_list:
            units = paper.get("evidence_units") if isinstance(paper.get("evidence_units"), list) else []
            evidence_units.extend([item for item in units if isinstance(item, dict)])

        max_retries = self._final_report_retry_limit()
        report_body = ""
        last_retry_reasons: list[str] = []
        for attempt in range(max_retries + 1):
            report_body, retry_reasons = await self._generate_final_report_body(state)
            if not retry_reasons:
                break
            last_retry_reasons = retry_reasons
            if attempt >= max_retries:
                report_body = ""
                break
            next_attempt = attempt + 1
            await self.store.append_event(
                job_id=state.job.job_id,
                phase="final_report_retry",
                role="system",
                payload={
                    "round": state.job.round,
                    "attempt": next_attempt,
                    "max_retries": max_retries,
                    "reasons": retry_reasons,
                    "summary": f"终稿生成出现异常，准备自动重试（{next_attempt}/{max_retries}）。",
                },
            )
            await self._append_phase_update(
                state.job.job_id,
                round_number=state.job.round,
                summary=(
                    f"终稿生成出现异常，准备自动重试（{next_attempt}/{max_retries}）："
                    f"{'；'.join(retry_reasons[:2])}"
                ),
            )
        if not str(report_body or "").strip():
            report_body = self._fallback_report(state)
            if last_retry_reasons:
                await self.store.append_event(
                    job_id=state.job.job_id,
                    phase="final_report_fallback",
                    role="system",
                    payload={
                        "round": state.job.round,
                        "reasons": last_retry_reasons,
                        "summary": "终稿自动重试后仍异常，已回退到保底综述模板。",
                    },
                )

        references_markdown = self._final_references_markdown(state)
        final_report = (
            f"{report_body.strip()}\n\n"
            + self._wrap_fold_block("参考来源", references_markdown)
        )
        if self._report_postprocessor:
            final_report = self._report_postprocessor(
                final_report,
                state.paper_list,
                state.web_list,
                evidence_units,
            )
        return final_report

    async def _generate_final_report_body(
        self,
        state: _ResearchState,
    ) -> tuple[str, list[str]]:
        prompt, question_needs_formula = self._final_report_prompt(state)
        try:
            report_body = await self._text_llm(
                messages=[
                    {
                        "role": "system",
                        "content": "你是严谨的学术综述写作者。请写一篇先回答用户问题、再在末尾简短说明证据边界的中文综述；主体必须像学术查询模式那样带引用、讲清概念与机制，不要写成严谨性报告。",
                    },
                    {"role": "user", "content": prompt},
                ],
                selected_model=state.settings.selected_model,
                max_tokens=4600,
            )
        except Exception as exc:
            return "", [f"初稿生成异常：{exc!s}"]

        report_body = str(report_body or "").strip()
        quality_issues = self._report_quality_issues(report_body, state.job.question) if report_body else []
        if report_body and quality_issues:
            try:
                issues_text = "\n".join(f"- {item}" for item in quality_issues)
                rewritten = await self._text_llm(
                    messages=[
                        {
                            "role": "system",
                            "content": "你是严谨的学术综述写作者。请把草稿改写成更完整、更理论扎实的中文综述：先回答问题，再在结尾简短说明证据边界。",
                        },
                        {
                            "role": "user",
                            "content": (
                                f"研究问题：{state.job.question}\n\n"
                                f"现有草稿：\n{report_body}\n\n"
                                "请保留这 4 个一级标题：\n"
                                "## 结论\n"
                                "## 核心发现\n"
                                "## 证据不足与争议点\n"
                                "## 方法与适用边界\n\n"
                                f"当前草稿存在这些问题：\n{issues_text}\n\n"
                                "重写要求：\n"
                                "- 重写后，`## 结论` 与 `## 核心发现` 合计必须明显更充分，主体内容先解释问题本身。\n"
                                "- `## 结论` 的每个自然段都要有引用；`## 核心发现` 的每一条都要有引用。\n"
                                "- 绪论/定义/机制/公式/应用等主体内容要先写清楚，再在后两节简短补充边界。\n"
                                "- `## 证据不足与争议点` 保持简短克制，最多 4 条。\n"
                                "- `## 结论` 与 `## 核心发现` 中禁止出现保留意见、证据等级或过程性描述。\n"
                                "- 不能虚构证据，不能把待补原文写成已精读。\n"
                                f"- {'必须补上核心公式，并解释符号含义。' if question_needs_formula else '若问题属于理论/原理解释，请补上核心公式。'}\n"
                                "- 继续使用现有引用格式。"
                            ),
                        },
                    ],
                    selected_model=state.settings.selected_model,
                    max_tokens=5000,
                )
                if str(rewritten or "").strip():
                    report_body = str(rewritten).strip()
            except Exception:
                pass
        return report_body, self._final_report_hard_failure_reasons(report_body)

    def _final_report_prompt(self, state: _ResearchState) -> tuple[str, bool]:
        plan_markdown = self._format_plan_markdown(
            state.latest_round_plan or self._fallback_round_plan(state, self._budgets_left(state))
        )
        question_needs_formula = self._question_prefers_formula(state.job.question)
        prompt = (
            f"研究问题：{state.job.question}\n"
            f"最近一轮拆题与计划：\n{plan_markdown}\n\n"
            f"最终导师意见：{json.dumps(state.latest_mentor_review or {}, ensure_ascii=False)}\n\n"
            f"学生阶段综述：\n{state.latest_synthesis or '暂无'}\n\n"
            f"论文证据目录：\n{self._compact_paper_catalog(state, limit=14)}\n\n"
            f"待用户上传原文的论文：\n{self._papers_waiting_upload_prompt(state)}\n\n"
            f"网页来源目录：\n{self._compact_web_catalog(state, limit=10)}\n\n"
            f"最近工具结果：\n{self._recent_tool_history_for_prompt(state, limit=8)}\n\n"
            "请输出 Markdown，且只包含以下一级标题：\n"
            "## 结论\n"
            "## 核心发现\n"
            "## 证据不足与争议点\n"
            "## 方法与适用边界\n\n"
            "写作目标：\n"
            "- 把“研究问题”当作用户在直接提问。你的主要任务是回答问题本身，不是评价研究流程。\n"
            "- 主体篇幅至少 80% 用于阐述问题本身，包括概念界定、学术背景、核心机制、关键结论、典型应用、差异、适用条件或实现路径；按问题类型灵活展开。\n"
            "- `## 结论` 必须写成一篇小型学术综述的正文：先用 1 段做绪论式定义与背景交代，再分段解释核心机制、关键结论与应用，不要写成摘要式结论。\n"
            "- `## 结论` 使用 4-7 个自然段，尽量写到 700-1400 中文字；复杂问题可以更长，但必须充实、底层、可读。\n"
            "- `## 核心发现` 至少 4 条、最多 8 条；每条都要展开解释，不要只写一句话摘要。\n"
            "- `## 证据不足与争议点` 只放在正文后，控制在 2-4 条，用于补充保留意见，不能喧宾夺主。\n"
            "- `## 方法与适用边界` 简短说明研究方法、适用前提和外推限制，避免重复前文。\n"
            "- 不要描述检索流程、轮次、审稿意见、任务状态、上传等待或任何过程元信息。\n"
            "引用与严谨性规则：\n"
            "- 绪论式介绍也必须有论文引用；`## 结论` 的每个自然段结尾都至少带一个引用。\n"
            "- `## 核心发现` 的每一条都必须带至少一个引用。\n"
            "- 论文引用使用 [1] [2]；如果论文有句级证据，关键句优先使用 [P1-S3] 之类的引用。\n"
            "- 网页引用使用 [W1]，只可用于背景、实现细节或补充核验，不能替代核心论文结论。\n"
            "- 只有摘要、没有全文的论文，要明确标注为低证据或仅摘要证据。\n"
            "- 对待用户上传原文的关键论文，必须明确写出“待用户上传原文”，不能冒充已精读。\n"
            "- 不要把证据不足的问题包装成确定性结论。\n"
            "- `## 结论` 与 `## 核心发现` 中禁止出现以下措辞：证据不足、需谨慎、低证据、摘要证据、待用户上传原文、用户未补充原文、科学性、样本偏差、因果夸大、外推过度、争议点；这些内容只能放在后两节。\n"
            f"- {'该问题偏理论/原理解释，必须给出核心公式，优先使用 $$...$$ 的 LaTeX 显示公式，并在公式后解释符号含义与物理/数学意义。' if question_needs_formula else '如果问题涉及理论、原理、算法或机理，请主动写出关键公式并解释符号含义；若确实不需要公式，可省略。'}"
        )
        return prompt, question_needs_formula

    def _final_references_markdown(self, state: _ResearchState) -> str:
        reference_lines = ["### 论文"]
        if state.paper_list:
            for paper in state.paper_list:
                index = self._safe_int(paper.get("paper_number"), 0)
                pdf_bits: list[str] = []
                local_pdf_url = str(paper.get("local_pdf_url") or "").strip()
                source_pdf_url = str(paper.get("source_pdf_url") or paper.get("oa_url") or "").strip()
                if local_pdf_url:
                    label = "PDF（本地缓存）"
                    if local_pdf_url.endswith(".html") or local_pdf_url.endswith(".htm"):
                        label = "原文快照（本地）"
                    pdf_bits.append(f"[{label}]({local_pdf_url})")
                if source_pdf_url:
                    pdf_bits.append(f"[原始链接]({source_pdf_url})")
                evidence_note = "全文+句级证据" if paper.get("evidence_units") else "仅摘要/元数据"
                if bool(paper.get("skipped_by_user")):
                    upload_request = paper.get("upload_request") if isinstance(paper.get("upload_request"), dict) else {}
                    evidence_note = "用户未补充原文，已跳过" if not bool(upload_request.get("timed_out")) else "原文补充超时，已跳过"
                if self._paper_needs_user_upload(paper):
                    evidence_note = "待用户上传原文"
                parts = [
                    f'<a id="paper-{index}"></a> [{index}] {str(paper.get("title") or "").strip()}',
                    str(paper.get("authors") or "").strip(),
                    str(paper.get("year") or "").strip(),
                    str(paper.get("venue") or "").strip(),
                    evidence_note,
                ]
                doi = str(paper.get("doi") or "").strip()
                if doi:
                    parts.append(doi)
                entry = " | ".join(part for part in parts if part)
                if pdf_bits:
                    entry = f"{entry} | {' '.join(pdf_bits)}"
                reference_lines.append(f"- {entry}")
        else:
            reference_lines.append("- 无")

        reference_lines.extend(["", "### 网页"])
        if state.web_list:
            for entry in state.web_list:
                index = self._safe_int(entry.get("web_number"), 0)
                title = str(entry.get("title") or entry.get("url") or "").strip()
                url = str(entry.get("url") or "").strip()
                reference_lines.append(
                    f'- <a id="web-{index}"></a> [W{index}] [{title}]({url})'
                )
        else:
            reference_lines.append("- 无")
        return "\n".join(reference_lines).strip()

    @classmethod
    def _final_report_hard_failure_reasons(cls, markdown: str) -> list[str]:
        text = str(markdown or "").strip()
        if not text:
            return ["终稿内容为空。"]
        reasons: list[str] = []
        for heading in ("结论", "核心发现", "证据不足与争议点", "方法与适用边界"):
            if not cls._section_text(text, heading):
                reasons.append(f"缺少 `## {heading}` 段落。")
        normalized = text.lower()
        for token in ("undefined", "[object object]", "<|", "assistant:", "user:"):
            if token in normalized:
                reasons.append(f"包含异常占位文本：{token}")
        main_len = len(re.sub(r"\s+", "", cls._section_text(text, "结论"))) + len(
            re.sub(r"\s+", "", cls._section_text(text, "核心发现"))
        )
        if main_len < 20:
            reasons.append("主体异常过短，疑似生成中断。")
        return reasons

    @staticmethod
    def _wrap_fold_block(title: str, body: str) -> str:
        safe_title = str(title or "").replace("\\", "\\\\").replace('"', '\\"')
        return f':::fold{{title="{safe_title}"}}\n{body.strip()}\n:::'

    @staticmethod
    def _section_text(markdown: str, heading: str) -> str:
        pattern = rf"^## {re.escape(heading)}\s*\n(.*?)(?=^##\s|\Z)"
        match = re.search(pattern, markdown or "", flags=re.M | re.S)
        return str(match.group(1) if match else "").strip()

    @classmethod
    def _section_blocks(cls, markdown: str, heading: str) -> list[str]:
        section = cls._section_text(markdown, heading)
        if not section:
            return []
        blocks: list[str] = []
        buffer: list[str] = []
        for raw_line in section.splitlines():
            line = raw_line.strip()
            if not line:
                if buffer:
                    blocks.append(" ".join(buffer).strip())
                    buffer = []
                continue
            if re.match(r"^(- |\d+\.)", line):
                if buffer:
                    blocks.append(" ".join(buffer).strip())
                    buffer = []
                blocks.append(line)
                continue
            buffer.append(line)
        if buffer:
            blocks.append(" ".join(buffer).strip())
        return [block for block in blocks if block]

    @staticmethod
    def _contains_citation(block: str) -> bool:
        return bool(FINAL_REPORT_CITATION_RE.search(block or ""))

    @staticmethod
    def _question_prefers_formula(question: str) -> bool:
        normalized = re.sub(r"\s+", " ", str(question or "").strip().lower())
        if not normalized:
            return False
        return any(term in normalized for term in FINAL_REPORT_FORMULA_HINT_TERMS)

    @staticmethod
    def _text_has_formula(text: str) -> bool:
        compact = str(text or "")
        return bool(
            "$$" in compact
            or re.search(r"\$[^$\n]+\$", compact)
            or re.search(r"\\(frac|sum|prod|int|partial|nabla|sqrt|log|exp|arg|min|max)\b", compact)
        )

    @classmethod
    def _section_has_forbidden_terms(cls, markdown: str, heading: str) -> bool:
        section = cls._section_text(markdown, heading)
        return any(term in section for term in FINAL_REPORT_MAIN_FORBIDDEN_TERMS)

    @classmethod
    def _section_has_uncited_blocks(cls, markdown: str, heading: str) -> bool:
        blocks = cls._section_blocks(markdown, heading)
        if not blocks:
            return True
        for block in blocks:
            visible_len = len(re.sub(r"\s+", "", re.sub(r"\[[^\]]+\]", "", block)))
            if visible_len < 24:
                continue
            if not cls._contains_citation(block):
                return True
        return False

    @classmethod
    def _report_quality_issues(cls, markdown: str, question: str = "") -> list[str]:
        conclusion = re.sub(r"\s+", "", cls._section_text(markdown, "结论"))
        findings = re.sub(r"\s+", "", cls._section_text(markdown, "核心发现"))
        insufficiency = re.sub(r"\s+", "", cls._section_text(markdown, "证据不足与争议点"))
        main_len = len(conclusion) + len(findings)
        issues: list[str] = []
        if main_len < 720:
            issues.append("主体回答过短，`## 结论` 与 `## 核心发现` 仍不够展开。")
        if insufficiency and len(insufficiency) > max(220, int(main_len * 0.35)):
            issues.append("保留意见篇幅过大，喧宾夺主。")
        if cls._section_has_forbidden_terms(markdown, "结论"):
            issues.append("`## 结论` 出现了保留意见或严谨性措辞。")
        if cls._section_has_forbidden_terms(markdown, "核心发现"):
            issues.append("`## 核心发现` 出现了保留意见或严谨性措辞。")
        if cls._section_has_uncited_blocks(markdown, "结论"):
            issues.append("`## 结论` 存在没有引用的段落。")
        if cls._section_has_uncited_blocks(markdown, "核心发现"):
            issues.append("`## 核心发现` 存在没有引用的条目。")
        if cls._question_prefers_formula(question) and not cls._text_has_formula(
            "\n".join(
                [
                    cls._section_text(markdown, "结论"),
                    cls._section_text(markdown, "核心发现"),
                ]
            )
        ):
            issues.append("该问题属于理论/原理解释，但主体没有给出关键公式。")
        return issues

    @classmethod
    def _report_needs_expansion(cls, markdown: str, question: str = "") -> bool:
        return bool(cls._report_quality_issues(markdown, question))

    def _fallback_report(self, state: _ResearchState) -> str:
        def paper_citation(paper: dict[str, Any]) -> str:
            evidence_units = paper.get("evidence_units") if isinstance(paper.get("evidence_units"), list) else []
            first_unit = evidence_units[0] if evidence_units and isinstance(evidence_units[0], dict) else {}
            evidence_id = str(first_unit.get("evidence_id") or "").strip()
            if evidence_id:
                return f"[{evidence_id}]"
            return f"[{self._safe_int(paper.get('paper_number'), 0)}]"

        findings: list[str] = []
        for paper in state.paper_list[:5]:
            index = self._safe_int(paper.get("paper_number"), 0)
            title = str(paper.get("title") or "").strip()
            if self._paper_needs_user_upload(paper):
                findings.append(f"- [{index}] {title} 是当前主题的重要线索之一，但尚未获得原文精读。")
            elif paper.get("evidence_units"):
                findings.append(f"- [{index}] {title} 已提供全文与句级证据，可直接支撑正文中的关键判断。")
            else:
                findings.append(f"- [{index}] {title} 提供了与问题直接相关的摘要级线索，可用于补充背景或方向判断。")
        if not findings:
            findings.append("- 当前没有足够论文证据支撑明确结论。")

        insufficiency: list[str] = []
        review = state.latest_mentor_review or {}
        for key in ("support_gaps", "scientificity_risks", "next_questions"):
            values = review.get(key)
            if isinstance(values, list):
                insufficiency.extend(
                    f"- {str(item).strip()}" for item in values if str(item).strip()
                )
        if not insufficiency:
            insufficiency.append("- 仍需对关键结论做进一步核验。")

        conclusion_citations = ", ".join(
            paper_citation(paper) for paper in state.paper_list[:3]
        ).strip(", ")
        conclusion_lines = [
            (
                f"围绕“{state.job.question}”，当前已经整理出一批与主题直接相关的论文与网页材料，"
                f"可以先给出面向问题本身的工作性综述。"
                + (f" {conclusion_citations}" if conclusion_citations else "")
            ),
        ]
        if state.paper_list:
            strongest = state.paper_list[0]
            strongest_number = self._safe_int(strongest.get("paper_number"), 0)
            strongest_title = str(strongest.get("title") or "").strip()
            if strongest_title:
                conclusion_lines.append(
                    f"就目前材料看，[{strongest_number}] {strongest_title} 是最直接相关的线索之一，应优先据此理解问题的核心定义、关键机制或应用背景。 {paper_citation(strongest)}"
                )
        else:
            conclusion_lines.append("由于目前还没有足够直接相关的论文进入证据池，下面的内容只能给出初步的结构化回答。")

        return "\n".join(
            [
                "## 结论",
                *conclusion_lines,
                "",
                "## 核心发现",
                *findings,
                "",
                "## 证据不足与争议点",
                *insufficiency,
                "",
                "## 方法与适用边界",
                "- 本综述基于论文检索、网页核验以及有限的全文精读生成。",
                "- 只有具备全文和句级证据的论文，才适合承载较强结论。",
            ]
        )

    @staticmethod
    def _safe_int(value: Any, default: int) -> int:
        try:
            return int(value)
        except Exception:
            return default
