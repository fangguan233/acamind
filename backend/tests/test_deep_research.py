import asyncio
from types import SimpleNamespace

import pytest

from deep_research import DeepResearchManager, DeepResearchSettings, DeepResearchStore
from deep_research.render import build_thread_snapshot, build_trace_markdown
from deep_research.schemas import JobRecord, utc_now_iso


class FakeMcpClient:
    responses = []
    calls = []

    def __init__(self, cwd: str):
        self.cwd = cwd

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def call_tool(self, name: str, arguments: dict):
        self.calls.append({"name": name, "arguments": dict(arguments)})
        if not self.responses:
            raise RuntimeError(f"No fake MCP response configured for {name}")
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


async def _wait_for_phase(store, job_id: str, phase: str, timeout_seconds: float = 3.0):
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    last_job = None
    while asyncio.get_running_loop().time() < deadline:
        last_job = await store.get_job(job_id)
        if last_job is not None and last_job.phase == phase:
            return last_job
        await asyncio.sleep(0.05)
    return last_job


def _make_manager(
    tmp_path,
    monkeypatch,
    *,
    json_llm,
    text_llm,
    stream_text_llm=None,
    startup_policy="resume",
):
    import deep_research.runner as runner_module

    monkeypatch.setattr(runner_module, "_McpToolClient", FakeMcpClient)
    return DeepResearchManager(
        store=DeepResearchStore(str(tmp_path / "deep_research.sqlite")),
        json_llm=json_llm,
        text_llm=text_llm,
        stream_text_llm=stream_text_llm,
        tasklist_url_builder=lambda job_id: f"/research/jobs/{job_id}/tasklist",
        backend_cwd=str(tmp_path),
        report_postprocessor=lambda markdown, papers, webs, evidence_units: markdown,
        startup_policy=startup_policy,
    )


@pytest.mark.asyncio
async def test_deep_research_store_lifecycle_and_waiting_fields(tmp_path):
    store = DeepResearchStore(str(tmp_path / "deep_research.sqlite"))
    await store.initialize()
    job = await store.create_job(
        job_id="job-1",
        thread_id="thread-1",
        owner_key="thread-1",
        question="test question",
        status="running",
        phase="waiting_user",
        round=1,
        trace_message_id="trace-1",
        final_message_id="final-1",
        tasklist_element_id="tasklist-1",
        settings_json={"budget": {"max_rounds": 2}},
    )
    assert job.waiting_kind == ""
    assert job.waiting_payload_json == {}

    updated = await store.update_job(
        "job-1",
        waiting_kind="clarification",
        waiting_payload_json={"request_id": "req-1"},
        waiting_until="",
    )
    assert updated is not None
    assert updated.waiting_kind == "clarification"
    assert updated.waiting_payload_json["request_id"] == "req-1"

    await store.append_event(
        job_id="job-1",
        phase="phase_update",
        role="system",
        payload={"summary": "waiting"},
    )
    await store.upsert_artifact(
        job_id="job-1",
        kind="round_plan",
        paper_key="round-01",
        payload={"round": 1, "content": "plan"},
    )
    events = await store.list_events("job-1")
    artifacts = await store.list_artifacts("job-1")
    assert len(events) == 1
    assert len(artifacts) == 1

    await store.reset_running_jobs_to_queued()
    preserved = await store.get_job("job-1")
    assert preserved is not None
    assert preserved.phase == "waiting_user"


@pytest.mark.asyncio
async def test_deep_research_store_cancel_and_delete_jobs(tmp_path):
    store = DeepResearchStore(str(tmp_path / "deep_research.sqlite"))
    await store.initialize()
    await store.create_job(
        job_id="job-queued",
        thread_id="thread-1",
        owner_key="owner-1",
        question="queued question",
        status="queued",
        phase="queued",
        round=1,
        trace_message_id="trace-queued",
        final_message_id="final-queued",
        tasklist_element_id="tasklist-queued",
        settings_json={},
    )
    await store.create_job(
        job_id="job-running",
        thread_id="thread-2",
        owner_key="owner-2",
        question="running question",
        status="running",
        phase="student",
        round=1,
        trace_message_id="trace-running",
        final_message_id="final-running",
        tasklist_element_id="tasklist-running",
        settings_json={},
    )
    await store.append_event(
        job_id="job-running",
        phase="phase_update",
        role="system",
        payload={"summary": "running"},
    )
    await store.upsert_artifact(
        job_id="job-running",
        kind="paper",
        paper_key="paper-1",
        payload={"title": "Paper"},
    )

    canceled = await store.cancel_active_jobs()
    assert canceled == 2
    assert (await store.get_job("job-queued")).status == "canceled"
    assert (await store.get_job("job-running")).waiting_kind == ""

    deleted = await store.delete_all_jobs()
    assert deleted == {"jobs": 2, "events": 1, "artifacts": 1}


@pytest.mark.asyncio
async def test_paper_read_marks_upload_required_when_no_fulltext(monkeypatch):
    import deep_research.mcp_bridge as mcp_bridge

    fake_core = SimpleNamespace(
        _parse_openalex_work=lambda work: dict(work),
        _to_str=lambda value: "" if value is None else str(value),
        _truncate=lambda text, limit: str(text)[:limit],
        _format_doi=lambda doi: f"https://doi.org/{doi}" if doi else "",
    )

    async def fake_resolve_paper_by_identifier(*, identifier=None, title=""):
        return (
            {
                "paper_key": "paper-1",
                "title": "Closed Access Paper",
                "doi": "10.1000/test",
                "abstract": "Only abstract is available.",
                "oa_url": "https://publisher.example/closed-paper",
            },
            {"type": "doi", "value": "10.1000/test"},
        )

    async def fake_load_or_fetch_paper_content(paper, identifier):
        loaded = dict(paper)
        loaded.update(
            {
                "fulltext": "",
                "ocr_text": "",
                "local_pdf_url": "",
                "source_pdf_url": "https://publisher.example/closed-paper.pdf",
                "evidence_units": [],
            }
        )
        return loaded

    monkeypatch.setattr(mcp_bridge, "_core", lambda: fake_core)
    monkeypatch.setattr(mcp_bridge, "_resolve_paper_by_identifier", fake_resolve_paper_by_identifier)
    monkeypatch.setattr(mcp_bridge, "_load_or_fetch_paper_content", fake_load_or_fetch_paper_content)

    result = await mcp_bridge._paper_read_impl(identifier="10.1000/test")

    assert result["ok"] is True
    assert result["access_status"] == "upload_required"
    assert result["can_auto_deep_read"] is False
    assert result["requires_user_upload"] is True


@pytest.mark.asyncio
async def test_paper_read_resolution_failure_returns_upload_request(monkeypatch):
    import deep_research.mcp_bridge as mcp_bridge

    fake_core = SimpleNamespace(
        _to_str=lambda value: "" if value is None else str(value),
        _truncate=lambda text, limit: str(text)[:limit],
        _format_doi=lambda doi: f"https://doi.org/{doi}" if doi else "",
    )

    async def fake_resolve_paper_by_identifier(*, identifier=None, title=""):
        return None, {"type": "doi", "value": "10.1000/missing"}

    monkeypatch.setattr(mcp_bridge, "_core", lambda: fake_core)
    monkeypatch.setattr(mcp_bridge, "_resolve_paper_by_identifier", fake_resolve_paper_by_identifier)

    result = await mcp_bridge._paper_read_impl(
        identifier="10.1000/missing",
        title="Missing Paper",
    )

    assert result["ok"] is False
    assert result["access_status"] == "resolution_failed"
    assert result["requires_user_upload"] is True
    assert result["paper"]["paper_key"] == "doi:10.1000/missing"
    assert result["upload_request"]["title"] == "Missing Paper"
    assert result["upload_request"]["source_links"] == ["https://doi.org/10.1000/missing"]


