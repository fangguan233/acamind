from unittest.mock import AsyncMock

import pytest

import chainlit as cl
import demo_openai_compatible_httpx as demo


@pytest.mark.asyncio
async def test_get_chat_history_normalizes_multimodal_entries(mock_chainlit_context):
    async with mock_chainlit_context:
        cl.user_session.set(
            "chat_history",
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "look at this image"},
                        {
                            "type": "image_url",
                            "image_url": {"url": "data:image/png;base64,AAAA"},
                        },
                        {"type": "unsupported", "value": "ignored"},
                    ],
                },
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": []},
            ],
        )

        history = demo._get_chat_history()

        assert history == [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "look at this image"},
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/png;base64,AAAA"},
                    },
                ],
            },
            {"role": "assistant", "content": "ok"},
        ]


@pytest.mark.asyncio
async def test_run_completion_reuses_images_from_history(
    mock_chainlit_context, monkeypatch: pytest.MonkeyPatch
):
    captured_messages: list[list[dict]] = []

    async def fake_generate(messages, **kwargs):
        captured_messages.append(messages)
        return f"assistant-{len(captured_messages)}"

    monkeypatch.setattr(demo, "_generate_llm_text", fake_generate)

    async with mock_chainlit_context:
        demo._set_chat_history([])

        await demo._run_completion(
            "describe this image",
            user_images=[{"name": "cat.png", "mime": "image/png", "url": "ZmFrZQ=="}],
        )

        history = demo._get_chat_history()
        assert history[0]["role"] == "user"
        assert isinstance(history[0]["content"], list)
        assert history[0]["content"][0] == {
            "type": "text",
            "text": "describe this image",
        }
        assert history[0]["content"][1]["type"] == "image_url"
        assert history[0]["content"][1]["image_url"]["url"].startswith(
            "data:image/png;base64,"
        )

        await demo._run_completion("continue using the previous image")

    assert len(captured_messages) == 2
    second_request = captured_messages[1]
    history_user_messages = [
        message
        for message in second_request
        if message.get("role") == "user" and isinstance(message.get("content"), list)
    ]

    assert len(history_user_messages) == 1
    assert any(
        part.get("type") == "image_url"
        for part in history_user_messages[0]["content"]
        if isinstance(part, dict)
    )


@pytest.mark.asyncio
async def test_hydrate_chat_history_restores_metadata_multimodal_content(
    mock_chainlit_context,
):
    thread = {
        "steps": [
            {
                "id": "user-1",
                "type": "user_message",
                "createdAt": "2026-03-23T00:00:00+00:00",
                "output": "raw user text",
                "metadata": {
                    "multimodal_memory": {
                        "version": 1,
                        "text_for_model": "model-visible text",
                        "direct_image_element_ids": ["img-1"],
                    }
                },
            },
            {
                "id": "assistant-1",
                "type": "assistant_message",
                "createdAt": "2026-03-23T00:00:01+00:00",
                "output": "assistant answer",
                "metadata": {},
            },
        ],
        "elements": [
            {
                "id": "img-1",
                "forId": "user-1",
                "type": "image",
                "name": "cat.png",
                "mime": "image/png",
                "url": "data:image/png;base64,AAAA",
            }
        ],
    }

    async with mock_chainlit_context:
        history = await demo._hydrate_chat_history_from_thread(thread)

        assert len(history) == 2
        assert history[0]["role"] == "user"
        assert isinstance(history[0]["content"], list)
        assert history[0]["content"][0] == {
            "type": "text",
            "text": "model-visible text",
        }
        assert history[0]["content"][1]["type"] == "image_url"
        assert history[0]["content"][1]["image_url"]["url"].startswith(
            "data:image/png;base64,"
        )
        assert cl.user_session.get("chat_history") == history
        assert cl.user_session.get("last_user_message") == "model-visible text"
        assert cl.user_session.get("last_user_images")


