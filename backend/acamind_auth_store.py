import asyncio
import base64
import hashlib
import json
import os
import secrets
import shutil
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

STORE_VERSION = 2
DEFAULT_STORE_PATH = os.path.join(
    os.path.dirname(__file__), ".data", "acamind_auth.json"
)

PROVIDER_TYPES = {"openai_compat", "qwen_responses", "dashscope"}
WEBSEARCH_TOOL_MODES = {"auto", "on", "off"}

_LOCK = asyncio.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_utc() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _ensure_dir(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)


def _empty_store() -> dict:
    return {
        "version": STORE_VERSION,
        "users": {},
        "groups": {},
        "invites": {},
        "providers": {},
        "meta": {},
    }


def _backup_path(path: str) -> str:
    return f"{path}.bak"


def _corrupt_path(path: str) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    return f"{path}.corrupt.{timestamp}"


def _read_store_file(path: str) -> Optional[dict]:
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("Invalid store")
    return data


def _preserve_corrupt_store(path: str) -> None:
    if not os.path.isfile(path):
        return
    target = _corrupt_path(path)
    try:
        os.replace(path, target)
    except Exception:
        try:
            shutil.copy2(path, target)
        except Exception:
            pass


def _read_store_unlocked(path: str) -> dict:
    if not os.path.isfile(path):
        return _empty_store()

    try:
        data = _read_store_file(path)
    except Exception:
        data = None

    if data is None:
        backup = _backup_path(path)
        try:
            data = _read_store_file(backup)
        except Exception:
            data = None
        if data is not None:
            try:
                _preserve_corrupt_store(path)
                _atomic_write(path, data)
            except Exception:
                pass
        else:
            _preserve_corrupt_store(path)
            return _empty_store()

    data.setdefault("version", STORE_VERSION)
    data.setdefault("users", {})
    data.setdefault("groups", {})
    data.setdefault("invites", {})
    data.setdefault("providers", {})
    data.setdefault("meta", {})
    if not isinstance(data["users"], dict):
        data["users"] = {}
    if not isinstance(data["groups"], dict):
        data["groups"] = {}
    if not isinstance(data["invites"], dict):
        data["invites"] = {}
    if not isinstance(data["providers"], dict):
        data["providers"] = {}
    if not isinstance(data["meta"], dict):
        data["meta"] = {}
    try:
        data["version"] = int(data.get("version") or STORE_VERSION)
    except Exception:
        data["version"] = STORE_VERSION
    if data["version"] < STORE_VERSION:
        data["version"] = STORE_VERSION
    return data


def _atomic_write(path: str, data: dict) -> None:
    _ensure_dir(path)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)
    try:
        shutil.copy2(path, _backup_path(path))
    except Exception:
        pass


def _normalize_username(value: str) -> str:
    return value.strip()


def _normalize_email(value: str) -> str:
    return value.strip().lower()


def _hash_password(password: str, salt_b64: Optional[str] = None) -> Tuple[str, str]:
    if salt_b64:
        salt = base64.b64decode(salt_b64.encode("utf-8"))
    else:
        salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return base64.b64encode(dk).decode("utf-8"), base64.b64encode(salt).decode("utf-8")


def _verify_password(password: str, stored_hash: str, stored_salt: str) -> bool:
    computed, _ = _hash_password(password, stored_salt)
    return secrets.compare_digest(computed, stored_hash)


def _clean_model_list(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, str):
        raw = [v.strip() for v in value.split(",")]
    elif isinstance(value, list):
        raw = [str(v).strip() for v in value]
    else:
        return []
    return [v for v in raw if v]