@pytest.mark.asyncio
async def test_paper_read_without_target_returns_invalid_request():
    import deep_research.mcp_bridge as mcp_bridge

    result = await mcp_bridge._paper_read_impl(identifier="", title="")

    assert result["ok"] is False
    assert result["access_status"] == "invalid_request"
    assert result["requires_user_upload"] is False
    assert "缺少具体论文目标" in result["error"]


@pytest.mark.asyncio
async def test_web_search_prefers_provider_builtin_search(monkeypatch):
    import deep_research.mcp_bridge as mcp_bridge

    calls: list[tuple[str, str]] = []

    async def fake_provider_websearch_tool_generate(question: str, *, context: str = "", selected_model: str = ""):
        calls.append(("provider_tool", selected_model))
        return (
            "provider answer",
            [
                {
                    "title": "Provider Result",
                    "link": "https://example.com/provider",
                    "display": "example.com",
                    "snippet": "provider snippet",
                }
            ],
        )

    async def fake_websearch_search(*args, **kwargs):
        raise AssertionError("fallback search should not be called when provider tool already returned sources")

    fake_core = SimpleNamespace(
        _to_str=lambda value: "" if value is None else str(value),
        _truncate=lambda text, limit: str(text)[:limit],
        _get_websearch_provider=lambda: "searxng",
        _get_google_cse_config=lambda: {"api_key": "k", "cx": "cx", "oauth_token": "", "use_oauth": False},
        _get_searxng_config=lambda: {"base_url": "http://example.com:5011"},
        _env_float=lambda key, default=20.0: default,
        _provider_websearch_tool_generate=fake_provider_websearch_tool_generate,
        _websearch_search=fake_websearch_search,
    )

    monkeypatch.setattr(mcp_bridge, "_core", lambda: fake_core)

    result = await mcp_bridge._web_search_impl("DFT basic idea", 5, selected_model="qwen:test")

    assert result["ok"] is True
    assert result["backend"] == "provider_tool"
    assert result["results"][0]["url"] == "https://example.com/provider"
    assert calls == [("provider_tool", "qwen:test")]


@pytest.mark.asyncio
async def test_web_search_falls_back_to_google_before_searxng(monkeypatch):
    import deep_research.mcp_bridge as mcp_bridge

    calls: list[str] = []

    async def fake_provider_websearch_tool_generate(question: str, *, context: str = "", selected_model: str = ""):
        raise RuntimeError("provider tool unavailable")

    async def fake_websearch_search(query: str, *, provider: str, **kwargs):
        calls.append(provider)
        if provider == "google":
            return [
                {
                    "title": "Google Result",
                    "link": "https://example.com/google",
                    "display": "example.com",
                    "snippet": "google snippet",
                }
            ]
        raise AssertionError("SearXNG should not be reached when google fallback already succeeded")

    fake_core = SimpleNamespace(
        _to_str=lambda value: "" if value is None else str(value),
        _truncate=lambda text, limit: str(text)[:limit],
        _get_websearch_provider=lambda: "searxng",
        _get_google_cse_config=lambda: {"api_key": "k", "cx": "cx", "oauth_token": "", "use_oauth": False},
        _get_searxng_config=lambda: {"base_url": "http://example.com:5011"},
        _env_float=lambda key, default=20.0: default,
        _provider_websearch_tool_generate=fake_provider_websearch_tool_generate,
        _websearch_search=fake_websearch_search,
    )

    monkeypatch.setattr(mcp_bridge, "_core", lambda: fake_core)

    result = await mcp_bridge._web_search_impl("DFT applications", 5, selected_model="openai:test")

    assert result["ok"] is True
    assert result["backend"] == "google"
    assert result["results"][0]["url"] == "https://example.com/google"
    assert calls == ["google"]
    assert any("模型内置联网搜索失败" in item for item in result.get("warnings", []))


@pytest.mark.asyncio
async def test_runner_waits_for_clarification_and_resumes(tmp_path, monkeypatch):
    plan_calls = {"count": 0}
    FakeMcpClient.calls = []
    FakeMcpClient.responses = [
        {
            "ok": True,
            "papers": [
                {
                    "paper_key": "paper-1",
                    "title": "Paper One",
                    "authors": "A",
                    "year": "2024",
                    "venue": "Venue",
                    "abstract": "Abstract",
                }
            ],
        },
        {
            "ok": True,
            "access_status": "open_access",
            "can_auto_deep_read": True,
            "requires_user_upload": False,
            "paper": {
                "paper_key": "paper-1",
                "title": "Paper One",
                "authors": "A",
                "year": "2024",
                "venue": "Venue",
                "abstract": "Abstract",
                "evidence_units": [{"evidence_id": "P1-S1", "text": "Evidence sentence."}],
            },
        },
    ]

    async def fake_json_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "前置澄清器" in system:
            return {
                "needs_clarification": True,
                "reason": "DFT 可能指两个不同概念。",
                "questions": [
                    {
                        "id": "dft_meaning",
                        "prompt": "这里的 DFT 指哪个含义？",
                        "options": [
                            {"label": "密度泛函理论", "description": "面向量子化学/材料模拟"},
                            {"label": "离散傅里叶变换", "description": "面向信号处理"},
                        ],
                        "allow_other": False,
                        "required": True,
                    }
                ],
            }
        if "拆题规划器" in system:
            plan_calls["count"] += 1
            return {
                "subquestions": ["它的定义是什么", "关键应用是什么"],
                "evidence_plan": ["先用论文检索建立候选综述。"],
                "planned_calls": [
                    {
                        "tool_name": "paper_search",
                        "arguments": {"query": "density functional theory review", "max_results": 3},
                        "reason": "优先找综述与 OA 文献",
                    }
                ],
                "plan_summary": "明确为密度泛函理论后，先检索综述论文，再基于结果给出阶段总结。",
            }
        if "工具后续决策器" in system:
            return {"continue": False, "extra_call": None, "reason": "当前证据足够形成阶段总结。"}
        if "研究质量审查器" in system:
            return {
                "support_gaps": [],
                "scientificity_risks": ["当前以摘要级证据为主，结论需谨慎。"],
                "next_questions": [],
                "ready_to_conclude": True,
            }
        return {}

    async def fake_text_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "严谨的学术综述写作者" in system:
            return "\n".join(
                [
                    "## 结论",
                    "当前证据支持形成谨慎结论 [1]。",
                    "",
                    "## 核心发现",
                    "- [1] 与研究问题直接相关。",
                    "",
                    "## 证据不足与争议点",
                    "- 目前仍以摘要级证据为主。",
                    "",
                    "## 方法与适用边界",
                    "- 本轮主要完成论文检索与阶段综合。",
                ]
            )
        return "\n".join(
            [
                "### 阶段结论",
                "- 已找到初步论文证据 [1]。",
                "",
                "### 证据支撑",
                "- [1] 提供与问题直接相关的摘要信息。",
                "",
                "### 证据不足与待核验点",
                "- 仍缺少全文级证据。",
                "",
                "### 建议导师重点审查处",
                "- 结论是否被过度表述。",
            ]
        )

    manager = _make_manager(
        tmp_path,
        monkeypatch,
        json_llm=fake_json_llm,
        text_llm=fake_text_llm,
        stream_text_llm=fake_text_llm,
    )
    await manager.initialize()
    job, _ = await manager.start_or_continue_job(
        thread_id="thread-clarify",
        owner_key="thread-clarify",
        question="DFT 是什么？",
        settings=DeepResearchSettings.from_dict({"selected_model": "test"}),
    )

    waiting = await _wait_for_phase(manager.store, job.job_id, "waiting_user")
    assert waiting is not None
    assert waiting.phase == "waiting_user"
    assert waiting.waiting_kind == "clarification"

    request_id = waiting.waiting_payload_json["request_id"]
    result = await manager.submit_clarification_answers(
        job_id=job.job_id,
        owner_key="thread-clarify",
        request_id=request_id,
        answers={"dft_meaning": {"label": "密度泛函理论", "value": "密度泛函理论"}},
    )
    assert result is not None

    await manager.wait_for_job(job.job_id, timeout_seconds=5)
    completed = await manager.store.get_job(job.job_id)
    assert completed is not None
    assert completed.status == "completed"
    assert ':::fold{title="参考来源"}' in completed.final_report_md
    assert plan_calls["count"] >= 1
    assert FakeMcpClient.calls[0]["name"] == "paper_search"

    snapshot = await manager.get_thread_snapshot(thread_id="thread-clarify", owner_key="thread-clarify")
    assert snapshot is not None
    assert snapshot["elements"][0]["name"] == "deepResearchCard"
    assert snapshot["research_card"]["rounds"]


