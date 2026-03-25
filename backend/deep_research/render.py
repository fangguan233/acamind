from __future__ import annotations

import json
import re
from typing import Any

from .schemas import ACTIVE_JOB_STATUSES, JobRecord


def _payload_lookup(artifacts: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for artifact in artifacts:
        if str(artifact.get("kind") or "") != kind:
            continue
        payload = artifact.get("payload")
        if isinstance(payload, dict):
            result.append(payload)
    return result


def _status_label(status: str) -> str:
    return {
        "queued": "等待启动",
        "running": "研究中",
        "cancel_requested": "正在停止",
        "completed": "已完成",
        "failed": "失败",
        "canceled": "已取消",
    }.get(status, status or "未知")


def _phase_label(phase: str, *, waiting_kind: str = "") -> str:
    if phase == "waiting_user":
        if waiting_kind == "clarification":
            return "等待问题澄清"
        if waiting_kind == "upload":
            return "等待补充原文"
        return "等待用户输入"
    return {
        "queued": "准备任务",
        "student": "拆题与执行",
        "mentor": "质量审查",
        "writing": "撰写最终综述",
        "completed": "完成",
        "failed": "失败",
        "canceled": "已取消",
    }.get(phase, phase or "处理中")


def _artifact_sort_key(artifact: dict[str, Any]) -> tuple[str, int, int]:
    payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
    created_at = str(artifact.get("created_at") or "")
    round_number = int(payload.get("round") or 0)
    seq = int(payload.get("seq") or 0)
    return (created_at, round_number, seq)


def _event_round(event: dict[str, Any]) -> int:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    try:
        return int(payload.get("round") or 0)
    except Exception:
        return 0


def _latest_phase_update(events: list[dict[str, Any]]) -> str:
    for event in reversed(events):
        if str(event.get("phase") or "") != "phase_update":
            continue
        payload = event.get("payload")
        if isinstance(payload, dict):
            summary = str(payload.get("summary") or "").strip()
            if summary:
                return summary
    return ""


def _format_review_text(payload: dict[str, Any]) -> str:
    blocks: list[str] = []
    support_gaps = payload.get("support_gaps") if isinstance(payload.get("support_gaps"), list) else []
    scientificity = (
        payload.get("scientificity_risks")
        if isinstance(payload.get("scientificity_risks"), list)
        else []
    )
    next_questions = (
        payload.get("next_questions")
        if isinstance(payload.get("next_questions"), list)
        else []
    )
    if support_gaps:
        blocks.append("证据缺口：" + "；".join(str(item).strip() for item in support_gaps if str(item).strip()))
    if scientificity:
        blocks.append("科学性风险：" + "；".join(str(item).strip() for item in scientificity if str(item).strip()))
    if next_questions:
        blocks.append("补强建议：" + "；".join(str(item).strip() for item in next_questions if str(item).strip()))
    blocks.append(f"是否可收尾：{'是' if bool(payload.get('ready_to_conclude')) else '否'}")
    return "\n".join(blocks).strip()


def build_tasklist_content(job: JobRecord) -> dict[str, Any]:
    current_phase = job.phase or "queued"
    overall_status = "running" if job.status in ACTIVE_JOB_STATUSES else "done"
    if job.status == "completed":
        overall_status = "done"

    is_waiting = current_phase == "waiting_user" and job.status in ACTIVE_JOB_STATUSES
    waiting_kind = str(job.waiting_kind or "").strip()
    tasks = [
        {
            "title": "创建研究任务",
            "status": "done" if job.status != "queued" else "running",
            "forId": "",
        },
        {
            "title": f"必要澄清与拆题计划（第 {max(1, job.round)} 轮）",
            "status": (
                "running"
                if current_phase == "student" or (is_waiting and waiting_kind == "clarification")
                else "done"
                if current_phase in {"mentor", "writing", "completed"} or job.status == "completed"
                else "ready"
            ),
            "forId": "",
        },
        {
            "title": "证据采集与阶段总结",
            "status": (
                "running"
                if current_phase == "student" or (is_waiting and waiting_kind == "upload")
                else "done"
                if current_phase in {"mentor", "writing", "completed"} or job.status == "completed"
                else "ready"
            ),
            "forId": "",
        },
        {
            "title": "质量审查与最终综述",
            "status": (
                "running"
                if current_phase in {"mentor", "writing"} and job.status in ACTIVE_JOB_STATUSES
                else "done"
                if job.status == "completed"
                else "ready"
            ),
            "forId": "",
        },
    ]
    if job.status in {"failed", "canceled"}:
        tasks[-1]["status"] = "failed"
    return {"status": overall_status, "tasks": tasks}


def build_trace_markdown(
    job: JobRecord,
    events: list[dict[str, Any]],
    artifacts: list[dict[str, Any]],
) -> str:
    del events
    del artifacts
    lines = [
        "## 深度研究",
        "研究过程会在下方过程卡片中实时同步。",
        "",
        f"- 研究问题：{job.question}",
        f"- 当前状态：{_status_label(job.status)}",
        f"- 当前阶段：{_phase_label(job.phase, waiting_kind=job.waiting_kind)}",
        f"- 当前轮次：第 {max(1, job.round)} 轮",
    ]
    if job.phase == "waiting_user":
        if job.waiting_kind == "clarification":
            lines.append("- 任务正在等待你确认研究方向。")
        elif job.waiting_kind == "upload":
            lines.append("- 任务正在等待你补充原文或跳过该文献。")
        else:
            lines.append("- 任务正在等待你的输入。")
    elif job.status in ACTIVE_JOB_STATUSES:
        lines.append("- 过程卡片会继续更新，最终综述完成后会自动填入下一条消息。")
    if job.error:
        lines.extend(["", "### 错误", f"```text\n{job.error.strip()}\n```"])
    return "\n".join(lines)

    latest_progress = _latest_phase_update(events)
    lines = [
        "## 深度研究",
        f"- 状态：{_status_label(job.status)}",
        f"- 当前阶段：{_phase_label(job.phase, waiting_kind=job.waiting_kind)}",
        f"- 当前轮次：第 {max(1, job.round)} 轮",
        f"- 研究问题：{job.question}",
    ]
    if latest_progress:
        lines.append(f"- 最新进度：{latest_progress}")
    if job.error:
        lines.extend(["", "### 错误", f"```text\n{job.error.strip()}\n```"])

    rounds = build_research_card(job=job, events=events, artifacts=artifacts).get("rounds") or []
    if rounds:
        lines.extend(["", "### 轮次概览"])
        for round_item in rounds:
            if not isinstance(round_item, dict):
                continue
            round_number = int(round_item.get("round") or 0)
            status = str(round_item.get("status") or "").strip()
            plan = str(round_item.get("plan") or "").strip()
            summary = str(round_item.get("round_summary") or "").strip()
            review = str(round_item.get("review") or "").strip()
            lines.append(f"- 第 {round_number} 轮（{status or '未知'}）")
            if plan:
                lines.append(f"  - 拆题与计划：{plan[:180]}")
            if summary:
                lines.append(f"  - 阶段总结：{summary[:180]}")
            if review:
                lines.append(f"  - 审查：{review[:180]}")
    else:
        lines.extend(["", "研究过程卡片加载中。"])
    return "\n".join(lines)


def build_placeholder_final_report(job: JobRecord) -> str:
    if job.status == "failed":
        return "## 最终综述\n\n研究任务失败，未能生成最终综述。请查看上方过程中的错误信息，或在研究卡中点击“重新生成综述”。"
    if job.status == "canceled":
        return "## 最终综述\n\n研究任务已取消，未生成最终综述。"
    if job.final_report_md.strip():
        return job.final_report_md
    return "## 最终综述\n\n最终综述尚未生成，完成后会自动填充到这里。"


def build_pdf_refs(artifacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for paper in _payload_lookup(artifacts, "paper"):
        local_pdf_url = str(paper.get("local_pdf_url") or "").strip()
        snapshot_url = str(paper.get("snapshot_url") or "").strip()
        if not (local_pdf_url or snapshot_url):
            continue
        refs.append(
            {
                "paper_key": str(paper.get("paper_key") or "").strip(),
                "title": str(paper.get("title") or "").strip(),
                "local_pdf_url": local_pdf_url,
                "snapshot_url": snapshot_url,
                "source_url": str(
                    paper.get("source_pdf_url") or paper.get("oa_url") or ""
                ).strip(),
            }
        )
    return refs


def _normalize_doi_value(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    return re.sub(r"(?i)^https?://(?:dx\.)?doi\.org/", "", raw).strip()


def _upload_identifier_payload(
    upload_request: dict[str, Any],
    paper: dict[str, Any],
) -> dict[str, str]:
    identifier = (
        upload_request.get("identifier")
        if isinstance(upload_request.get("identifier"), dict)
        else {}
    )
    identifier_type = str(identifier.get("type") or "").strip().lower()
    identifier_value = str(identifier.get("value") or "").strip()
    doi_source = paper.get("doi")
    if not doi_source and identifier_type == "doi":
        doi_source = identifier_value
    doi = _normalize_doi_value(doi_source)
    openalex_id = str(
        paper.get("openalex_id") or paper.get("openalex_url") or ""
    ).strip()
    if doi:
        identifier_type = identifier_type or "doi"
        identifier_value = identifier_value or doi
    elif openalex_id:
        identifier_type = identifier_type or "openalex"
        identifier_value = identifier_value or openalex_id
    return {
        "type": identifier_type,
        "value": identifier_value,
        "doi": doi,
        "openalex_id": openalex_id,
    }


def _build_upload_request_entry(
    *,
    job: JobRecord,
    paper: dict[str, Any],
    upload_request: dict[str, Any],
    waiting_request_id: str,
    waiting_paper_key: str,
    waiting_until: str,
) -> dict[str, Any]:
    identifier = _upload_identifier_payload(upload_request, paper)
    doi = identifier.get("doi") or _normalize_doi_value(
        paper.get("doi") or upload_request.get("doi") or ""
    )
    openalex_id = (
        identifier.get("openalex_id")
        or str(
            paper.get("openalex_id")
            or paper.get("openalex_url")
            or upload_request.get("openalex_id")
            or ""
        ).strip()
    )
    request_id = str(upload_request.get("request_id") or "").strip()
    paper_key = str(paper.get("paper_key") or upload_request.get("paper_key") or "").strip()
    source_links = upload_request.get("source_links") if isinstance(upload_request.get("source_links"), list) else []
    source_url = str(
        paper.get("source_pdf_url")
        or paper.get("oa_url")
        or upload_request.get("source_url")
        or ""
    ).strip()
    return {
        "job_id": job.job_id,
        "request_id": request_id,
        "paper_key": paper_key,
        "paper_number": int(paper.get("paper_number") or upload_request.get("paper_number") or 0),
        "title": str(
            paper.get("title")
            or upload_request.get("title")
            or doi
            or openalex_id
            or paper_key
            or "未命名论文"
        ).strip(),
        "identifier": identifier,
        "doi": doi,
        "doi_url": f"https://doi.org/{doi}" if doi else "",
        "openalex_id": openalex_id,
        "reason": str(
            paper.get("user_upload_reason")
            or upload_request.get("reason")
            or "未获取到可自动精读的全文，请补充 PDF。"
        ).strip(),
        "source_links": [
            str(item).strip() for item in source_links if str(item).strip()
        ],
        "source_url": source_url,
        "status": (
            "waiting"
            if (request_id and request_id == waiting_request_id)
            or (paper_key and paper_key == waiting_paper_key)
            else "pending"
        ),
        "waiting_until": (
            waiting_until
            if ((request_id and request_id == waiting_request_id)
            or (paper_key and paper_key == waiting_paper_key))
            else ""
        ),
    }


def _is_invalid_upload_request_entry(entry: dict[str, Any]) -> bool:
    if not isinstance(entry, dict):
        return True
    paper_key = str(entry.get("paper_key") or "").strip().lower()
    title = str(entry.get("title") or "").strip()
    doi = str(entry.get("doi") or "").strip()
    openalex_id = str(entry.get("openalex_id") or "").strip()
    source_url = str(entry.get("source_url") or "").strip()
    identifier = entry.get("identifier") if isinstance(entry.get("identifier"), dict) else {}
    identifier_value = str(identifier.get("value") or "").strip()
    source_links = entry.get("source_links") if isinstance(entry.get("source_links"), list) else []
    has_signal = bool(
        (title and title != "paper")
        or doi
        or openalex_id
        or source_url
        or identifier_value
        or any(str(item).strip() for item in source_links)
    )
    return paper_key in {"", "paper"} and not has_signal


def build_pending_upload_requests(
    job: JobRecord,
    artifacts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    requests: list[dict[str, Any]] = []
    waiting_payload = job.waiting_payload_json if isinstance(job.waiting_payload_json, dict) else {}
    waiting_request_id = str(waiting_payload.get("request_id") or "").strip()
    waiting_paper_key = str(waiting_payload.get("paper_key") or "").strip()
    seen_keys: set[str] = set()
    papers = _payload_lookup(artifacts, "paper")
    paper_by_key = {
        str(paper.get("paper_key") or "").strip(): paper
        for paper in papers
        if str(paper.get("paper_key") or "").strip()
    }

    def append_request(paper: dict[str, Any], upload_request: dict[str, Any]) -> None:
        entry = _build_upload_request_entry(
            job=job,
            paper=paper,
            upload_request=upload_request,
            waiting_request_id=waiting_request_id,
            waiting_paper_key=waiting_paper_key,
            waiting_until=job.waiting_until,
        )
        if _is_invalid_upload_request_entry(entry):
            return
        dedupe_key = str(entry.get("request_id") or entry.get("paper_key") or "").strip()
        if dedupe_key and dedupe_key in seen_keys:
            return
        if dedupe_key:
            seen_keys.add(dedupe_key)
        requests.append(entry)

    if job.waiting_kind == "upload" and waiting_payload:
        waiting_paper = dict(paper_by_key.get(waiting_paper_key) or {})
        waiting_upload_request = (
            dict(waiting_paper.get("upload_request"))
            if isinstance(waiting_paper.get("upload_request"), dict)
            else {}
        )
        waiting_identifier = (
            waiting_payload.get("identifier")
            if isinstance(waiting_payload.get("identifier"), dict)
            else {}
        )
        waiting_source_links = (
            waiting_payload.get("source_links")
            if isinstance(waiting_payload.get("source_links"), list)
            else []
        )
        if waiting_request_id:
            waiting_upload_request["request_id"] = waiting_request_id
        if waiting_paper_key:
            waiting_upload_request["paper_key"] = waiting_paper_key
        if waiting_identifier:
            waiting_upload_request["identifier"] = waiting_identifier
        if waiting_source_links:
            waiting_upload_request["source_links"] = waiting_source_links
        if str(waiting_payload.get("source_url") or "").strip():
            waiting_upload_request["source_url"] = str(waiting_payload.get("source_url") or "").strip()
        if str(waiting_payload.get("title") or "").strip():
            waiting_upload_request["title"] = str(waiting_payload.get("title") or "").strip()
        if str(waiting_payload.get("reason") or "").strip():
            waiting_upload_request["reason"] = str(waiting_payload.get("reason") or "").strip()
        if str(waiting_payload.get("doi") or "").strip():
            waiting_upload_request["doi"] = str(waiting_payload.get("doi") or "").strip()
        if str(waiting_payload.get("openalex_id") or "").strip():
            waiting_upload_request["openalex_id"] = str(waiting_payload.get("openalex_id") or "").strip()
        if waiting_paper_key and not str(waiting_paper.get("paper_key") or "").strip():
            waiting_paper["paper_key"] = waiting_paper_key
        if str(waiting_payload.get("title") or "").strip() and not str(waiting_paper.get("title") or "").strip():
            waiting_paper["title"] = str(waiting_payload.get("title") or "").strip()
        if waiting_payload.get("paper_number") and not waiting_paper.get("paper_number"):
            waiting_paper["paper_number"] = waiting_payload.get("paper_number")
        if str(waiting_payload.get("doi") or "").strip() and not str(waiting_paper.get("doi") or "").strip():
            waiting_paper["doi"] = str(waiting_payload.get("doi") or "").strip()
        if str(waiting_payload.get("openalex_id") or "").strip() and not str(waiting_paper.get("openalex_id") or "").strip():
            waiting_paper["openalex_id"] = str(waiting_payload.get("openalex_id") or "").strip()
        if str(waiting_payload.get("source_url") or "").strip() and not str(waiting_paper.get("source_pdf_url") or "").strip():
            waiting_paper["source_pdf_url"] = str(waiting_payload.get("source_url") or "").strip()
        append_request(waiting_paper, waiting_upload_request)

    for paper in papers:
        upload_request = (
            paper.get("upload_request")
            if isinstance(paper.get("upload_request"), dict)
            else {}
        )
        if bool(upload_request.get("fulfilled")) or bool(upload_request.get("skipped")):
            continue
        if bool(paper.get("skipped_by_user")):
            continue
        access_status = str(paper.get("access_status") or "").strip().lower()
        needs_upload = bool(paper.get("needs_user_upload")) or bool(
            paper.get("requires_user_upload")
        )
        if not needs_upload and access_status not in {"upload_required", "resolution_failed"}:
            continue
        append_request(paper, upload_request)
    requests.sort(key=lambda item: int(item.get("paper_number") or 0))
    return requests


def build_clarification_requests(
    job: JobRecord,
    artifacts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    requests: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    waiting_payload = job.waiting_payload_json if isinstance(job.waiting_payload_json, dict) else {}
    if job.waiting_kind == "clarification" and waiting_payload:
        request_id = str(waiting_payload.get("request_id") or "").strip()
        if request_id:
            seen_ids.add(request_id)
        requests.append(
            {
                "job_id": job.job_id,
                "request_id": request_id,
                "reason": str(waiting_payload.get("reason") or "").strip(),
                "questions": waiting_payload.get("questions") if isinstance(waiting_payload.get("questions"), list) else [],
                "status": "waiting",
            }
        )
    for payload in _payload_lookup(artifacts, "clarification_request"):
        request_id = str(payload.get("request_id") or "").strip()
        if not request_id or request_id in seen_ids:
            continue
        if bool(payload.get("answered")):
            continue
        requests.append(
            {
                "job_id": job.job_id,
                "request_id": request_id,
                "reason": str(payload.get("reason") or "").strip(),
                "questions": payload.get("questions") if isinstance(payload.get("questions"), list) else [],
                "status": "pending",
            }
        )
    return requests


def _build_round_bucket(round_number: int) -> dict[str, Any]:
    return {
        "round": round_number,
        "status": "completed",
        "plan": "",
        "tool_runs": [],
        "round_summary": "",
        "review": "",
        "collapsed_by_default": True,
    }


def build_research_card(
    *,
    job: JobRecord,
    events: list[dict[str, Any]],
    artifacts: list[dict[str, Any]],
) -> dict[str, Any]:
    round_map: dict[int, dict[str, Any]] = {}

    def get_bucket(round_number: int) -> dict[str, Any]:
        normalized = round_number if round_number > 0 else max(1, job.round)
        bucket = round_map.get(normalized)
        if bucket is None:
            bucket = _build_round_bucket(normalized)
            round_map[normalized] = bucket
        return bucket

    for artifact in sorted(artifacts, key=_artifact_sort_key):
        payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
        kind = str(artifact.get("kind") or "").strip()
        round_number = int(payload.get("round") or 0)
        bucket = get_bucket(round_number or max(1, job.round))
        if kind == "round_plan":
            bucket["plan"] = str(payload.get("content") or "").strip()
        elif kind == "round_summary":
            bucket["round_summary"] = str(payload.get("markdown") or payload.get("content") or "").strip()
        elif kind == "round_review":
            bucket["review"] = str(payload.get("content") or "").strip()
        elif kind == "student_discussion" and not bucket["plan"]:
            bucket["plan"] = str(payload.get("markdown") or "").strip()
        elif kind == "mentor_discussion" and not bucket["review"]:
            bucket["review"] = str(payload.get("markdown") or "").strip()

    for event in events:
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        round_number = _event_round(event) or max(1, job.round)
        bucket = get_bucket(round_number)
        phase = str(event.get("phase") or "").strip()
        if phase == "tool_result":
            bucket["tool_runs"].append(
                {
                    "tool_name": str(event.get("tool_name") or payload.get("tool_name") or "").strip(),
                    "summary": str(payload.get("summary") or "").strip(),
                    "count_towards_budget": bool(payload.get("count_towards_budget", True)),
                }
            )
        elif phase == "student_synthesis" and not bucket["round_summary"]:
            bucket["round_summary"] = str(
                payload.get("summary_md") or payload.get("summary") or ""
            ).strip()
        elif phase == "mentor_review":
            formatted = _format_review_text(payload)
            if formatted:
                bucket["review"] = formatted

    rounds = [round_map[key] for key in sorted(round_map)]
    active_round = max(1, job.round)
    for round_item in rounds:
        round_number = int(round_item.get("round") or 0)
        if job.status in {"failed", "canceled"} and round_number == active_round:
            round_item["status"] = job.status
        elif round_number < active_round:
            round_item["status"] = "completed"
        elif round_number == active_round and job.status in ACTIVE_JOB_STATUSES:
            round_item["status"] = "in_progress"
        else:
            round_item["status"] = "completed"

    clarification_requests = build_clarification_requests(job, artifacts)
    upload_requests = build_pending_upload_requests(job, artifacts)
    latest_progress = _latest_phase_update(events)
    return {
        "summary": {
            "job_id": job.job_id,
            "question": job.question,
            "status": job.status,
            "status_label": _status_label(job.status),
            "phase": job.phase,
            "phase_label": _phase_label(job.phase, waiting_kind=job.waiting_kind),
            "round": max(1, job.round),
            "budget": job.settings.budget.to_dict(),
            "latest_progress": latest_progress,
            "error": job.error,
            "waiting_kind": job.waiting_kind,
            "waiting_until": job.waiting_until,
            "can_regenerate": job.status in {"completed", "failed"},
        },
        "rounds": rounds,
        "clarification_requests": clarification_requests,
        "upload_requests": upload_requests,
        "latest_status": {
            "status": job.status,
            "phase": job.phase,
            "round": max(1, job.round),
            "waiting_kind": job.waiting_kind,
        },
    }


def build_thread_metadata(job: JobRecord) -> dict[str, Any]:
    return {
        "deep_research": {
            "job_id": job.job_id,
            "status": job.status,
            "active_mode": "deep_research" if job.status in ACTIVE_JOB_STATUSES else "",
        }
    }


def build_thread_snapshot(
    *,
    job: JobRecord,
    events: list[dict[str, Any]],
    artifacts: list[dict[str, Any]],
    tasklist_url: str,
) -> dict[str, Any]:
    trace_output = build_trace_markdown(job, events, artifacts)
    final_output = build_placeholder_final_report(job)
    pending_uploads = build_pending_upload_requests(job, artifacts)
    clarification_requests = build_clarification_requests(job, artifacts)
    research_card = build_research_card(job=job, events=events, artifacts=artifacts)
    research_card_element = {
        "id": f"deep-research-card-{job.job_id}",
        "type": "custom",
        "threadId": job.thread_id,
        "forId": job.trace_message_id,
        "name": "deepResearchCard",
        "display": "inline",
        "props": research_card,
    }
    return {
        "job": {
            "job_id": job.job_id,
            "thread_id": job.thread_id,
            "status": job.status,
            "phase": job.phase,
            "round": job.round,
            "question": job.question,
            "created_at": job.created_at,
            "updated_at": job.updated_at,
            "started_at": job.started_at,
            "finished_at": job.finished_at,
            "error": job.error,
            "waiting_kind": job.waiting_kind,
            "waiting_until": job.waiting_until,
        },
        "messages": [
            {
                "id": job.trace_message_id,
                "name": "深度研究",
                "type": "assistant_message",
                "threadId": job.thread_id,
                "output": trace_output,
                "createdAt": job.created_at,
                "metadata": {
                    "deep_research": {
                        "job_id": job.job_id,
                        "kind": "trace",
                    }
                },
            },
            {
                "id": job.final_message_id,
                "name": "深度研究综述",
                "type": "assistant_message",
                "threadId": job.thread_id,
                "output": final_output,
                "createdAt": job.created_at,
                "metadata": {
                    "deep_research": {
                        "job_id": job.job_id,
                        "kind": "final_report",
                    }
                },
            },
        ],
        "elements": [research_card_element],
        "tasklist": {
            "id": job.tasklist_element_id,
            "type": "tasklist",
            "threadId": job.thread_id,
            "forId": "",
            "url": tasklist_url,
        },
        "pdf_refs": build_pdf_refs(artifacts),
        "upload_requests": pending_uploads,
        "clarification_requests": clarification_requests,
        "research_card": research_card,
        "thread_metadata": build_thread_metadata(job),
    }
