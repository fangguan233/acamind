import base64
import json
from pathlib import Path

import pytest

import acamind_auth_store as auth_store
import demo_openai_compatible_httpx as demo


def _set_master_key(monkeypatch: pytest.MonkeyPatch) -> None:
    raw = b"0123456789abcdef0123456789abcdef"
    monkeypatch.setenv("ACAMIND_APIKEY_MASTER_KEY", base64.b64encode(raw).decode("utf-8"))
    demo._APIKEY_MASTER_KEY_CACHE = None


def test_apikey_encrypt_decrypt_roundtrip(monkeypatch: pytest.MonkeyPatch):
    _set_master_key(monkeypatch)
    cipher = demo._encrypt_api_key_value("sk-test-key-123")
    assert cipher.startswith("enc_v1:")
    assert demo._decrypt_api_key_value(cipher) == "sk-test-key-123"


def test_apikey_master_key_missing(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("ACAMIND_APIKEY_MASTER_KEY", raising=False)
    demo._APIKEY_MASTER_KEY_CACHE = None
    with pytest.raises(RuntimeError, match="Missing ACAMIND_APIKEY_MASTER_KEY"):
        demo._load_apikey_master_key()


def test_extract_stream_update_openai_and_responses_formats():
    assert demo._extract_stream_update({"choices": [{"delta": {"content": "Hi"}}]}) == (
        "Hi",
        False,
    )
    assert demo._extract_stream_update(
        {"type": "response.output_text.delta", "delta": "Hello"}
    ) == ("Hello", False)
    assert demo._extract_stream_update(
        {"type": "response.output_text.done", "text": "Final"}
    ) == ("Final", True)


@pytest.mark.asyncio
async def test_store_upgrade_adds_providers(tmp_path: Path):
    store_path = tmp_path / "auth.json"
    store_path.write_text(
        json.dumps({"version": 1, "users": {}, "groups": {}, "invites": {}}),
        encoding="utf-8",
    )
    default_groups = [{"id": "admin", "name": "admin"}, {"id": "guest", "name": "guest"}]
    data = await auth_store.ensure_store(
        default_groups, default_group_id="guest", path=str(store_path)
    )
    assert data.get("version") == auth_store.STORE_VERSION
    assert isinstance(data.get("providers"), dict)


@pytest.mark.asyncio
async def test_provider_prefix_must_be_unique(tmp_path: Path):
    store_path = tmp_path / "auth.json"
    default_groups = [{"id": "admin", "name": "admin"}, {"id": "guest", "name": "guest"}]
    await auth_store.ensure_store(default_groups, default_group_id="guest", path=str(store_path))
    await auth_store.create_provider(
        {
            "id": "provider-a",
            "name": "provider-a",
            "type": "openai_compat",
            "model_prefix": "openai",
        },
        path=str(store_path),
    )
    with pytest.raises(ValueError, match="Model prefix already exists"):
        await auth_store.create_provider(
            {
                "id": "provider-b",
                "name": "provider-b",
                "type": "openai_compat",
                "model_prefix": "openai",
            },
            path=str(store_path),
        )


@pytest.mark.asyncio
async def test_consume_quota_supports_prefixed_and_bare_model_ids(tmp_path: Path):
    store_path = tmp_path / "auth.json"
    default_groups = [
        {
            "id": "admin",
            "name": "admin",
            "allowed_models": [],
            "model_quotas": {},
            "model_daily_quotas": {},
        },
        {
            "id": "guest",
            "name": "guest",
            "allowed_models": ["openai:gpt-5.2-codex"],
            "model_quotas": {"openai:gpt-5.2-codex": 2},
            "model_daily_quotas": {},
        },
    ]
    await auth_store.ensure_store(default_groups, default_group_id="guest", path=str(store_path))
    user = await auth_store.create_user(
        username="tester",
        password="pass-123",
        default_group_id="guest",
        path=str(store_path),
    )
    uid = user["id"]

    ok1, remaining1 = await auth_store.consume_quota(
        uid, "gpt-5.2-codex", amount=1, path=str(store_path)
    )
    ok2, remaining2 = await auth_store.consume_quota(
        uid, "openai:gpt-5.2-codex", amount=1, path=str(store_path)
    )
    ok3, remaining3 = await auth_store.consume_quota(
        uid, "gpt-5.2-codex", amount=1, path=str(store_path)
    )

    assert ok1 is True and remaining1 == 1
    assert ok2 is True and remaining2 == 0
    assert ok3 is False and remaining3 == 0
