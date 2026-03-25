from __future__ import annotations

import asyncio
import logging
import sys
from typing import Any, Optional

import httpx
from mcp.server.fastmcp import FastMCP


def _configure_stdio_logging() -> None:
    # MCP stdio requires stdout to contain protocol frames only.
    noisy_loggers = [
        "httpx",
        "httpcore",
        "openai",
        "chainlit",
        "mcp",
        "traceloop",
    ]
    for name in noisy_loggers:
        logger = logging.getLogger(name)
        logger.setLevel(logging.WARNING)

    root = logging.getLogger()
    for handler in root.handlers:
        stream = getattr(handler, "stream", None)
        if stream is sys.stdout:
            try:
                handler.setStream(sys.stderr)
            except Exception:
                pass


_configure_stdio_logging()


def _core():
    import demo_openai_compatible_httpx as core

    return core


def _safe_paper_key(paper: dict[str, Any]) -> str:
    core = _core()
    doi = core._to_str(paper.get("doi") or "").strip()
    if doi:
        return f"doi:{doi.lower()}"
    work_id = core._to_str(paper.get("id") or "").strip()
    if work_id:
        return work_id.lower()
    title = core._to_str(paper.get("title") or "").strip().lower()
    return title or "paper"


def _paper_read_has_target(identifier: Any = None, title: str = "") -> bool:
    core = _core()
    return bool(core._to_str(identifier or "").strip() or core._to_str(title or "").strip())


def _normalize_paper_payload(paper: dict[str, Any]) -> dict[str, Any]:
    core = _core()
    payload = dict(paper)
    payload["paper_key"] = _safe_paper_key(payload)
    payload["openalex_id"] = core._to_str(payload.get("id") or "").strip()
    payload["openalex_url"] = core._to_str(payload.get("id") or "").strip()
    return payload