@pytest.mark.asyncio
async def test_round_executes_all_planned_calls_before_revision_stop(tmp_path, monkeypatch):
    FakeMcpClient.calls = []
    FakeMcpClient.responses = [
        {
            "ok": True,
            "papers": [
                {
                    "paper_key": "paper-1",
                    "title": "Paper One",
                    "authors": "A",
                    "year": "2024",
                    "venue": "Venue",
                    "abstract": "Abstract",
                }
            ],
        },
        {
            "ok": True,
            "access_status": "open_access",
            "can_auto_deep_read": True,
            "requires_user_upload": False,
            "paper": {
                "paper_key": "paper-1",
                "title": "Paper One",
                "authors": "A",
                "year": "2024",
                "venue": "Venue",
                "abstract": "Abstract",
                "evidence_units": [{"evidence_id": "P1-S1", "text": "Evidence sentence."}],
            },
        },
    ]

    async def fake_json_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "前置澄清器" in system:
            return {"needs_clarification": False, "reason": "", "questions": []}
        if "拆题规划器" in system:
            return {
                "subquestions": ["先找论文", "再精读关键论文"],
                "evidence_plan": ["同轮完成检索与精读"],
                "planned_calls": [
                    {
                        "tool_name": "paper_search",
                        "arguments": {"query": "test topic review", "max_results": 1},
                        "reason": "先建立候选论文池",
                    },
                    {
                        "tool_name": "paper_read",
                        "arguments": {"identifier": "paper-1", "title": "Paper One"},
                        "reason": "继续精读关键论文",
                    },
                ],
                "plan_summary": "本轮直接串行完成检索与精读。",
            }
        if "工具后续决策器" in system:
            return {"continue": False, "extra_call": None, "reason": "当前不再追加调用。"}
        if "研究质量审查器" in system:
            return {
                "support_gaps": [],
                "scientificity_risks": [],
                "next_questions": [],
                "ready_to_conclude": True,
            }
        return {}

    async def fake_text_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "学术综述写作者" in system:
            return "\n".join(
                [
                    "## 结论",
                    "问题已经得到直接回答 [P1-S1]。",
                    "",
                    "## 核心发现",
                    "- 关键论文已完成精读并提供句级证据 [P1-S1]。",
                    "",
                    "## 证据不足与争议点",
                    "- 无。",
                    "",
                    "## 方法与适用边界",
                    "- 本轮完成检索与精读。",
                ]
            )
        return "\n".join(
            [
                "### 阶段结论",
                "- 已在同轮完成论文检索与精读 [P1-S1]。",
                "",
                "### 证据支撑",
                "- 关键论文提供句级证据 [P1-S1]。",
                "",
                "### 证据不足与待核验点",
                "- 无。",
                "",
                "### 建议导师重点审查处",
                "- 检查是否可以直接收尾。",
            ]
        )

    manager = _make_manager(
        tmp_path,
        monkeypatch,
        json_llm=fake_json_llm,
        text_llm=fake_text_llm,
        stream_text_llm=fake_text_llm,
    )
    await manager.initialize()
    job, _ = await manager.start_or_continue_job(
        thread_id="thread-multi-planned",
        owner_key="thread-multi-planned",
        question="test multi planned calls",
        settings=DeepResearchSettings.from_dict({"selected_model": "test"}),
    )
    await manager.wait_for_job(job.job_id, timeout_seconds=5)
    completed = await manager.store.get_job(job.job_id)
    assert completed is not None
    assert completed.status == "completed"
    assert [call["name"] for call in FakeMcpClient.calls] == ["paper_search", "paper_read"]


@pytest.mark.asyncio
async def test_round_auto_followup_can_append_second_tool_call(tmp_path, monkeypatch):
    FakeMcpClient.calls = []
    FakeMcpClient.responses = [
        {
            "ok": True,
            "papers": [
                {
                    "paper_key": "paper-1",
                    "title": "Paper One",
                    "authors": "A",
                    "year": "2024",
                    "venue": "Venue",
                    "abstract": "Abstract",
                }
            ],
        },
        {
            "ok": True,
            "access_status": "open_access",
            "can_auto_deep_read": True,
            "requires_user_upload": False,
            "paper": {
                "paper_key": "paper-1",
                "title": "Paper One",
                "authors": "A",
                "year": "2024",
                "venue": "Venue",
                "abstract": "Abstract",
                "evidence_units": [{"evidence_id": "P1-S1", "text": "Evidence sentence."}],
            },
        },
    ]

    async def fake_json_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "前置澄清器" in system:
            return {"needs_clarification": False, "reason": "", "questions": []}
        if "拆题规划器" in system:
            return {
                "subquestions": ["先找关键论文"],
                "evidence_plan": ["检索到论文后继续补强全文证据"],
                "planned_calls": [
                    {
                        "tool_name": "paper_search",
                        "arguments": {"query": "test topic review", "max_results": 1},
                        "reason": "先检索候选论文",
                    }
                ],
                "plan_summary": "本轮先检索，若拿到合适论文则继续精读。",
            }
        if "工具后续决策器" in system:
            return {"continue": False, "extra_call": None, "reason": "不要继续。"}
        if "研究质量审查器" in system:
            return {
                "support_gaps": [],
                "scientificity_risks": [],
                "next_questions": [],
                "ready_to_conclude": True,
            }
        return {}

    async def fake_text_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "学术综述写作者" in system:
            return "\n".join(
                [
                    "## 结论",
                    "问题已经得到直接回答 [P1-S1]。",
                    "",
                    "## 核心发现",
                    "- 检索后同轮自动补上了关键论文精读 [P1-S1]。",
                    "",
                    "## 证据不足与争议点",
                    "- 无。",
                    "",
                    "## 方法与适用边界",
                    "- 本轮包含自动衔接的连续调用。",
                ]
            )
        return "\n".join(
            [
                "### 阶段结论",
                "- 检索后已自动继续精读 [P1-S1]。",
                "",
                "### 证据支撑",
                "- 已获取句级证据 [P1-S1]。",
                "",
                "### 证据不足与待核验点",
                "- 无。",
                "",
                "### 建议导师重点审查处",
                "- 检查是否可以收尾。",
            ]
        )

    manager = _make_manager(
        tmp_path,
        monkeypatch,
        json_llm=fake_json_llm,
        text_llm=fake_text_llm,
        stream_text_llm=fake_text_llm,
    )
    await manager.initialize()
    job, _ = await manager.start_or_continue_job(
        thread_id="thread-auto-followup",
        owner_key="thread-auto-followup",
        question="test auto followup",
        settings=DeepResearchSettings.from_dict({"selected_model": "test"}),
    )
    await manager.wait_for_job(job.job_id, timeout_seconds=5)
    completed = await manager.store.get_job(job.job_id)
    assert completed is not None
    assert completed.status == "completed"
    assert [call["name"] for call in FakeMcpClient.calls] == ["paper_search", "paper_read"]