@pytest.mark.asyncio
async def test_compress_chat_history_uses_summary_when_message_count_exceeded(
    mock_chainlit_context, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("HISTORY_SUMMARY_TOKEN_THRESHOLD", "999999")
    monkeypatch.setenv("HISTORY_SUMMARY_KEEP_LAST", "2")

    async def failing_summary(*args, **kwargs):
        raise RuntimeError("summary failed")

    monkeypatch.setattr(demo, "_summarize_history", failing_summary)

    history = [
        {"role": "user", "content": "question one"},
        {"role": "assistant", "content": "answer one"},
        {"role": "user", "content": "question two"},
        {"role": "assistant", "content": "answer two"},
    ]

    async with mock_chainlit_context:
        compressed = await demo._compress_chat_history(
            history,
            user_content="",
            max_messages=3,
        )

        assert len(compressed) == 3
        assert compressed[0]["role"] == "assistant"
        assert compressed[0]["content"].startswith(demo.SUMMARY_PREFIX)
        assert "question one" in compressed[0]["content"]
        assert compressed[-2:] == history[-2:]


@pytest.mark.asyncio
async def test_hydrate_chat_history_legacy_images_become_image_blocks(
    mock_chainlit_context, monkeypatch: pytest.MonkeyPatch
):
    async def fake_image_ocr(image_bytes: bytes, mime: str, display_name: str) -> str:
        assert image_bytes
        assert mime == "image/png"
        assert display_name == "scan.png"
        return "text found in image"

    monkeypatch.setattr(demo, "_extract_image_text_with_ocr", fake_image_ocr)

    thread = {
        "steps": [
            {
                "id": "user-legacy",
                "type": "user_message",
                "createdAt": "2026-03-23T00:00:00+00:00",
                "output": "please inspect these attachments",
                "metadata": {},
            }
        ],
        "elements": [
            {
                "id": "img-legacy",
                "forId": "user-legacy",
                "type": "image",
                "name": "scan.png",
                "mime": "image/png",
                "url": "data:image/png;base64,AAAA",
            },
            {
                "id": "zip-legacy",
                "forId": "user-legacy",
                "type": "file",
                "name": "archive.zip",
                "mime": "application/zip",
                "url": "data:application/zip;base64,UEsDBA==",
            },
        ],
    }

    async with mock_chainlit_context:
        history = await demo._hydrate_chat_history_from_thread(thread)
        user_text = demo._history_content_to_text(
            history[0]["content"], include_image_note=False
        )

        assert "please inspect these attachments" in user_text
        assert demo._attachment_placeholder("archive.zip", "application/zip") in user_text
        assert isinstance(history[0]["content"], list)
        assert any(
            isinstance(part, dict) and part.get("type") == "image_url"
            for part in history[0]["content"]
        )


@pytest.mark.asyncio
async def test_on_chat_resume_hydrates_user_session_history(
    mock_chainlit_context, monkeypatch: pytest.MonkeyPatch
):
    thread = {
        "steps": [
            {
                "id": "user-1",
                "type": "user_message",
                "createdAt": "2026-03-23T00:00:00+00:00",
                "output": "raw text",
                "metadata": {
                    "multimodal_memory": {
                        "version": 1,
                        "text_for_model": "restored text",
                        "direct_image_element_ids": [],
                    }
                },
            }
        ],
        "elements": [],
    }
    emit_commands = AsyncMock()
    monkeypatch.setattr(demo, "_emit_commands_and_modes", emit_commands)

    async with mock_chainlit_context:
        await demo.on_chat_resume(thread)

        history = cl.user_session.get("chat_history")
        assert history == [
            {
                "role": "user",
                "content": "restored text",
                "metadata": {
                    "multimodal_memory": {
                        "version": 1,
                        "text_for_model": "restored text",
                        "direct_image_element_ids": [],
                    }
                },
            }
        ]
        assert cl.user_session.get("last_user_message") == "restored text"
        emit_commands.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("store_fn", "items", "prefix_builder"),
    [
        (
            demo._store_openalex_memory,
            [{"title": "Paper Title", "year": 2025, "doi": "10.1000/test"}],
            lambda: demo._build_openalex_memory(
                "same question", "analysis", [{"title": "Paper Title", "year": 2025}]
            ).splitlines()[0],
        ),
        (
            demo._store_websearch_memory,
            [{"title": "Source Title", "link": "https://example.com"}],
            lambda: demo._build_websearch_memory(
                "same question", "analysis", [{"title": "Source Title", "link": "https://example.com"}]
            ).splitlines()[0],
        ),
    ],
)
async def test_store_memory_replace_last_matches_multimodal_user_text(
    mock_chainlit_context,
    store_fn,
    items,
    prefix_builder,
):
    prefix = prefix_builder()

    async with mock_chainlit_context:
        cl.user_session.set(
            "chat_history",
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "same question"},
                        {
                            "type": "image_url",
                            "image_url": {"url": "data:image/png;base64,AAAA"},
                        },
                    ],
                },
                {"role": "assistant", "content": f"{prefix}\nold content"},
            ],
        )

        await store_fn("same question", "new analysis", items, replace_last=True)
        history = demo._get_chat_history()

        assert len(history) == 2
        assert (
            demo._history_content_to_text(
                history[0]["content"], include_image_note=False
            )
            == "same question"
        )
        assert history[1]["role"] == "assistant"
        assert history[1]["content"].startswith(prefix)