def _paper_read_resolution_failure_payload(
    *,
    identifier: Any = None,
    title: str = "",
    normalized_identifier: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    core = _core()
    normalized_title = core._to_str(title or "").strip()
    normalized_identifier = (
        normalized_identifier
        if isinstance(normalized_identifier, dict)
        else {}
    )
    identifier_type = core._to_str(normalized_identifier.get("type") or "").strip().lower()
    identifier_value = core._to_str(normalized_identifier.get("value") or identifier or "").strip()

    paper: dict[str, Any] = {
        "title": normalized_title,
        "abstract": "",
        "authors": "",
        "year": "",
        "venue": "",
        "evidence_units": [],
        "fulltext": "",
        "ocr_text": "",
        "local_pdf_url": "",
        "source_pdf_url": "",
    }
    source_links: list[str] = []

    if identifier_type == "doi" and identifier_value:
        paper["doi"] = identifier_value
        doi_url = core._format_doi(identifier_value)
        if doi_url:
            source_links.append(doi_url)
    elif identifier_type in {"openalex", "openalex_id", "openalex-url"} and identifier_value:
        paper["openalex_id"] = identifier_value
        paper["openalex_url"] = identifier_value
        source_links.append(identifier_value)
    elif identifier_value:
        paper["id"] = identifier_value
        if identifier_value.startswith(("http://", "https://")):
            paper["source_pdf_url"] = identifier_value
            source_links.append(identifier_value)

    paper = _normalize_paper_payload(paper)
    upload_reason = "未能定位论文；若这篇文献对结论关键，请上传原文 PDF。"
    return {
        "ok": False,
        "error": upload_reason,
        "access_status": "resolution_failed",
        "can_auto_deep_read": False,
        "requires_user_upload": True,
        "upload_request": {
            "title": core._to_str(paper.get("title") or "").strip(),
            "paper_key": core._to_str(paper.get("paper_key") or "").strip(),
            "identifier": normalized_identifier or {},
            "reason": upload_reason,
            "source_links": source_links,
        },
        "paper": paper,
        "summary": {
            "title": core._to_str(paper.get("title") or "").strip(),
            "access_status": "resolution_failed",
            "can_auto_deep_read": False,
            "requires_user_upload": True,
            "upload_request": {
                "title": core._to_str(paper.get("title") or "").strip(),
                "paper_key": core._to_str(paper.get("paper_key") or "").strip(),
                "reason": upload_reason,
                "source_links": source_links,
            },
        },
    }


async def _resolve_paper_by_identifier(
    *,
    identifier: Any = None,
    title: str = "",
) -> tuple[Optional[dict[str, Any]], Optional[dict[str, str]]]:
    core = _core()
    normalized_identifier = core._normalize_identifier(identifier)
    if normalized_identifier:
        work = await core._openalex_fetch_work(
            normalized_identifier,
            mailto=core._env("OPENALEX_MAILTO"),
            api_key="",
            timeout_s=core._env_float("OPENALEX_TIMEOUT_S", 30.0),
        )
        if work:
            return work, normalized_identifier
    if title.strip():
        results = await core._openalex_search(
            title.strip(),
            per_page=5,
            mailto=core._env("OPENALEX_MAILTO"),
            api_key="",
            timeout_s=core._env_float("OPENALEX_TIMEOUT_S", 30.0),
        )
        if results:
            work = results[0]
            parsed = core._parse_openalex_work(work)
            parsed_identifier = core._normalize_identifier(
                parsed.get("doi") or parsed.get("id") or parsed.get("oa_url") or ""
            )
            return work, parsed_identifier
    return None, normalized_identifier


async def _collect_pdf_candidates(paper: dict[str, Any], doi: str) -> list[str]:
    core = _core()
    candidates: list[str] = []
    seen: set[str] = set()

    def add(url: str) -> None:
        for expanded in core._expand_pdf_candidate_url_variants(url):
            value = core._to_str(expanded).strip()
            if not value:
                continue
            lowered = value.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            candidates.append(value)

    add(core._to_str(paper.get("content_url") or "").strip())
    add(core._to_str(paper.get("pdf_url") or "").strip())
    add(core._to_str(paper.get("oa_url") or "").strip())
    for item in paper.get("pdf_candidates") or []:
        add(core._to_str(item))
    for item in paper.get("oa_candidates") or []:
        add(core._to_str(item))

    if doi:
        timeout_s = core._env_float("OPENALEX_TIMEOUT_S", 30.0)
        email = (
            core._env("UNPAYWALL_EMAIL").strip()
            or core._env("OPENALEX_MAILTO").strip()
            or "openalex@chainlit.local"
        )
        try:
            for record in await core._unpaywall_open_access_records(
                doi, timeout_s=timeout_s, email=email
            ):
                if not isinstance(record, dict):
                    continue
                add(core._to_str(record.get("pdf_url") or "").strip())
                add(core._to_str(record.get("url") or "").strip())
        except Exception:
            pass
        try:
            for record in await core._core_open_access_records(
                doi=doi,
                title=core._to_str(paper.get("title") or "").strip(),
                timeout_s=timeout_s,
            ):
                if not isinstance(record, dict):
                    continue
                add(core._to_str(record.get("url") or "").strip())
        except Exception:
            pass
        try:
            for url in await core._crossref_open_access_urls(doi, timeout_s=timeout_s):
                add(url)
        except Exception:
            pass
        try:
            for url in await core._europe_pmc_open_access_urls(doi, timeout_s=timeout_s):
                add(url)
        except Exception:
            pass
        try:
            add(await core._semantic_scholar_open_access_pdf_url(doi, timeout_s=timeout_s))
        except Exception:
            pass
        add(core._format_doi(doi))

    candidates.sort(key=lambda url: url.lower())
    return candidates


async def _load_or_fetch_paper_content(
    paper: dict[str, Any],
    identifier: Optional[dict[str, str]],
) -> dict[str, Any]:
    core = _core()
    pdf_timeout_s = core._env_float(
        "OPENALEX_PDF_TIMEOUT_S", max(60.0, core._env_float("OPENALEX_TIMEOUT_S", 30.0))
    )
    deepread_max_chars = core._env_int("OPENALEX_DEEPREAD_MAX_CHARS", 50000)
    deepread_max_chars = max(5000, min(deepread_max_chars, 200000))
    allow_snapshot = core._openalex_deepread_allow_text_snapshot()
    require_local_pdf = core._openalex_deepread_require_local_pdf()

    cache_key = core._fulltext_cache_key(identifier=identifier)
    cached_meta = core._load_fulltext_cache_meta(cache_key) if cache_key else {}
    cached_fulltext = core._load_fulltext_cache(cache_key) if cache_key else ""
    cached_ocr = core._load_fulltext_cache_ocr(cache_key) if cache_key else ""
    cached_pages = core._load_fulltext_cache_ocr_pages(cache_key) if cache_key else []
    cached_rows = core._load_fulltext_cache_ocr_page_rows(cache_key) if cache_key else []

    local_pdf_url = core._to_str(cached_meta.get("local_pdf_url") or "").strip()
    source_pdf_url = core._to_str(cached_meta.get("source_pdf_url") or "").strip()
    fulltext = core._to_str(cached_fulltext or "").strip()
    ocr_text = core._to_str(cached_ocr or fulltext).strip()
    page_texts = cached_pages if isinstance(cached_pages, list) else []
    page_rows = core._normalize_ocr_page_rows(cached_rows)

    doi = ""
    if identifier and core._to_str(identifier.get("type") or "").lower() == "doi":
        doi = core._to_str(identifier.get("value") or "").strip()
    if not doi:
        doi = core._to_str(paper.get("doi") or "").strip()

    if paper.get("content_url") and not fulltext:
        fulltext = await core._openalex_fetch_fulltext(
            core._to_str(paper.get("content_url") or "").strip(),
            mailto=core._env("OPENALEX_MAILTO"),
            api_key="",
            timeout_s=pdf_timeout_s,
        )
        if fulltext:
            source_pdf_url = core._to_str(paper.get("content_url") or "").strip()

    if not fulltext:
        for url in await _collect_pdf_candidates(paper, doi):
            if not url:
                continue
            pdf_bytes = await core._download_pdf_bytes(url, timeout_s=pdf_timeout_s)
            if pdf_bytes:
                cached_url = core._cache_pdf_to_local_public(
                    pdf_bytes,
                    source_url=url,
                    doi=doi,
                    title=core._to_str(paper.get("title") or ""),
                )
                if cached_url:
                    local_pdf_url = cached_url
                    source_pdf_url = url
                pdf_text, pdf_page_texts, pdf_page_rows = (
                    await core._extract_pdf_text_with_ocr_pages_and_rows(pdf_bytes)
                )
                if pdf_page_texts:
                    page_texts = pdf_page_texts
                if pdf_page_rows:
                    page_rows = pdf_page_rows
                if pdf_text and not ocr_text:
                    ocr_text = pdf_text
                valid_pdf, _ = core._validate_deepread_fulltext(pdf_text)
                if valid_pdf:
                    fulltext = pdf_text
                    if not ocr_text:
                        ocr_text = pdf_text
                    break
            if fulltext:
                break
            pdf_text = await core._download_pdf_text(url, timeout_s=pdf_timeout_s)
            valid_text, _ = core._validate_deepread_fulltext(pdf_text)
            if valid_text:
                fulltext = pdf_text
                source_pdf_url = source_pdf_url or url
                break

    if (not ocr_text or not page_texts) and local_pdf_url and not core._is_local_text_snapshot_url(local_pdf_url):
        regenerated_ocr, regenerated_pages, regenerated_rows = (
            await core._extract_ocr_text_and_pages_from_local_cached_pdf(local_pdf_url)
        )
        if regenerated_ocr and not ocr_text:
            ocr_text = regenerated_ocr
        if regenerated_pages:
            page_texts = regenerated_pages
        if regenerated_rows:
            page_rows = regenerated_rows

    if fulltext and not local_pdf_url and allow_snapshot:
        snapshot_url = core._cache_text_snapshot_to_local_public_html(
            fulltext,
            source_url=source_pdf_url,
            doi=doi,
            title=core._to_str(paper.get("title") or ""),
        )
        if snapshot_url:
            local_pdf_url = snapshot_url

    if fulltext and require_local_pdf and not local_pdf_url:
        fulltext = ""

    evidence_source = core._to_str(fulltext or ocr_text).strip()
    evidence_units: list[dict[str, Any]] = []
    if evidence_source:
        evidence_units = core._build_deepread_evidence_units(
            paper_id="P1",
            fulltext=evidence_source,
            local_pdf_url=local_pdf_url,
            page_texts_override=page_texts,
            page_rows_override=page_rows,
            max_units=min(core._env_int("OPENALEX_DEEPREAD_MAX_EVIDENCE_UNITS", 500), 500),
        )

    paper["fulltext"] = core._truncate(fulltext, deepread_max_chars)
    paper["ocr_text"] = core._truncate(ocr_text or fulltext, deepread_max_chars)
    paper["ocr_page_texts"] = page_texts
    paper["ocr_page_rows"] = page_rows
    paper["local_pdf_url"] = local_pdf_url
    paper["source_pdf_url"] = source_pdf_url
    paper["evidence_units"] = evidence_units

    if cache_key and (paper.get("fulltext") or paper.get("ocr_text")):
        try:
            core._save_fulltext_cache(
                cache_key,
                core._to_str(paper.get("fulltext") or ""),
                {
                    "identifier": identifier,
                    "local_pdf_url": local_pdf_url,
                    "source_pdf_url": source_pdf_url,
                },
                ocr_text=core._to_str(paper.get("ocr_text") or ""),
                ocr_pages=page_texts,
                ocr_page_rows=page_rows,
            )
        except Exception:
            pass

    return paper


async def _paper_search_impl(query: str, max_results: int) -> dict[str, Any]:
    core = _core()
    query = core._to_str(query).strip()
    max_results = max(1, min(int(max_results or 8), 20))
    results = await core._openalex_search(
        query,
        per_page=max_results,
        mailto=core._env("OPENALEX_MAILTO"),
        api_key="",
        timeout_s=core._env_float("OPENALEX_TIMEOUT_S", 30.0),
    )
    papers = [_normalize_paper_payload(core._parse_openalex_work(work)) for work in results]
    return {"ok": True, "query": query, "papers": papers[:max_results]}


def _coerce_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _tool_query_arg(arguments: dict[str, Any]) -> str:
    for key in ("query", "q", "question", "keywords"):
        value = str(arguments.get(key) or "").strip()
        if value:
            return value
    return ""


async def call_tool_local(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    args = arguments if isinstance(arguments, dict) else {}
    tool_name = str(name or "").strip()

    if tool_name == "paper_search":
        return await _paper_search_impl(
            query=_tool_query_arg(args),
            max_results=_coerce_int(
                args.get("max_results") or args.get("top_k") or args.get("k") or 8,
                8,
            ),
        )
    if tool_name == "paper_read":
        return await _paper_read_impl(
            identifier=(
                args.get("identifier")
                or args.get("doi")
                or args.get("openalex_id")
                or args.get("arxiv_id")
                or args.get("url")
                or ""
            ),
            title=str(args.get("title") or "").strip(),
        )
    if tool_name == "web_search":
        return await _web_search_impl(
            query=_tool_query_arg(args),
            max_results=_coerce_int(
                args.get("max_results") or args.get("top_k") or args.get("k") or 8,
                8,
            ),
            selected_model=str(args.get("selected_model") or "").strip(),
        )
    if tool_name == "web_read":
        return await _web_read_impl(
            url=str(args.get("url") or "").strip(),
            max_chars=_coerce_int(args.get("max_chars") or args.get("max_length") or 6000, 6000),
        )
    return {"ok": False, "error": f"Unknown tool: {tool_name}"}


async def _paper_read_impl(
    *,
    identifier: Any = None,
    title: str = "",
) -> dict[str, Any]:
    core = _core()
    normalized_title = core._to_str(title or "").strip()
    normalized_identifier = core._to_str(identifier or "").strip()
    if not _paper_read_has_target(identifier=normalized_identifier, title=normalized_title):
        error = "paper_read 缺少具体论文目标，请先检索并指定标题、DOI 或 OpenAlex ID。"
        return {
            "ok": False,
            "error": error,
            "access_status": "invalid_request",
            "can_auto_deep_read": False,
            "requires_user_upload": False,
            "upload_request": None,
            "paper": {},
            "summary": {
                "title": "",
                "access_status": "invalid_request",
                "can_auto_deep_read": False,
                "requires_user_upload": False,
                "upload_request": None,
                "error": error,
            },
        }
    work, normalized_identifier = await _resolve_paper_by_identifier(
        identifier=normalized_identifier,
        title=normalized_title,
    )
    if not work:
        return _paper_read_resolution_failure_payload(
            identifier=normalized_identifier,
            title=normalized_title,
            normalized_identifier=normalized_identifier,
        )
    paper = _normalize_paper_payload(core._parse_openalex_work(work))
    paper = await _load_or_fetch_paper_content(paper, normalized_identifier)
    evidence_units = (
        paper.get("evidence_units") if isinstance(paper.get("evidence_units"), list) else []
    )
    evidence_preview = [
        {
            "evidence_id": core._to_str(item.get("evidence_id") or "").strip(),
            "text": core._truncate(core._to_str(item.get("text") or "").strip(), 240),
            "page": item.get("page"),
        }
        for item in evidence_units[:12]
        if isinstance(item, dict)
    ]
    fulltext_excerpt = core._truncate(
        core._to_str(paper.get("fulltext") or paper.get("ocr_text") or "").strip(),
        4000,
    )
    source_links: list[str] = []
    seen_links: set[str] = set()
    for candidate in (
        core._to_str(paper.get("source_pdf_url") or "").strip(),
        core._to_str(paper.get("oa_url") or "").strip(),
        core._to_str(paper.get("openalex_url") or "").strip(),
        core._format_doi(core._to_str(paper.get("doi") or "").strip()),
    ):
        if not candidate:
            continue
        lowered = candidate.lower()
        if lowered in seen_links:
            continue
        seen_links.add(lowered)
        source_links.append(candidate)

    can_auto_deep_read = bool(
        evidence_preview
        or fulltext_excerpt
        or core._to_str(paper.get("local_pdf_url") or "").strip()
    )
    access_status = "open_access" if can_auto_deep_read else "metadata_only"
    if not can_auto_deep_read and source_links:
        access_status = "upload_required"
    requires_user_upload = not can_auto_deep_read
    upload_request = None
    if requires_user_upload:
        upload_request = {
            "title": core._to_str(paper.get("title") or "").strip(),
            "paper_key": core._to_str(paper.get("paper_key") or "").strip(),
            "identifier": normalized_identifier or {},
            "reason": "未获取到可自动精读的开放获取全文，当前只能使用摘要或元数据；如需精读，请用户上传原文 PDF。",
            "source_links": source_links,
        }

    return {
        "ok": True,
        "access_status": access_status,
        "can_auto_deep_read": can_auto_deep_read,
        "requires_user_upload": requires_user_upload,
        "upload_request": upload_request,
        "paper": paper,
        "summary": {
            "title": core._to_str(paper.get("title") or "").strip(),
            "abstract": core._truncate(core._to_str(paper.get("abstract") or "").strip(), 1600),
            "fulltext_excerpt": fulltext_excerpt,
            "evidence_units": evidence_preview,
            "local_pdf_url": core._to_str(paper.get("local_pdf_url") or "").strip(),
            "access_status": access_status,
            "can_auto_deep_read": can_auto_deep_read,
            "requires_user_upload": requires_user_upload,
            "upload_request": upload_request,
        },
    }


def _normalize_web_results(raw_results: list[dict[str, Any]], max_results: int) -> list[dict[str, Any]]:
    core = _core()
    normalized: list[dict[str, Any]] = []
    for entry in raw_results[:max_results]:
        if not isinstance(entry, dict):
            continue
        normalized.append(
            {
                "title": core._to_str(entry.get("title") or "").strip(),
                "url": core._to_str(entry.get("link") or entry.get("url") or "").strip(),
                "display": core._to_str(entry.get("display") or "").strip(),
                "snippet": core._to_str(entry.get("snippet") or "").strip(),
            }
        )
    return normalized


def _google_search_available(core: Any, google_cfg: dict[str, Any]) -> bool:
    return bool(
        core._to_str(google_cfg.get("cx") or "").strip()
        and (
            core._to_str(google_cfg.get("api_key") or "").strip()
            or core._to_str(google_cfg.get("oauth_token") or "").strip()
        )
    )


async def _web_search_impl(query: str, max_results: int, selected_model: str = "") -> dict[str, Any]:
    core = _core()
    query = core._to_str(query).strip()
    max_results = max(1, min(int(max_results or 8), 10))
    selected_model = core._to_str(selected_model).strip()
    provider = core._get_websearch_provider()
    google_cfg = core._get_google_cse_config()
    searxng_cfg = core._get_searxng_config()
    timeout_s = core._env_float("WEBSEARCH_TIMEOUT_S", 20.0)
    warnings: list[str] = []

    try:
        provider_answer, provider_sources = await core._provider_websearch_tool_generate(
            query,
            context="",
            selected_model=selected_model,
        )
        normalized = _normalize_web_results(provider_sources, max_results)
        if normalized:
            return {
                "ok": True,
                "query": query,
                "results": normalized,
                "backend": "provider_tool",
                "provider_answer": core._truncate(core._to_str(provider_answer).strip(), 1200),
            }
        if core._to_str(provider_answer).strip():
            warnings.append("模型内置联网工具返回了回答，但未返回可用来源列表，已改走传统检索后端。")
        else:
            warnings.append("模型内置联网工具未返回可用来源列表，已改走传统检索后端。")
    except Exception as exc:
        warnings.append(f"模型内置联网搜索失败：{exc!s}")

    providers_to_try: list[str] = []
    if _google_search_available(core, google_cfg):
        providers_to_try.append("google")
    configured_provider = core._to_str(provider).strip().lower()
    if configured_provider:
        providers_to_try.append(configured_provider)
    if core._to_str(searxng_cfg.get("base_url") or "").strip():
        providers_to_try.append("searxng")

    seen_providers: set[str] = set()
    ordered_providers: list[str] = []
    for item in providers_to_try:
        key = core._to_str(item).strip().lower()
        if not key or key in seen_providers:
            continue
        seen_providers.add(key)
        ordered_providers.append(key)

    last_error = ""
    for fallback_provider in ordered_providers:
        try:
            results = await core._websearch_search(
                query,
                provider=fallback_provider,
                api_key=google_cfg.get("api_key", ""),
                cx=google_cfg.get("cx", ""),
                oauth_token=google_cfg.get("oauth_token", ""),
                use_oauth=bool(google_cfg.get("use_oauth")),
                searxng_cfg=searxng_cfg,
                max_results=max_results,
                timeout_s=timeout_s,
                max_queries=1,
            )
            normalized = _normalize_web_results(results, max_results)
            if normalized:
                payload: dict[str, Any] = {
                    "ok": True,
                    "query": query,
                    "results": normalized,
                    "backend": fallback_provider,
                }
                if warnings:
                    payload["warnings"] = warnings
                return payload
        except Exception as exc:
            last_error = f"{fallback_provider}: {exc!s}"
            warnings.append(f"后备搜索 `{fallback_provider}` 失败：{exc!s}")

    error = last_error or "未获得可用网页检索结果。"
    return {
        "ok": False,
        "query": query,
        "results": [],
        "backend": "none",
        "error": error,
        "warnings": warnings,
    }


async def _web_read_impl(url: str, max_chars: int) -> dict[str, Any]:
    core = _core()
    url = core._to_str(url).strip()
    max_chars = max(500, min(int(max_chars or 6000), 20000))
    timeout_s = core._env_float("WEBSEARCH_TIMEOUT_S", 20.0)
    timeout = httpx.Timeout(timeout_s)
    try:
        if url.lower().endswith(".pdf"):
            text = await core._download_pdf_text(url, timeout_s=max(timeout_s, 60.0))
            return {
                "ok": True,
                "url": url,
                "title": url,
                "content": core._truncate(core._to_str(text).strip(), max_chars),
            }
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
            content_type = core._to_str(response.headers.get("content-type") or "").lower()
            title = url
            if "html" in content_type or response.text.lstrip().startswith("<"):
                text = core._extract_text_from_html_document(response.text)
                match = core.re.search(
                    r"<title[^>]*>(.*?)</title>",
                    response.text,
                    flags=core.re.I | core.re.S,
                )
                if match:
                    title = core._to_str(match.group(1) or "").strip() or title
            else:
                text = core._to_str(response.text).strip()
            return {
                "ok": True,
                "url": url,
                "title": title,
                "content": core._truncate(core._to_str(text).strip(), max_chars),
            }
    except Exception as exc:
        return {"ok": False, "url": url, "error": f"{exc!s}"}


_SERVER = FastMCP("deep-research-tools")


@_SERVER.tool()
async def paper_search(query: str, max_results: int = 8) -> dict[str, Any]:
    return await _paper_search_impl(query=query, max_results=max_results)


@_SERVER.tool()
async def paper_read(
    identifier: str = "",
    title: str = "",
    doi: str = "",
    openalex_id: str = "",
    arxiv_id: str = "",
    url: str = "",
) -> dict[str, Any]:
    resolved_identifier = identifier or doi or openalex_id or arxiv_id or url
    return await _paper_read_impl(identifier=resolved_identifier, title=title)


@_SERVER.tool()
async def web_search(query: str, max_results: int = 8) -> dict[str, Any]:
    return await _web_search_impl(query=query, max_results=max_results)


@_SERVER.tool()
async def web_read(url: str, max_chars: int = 6000) -> dict[str, Any]:
    return await _web_read_impl(url=url, max_chars=max_chars)


async def main() -> None:
    await _SERVER.run_stdio_async()


if __name__ == "__main__":
    asyncio.run(main())
