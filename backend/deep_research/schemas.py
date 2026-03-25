from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal, Optional

JobStatus = Literal[
    "queued",
    "running",
    "cancel_requested",
    "completed",
    "failed",
    "canceled",
]
JobPhase = Literal[
    "queued",
    "student",
    "mentor",
    "waiting_user",
    "writing",
    "completed",
    "failed",
    "canceled",
]

ACTIVE_JOB_STATUSES: set[str] = {"queued", "running", "cancel_requested"}
TERMINAL_JOB_STATUSES: set[str] = {"completed", "failed", "canceled"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clamp_int(
    value: Any,
    *,
    default: int,
    min_value: int,
    max_value: int,
) -> int:
    try:
        ivalue = int(value)
    except Exception:
        ivalue = default
    return max(min_value, min(ivalue, max_value))


@dataclass(slots=True)
class DeepResearchBudget:
    max_rounds: int = 2
    max_tool_calls: int = 18
    max_paper_reads: int = 6
    max_candidate_papers: int = 40

    @classmethod
    def from_dict(cls, data: Optional[dict[str, Any]]) -> "DeepResearchBudget":
        payload = data or {}
        return cls(
            max_rounds=_clamp_int(
                payload.get("max_rounds"),
                default=2,
                min_value=1,
                max_value=2,
            ),
            max_tool_calls=_clamp_int(
                payload.get("max_tool_calls"),
                default=18,
                min_value=1,
                max_value=60,
            ),
            max_paper_reads=_clamp_int(
                payload.get("max_paper_reads"),
                default=6,
                min_value=1,
                max_value=20,
            ),
            max_candidate_papers=_clamp_int(
                payload.get("max_candidate_papers"),
                default=40,
                min_value=5,
                max_value=120,
            ),
        )

    def to_dict(self) -> dict[str, int]:
        return {
            "max_rounds": self.max_rounds,
            "max_tool_calls": self.max_tool_calls,
            "max_paper_reads": self.max_paper_reads,
            "max_candidate_papers": self.max_candidate_papers,
        }


@dataclass(slots=True)
class DeepResearchSettings:
    selected_model: str = ""
    language: str = "zh"
    openalex_per_query: int = 8
    websearch_per_query: int = 5
    budget: DeepResearchBudget = field(default_factory=DeepResearchBudget)

    @classmethod
    def from_dict(cls, data: Optional[dict[str, Any]]) -> "DeepResearchSettings":
        payload = data or {}
        return cls(
            selected_model=str(payload.get("selected_model") or "").strip(),
            language=str(payload.get("language") or "zh").strip() or "zh",
            openalex_per_query=_clamp_int(
                payload.get("openalex_per_query"),
                default=8,
                min_value=1,
                max_value=50,
            ),
            websearch_per_query=_clamp_int(
                payload.get("websearch_per_query"),
                default=5,
                min_value=1,
                max_value=10,
            ),
            budget=DeepResearchBudget.from_dict(payload.get("budget")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "selected_model": self.selected_model,
            "language": self.language,
            "openalex_per_query": self.openalex_per_query,
            "websearch_per_query": self.websearch_per_query,
            "budget": self.budget.to_dict(),
        }


@dataclass(slots=True)
class JobRecord:
    job_id: str
    thread_id: str
    owner_key: str
    question: str
    status: str
    phase: str
    round: int
    created_at: str
    updated_at: str
    started_at: str = ""
    finished_at: str = ""
    final_report_md: str = ""
    final_message_id: str = ""
    trace_message_id: str = ""
    tasklist_element_id: str = ""
    error: str = ""
    settings_json: dict[str, Any] = field(default_factory=dict)
    waiting_kind: str = ""
    waiting_payload_json: dict[str, Any] = field(default_factory=dict)
    waiting_until: str = ""

    @property
    def settings(self) -> DeepResearchSettings:
        return DeepResearchSettings.from_dict(self.settings_json)

    @property
    def is_active(self) -> bool:
        return self.status in ACTIVE_JOB_STATUSES