@pytest.mark.asyncio
async def test_blank_paper_read_placeholder_does_not_create_upload_request(tmp_path, monkeypatch):
    FakeMcpClient.calls = []
    FakeMcpClient.responses = [
        {
            "ok": True,
            "papers": [
                {
                    "paper_key": "paper-1",
                    "title": "Paper One",
                    "authors": "A",
                    "year": "2024",
                    "venue": "Venue",
                    "abstract": "Abstract",
                }
            ],
        },
        {
            "ok": True,
            "access_status": "open_access",
            "can_auto_deep_read": True,
            "requires_user_upload": False,
            "paper": {
                "paper_key": "paper-1",
                "title": "Paper One",
                "authors": "A",
                "year": "2024",
                "venue": "Venue",
                "abstract": "Abstract",
                "evidence_units": [{"evidence_id": "P1-S1", "text": "Evidence sentence."}],
            },
        },
    ]

    async def fake_json_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "前置澄清器" in system:
            return {"needs_clarification": False, "reason": "", "questions": []}
        if "拆题规划器" in system:
            return {
                "subquestions": ["先搜索，再精读其中最关键的论文"],
                "evidence_plan": ["先建立候选池，再选择具体论文精读。"],
                "planned_calls": [
                    {
                        "tool_name": "paper_search",
                        "arguments": {"query": "test topic review", "max_results": 1},
                        "reason": "先建立候选论文池",
                    },
                    {
                        "tool_name": "paper_read",
                        "arguments": {"identifier": "", "title": ""},
                        "reason": "搜索后再精读具体论文",
                    },
                ],
                "plan_summary": "先搜索，再选定具体论文精读。",
            }
        if "工具后续决策器" in system:
            return {"continue": False, "extra_call": None, "reason": "当前不再追加调用。"}
        if "研究质量审查器" in system:
            return {
                "support_gaps": [],
                "scientificity_risks": [],
                "next_questions": [],
                "ready_to_conclude": True,
            }
        return {}

    async def fake_text_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "严谨的学术综述写作者" in system:
            return "\n".join(
                [
                    "## 结论",
                    "已基于具体论文形成结论。[1]",
                    "",
                    "## 核心发现",
                    "- [1] 已获取句级证据。",
                    "",
                    "## 证据不足与争议点",
                    "- 暂无。",
                    "",
                    "## 方法与适用边界",
                    "- 基于当前候选论文。",
                ]
            )
        return "\n".join(
            [
                "### 阶段结论",
                "- 已选定具体论文并完成精读。",
                "",
                "### 证据支撑",
                "- [1] Paper One 提供了句级证据。",
                "",
                "### 证据不足与待核验点",
                "- 暂无。",
                "",
                "### 建议导师重点审查处",
                "- 检查是否足以收束。",
            ]
        )

    manager = _make_manager(
        tmp_path,
        monkeypatch,
        json_llm=fake_json_llm,
        text_llm=fake_text_llm,
        stream_text_llm=fake_text_llm,
    )
    await manager.initialize()
    job, _ = await manager.start_or_continue_job(
        thread_id="thread-empty-paper-read",
        owner_key="thread-empty-paper-read",
        question="Need a concrete paper after search",
        settings=DeepResearchSettings.from_dict({"selected_model": "test"}),
    )
    await manager.wait_for_job(job.job_id, timeout_seconds=5)
    completed = await manager.store.get_job(job.job_id)

    assert completed is not None
    assert completed.status == "completed"
    assert completed.phase == "completed"
    assert [call["name"] for call in FakeMcpClient.calls] == ["paper_search", "paper_read"]
    assert FakeMcpClient.calls[1]["arguments"]["identifier"] == "paper-1"
    assert FakeMcpClient.calls[1]["arguments"]["title"] == "Paper One"

    snapshot = await manager.get_thread_snapshot(
        thread_id="thread-empty-paper-read",
        owner_key="thread-empty-paper-read",
    )
    assert snapshot is not None
    assert snapshot["research_card"]["upload_requests"] == []


@pytest.mark.asyncio
async def test_runner_waits_for_upload_then_skip_and_finalize(tmp_path, monkeypatch):
    plan_calls = {"count": 0}
    FakeMcpClient.calls = []
    FakeMcpClient.responses = [
        {
            "ok": True,
            "papers": [
                {
                    "paper_key": "paper-1",
                    "title": "Closed Access Paper",
                    "authors": "A",
                    "year": "2024",
                    "venue": "Venue",
                    "abstract": "Abstract only",
                }
            ],
        },
        {
            "ok": True,
            "access_status": "upload_required",
            "can_auto_deep_read": False,
            "requires_user_upload": True,
            "upload_request": {
                "title": "Closed Access Paper",
                "paper_key": "paper-1",
                "reason": "未获取到可自动精读的开放获取全文，请用户上传 PDF。",
                "source_links": ["https://publisher.example/closed-paper.pdf"],
            },
            "paper": {
                "paper_key": "paper-1",
                "title": "Closed Access Paper",
                "authors": "A",
                "year": "2024",
                "venue": "Venue",
                "abstract": "Abstract only",
                "evidence_units": [],
                "fulltext": "",
                "ocr_text": "",
                "local_pdf_url": "",
                "source_pdf_url": "https://publisher.example/closed-paper.pdf",
            },
        },
    ]

    async def fake_json_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "前置澄清器" in system:
            return {"needs_clarification": False, "reason": "", "questions": []}
        if "拆题规划器" in system:
            plan_calls["count"] += 1
            if plan_calls["count"] == 1:
                return {
                    "subquestions": ["先找关键论文", "尝试精读关键论文"],
                    "evidence_plan": ["先检索，再精读最关键论文。"],
                    "planned_calls": [
                        {
                            "tool_name": "paper_search",
                            "arguments": {"query": "closed access topic", "max_results": 1},
                            "reason": "先建立候选池",
                        },
                        {
                            "tool_name": "paper_read",
                            "arguments": {"identifier": "paper-1", "title": "Closed Access Paper"},
                            "reason": "尝试精读关键论文",
                        },
                    ],
                    "plan_summary": "先检索关键论文，再尝试精读最关键文献。",
                }
            return {
                "subquestions": ["基于已有证据收束结论"],
                "evidence_plan": ["原文不可得时明确降级表述并收尾。"],
                "planned_calls": [],
                "plan_summary": "关键论文未补原文，改为基于现有证据直接收束。",
            }
        if "工具后续决策器" in system:
            return {"continue": True, "extra_call": None, "reason": "继续执行剩余计划。"}
        if "研究质量审查器" in system:
            return {
                "support_gaps": ["关键论文未补原文"],
                "scientificity_risks": ["不能把摘要证据当作全文证据"],
                "next_questions": [],
                "ready_to_conclude": True,
            }
        return {}

    async def fake_text_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "严谨的学术综述写作者" in system:
            conclusion = " ".join(
                [
                    "当前围绕这篇闭源论文只能建立摘要级理解，但其题目、摘要、年份与来源仍然说明它是当前问题的重要研究线索 [1]。"
                ]
                * 8
            )
            return "\n".join(
                [
                    "## 结论",
                    conclusion,
                    "",
                    "## 核心发现",
                    "- [1] 该论文已经进入候选证据池，至少能提供研究对象、问题设定与摘要层面的背景信息，可用于界定综述边界。",
                    "- [1] 当前没有获得可自动精读的全文，因此正文只能把它当作摘要级线索，而不能当作句级全文证据来支撑强结论。",
                    "- [1] 即使原文缺失，这篇论文仍然提示了后续应优先补强的方向，即围绕同主题继续寻找开放获取综述或等待用户补充 PDF。",
                    "",
                    "## 证据不足与争议点",
                    "- [1] 原文未补充，已跳过。",
                    "",
                    "## 方法与适用边界",
                    "- 关键文献无法自动精读时，会要求补原文；若跳过，则显式披露。",
                ]
            )
        return "\n".join(
            [
                "### 阶段结论",
                "- 当前只能形成谨慎判断，关键论文 [1] 尚未获得全文。",
                "",
                "### 证据支撑",
                "- [1] 目前只有摘要可用。",
                "",
                "### 证据不足与待核验点",
                "- [1] 原文未补充，不能作为全文证据。",
                "",
                "### 建议导师重点审查处",
                "- 检查是否充分降低了证据强度。",
            ]
        )

    manager = _make_manager(
        tmp_path,
        monkeypatch,
        json_llm=fake_json_llm,
        text_llm=fake_text_llm,
        stream_text_llm=fake_text_llm,
    )
    await manager.initialize()
    job, _ = await manager.start_or_continue_job(
        thread_id="thread-upload",
        owner_key="thread-upload",
        question="Need evidence from a closed paper",
        settings=DeepResearchSettings.from_dict({"selected_model": "test"}),
    )

    waiting = await _wait_for_phase(manager.store, job.job_id, "waiting_user")
    assert waiting is not None
    assert waiting.phase == "waiting_user"
    assert waiting.waiting_kind == "upload"

    request_id = waiting.waiting_payload_json["request_id"]
    result = await manager.skip_upload_request(
        job_id=job.job_id,
        owner_key="thread-upload",
        request_id=request_id,
        paper_key="paper-1",
        reason="用户跳过该文献",
    )
    assert result is not None

    await manager.wait_for_job(job.job_id, timeout_seconds=10)
    completed = await manager.store.get_job(job.job_id)
    assert completed is not None
    assert completed.status == "completed"
    assert ':::fold{title="参考来源"}' in completed.final_report_md

    paper_read_calls = [call for call in FakeMcpClient.calls if call["name"] == "paper_read"]
    assert len(paper_read_calls) == 1
    assert (
        "用户未补充原文" in completed.final_report_md
        or "待用户上传原文" in completed.final_report_md
        or "原文未补充" in completed.final_report_md
    )