def _clean_quota_map(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    cleaned: dict[str, int] = {}
    for k, v in value.items():
        key = str(k).strip()
        if not key:
            continue
        try:
            num = int(v)
        except Exception:
            continue
        cleaned[key] = num
    return cleaned


def _clean_daily_usage_map(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict):
        return {}
    cleaned: dict[str, dict[str, Any]] = {}
    for k, v in value.items():
        key = str(k).strip()
        if not key or not isinstance(v, dict):
            continue
        day = str(v.get("date") or "").strip()
        try:
            count = int(v.get("count") or 0)
        except Exception:
            count = 0
        cleaned[key] = {"date": day, "count": max(count, 0)}
    return cleaned


def _model_lookup_keys(model_id: str) -> list[str]:
    value = str(model_id or "").strip()
    if not value:
        return []
    keys = [value]
    if ":" in value:
        suffix = value.split(":", 1)[1].strip()
        if suffix and suffix not in keys:
            keys.append(suffix)
    return keys


def _mask_api_key(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if len(raw) <= 8:
        return f"{raw[:2]}***{raw[-1:]}"
    return f"{raw[:4]}***{raw[-4:]}"


def _clean_provider_type(value: Any) -> str:
    provider_type = str(value or "").strip().lower()
    if provider_type in PROVIDER_TYPES:
        return provider_type
    return "openai_compat"


def _clean_websearch_tool_mode(value: Any) -> str:
    mode = str(value or "").strip().lower()
    if mode in WEBSEARCH_TOOL_MODES:
        return mode
    return "auto"


def _clean_model_prefix(value: Any, fallback: str = "openai") -> str:
    raw = str(value or "").strip().lower()
    cleaned = "".join(ch for ch in raw if ch.isalnum() or ch in {"_", "-"})
    if cleaned:
        return cleaned
    fallback_clean = "".join(
        ch for ch in str(fallback or "openai").strip().lower() if ch.isalnum() or ch in {"_", "-"}
    )
    return fallback_clean or "openai"


def _clean_exposed_models(value: Any) -> list[str]:
    models = _clean_model_list(value)
    seen: set[str] = set()
    result: list[str] = []
    for mid in models:
        if mid in seen:
            continue
        seen.add(mid)
        result.append(mid)
    return result


def _safe_provider_view(provider: dict) -> dict:
    return {
        "id": provider.get("id"),
        "name": provider.get("name"),
        "type": provider.get("type"),
        "base_url": provider.get("base_url"),
        "model_prefix": provider.get("model_prefix"),
        "priority": int(provider.get("priority") or 100),
        "enabled": bool(provider.get("enabled", True)),
        "websearch_tool_mode": provider.get("websearch_tool_mode") or "auto",
        "exposed_models": _clean_exposed_models(provider.get("exposed_models")),
        "api_key_hint": provider.get("api_key_hint") or "",
        "has_api_key": bool(provider.get("api_key_cipher")),
        "created_at": provider.get("created_at"),
        "updated_at": provider.get("updated_at"),
    }


def _clean_provider_payload(payload: dict, *, existing: Optional[dict] = None) -> dict:
    now = _now_iso()
    base = dict(existing or {})
    provider_type = _clean_provider_type(payload.get("type") if "type" in payload else base.get("type"))
    if provider_type == "qwen_responses":
        default_prefix = "qwen"
    elif provider_type == "dashscope":
        default_prefix = "dashscope"
    else:
        default_prefix = "openai"
    provider_id = str(payload.get("id") or base.get("id") or uuid.uuid4()).strip()
    model_prefix = _clean_model_prefix(
        payload.get("model_prefix") if "model_prefix" in payload else base.get("model_prefix"),
        fallback=default_prefix,
    )
    base_url = str(payload.get("base_url") if "base_url" in payload else base.get("base_url") or "").strip()
    name = str(payload.get("name") if "name" in payload else base.get("name") or "").strip()
    if not name:
        name = provider_id
    priority_raw = payload.get("priority") if "priority" in payload else base.get("priority", 100)
    try:
        priority = int(priority_raw)
    except Exception:
        priority = 100
    enabled = bool(payload.get("enabled")) if "enabled" in payload else bool(base.get("enabled", True))
    tool_mode = _clean_websearch_tool_mode(
        payload.get("websearch_tool_mode")
        if "websearch_tool_mode" in payload
        else base.get("websearch_tool_mode")
    )
    exposed_models = (
        _clean_exposed_models(payload.get("exposed_models"))
        if "exposed_models" in payload
        else _clean_exposed_models(base.get("exposed_models"))
    )
    api_key_cipher = (
        str(payload.get("api_key_cipher") or "").strip()
        if "api_key_cipher" in payload
        else str(base.get("api_key_cipher") or "").strip()
    )
    api_key_hint = (
        str(payload.get("api_key_hint") or "").strip()
        if "api_key_hint" in payload
        else str(base.get("api_key_hint") or "").strip()
    )
    created_at = str(base.get("created_at") or now)
    return {
        "id": provider_id,
        "name": name,
        "type": provider_type,
        "base_url": base_url,
        "model_prefix": model_prefix,
        "priority": priority,
        "enabled": enabled,
        "websearch_tool_mode": tool_mode,
        "exposed_models": exposed_models,
        "api_key_cipher": api_key_cipher,
        "api_key_hint": api_key_hint,
        "created_at": created_at,
        "updated_at": now,
    }


def _merge_policy(base: dict, override: dict) -> dict:
    merged = {
        "allow_user_adjust": base.get("allow_user_adjust", True),
        "defaults": dict(base.get("defaults") or {}),
        "ranges": dict(base.get("ranges") or {}),
    }
    if isinstance(override, dict):
        if "allow_user_adjust" in override:
            merged["allow_user_adjust"] = bool(override.get("allow_user_adjust"))
        defaults = override.get("defaults")
        if isinstance(defaults, dict):
            merged["defaults"].update(defaults)
        ranges = override.get("ranges")
        if isinstance(ranges, dict):
            merged["ranges"].update(ranges)
    return merged


def _safe_user_view(user: dict) -> dict:
    return {
        "id": user.get("id"),
        "username": user.get("username"),
        "email": user.get("email"),
        "group_id": user.get("group_id"),
        "display_name": user.get("display_name"),
        "avatar_url": user.get("avatar_url"),
        "is_admin": bool(user.get("is_admin")),
        "overrides": user.get("overrides") or {},
        "usage": user.get("usage") or {},
        "usage_daily": user.get("usage_daily") or {},
        "created_at": user.get("created_at"),
    }


def _get_effective_permissions_unlocked(data: dict, user_id: str) -> dict:
    user = data["users"].get(user_id)
    if not user:
        raise ValueError("User not found")
    group_id = user.get("group_id") or "default"
    group = data["groups"].get(group_id)
    if not group:
        group = next(iter(data["groups"].values()), {})

    overrides = user.get("overrides") or {}
    allowed_models = overrides.get("allowed_models") or group.get("allowed_models") or []
    allowed_models = _clean_model_list(allowed_models)

    model_quotas = {}
    model_quotas.update(group.get("model_quotas") or {})
    model_quotas.update(overrides.get("model_quotas") or {})
    model_quotas = _clean_quota_map(model_quotas)

    model_daily_quotas = {}
    model_daily_quotas.update(group.get("model_daily_quotas") or {})
    model_daily_quotas.update(overrides.get("model_daily_quotas") or {})
    model_daily_quotas = _clean_quota_map(model_daily_quotas)

    openalex_policy = _merge_policy(
        group.get("openalex") or {}, overrides.get("openalex") or {}
    )
    websearch_policy = _merge_policy(
        group.get("websearch") or {}, overrides.get("websearch") or {}
    )
    deep_research_policy = _merge_policy(
        group.get("deep_research") or {},
        overrides.get("deep_research") or {},
    )

    usage = _clean_quota_map(user.get("usage") or {})
    usage_daily_raw = _clean_daily_usage_map(user.get("usage_daily") or {})
    today = _today_utc()
    usage_daily: dict[str, int] = {}
    for model_id, daily in usage_daily_raw.items():
        if daily.get("date") == today:
            usage_daily[model_id] = max(int(daily.get("count") or 0), 0)

    remaining: dict[str, Optional[int]] = {}
    for model_id, quota in model_quotas.items():
        if quota is None or int(quota) < 0:
            remaining[model_id] = None
        else:
            remaining[model_id] = max(int(quota) - usage.get(model_id, 0), 0)

    remaining_daily: dict[str, Optional[int]] = {}
    for model_id, quota in model_daily_quotas.items():
        if quota is None or int(quota) < 0:
            remaining_daily[model_id] = None
        else:
            remaining_daily[model_id] = max(int(quota) - usage_daily.get(model_id, 0), 0)

    return {
        "user_id": user_id,
        "group": group,
        "allowed_models": allowed_models,
        "model_quotas": model_quotas,
        "model_daily_quotas": model_daily_quotas,
        "usage": usage,
        "usage_daily": usage_daily,
        "remaining": remaining,
        "remaining_daily": remaining_daily,
        "settings_policy": {
            "openalex": openalex_policy,
            "websearch": websearch_policy,
            "deep_research": deep_research_policy,
        },
    }


async def ensure_store(
    default_groups: list[dict],
    *,
    default_group_id: str = "guest",
    path: str = DEFAULT_STORE_PATH,
) -> dict:
    async with _LOCK:
        data = _read_store_unlocked(path)
        changed = False

        groups = data.get("groups") or {}
        if not groups:
            for group in default_groups:
                group_id = str(group.get("id") or "").strip()
                if not group_id:
                    continue
                groups[group_id] = group
            data["groups"] = groups
            changed = True
        else:
            for group in default_groups:
                group_id = str(group.get("id") or "").strip()
                if not group_id:
                    continue
                if group_id not in groups:
                    groups[group_id] = group
                    changed = True
                    continue
                existing_group = groups.get(group_id) or {}
                for policy_key in ("openalex", "websearch", "deep_research"):
                    if policy_key in existing_group and isinstance(
                        existing_group.get(policy_key), dict
                    ):
                        continue
                    default_policy = group.get(policy_key)
                    if isinstance(default_policy, dict):
                        existing_group[policy_key] = default_policy
                        changed = True
                groups[group_id] = existing_group

        if "default" in groups and "guest" in groups:
            for user in data.get("users", {}).values():
                if str(user.get("group_id") or "").strip() == "default":
                    user["group_id"] = "guest"
                    changed = True
            for invite in data.get("invites", {}).values():
                if str(invite.get("group_id") or "").strip() == "default":
                    invite["group_id"] = "guest"
                    changed = True
            has_default_ref = any(
                str(user.get("group_id") or "").strip() == "default"
                for user in data.get("users", {}).values()
            ) or any(
                str(invite.get("group_id") or "").strip() == "default"
                for invite in data.get("invites", {}).values()
            )
            if not has_default_ref:
                groups.pop("default", None)
                changed = True

        if "admin" in groups:
            for user in data.get("users", {}).values():
                if not bool(user.get("is_admin")):
                    continue
                group_id = str(user.get("group_id") or "").strip()
                if group_id in {"", "default", "guest"}:
                    user["group_id"] = "admin"
                    changed = True

        fallback_group_id = default_group_id
        if fallback_group_id not in groups:
            fallback_group_id = next(iter(groups.keys()), "")
        if fallback_group_id:
            for user in data.get("users", {}).values():
                user_group_id = str(user.get("group_id") or "").strip()
                if not user_group_id or user_group_id not in groups:
                    user["group_id"] = fallback_group_id
                    changed = True

        if changed:
            _atomic_write(path, data)
        return data


async def create_user(
    username: str,
    password: str,
    *,
    email: Optional[str] = None,
    invite_code: Optional[str] = None,
    default_group_id: str = "guest",
    path: str = DEFAULT_STORE_PATH,
) -> dict:
    async with _LOCK:
        data = _read_store_unlocked(path)
        username_norm = _normalize_username(username)
        if not username_norm:
            raise ValueError("Username is required")
        email_norm = _normalize_email(email) if email else ""

        for user in data["users"].values():
            if user.get("username_lower") == username_norm.lower():
                raise ValueError("Username already exists")
            if email_norm and user.get("email_lower") == email_norm:
                raise ValueError("Email already exists")

        group_id = default_group_id
        if invite_code:
            invite = data["invites"].get(invite_code)
            if not invite or invite.get("used"):
                raise ValueError("Invalid invite code")
            group_id = invite.get("group_id") or default_group_id
        if group_id not in data["groups"]:
            if default_group_id in data["groups"]:
                group_id = default_group_id
            else:
                group_id = next(iter(data["groups"].keys()), "")

        is_first_user = len(data["users"]) == 0
        if is_first_user and "admin" in data["groups"]:
            group_id = "admin"
        user_id = str(uuid.uuid4())
        password_hash, password_salt = _hash_password(password)

        user = {
            "id": user_id,
            "username": username_norm,
            "username_lower": username_norm.lower(),
            "email": email_norm or "",
            "email_lower": email_norm or "",
            "password_hash": password_hash,
            "password_salt": password_salt,
            "created_at": _now_iso(),
            "is_admin": bool(is_first_user),
            "group_id": group_id,
            "display_name": username_norm,
            "avatar_url": "",
            "overrides": {},
            "usage": {},
            "usage_daily": {},
        }
        data["users"][user_id] = user

        if invite_code:
            invite = data["invites"].get(invite_code)
            if invite:
                invite["used"] = True
                invite["used_by"] = user_id
                invite["used_at"] = _now_iso()
                data["invites"][invite_code] = invite

        _atomic_write(path, data)
        return _safe_user_view(user)


async def authenticate(
    login: str, password: str, path: str = DEFAULT_STORE_PATH
) -> Optional[dict]:
    async with _LOCK:
        data = _read_store_unlocked(path)
        login_norm = (login or "").strip().lower()
        if not login_norm:
            return None
        user_match = None
        for user in data["users"].values():
            if user.get("username_lower") == login_norm:
                user_match = user
                break
        if not user_match:
            for user in data["users"].values():
                if user.get("email_lower") == login_norm and login_norm:
                    user_match = user
                    break
        if not user_match:
            return None
        if not _verify_password(
            password, user_match.get("password_hash", ""), user_match.get("password_salt", "")
        ):
            return None
        return _safe_user_view(user_match)


async def list_users(path: str = DEFAULT_STORE_PATH) -> list[dict]:
    async with _LOCK:
        data = _read_store_unlocked(path)
    return [_safe_user_view(u) for u in data["users"].values()]


async def get_user(user_id: str, path: str = DEFAULT_STORE_PATH) -> Optional[dict]:
    async with _LOCK:
        data = _read_store_unlocked(path)
        user = data["users"].get(user_id)
        if not user:
            return None
        return _safe_user_view(user)


async def resolve_user_id(identifier: str, path: str = DEFAULT_STORE_PATH) -> Optional[str]:
    ident = str(identifier or "").strip()
    if not ident:
        return None
    ident_lower = ident.lower()
    async with _LOCK:
        data = _read_store_unlocked(path)
        if ident in data["users"]:
            return ident
        for user_id, user in data["users"].items():
            if user.get("username_lower") == ident_lower:
                return user_id
            if ident_lower and user.get("email_lower") == ident_lower:
                return user_id
    return None


async def update_user(
    user_id: str, patch: dict, path: str = DEFAULT_STORE_PATH
) -> dict:
    async with _LOCK:
        data = _read_store_unlocked(path)
        user = data["users"].get(user_id)
        if not user:
            raise ValueError("User not found")

        if "display_name" in patch:
            user["display_name"] = str(patch.get("display_name") or "").strip()
        if "avatar_url" in patch:
            user["avatar_url"] = str(patch.get("avatar_url") or "").strip()
        if "group_id" in patch:
            group_id = str(patch.get("group_id") or "").strip()
            if group_id and group_id in data["groups"]:
                user["group_id"] = group_id
        if "is_admin" in patch:
            user["is_admin"] = bool(patch.get("is_admin"))

        overrides = user.get("overrides") or {}
        if "allowed_models" in patch:
            overrides["allowed_models"] = _clean_model_list(patch.get("allowed_models"))
        if "model_quotas" in patch:
            overrides["model_quotas"] = _clean_quota_map(patch.get("model_quotas"))
        if "model_daily_quotas" in patch:
            overrides["model_daily_quotas"] = _clean_quota_map(
                patch.get("model_daily_quotas")
            )
        if "openalex" in patch and isinstance(patch.get("openalex"), dict):
            overrides["openalex"] = patch.get("openalex")
        if "websearch" in patch and isinstance(patch.get("websearch"), dict):
            overrides["websearch"] = patch.get("websearch")
        if "deep_research" in patch and isinstance(patch.get("deep_research"), dict):
            overrides["deep_research"] = patch.get("deep_research")
        if "usage" in patch and isinstance(patch.get("usage"), dict):
            user["usage"] = _clean_quota_map(patch.get("usage"))
        if "usage_daily" in patch and isinstance(patch.get("usage_daily"), dict):
            user["usage_daily"] = _clean_daily_usage_map(patch.get("usage_daily"))
        user["overrides"] = overrides

        data["users"][user_id] = user
        _atomic_write(path, data)
        return _safe_user_view(user)


async def delete_user(user_id: str, path: str = DEFAULT_STORE_PATH) -> dict:
    async with _LOCK:
        data = _read_store_unlocked(path)
        user = data["users"].get(user_id)
        if not user:
            raise ValueError("User not found")

        if bool(user.get("is_admin")):
            admin_count = sum(
                1 for item in data["users"].values() if bool(item.get("is_admin"))
            )
            if admin_count <= 1:
                raise ValueError("Cannot delete the last admin user")

        deleted = _safe_user_view(user)
        data["users"].pop(user_id, None)
        _atomic_write(path, data)
        return deleted


async def list_groups(path: str = DEFAULT_STORE_PATH) -> list[dict]:
    async with _LOCK:
        data = _read_store_unlocked(path)
        return list(data["groups"].values())


async def create_group(payload: dict, path: str = DEFAULT_STORE_PATH) -> dict:
    async with _LOCK:
        data = _read_store_unlocked(path)
        group_id = str(payload.get("id") or uuid.uuid4())
        if group_id in data["groups"]:
            raise ValueError("Group already exists")
        group = {
            "id": group_id,
            "name": str(payload.get("name") or group_id),
            "allowed_models": _clean_model_list(payload.get("allowed_models")),
            "model_quotas": _clean_quota_map(payload.get("model_quotas")),
            "model_daily_quotas": _clean_quota_map(payload.get("model_daily_quotas")),
            "openalex": payload.get("openalex") or {},
            "websearch": payload.get("websearch") or {},
            "deep_research": payload.get("deep_research") or {},
            "created_at": _now_iso(),
        }
        data["groups"][group_id] = group
        _atomic_write(path, data)
        return group


async def update_group(
    group_id: str, patch: dict, path: str = DEFAULT_STORE_PATH
) -> dict:
    async with _LOCK:
        data = _read_store_unlocked(path)
        group = data["groups"].get(group_id)
        if not group:
            raise ValueError("Group not found")
        if "name" in patch:
            group["name"] = str(patch.get("name") or group_id)
        if "allowed_models" in patch:
            group["allowed_models"] = _clean_model_list(patch.get("allowed_models"))
        if "model_quotas" in patch:
            group["model_quotas"] = _clean_quota_map(patch.get("model_quotas"))
        if "model_daily_quotas" in patch:
            group["model_daily_quotas"] = _clean_quota_map(patch.get("model_daily_quotas"))
        if "openalex" in patch and isinstance(patch.get("openalex"), dict):
            group["openalex"] = patch.get("openalex")
        if "websearch" in patch and isinstance(patch.get("websearch"), dict):
            group["websearch"] = patch.get("websearch")
        if "deep_research" in patch and isinstance(patch.get("deep_research"), dict):
            group["deep_research"] = patch.get("deep_research")
        data["groups"][group_id] = group
        _atomic_write(path, data)
        return group


async def get_auth_status(path: str = DEFAULT_STORE_PATH) -> dict[str, Any]:
    async with _LOCK:
        data = _read_store_unlocked(path)
        users = data.get("users") or {}
        user_count = len(users)
        admin_count = sum(1 for item in users.values() if bool(item.get("is_admin")))
        return {
            "user_count": user_count,
            "admin_count": admin_count,
            "has_users": user_count > 0,
            "bootstrap_required": user_count == 0,
        }


async def delete_group(
    group_id: str,
    *,
    fallback_group_id: str = "guest",
    path: str = DEFAULT_STORE_PATH,
) -> dict:
    async with _LOCK:
        data = _read_store_unlocked(path)
        groups = data.get("groups") or {}
        if group_id not in groups:
            raise ValueError("Group not found")
        if group_id in {"admin", "guest"}:
            raise ValueError("Default groups cannot be deleted")

        fallback = str(fallback_group_id or "").strip()
        if not fallback or fallback == group_id or fallback not in groups:
            fallback = ""
            for candidate in groups.keys():
                if candidate != group_id:
                    fallback = candidate
                    break
        if not fallback:
            raise ValueError("No fallback group available")

        deleted = dict(groups.get(group_id) or {})

        for user in data.get("users", {}).values():
            if str(user.get("group_id") or "").strip() == group_id:
                user["group_id"] = fallback

        for invite in data.get("invites", {}).values():
            if str(invite.get("group_id") or "").strip() == group_id:
                invite["group_id"] = fallback

        groups.pop(group_id, None)
        data["groups"] = groups
        _atomic_write(path, data)

        return {
            "deleted_group": deleted,
            "deleted_group_id": group_id,
            "fallback_group_id": fallback,
        }


def _list_providers_unlocked(
    data: dict, *, include_sensitive: bool = False
) -> list[dict]:
    providers = data.get("providers") or {}
    records: list[dict] = []
    for raw in providers.values():
        if not isinstance(raw, dict):
            continue
        cleaned = _clean_provider_payload(raw, existing=raw)
        if include_sensitive:
            records.append(cleaned)
        else:
            records.append(_safe_provider_view(cleaned))
    records.sort(key=lambda item: (int(item.get("priority") or 100), str(item.get("id") or "")))
    return records


async def list_providers(
    path: str = DEFAULT_STORE_PATH, *, include_sensitive: bool = False
) -> list[dict]:
    async with _LOCK:
        data = _read_store_unlocked(path)
        return _list_providers_unlocked(data, include_sensitive=include_sensitive)


async def get_provider(
    provider_id: str,
    path: str = DEFAULT_STORE_PATH,
    *,
    include_sensitive: bool = False,
) -> Optional[dict]:
    pid = str(provider_id or "").strip()
    if not pid:
        return None
    async with _LOCK:
        data = _read_store_unlocked(path)
        raw = (data.get("providers") or {}).get(pid)
        if not isinstance(raw, dict):
            return None
        cleaned = _clean_provider_payload(raw, existing=raw)
        return cleaned if include_sensitive else _safe_provider_view(cleaned)


async def create_provider(payload: dict, path: str = DEFAULT_STORE_PATH) -> dict:
    async with _LOCK:
        data = _read_store_unlocked(path)
        providers = data.get("providers") or {}
        provider = _clean_provider_payload(payload or {})
        provider_id = str(provider.get("id") or "").strip()
        if not provider_id:
            raise ValueError("Provider id is required")
        if provider_id in providers:
            raise ValueError("Provider already exists")
        for existing in providers.values():
            if not isinstance(existing, dict):
                continue
            existing_prefix = _clean_model_prefix(existing.get("model_prefix") or "")
            if existing_prefix and existing_prefix == provider.get("model_prefix"):
                raise ValueError("Model prefix already exists")
        providers[provider_id] = provider
        data["providers"] = providers
        _atomic_write(path, data)
        return _safe_provider_view(provider)


async def upsert_provider(payload: dict, path: str = DEFAULT_STORE_PATH) -> dict:
    async with _LOCK:
        data = _read_store_unlocked(path)
        providers = data.get("providers") or {}
        candidate = _clean_provider_payload(payload or {})
        provider_id = str(candidate.get("id") or "").strip()
        if not provider_id:
            raise ValueError("Provider id is required")
        existing = providers.get(provider_id)
        provider = _clean_provider_payload(payload or {}, existing=existing if isinstance(existing, dict) else None)
        providers[provider_id] = provider
        data["providers"] = providers
        _atomic_write(path, data)
        return _safe_provider_view(provider)


async def update_provider(
    provider_id: str, patch: dict, path: str = DEFAULT_STORE_PATH
) -> dict:
    pid = str(provider_id or "").strip()
    if not pid:
        raise ValueError("Provider id is required")
    async with _LOCK:
        data = _read_store_unlocked(path)
        providers = data.get("providers") or {}
        existing = providers.get(pid)
        if not isinstance(existing, dict):
            raise ValueError("Provider not found")
        provider = _clean_provider_payload(patch or {}, existing=existing)
        provider["id"] = pid
        next_prefix = _clean_model_prefix(provider.get("model_prefix") or "")
        for other_id, other in providers.items():
            if other_id == pid or not isinstance(other, dict):
                continue
            other_prefix = _clean_model_prefix(other.get("model_prefix") or "")
            if next_prefix and other_prefix == next_prefix:
                raise ValueError("Model prefix already exists")
        providers[pid] = provider
        data["providers"] = providers
        _atomic_write(path, data)
        return _safe_provider_view(provider)


async def delete_provider(provider_id: str, path: str = DEFAULT_STORE_PATH) -> dict:
    pid = str(provider_id or "").strip()
    if not pid:
        raise ValueError("Provider id is required")
    async with _LOCK:
        data = _read_store_unlocked(path)
        providers = data.get("providers") or {}
        existing = providers.get(pid)
        if not isinstance(existing, dict):
            raise ValueError("Provider not found")
        deleted = _safe_provider_view(_clean_provider_payload(existing, existing=existing))
        providers.pop(pid, None)
        data["providers"] = providers
        _atomic_write(path, data)
        return deleted


async def get_meta(path: str = DEFAULT_STORE_PATH) -> dict:
    async with _LOCK:
        data = _read_store_unlocked(path)
        meta = data.get("meta")
        return dict(meta) if isinstance(meta, dict) else {}


async def update_meta(patch: dict, path: str = DEFAULT_STORE_PATH) -> dict:
    if not isinstance(patch, dict):
        return await get_meta(path=path)
    async with _LOCK:
        data = _read_store_unlocked(path)
        meta = data.get("meta")
        if not isinstance(meta, dict):
            meta = {}
        for key, value in patch.items():
            k = str(key or "").strip()
            if not k:
                continue
            if value is None:
                meta.pop(k, None)
            else:
                meta[k] = value
        data["meta"] = meta
        _atomic_write(path, data)
        return dict(meta)


async def list_invites(path: str = DEFAULT_STORE_PATH) -> list[dict]:
    async with _LOCK:
        data = _read_store_unlocked(path)
        return list(data["invites"].values())


async def create_invite(
    group_id: str, path: str = DEFAULT_STORE_PATH
) -> dict:
    async with _LOCK:
        data = _read_store_unlocked(path)
        if group_id not in data["groups"]:
            raise ValueError("Group not found")
        code = secrets.token_urlsafe(8)
        invite = {
            "code": code,
            "group_id": group_id,
            "created_at": _now_iso(),
            "used": False,
            "used_by": "",
            "used_at": "",
        }
        data["invites"][code] = invite
        _atomic_write(path, data)
        return invite


async def delete_invite(code: str, path: str = DEFAULT_STORE_PATH) -> None:
    async with _LOCK:
        data = _read_store_unlocked(path)
        if code in data["invites"]:
            data["invites"].pop(code, None)
            _atomic_write(path, data)


async def get_effective_permissions(
    user_id: str, path: str = DEFAULT_STORE_PATH
) -> dict:
    async with _LOCK:
        data = _read_store_unlocked(path)
        return _get_effective_permissions_unlocked(data, user_id)


async def consume_quota(
    user_id: str, model_id: str, amount: int = 1, path: str = DEFAULT_STORE_PATH
) -> Tuple[bool, Optional[int]]:
    async with _LOCK:
        data = _read_store_unlocked(path)
        user = data["users"].get(user_id)
        if not user:
            return False, None
        perms = _get_effective_permissions_unlocked(data, user_id)
        quotas = _clean_quota_map(perms.get("model_quotas") or {})
        daily_quotas = _clean_quota_map(perms.get("model_daily_quotas") or {})
        lookup_keys = _model_lookup_keys(model_id)

        def pick_limit_key(source: dict[str, int]) -> tuple[str, Optional[int]]:
            for key in lookup_keys:
                if key in source:
                    return key, source.get(key)
            return model_id, None

        usage = _clean_quota_map(user.get("usage") or {})
        total_limit_key, total_limit = pick_limit_key(quotas)
        total_remaining: Optional[int] = None
        if total_limit is not None:
            try:
                total_limit_val = int(total_limit)
            except Exception:
                total_limit_val = -1
            if total_limit_val >= 0:
                used_total = usage.get(total_limit_key, 0)
                if used_total + amount > total_limit_val:
                    return False, max(total_limit_val - used_total, 0)
                total_remaining = max(total_limit_val - (used_total + amount), 0)

        usage_daily = _clean_daily_usage_map(user.get("usage_daily") or {})
        today = _today_utc()
        daily_limit_key, daily_limit = pick_limit_key(daily_quotas)
        daily_entry = usage_daily.get(daily_limit_key) or {"date": today, "count": 0}
        if daily_entry.get("date") != today:
            daily_entry = {"date": today, "count": 0}

        daily_remaining: Optional[int] = None
        if daily_limit is not None:
            try:
                daily_limit_val = int(daily_limit)
            except Exception:
                daily_limit_val = -1
            if daily_limit_val >= 0:
                used_daily = int(daily_entry.get("count") or 0)
                if used_daily + amount > daily_limit_val:
                    return False, max(daily_limit_val - used_daily, 0)
                daily_remaining = max(daily_limit_val - (used_daily + amount), 0)

        usage_key = total_limit_key if total_limit is not None else model_id
        daily_key = daily_limit_key if daily_limit is not None else usage_key
        usage[usage_key] = usage.get(usage_key, 0) + amount
        daily_entry["date"] = today
        daily_entry["count"] = int(daily_entry.get("count") or 0) + amount
        usage_daily[daily_key] = daily_entry

        user["usage"] = usage
        user["usage_daily"] = usage_daily
        data["users"][user_id] = user
        _atomic_write(path, data)

        if total_remaining is None and daily_remaining is None:
            return True, None
        remaining_values = [
            v for v in [total_remaining, daily_remaining] if isinstance(v, int)
        ]
        if not remaining_values:
            return True, None
        return True, min(remaining_values)
