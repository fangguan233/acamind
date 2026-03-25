import json

import pytest

import acamind_auth_store as auth_store


def _default_groups():
    shared_deep_research = {
        "allow_user_adjust": True,
        "defaults": {
            "deep_research_max_rounds": 6,
            "deep_research_max_tool_calls": 18,
        },
        "ranges": {
            "deep_research_max_rounds": {"min": 1, "max": 12},
            "deep_research_max_tool_calls": {"min": 1, "max": 60},
        },
    }
    return [
        {
            "id": "admin",
            "name": "admin",
            "allowed_models": [],
            "model_quotas": {},
            "model_daily_quotas": {},
            "openalex": {},
            "websearch": {},
            "deep_research": shared_deep_research,
            "created_at": "now",
        },
        {
            "id": "guest",
            "name": "guest",
            "allowed_models": [],
            "model_quotas": {},
            "model_daily_quotas": {},
            "openalex": {},
            "websearch": {},
            "deep_research": shared_deep_research,
            "created_at": "now",
        },
    ]


@pytest.mark.asyncio
async def test_first_user_becomes_admin_and_receives_deep_research_policy(tmp_path):
    path = str(tmp_path / "auth.json")
    await auth_store.ensure_store(_default_groups(), default_group_id="guest", path=path)

    initial_status = await auth_store.get_auth_status(path=path)
    assert initial_status["bootstrap_required"] is True
    assert initial_status["user_count"] == 0

    user = await auth_store.create_user(
        "admin1",
        "secret123",
        email="admin@example.com",
        default_group_id="guest",
        path=path,
    )
    assert user["is_admin"] is True
    assert user["group_id"] == "admin"

    perms = await auth_store.get_effective_permissions(user["id"], path=path)
    deep_research_policy = perms["settings_policy"]["deep_research"]
    assert deep_research_policy["allow_user_adjust"] is True
    assert deep_research_policy["defaults"]["deep_research_max_rounds"] == 6

    final_status = await auth_store.get_auth_status(path=path)
    assert final_status["bootstrap_required"] is False
    assert final_status["admin_count"] == 1


@pytest.mark.asyncio
async def test_corrupt_primary_store_recovers_from_backup(tmp_path):
    path = str(tmp_path / "auth.json")
    await auth_store.ensure_store(_default_groups(), default_group_id="guest", path=path)
    user = await auth_store.create_user(
        "admin1",
        "secret123",
        email="admin@example.com",
        default_group_id="guest",
        path=path,
    )

    assert tmp_path.joinpath("auth.json.bak").is_file()

    tmp_path.joinpath("auth.json").write_text("{not valid json", encoding="utf-8")

    recovered_status = await auth_store.get_auth_status(path=path)
    assert recovered_status["has_users"] is True

    users = await auth_store.list_users(path=path)
    assert len(users) == 1
    assert users[0]["id"] == user["id"]

    restored = json.loads(tmp_path.joinpath("auth.json").read_text(encoding="utf-8"))
    assert user["id"] in restored["users"]
    assert list(tmp_path.glob("auth.json.corrupt.*"))