@pytest.mark.asyncio
async def test_runner_requests_upload_when_paper_read_cannot_resolve_paper(tmp_path, monkeypatch):
    plan_calls = {"count": 0}
    FakeMcpClient.calls = []
    FakeMcpClient.responses = [
        {
            "ok": False,
            "error": "未能定位论文；若这篇文献对结论关键，请上传原文 PDF。",
            "access_status": "resolution_failed",
            "can_auto_deep_read": False,
            "requires_user_upload": True,
            "upload_request": {
                "title": "Missing Paper",
                "paper_key": "doi:10.1000/missing",
                "identifier": {"type": "doi", "value": "10.1000/missing"},
                "reason": "未能定位论文；若这篇文献对结论关键，请上传原文 PDF。",
                "source_links": ["https://doi.org/10.1000/missing"],
            },
            "paper": {
                "paper_key": "doi:10.1000/missing",
                "title": "Missing Paper",
                "doi": "10.1000/missing",
                "evidence_units": [],
            },
        },
    ]

    async def fake_json_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "前置澄清器" in system:
            return {"needs_clarification": False, "reason": "", "questions": []}
        if "拆题规划器" in system:
            plan_calls["count"] += 1
            if plan_calls["count"] > 1:
                return {
                    "subquestions": ["基于现有材料收尾"],
                    "evidence_plan": ["保留缺失原文这一限制，直接完成综述。"],
                    "planned_calls": [],
                    "plan_summary": "关键论文仍缺原文，本轮不再重复检索，直接收尾。",
                }
            return {
                "subquestions": ["确认关键文献是否可精读"],
                "evidence_plan": ["先尝试精读目标论文，失败则请求用户补传原文。"],
                "planned_calls": [
                    {
                        "tool_name": "paper_read",
                        "arguments": {"identifier": "10.1000/missing", "title": "Missing Paper"},
                        "reason": "这篇论文是核心证据，先尝试定位原文。",
                    }
                ],
                "plan_summary": "先精读核心论文；若无法定位，则立即转入补充原文流程。",
            }
        if "工具后续决策器" in system:
            return {"continue": False, "extra_call": None, "reason": "等待用户补传原文。"}
        if "研究质量审查器" in system:
            return {
                "support_gaps": ["关键论文原文尚未获得"],
                "scientificity_risks": ["不能把未定位到的论文当作已验证证据"],
                "next_questions": [],
                "ready_to_conclude": True,
            }
        return {}

    async def fake_text_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "严谨的学术综述写作者" in system:
            conclusion = " ".join(
                [
                    "当前只能确认这篇缺失原文的论文是问题相关线索，而不能把它视为已经完成验证的全文证据；因此综述需要把它放在限制条件下解释 [1]。"
                ]
                * 18
            )
            return "\n".join(
                [
                    "## 结论",
                    conclusion,
                    "",
                    "## 核心发现",
                    "- [1] 这篇论文已经被识别为关键文献线索，因此系统必须暂停并请求用户补传原文，而不是直接把它包装成已验证证据。",
                    "- [1] 在原文缺失的情况下，当前能够使用的只是题名、标识符和待补传线索，这些信息只适合支持范围界定与后续检索规划。",
                    "- [1] 若用户选择跳过，该论文仍应保留在参考来源中，并明确标记为未获得原文、未形成全文级证据的来源。",
                    "",
                    "## 证据不足与争议点",
                    "- [1] 用户跳过了缺失原文的关键论文。",
                    "",
                    "## 方法与适用边界",
                    "- 未定位到原文时系统会请求用户补传 PDF。",
                ]
            )
        return "\n".join(
            [
                "### 阶段结论",
                "- 关键论文尚未定位到原文，需等待用户补传。",
                "",
                "### 证据支撑",
                "- 当前只有论文标识和待补传线索。",
                "",
                "### 证据不足与待核验点",
                "- 未获得原文前不能把这篇论文当成已精读证据。",
                "",
                "### 建议导师重点审查处",
                "- 确认是否已明确进入补充原文流程。",
            ]
        )

    manager = _make_manager(
        tmp_path,
        monkeypatch,
        json_llm=fake_json_llm,
        text_llm=fake_text_llm,
        stream_text_llm=fake_text_llm,
    )
    await manager.initialize()
    job, _ = await manager.start_or_continue_job(
        thread_id="thread-unresolved-upload",
        owner_key="thread-unresolved-upload",
        question="Need evidence from a missing paper",
        settings=DeepResearchSettings.from_dict({"selected_model": "test"}),
    )

    waiting = await _wait_for_phase(manager.store, job.job_id, "waiting_user")
    assert waiting is not None
    assert waiting.phase == "waiting_user"
    assert waiting.waiting_kind == "upload"
    assert waiting.waiting_payload_json["paper_key"] == "doi:10.1000/missing"
    assert waiting.waiting_payload_json["title"] == "Missing Paper"

    snapshot = await manager.get_thread_snapshot(
        thread_id="thread-unresolved-upload",
        owner_key="thread-unresolved-upload",
    )
    assert snapshot is not None
    upload_request = snapshot["research_card"]["upload_requests"][0]
    assert upload_request["paper_key"] == "doi:10.1000/missing"
    assert upload_request["doi"] == "10.1000/missing"
    assert upload_request["doi_url"] == "https://doi.org/10.1000/missing"
    assert upload_request["identifier"]["type"] == "doi"
    assert upload_request["identifier"]["value"] == "10.1000/missing"

    request_id = waiting.waiting_payload_json["request_id"]
    result = await manager.skip_upload_request(
        job_id=job.job_id,
        owner_key="thread-unresolved-upload",
        request_id=request_id,
        paper_key="doi:10.1000/missing",
        reason="用户暂时无法提供该论文",
    )
    assert result is not None

    await manager.wait_for_job(job.job_id, timeout_seconds=10)
    completed = await manager.store.get_job(job.job_id)
    assert completed is not None
    assert completed.status == "completed"


@pytest.mark.asyncio
async def test_round_two_forces_finalize(tmp_path, monkeypatch):
    plan_calls = {"count": 0}
    FakeMcpClient.calls = []
    FakeMcpClient.responses = [
        {
            "ok": True,
            "papers": [{"paper_key": "paper-1", "title": "Paper One", "abstract": "Abstract"}],
        },
        {
            "ok": True,
            "access_status": "open_access",
            "can_auto_deep_read": True,
            "requires_user_upload": False,
            "paper": {
                "paper_key": "paper-1",
                "title": "Paper One",
                "abstract": "Abstract",
                "evidence_units": [{"evidence_id": "P1-S1", "text": "Evidence sentence."}],
            },
        },
    ]

    async def fake_json_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "前置澄清器" in system:
            return {"needs_clarification": False, "reason": "", "questions": []}
        if "拆题规划器" in system:
            plan_calls["count"] += 1
            if plan_calls["count"] == 1:
                return {
                    "subquestions": ["先建立证据池"],
                    "evidence_plan": ["先检索论文。"],
                    "planned_calls": [
                        {
                            "tool_name": "paper_search",
                            "arguments": {"query": "test topic", "max_results": 1},
                            "reason": "建立证据池",
                        }
                    ],
                    "plan_summary": "第 1 轮先建立证据池。",
                }
            return {
                "subquestions": ["只围绕缺口收尾"],
                "evidence_plan": ["不扩题，直接收束。"],
                "planned_calls": [],
                "plan_summary": "第 2 轮直接围绕缺口收束。",
            }
        if "工具后续决策器" in system:
            return {"continue": False, "extra_call": None, "reason": "当前结果足够。"}
        if "研究质量审查器" in system:
            return {
                "support_gaps": ["仍缺少全文证据"],
                "scientificity_risks": [],
                "next_questions": ["继续降低结论强度"],
                "ready_to_conclude": False,
            }
        return {}

    async def fake_text_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "严谨的学术综述写作者" in system:
            return "\n".join(
                [
                    "## 结论",
                    "两轮补强后输出谨慎结论 [1]。",
                    "",
                    "## 核心发现",
                    "- [1] 是当前最相关的论文。",
                    "",
                    "## 证据不足与争议点",
                    "- 仍缺少全文证据。",
                    "",
                    "## 方法与适用边界",
                    "- 第 2 轮已按预算强制收尾。",
                ]
            )
        return "\n".join(
            [
                "### 阶段结论",
                "- 已形成阶段性判断。",
                "",
                "### 证据支撑",
                "- 有论文候选 [1]。",
                "",
                "### 证据不足与待核验点",
                "- 仍缺少全文证据。",
                "",
                "### 建议导师重点审查处",
                "- 检查是否应继续降低表述强度。",
            ]
        )

    manager = _make_manager(
        tmp_path,
        monkeypatch,
        json_llm=fake_json_llm,
        text_llm=fake_text_llm,
        stream_text_llm=fake_text_llm,
    )
    await manager.initialize()
    settings = DeepResearchSettings.from_dict(
        {"selected_model": "test", "budget": {"max_rounds": 2, "max_tool_calls": 3}}
    )
    job, _ = await manager.start_or_continue_job(
        thread_id="thread-round2",
        owner_key="thread-round2",
        question="Budgeted question",
        settings=settings,
    )
    await manager.wait_for_job(job.job_id, timeout_seconds=5)
    completed = await manager.store.get_job(job.job_id)
    assert completed is not None
    assert completed.status == "completed"
    assert ':::fold{title="参考来源"}' in completed.final_report_md
    assert plan_calls["count"] == 2
    assert "第 2 轮已按预算强制收尾" in completed.final_report_md


@pytest.mark.asyncio
async def test_manager_cancel_startup_policy_closes_unfinished_jobs(tmp_path, monkeypatch):
    store = DeepResearchStore(str(tmp_path / "deep_research.sqlite"))
    await store.initialize()
    await store.create_job(
        job_id="job-pending",
        thread_id="thread-pending",
        owner_key="owner-pending",
        question="pending question",
        status="running",
        phase="waiting_user",
        round=1,
        trace_message_id="trace-pending",
        final_message_id="final-pending",
        tasklist_element_id="tasklist-pending",
        settings_json={},
    )

    async def fake_json_llm(*, messages, selected_model="", max_tokens=None):
        return {}

    async def fake_text_llm(*, messages, selected_model="", max_tokens=None, on_update=None):
        return "unused"

    import deep_research.runner as runner_module

    monkeypatch.setattr(runner_module, "_McpToolClient", FakeMcpClient)
    manager = DeepResearchManager(
        store=store,
        json_llm=fake_json_llm,
        text_llm=fake_text_llm,
        stream_text_llm=fake_text_llm,
        tasklist_url_builder=lambda job_id: f"/research/jobs/{job_id}/tasklist",
        backend_cwd=str(tmp_path),
        report_postprocessor=lambda markdown, papers, webs, evidence_units: markdown,
        startup_policy="cancel",
    )
    await manager.initialize()
    closed = await store.get_job("job-pending")
    assert closed is not None
    assert closed.status == "canceled"
    assert closed.phase == "canceled"


@pytest.mark.asyncio
async def test_final_report_auto_retries_after_writer_exception(tmp_path, monkeypatch):
    FakeMcpClient.calls = []
    FakeMcpClient.responses = [
        {
            "ok": True,
            "papers": [
                {
                    "paper_key": "paper-1",
                    "title": "DFT Review",
                    "authors": "A",
                    "year": "2024",
                    "venue": "Venue",
                    "abstract": "Abstract",
                }
            ],
        }
        ,
        {
            "ok": True,
            "access_status": "open_access",
            "can_auto_deep_read": True,
            "requires_user_upload": False,
            "paper": {
                "paper_key": "paper-1",
                "title": "DFT Review",
                "authors": "A",
                "year": "2024",
                "venue": "Venue",
                "abstract": "Abstract",
                "evidence_units": [{"evidence_id": "P1-S1", "text": "Evidence sentence."}],
            },
        }
    ]
    counters = {"report_calls": 0}

    async def fake_json_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "前置澄清器" in system:
            return {"needs_clarification": False, "reason": "", "questions": []}
        if "拆题规划器" in system:
            return {
                "subquestions": ["DFT 的定义", "DFT 的核心公式"],
                "evidence_plan": ["先建立候选论文池，再整理终稿。"],
                "planned_calls": [
                    {
                        "tool_name": "paper_search",
                        "arguments": {"query": "density functional theory review", "max_results": 1},
                        "reason": "先收集综述论文",
                    }
                ],
                "plan_summary": "先检索综述论文，再直接整理终稿。",
            }
        if "工具后续决策器" in system:
            return {"continue": False, "extra_call": None, "reason": "当前证据足够形成阶段总结。"}
        if "研究质量审查器" in system:
            return {
                "support_gaps": [],
                "scientificity_risks": [],
                "next_questions": [],
                "ready_to_conclude": True,
            }
        return {}

    async def fake_text_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "严谨的学术综述写作者" in system:
            counters["report_calls"] += 1
            if counters["report_calls"] == 1:
                raise RuntimeError("upstream api disconnected")
            return "\n".join(
                [
                    "## 结论",
                    "DFT 通常指密度泛函理论，它把多电子基态问题转写为关于电子密度的变分问题，从而把原本高维的波函数描述压缩到三维密度函数的层面 [1]",
                    "在 Kohn-Sham 框架中，体系总能量可写为 $$E[\\rho]=T_s[\\rho]+\\int v_{ext}(r)\\rho(r)dr+E_H[\\rho]+E_{xc}[\\rho]$$，其中 $T_s$ 是非相互作用参考体系动能，$v_{ext}$ 是外场势，$E_H$ 是 Hartree 项，$E_{xc}$ 则吸收交换关联效应 [1]",
                    "这套框架使 DFT 成为计算分子结构、固体能带、吸附能和反应路径的核心工具，并在材料设计与量子化学中长期占据基础地位 [1]",
                    "",
                    "## 核心发现",
                    "- Hohenberg-Kohn 定理说明基态性质由电子密度唯一决定，为密度表述提供了理论基础 [1]",
                    "- Kohn-Sham 方程把相互作用电子体系映射到辅助非相互作用体系，显著降低了计算难度 [1]",
                    "- 交换关联泛函决定了结果精度上限，因此泛函选择直接影响预测可靠性 [1]",
                    "- DFT 最适合描述基态性质，涉及强关联或激发态问题时通常需要额外方法补强 [1]",
                    "",
                    "## 证据不足与争议点",
                    "- 无",
                    "",
                    "## 方法与适用边界",
                    "- 本综述基于综述论文与阶段性证据整理。",
                ]
            )
        return "\n".join(
            [
                "### 阶段结论",
                "- 已建立与 DFT 基本原理直接相关的论文证据池 [1]。",
                "",
                "### 证据支撑",
                "- [1] 提供了概念、框架和公式级背景。",
                "",
                "### 证据不足与待核验点",
                "- 当前仍需更多全文级细节，但不影响收束。",
                "",
                "### 建议导师重点审查处",
                "- 检查是否可以直接收尾。",
            ]
        )

    manager = _make_manager(
        tmp_path,
        monkeypatch,
        json_llm=fake_json_llm,
        text_llm=fake_text_llm,
        stream_text_llm=fake_text_llm,
    )
    await manager.initialize()
    job, _ = await manager.start_or_continue_job(
        thread_id="thread-final-retry",
        owner_key="thread-final-retry",
        question="DFT 的基本原理是什么？",
        settings=DeepResearchSettings.from_dict({"selected_model": "test"}),
    )
    await manager.wait_for_job(job.job_id, timeout_seconds=8)
    completed = await manager.store.get_job(job.job_id)
    assert completed is not None
    assert completed.status == "completed"
    assert counters["report_calls"] >= 2
    events = await manager.store.list_events(job.job_id)
    assert any(event["phase"] == "final_report_retry" for event in events)
    assert "参考来源" in completed.final_report_md


@pytest.mark.asyncio
async def test_job_auto_retries_after_tool_exception(tmp_path, monkeypatch):
    FakeMcpClient.calls = []
    FakeMcpClient.responses = [
        RuntimeError("temporary mcp failure"),
        {
            "ok": True,
            "papers": [
                {
                    "paper_key": "paper-1",
                    "title": "Paper One",
                    "authors": "A",
                    "year": "2024",
                    "venue": "Venue",
                    "abstract": "Abstract",
                }
            ],
        },
        {
            "ok": True,
            "access_status": "open_access",
            "can_auto_deep_read": True,
            "requires_user_upload": False,
            "paper": {
                "paper_key": "paper-1",
                "title": "Paper One",
                "authors": "A",
                "year": "2024",
                "venue": "Venue",
                "abstract": "Abstract",
                "evidence_units": [{"evidence_id": "P1-S1", "text": "Evidence sentence."}],
            },
        },
    ]

    async def fake_json_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "前置澄清器" in system:
            return {"needs_clarification": False, "reason": "", "questions": []}
        if "拆题规划器" in system:
            return {
                "subquestions": ["先检索论文"],
                "evidence_plan": ["先建立候选池后收尾。"],
                "planned_calls": [
                    {
                        "tool_name": "paper_search",
                        "arguments": {"query": "test retry topic", "max_results": 1},
                        "reason": "先检索论文",
                    }
                ],
                "plan_summary": "本轮只需一次论文检索。",
            }
        if "工具后续决策器" in system:
            return {"continue": False, "extra_call": None, "reason": "当前结果足够。"}
        if "研究质量审查器" in system:
            return {
                "support_gaps": [],
                "scientificity_risks": [],
                "next_questions": [],
                "ready_to_conclude": True,
            }
        return {}

    async def fake_text_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "严谨的学术综述写作者" in system:
            return "\n".join(
                [
                    "## 结论",
                    "当前问题已经有直接相关论文可用于形成简要回答 [1]",
                    "这批材料至少说明研究主题与候选论文高度相关，足以形成初步综述 [1]",
                    "",
                    "## 核心发现",
                    "- 已成功恢复并完成论文检索 [1]",
                    "- 自动重试后流程继续推进，没有丢失证据池状态 [1]",
                    "- 当前输出已补齐参考来源折叠块 [1]",
                    "- 终稿能够正常生成 [1]",
                    "",
                    "## 证据不足与争议点",
                    "- 无",
                    "",
                    "## 方法与适用边界",
                    "- 本综述基于一次恢复后的论文检索。",
                ]
            )
        return "\n".join(
            [
                "### 阶段结论",
                "- 自动重试后已重新拿到检索结果 [1]。",
                "",
                "### 证据支撑",
                "- [1] Paper One 已进入候选池。",
                "",
                "### 证据不足与待核验点",
                "- 无",
                "",
                "### 建议导师重点审查处",
                "- 可直接收尾。",
            ]
        )

    manager = _make_manager(
        tmp_path,
        monkeypatch,
        json_llm=fake_json_llm,
        text_llm=fake_text_llm,
        stream_text_llm=fake_text_llm,
    )
    await manager.initialize()
    job, _ = await manager.start_or_continue_job(
        thread_id="thread-job-retry",
        owner_key="thread-job-retry",
        question="test retry topic",
        settings=DeepResearchSettings.from_dict({"selected_model": "test"}),
    )
    await manager.wait_for_job(job.job_id, timeout_seconds=8)
    completed = await manager.store.get_job(job.job_id)
    assert completed is not None
    assert completed.status == "completed"
    events = await manager.store.list_events(job.job_id)
    assert any(event["phase"] == "job_retry_scheduled" for event in events)
    assert [call["name"] for call in FakeMcpClient.calls] == ["paper_search", "paper_search", "paper_read"]


@pytest.mark.asyncio
async def test_manual_regenerate_final_report_reuses_existing_evidence(tmp_path, monkeypatch):
    FakeMcpClient.calls = []
    FakeMcpClient.responses = [
        {
            "ok": True,
            "papers": [
                {
                    "paper_key": "paper-1",
                    "title": "Paper One",
                    "authors": "A",
                    "year": "2024",
                    "venue": "Venue",
                    "abstract": "Abstract",
                }
            ],
        }
        ,
        {
            "ok": True,
            "access_status": "open_access",
            "can_auto_deep_read": True,
            "requires_user_upload": False,
            "paper": {
                "paper_key": "paper-1",
                "title": "Paper One",
                "authors": "A",
                "year": "2024",
                "venue": "Venue",
                "abstract": "Abstract",
                "evidence_units": [{"evidence_id": "P1-S1", "text": "Evidence sentence."}],
            },
        }
    ]
    report_version = {"value": "版本 A"}

    async def fake_json_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "前置澄清器" in system:
            return {"needs_clarification": False, "reason": "", "questions": []}
        if "拆题规划器" in system:
            return {
                "subquestions": ["先检索论文"],
                "evidence_plan": ["收敛到一篇论文即可。"],
                "planned_calls": [
                    {
                        "tool_name": "paper_search",
                        "arguments": {"query": "test regenerate topic", "max_results": 1},
                        "reason": "建立候选池",
                    }
                ],
                "plan_summary": "只需一次检索。",
            }
        if "工具后续决策器" in system:
            return {"continue": False, "extra_call": None, "reason": "当前结果足够。"}
        if "研究质量审查器" in system:
            return {
                "support_gaps": [],
                "scientificity_risks": [],
                "next_questions": [],
                "ready_to_conclude": True,
            }
        return {}

    async def fake_text_llm(*, messages, selected_model="", max_tokens=None):
        system = messages[0]["content"]
        if "严谨的学术综述写作者" in system:
            version = report_version["value"]
            return "\n".join(
                [
                    "## 结论",
                    f"{version}：当前问题已有稳定候选论文支撑，可形成面向主题本身的回答 [1]",
                    f"{version}：已有证据足以给出概念界定、背景说明与结论摘要 [1]",
                    "",
                    "## 核心发现",
                    f"- {version}：候选论文已进入证据池 [1]",
                    f"- {version}：终稿由现有证据直接写成 [1]",
                    f"- {version}：重新生成不需要重新执行研究轮次 [1]",
                    f"- {version}：参考来源继续保留 [1]",
                    "",
                    "## 证据不足与争议点",
                    "- 无",
                    "",
                    "## 方法与适用边界",
                    "- 基于现有证据重写终稿。",
                ]
            )
        return "\n".join(
            [
                "### 阶段结论",
                "- 已建立候选论文池 [1]。",
                "",
                "### 证据支撑",
                "- [1] Paper One 已进入证据池。",
                "",
                "### 证据不足与待核验点",
                "- 无",
                "",
                "### 建议导师重点审查处",
                "- 可直接收尾。",
            ]
        )

    manager = _make_manager(
        tmp_path,
        monkeypatch,
        json_llm=fake_json_llm,
        text_llm=fake_text_llm,
        stream_text_llm=fake_text_llm,
    )
    await manager.initialize()
    job, _ = await manager.start_or_continue_job(
        thread_id="thread-regenerate",
        owner_key="thread-regenerate",
        question="test regenerate topic",
        settings=DeepResearchSettings.from_dict({"selected_model": "test"}),
    )
    await manager.wait_for_job(job.job_id, timeout_seconds=5)
    first_completed = await manager.store.get_job(job.job_id)
    assert first_completed is not None
    assert "版本 A" in first_completed.final_report_md

    report_version["value"] = "版本 B"
    result = await manager.regenerate_final_report(
        job_id=job.job_id,
        owner_key="thread-regenerate",
    )
    assert result is not None
    assert result["started"] is True

    await manager.wait_for_job(job.job_id, timeout_seconds=5)
    regenerated = await manager.store.get_job(job.job_id)
    assert regenerated is not None
    assert regenerated.status == "completed"
    assert "版本 B" in regenerated.final_report_md
    events = await manager.store.list_events(job.job_id)
    assert any(event["phase"] == "report_regeneration_requested" for event in events)


def test_deep_research_owner_key_prefers_current_user(monkeypatch):
    import demo_openai_compatible_httpx as demo_module

    monkeypatch.setattr(demo_module, "_get_current_user_id", lambda: "user-123")
    assert demo_module._deep_research_owner_key(thread_id="thread-123") == "user-123"


def test_render_snapshot_contains_research_card_and_neutral_copy():
    now = utc_now_iso()
    job = JobRecord(
        job_id="job-render",
        thread_id="thread-render",
        owner_key="thread-render",
        question="render question",
        status="running",
        phase="mentor",
        round=1,
        created_at=now,
        updated_at=now,
        final_message_id="final-render",
        trace_message_id="trace-render",
        tasklist_element_id="tasklist-render",
        settings_json={},
    )
    events = [
        {
            "event_id": 1,
            "job_id": "job-render",
            "phase": "phase_update",
            "role": "system",
            "tool_name": "",
            "payload": {"round": 1, "summary": "开始第 1 轮研究。"},
            "created_at": now,
        },
        {
            "event_id": 2,
            "job_id": "job-render",
            "phase": "mentor_review",
            "role": "mentor",
            "tool_name": "",
            "payload": {
                "round": 1,
                "support_gaps": ["关键论文待用户上传原文"],
                "scientificity_risks": ["不能把摘要证据当作全文结论"],
                "next_questions": ["提示用户上传 PDF"],
                "ready_to_conclude": False,
            },
            "created_at": now,
        },
    ]
    artifacts = [
        {
            "kind": "round_plan",
            "created_at": now,
            "payload": {"round": 1, "content": "### 拆题与计划\n- 先找关键论文。"},
        },
        {
            "kind": "paper",
            "created_at": now,
            "payload": {
                "paper_key": "paper-1",
                "paper_number": 1,
                "title": "Closed Access Paper",
                "needs_user_upload": True,
                "access_status": "upload_required",
                "upload_request": {
                    "request_id": "req-1",
                    "reason": "缺少开放获取全文。",
                    "source_links": ["https://publisher.example/paper.pdf"],
                },
            },
        },
    ]

    output = build_trace_markdown(job, events, artifacts)
    assert "学生讨论" not in output
    assert "导师点评" not in output
    assert "过程卡片" in output
    assert "轮次概览" not in output

    snapshot = build_thread_snapshot(
        job=job,
        events=events,
        artifacts=artifacts,
        tasklist_url="/research/jobs/job-render/tasklist",
    )
    assert snapshot["elements"][0]["name"] == "deepResearchCard"
    assert snapshot["research_card"]["upload_requests"][0]["paper_key"] == "paper-1"
    assert snapshot["messages"][0]["metadata"]["deep_research"] == {"job_id": "job-render", "kind": "trace"}


def test_report_quality_guard_flags_caveats_missing_citations_and_formula():
    markdown = "\n".join(
        [
            "## 结论",
            "DFT 是一种重要理论，但目前证据不足，需要谨慎理解。",
            "",
            "## 核心发现",
            "- 它可以处理电子结构问题。",
            "",
            "## 证据不足与争议点",
            "- 当前仍有一些争议。",
            "",
            "## 方法与适用边界",
            "- 基于现有检索结果整理。",
        ]
    )

    issues = DeepResearchManager._report_quality_issues(markdown, "DFT 的基本原理和核心公式是什么？")

    assert any("保留意见" in item for item in issues)
    assert any("没有引用" in item for item in issues)
    assert any("公式" in item for item in issues)
