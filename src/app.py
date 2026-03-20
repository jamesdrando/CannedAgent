from __future__ import annotations

import asyncio
import ast
import json
import os
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from src.auth import (
    PRIMARY_ADMIN_EMAIL,
    SESSION_COOKIE_NAME,
    authenticate_user,
    clear_session_cookie,
    client_ip,
    create_session_record,
    get_user_for_session_token,
    hash_password,
    is_primary_admin,
    normalize_email,
    normalize_username,
    require_user,
    revoke_session,
    seed_admin_user,
    set_session_cookie,
    sync_primary_admin,
)
from src.db import engine, get_db_session, init_db
from src.internal.providers import (
    ConversationMessage,
    ProviderRegistry,
    ProviderMessage,
    ProviderUsage,
    RunSettings,
    RunSettingsPatch,
    ToolCall,
    ToolResult,
)
from src.internal.tools import browser_tool_definitions
from src.models import Chat, ChatSettings, Message, SessionRecord, UsageEvent, User, UserPreference, utcnow


DEV_CORS_ORIGINS = {
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
}

STATIC_DIR = Path(__file__).resolve().parent / "static"
PAGES_DIR = Path(__file__).resolve().parent / "pages"
LOGIN_PAGE = PAGES_DIR / "login.html"
APP_PAGE = PAGES_DIR / "index.html"
ADMIN_PAGE = PAGES_DIR / "admin.html"

provider_registry = ProviderRegistry()
db_session_dep = Annotated[Session, Depends(get_db_session)]
login_attempts: dict[str, deque[float]] = defaultdict(deque)
active_runs: dict[str, "ActiveRun"] = {}
MAX_TOOL_ITERATIONS = 10


@dataclass
class ActiveRun:
    id: str
    user_id: str
    chat_id: str
    pending_tool_call_ids: set[str] = field(default_factory=set)
    tool_result_queue: asyncio.Queue[list[ToolResult]] = field(default_factory=asyncio.Queue)
    created_at: float = field(default_factory=time.time)


def should_seed_default_admin() -> bool:
    return os.getenv("SEED_DEFAULT_ADMIN", "1").strip().lower() not in {"0", "false", "no"}


def is_production() -> bool:
    return os.getenv("APP_ENV", "development").strip().lower() == "production"


def cors_origins() -> list[str]:
    origins: set[str] = set()
    app_origin = os.getenv("APP_ORIGIN", "").strip()

    if app_origin:
        origins.add(app_origin.rstrip("/"))

    if not is_production():
        origins.update(DEV_CORS_ORIGINS)

    return sorted(origins)


def trusted_hosts() -> list[str]:
    configured = os.getenv("TRUSTED_HOSTS", "").strip()
    if configured:
        return [host.strip() for host in configured.split(",") if host.strip()]
    if is_production():
        app_origin = os.getenv("APP_ORIGIN", "").strip()
        if app_origin:
            return [app_origin.split("://", 1)[-1].rstrip("/")]
    return ["127.0.0.1", "localhost", "127.0.0.1:8000", "localhost:8000"]


def login_rate_limit_window_seconds() -> int:
    return max(1, int(os.getenv("LOGIN_RATE_LIMIT_WINDOW_SECONDS", "300")))


def login_rate_limit_max_attempts() -> int:
    return max(1, int(os.getenv("LOGIN_RATE_LIMIT_MAX_ATTEMPTS", "8")))


def enforce_login_rate_limit(ip_address: str) -> None:
    now = time.time()
    window_seconds = login_rate_limit_window_seconds()
    attempts = login_attempts[ip_address]
    while attempts and attempts[0] <= now - window_seconds:
        attempts.popleft()
    if len(attempts) >= login_rate_limit_max_attempts():
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many login attempts. Please wait a few minutes and try again.",
        )


def register_login_attempt(ip_address: str, *, succeeded: bool) -> None:
    if succeeded:
        login_attempts.pop(ip_address, None)
        return

    now = time.time()
    attempts = login_attempts[ip_address]
    attempts.append(now)
    window_seconds = login_rate_limit_window_seconds()
    while attempts and attempts[0] <= now - window_seconds:
        attempts.popleft()


def chat_title_from_content(content: str) -> str:
    normalized = " ".join(content.strip().split())
    if not normalized:
        return "New chat"
    if len(normalized) <= 60:
        return normalized
    return f"{normalized[:57].rstrip()}..."


def sanitize_generated_title(value: str) -> str:
    normalized = " ".join(value.replace("\n", " ").split()).strip().strip('"').strip("'")
    if not normalized:
        return "New chat"
    return normalized[:120]


def provider_history_from_messages(messages: list[Message]) -> list[ProviderMessage]:
    return [ProviderMessage(role=message.role, content=message.content) for message in messages]


def json_line(payload: dict[str, Any]) -> bytes:
    return f"{json.dumps(payload, separators=(',', ':'))}\n".encode("utf-8")


def run_event(run_id: str, event_type: str, **payload: Any) -> bytes:
    return json_line({"type": event_type, "run_id": run_id, **payload})


def iter_text_chunks(text: str, *, target_size: int = 96) -> list[str]:
    if not text:
        return []
    words = text.split(" ")
    chunks: list[str] = []
    current = ""
    for word in words:
        if not current:
            current = word
            continue
        candidate = f"{current} {word}"
        if len(candidate) <= target_size:
            current = candidate
            continue
        chunks.append(f"{current} ")
        current = word
    if current:
        chunks.append(current)
    return chunks


def tool_content_for_model(result: ToolResult) -> str:
    payload = {
        "tool_name": result.name,
        "summary_for_model": result.summary_for_model,
        "output": result.output,
    }
    return json.dumps(payload, ensure_ascii=True)


def browser_tool_usage_guidance() -> str:
    return (
        "Browser-local files from the workspace are available for this run only when they are included in the current manifest. "
        "They are not stored on the Jobbr website and should be accessed via the available tools.\n"
        "If you need file inspection or analysis, use the provider's native tool/function calling mechanism.\n"
        "In python.execute, pd, np, math, statistics, files, list_files(), file_info(), "
        "read_table(file_id_or_name), and read_text(file_id_or_name) are already available, so imports are optional.\n"
        "When files.list returns a reference_name, prefer that friendly reference over long opaque ids.\n"
        "Prefer the minimum number of tool calls needed. If a tool result already answers the user's question, "
        "respond directly instead of calling more tools.\n"
        "Do not print tool invocations as plain text, JSON blobs, XML, or wrappers such as TOOLCALL>...ALL>.\n"
        "Either answer normally, or request one of the available tools directly."
    )


def tool_call_signature(tool_call: ToolCall) -> str:
    serialized_arguments = json.dumps(tool_call.arguments, sort_keys=True, default=str)
    return f"{tool_call.name}:{serialized_arguments}"


def parse_inline_tool_calls(text: str) -> list[dict[str, Any]]:
    marker = "TOOLCALL>"
    if marker not in text:
        return []

    payload = text.split(marker, 1)[1]
    for terminator in ("ALL>", "<ALL>", "</TOOLCALL>", "ENDTOOLCALL>"):
        if terminator in payload:
            payload = payload.split(terminator, 1)[0]
            break

    normalized = (
        payload.strip()
        .replace("“", '"')
        .replace("”", '"')
        .replace("’", "'")
        .replace("‘", "'")
    )
    if not normalized:
        return []

    parsed: Any
    try:
        parsed = json.loads(normalized)
    except json.JSONDecodeError:
        try:
            parsed = ast.literal_eval(normalized)
        except (SyntaxError, ValueError):
            return []

    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list):
        return []

    tool_calls: list[dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        arguments = item.get("arguments")
        if not name or not isinstance(arguments, dict):
            continue
        tool_calls.append(
            {
                "id": str(item.get("id") or uuid4().hex),
                "name": name,
                "arguments": arguments,
            }
        )
    return tool_calls


async def generate_chat_title(
    *,
    settings: RunSettings,
    user_message: str,
    assistant_message: str,
) -> str:
    adapter = provider_registry.adapter_for(settings.provider)
    if adapter is None:
        return chat_title_from_content(user_message)

    generated = await adapter.generate_title(
        user_message=user_message,
        assistant_message=assistant_message,
        settings=settings,
    )
    return sanitize_generated_title(generated or "") or chat_title_from_content(user_message)


def message_to_conversation(message: Message) -> ConversationMessage:
    return ConversationMessage(role=message.role, content=message.content)


def get_chat_for_user(session: Session, user: User, chat_id: str) -> Chat:
    chat = session.exec(
        select(Chat).where(
            Chat.id == chat_id,
            Chat.user_id == user.id,
            Chat.archived_at.is_(None),
        )
    ).first()
    if chat is None:
        raise HTTPException(status_code=404, detail="Chat not found.")
    return chat


def list_messages_for_chat(session: Session, chat_id: str) -> list[Message]:
    return list(
        session.exec(
            select(Message)
            .where(Message.chat_id == chat_id)
            .order_by(Message.sequence)
        )
    )


def next_message_sequence(session: Session, chat_id: str) -> int:
    latest = session.exec(
        select(Message)
        .where(Message.chat_id == chat_id)
        .order_by(Message.sequence.desc())
    ).first()
    if latest is None:
        return 1
    return latest.sequence + 1


def build_chat_summary(session: Session, chat: Chat) -> dict:
    last_message = session.exec(
        select(Message)
        .where(Message.chat_id == chat.id)
        .order_by(Message.sequence.desc())
    ).first()
    return {
        "id": chat.id,
        "title": chat.title,
        "updated_at": chat.updated_at,
        "created_at": chat.created_at,
        "last_message_preview": (
            " ".join(last_message.content.strip().split())[:120] if last_message else None
        ),
    }


def settings_response(settings: RunSettings) -> dict:
    return settings.model_dump()


def user_preferences_statement(user: User):
    return select(UserPreference).where(UserPreference.user_id == user.id)


def chat_settings_statement(chat: Chat):
    return select(ChatSettings).where(ChatSettings.chat_id == chat.id)


def apply_settings_to_record(record: UserPreference | ChatSettings, settings: RunSettings) -> None:
    record.provider = settings.provider
    record.model = settings.model
    record.system_prompt = settings.system_prompt
    record.temperature = settings.temperature
    record.reasoning_effort = settings.reasoning_effort
    record.updated_at = utcnow()


def settings_from_record(record: UserPreference | ChatSettings | None) -> RunSettings:
    return provider_registry.normalize_settings(
        {
            "provider": record.provider if record else None,
            "model": record.model if record else None,
            "system_prompt": record.system_prompt if record else None,
            "temperature": record.temperature if record else None,
            "reasoning_effort": record.reasoning_effort if record else None,
        }
    )


def get_or_create_user_preference(session: Session, user: User) -> UserPreference:
    preference = session.exec(user_preferences_statement(user)).first()
    if preference is not None:
        normalized = provider_registry.normalize_settings(settings_from_record(preference))
        apply_settings_to_record(preference, normalized)
        session.add(preference)
        session.commit()
        session.refresh(preference)
        return preference

    settings = provider_registry.normalize_settings()
    preference = UserPreference(
        user_id=user.id,
        provider=settings.provider,
        model=settings.model,
        system_prompt=settings.system_prompt,
        temperature=settings.temperature,
        reasoning_effort=settings.reasoning_effort,
    )
    session.add(preference)
    session.commit()
    session.refresh(preference)
    return preference


def resolve_user_settings(session: Session, user: User) -> RunSettings:
    return settings_from_record(get_or_create_user_preference(session, user))


def get_or_create_chat_settings(session: Session, user: User, chat: Chat) -> ChatSettings:
    settings_record = session.exec(chat_settings_statement(chat)).first()
    if settings_record is not None:
        normalized = provider_registry.normalize_settings(settings_from_record(settings_record))
        apply_settings_to_record(settings_record, normalized)
        session.add(settings_record)
        session.commit()
        session.refresh(settings_record)
        return settings_record

    default_settings = resolve_user_settings(session, user)
    settings_record = ChatSettings(
        chat_id=chat.id,
        provider=default_settings.provider,
        model=default_settings.model,
        system_prompt=default_settings.system_prompt,
        temperature=default_settings.temperature,
        reasoning_effort=default_settings.reasoning_effort,
    )
    session.add(settings_record)
    session.commit()
    session.refresh(settings_record)
    return settings_record


def resolve_chat_settings(session: Session, user: User, chat: Chat) -> RunSettings:
    return settings_from_record(get_or_create_chat_settings(session, user, chat))


async def persist_assistant_reply(
    *,
    user: User,
    chat: Chat,
    current_message: str,
    assistant_text: str,
    settings: RunSettings,
) -> None:
    if not assistant_text:
        return

    with Session(engine) as write_session:
        persisted_chat = get_chat_for_user(write_session, user, chat.id)
        assistant_message = Message(
            chat_id=persisted_chat.id,
            role="assistant",
            content=assistant_text,
            sequence=next_message_sequence(write_session, persisted_chat.id),
        )
        persisted_chat.updated_at = utcnow()
        write_session.add(assistant_message)
        write_session.add(persisted_chat)
        write_session.commit()

        message_count = len(list_messages_for_chat(write_session, persisted_chat.id))
        if persisted_chat.title == "New chat" and message_count == 2:
            try:
                persisted_chat.title = await generate_chat_title(
                    settings=settings,
                    user_message=current_message,
                    assistant_message=assistant_text,
                )
            except Exception:
                persisted_chat.title = chat_title_from_content(current_message)
            persisted_chat.updated_at = utcnow()
            write_session.add(persisted_chat)
            write_session.commit()


def optional_page_user(request: Request, session: Session) -> User | None:
    return get_user_for_session_token(session, request.cookies.get(SESSION_COOKIE_NAME))


def current_user(request: Request, session: Session) -> User:
    return require_user(session, request.cookies.get(SESSION_COOKIE_NAME))


def current_admin_user(request: Request, session: Session) -> User:
    user = current_user(request, session)
    if not is_primary_admin(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required.")
    return user


def usage_summary_from_events(events: list[UsageEvent]) -> dict[str, Any]:
    prompt_tokens = sum(event.prompt_tokens for event in events)
    completion_tokens = sum(event.completion_tokens for event in events)
    total_tokens = sum(event.total_tokens for event in events)
    by_provider: dict[str, dict[str, Any]] = {}
    for event in events:
        bucket = by_provider.setdefault(
            event.provider,
            {
                "provider": event.provider,
                "request_count": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
            },
        )
        bucket["request_count"] += 1
        bucket["prompt_tokens"] += event.prompt_tokens
        bucket["completion_tokens"] += event.completion_tokens
        bucket["total_tokens"] += event.total_tokens

    return {
        "request_count": len(events),
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "providers": sorted(by_provider.values(), key=lambda item: item["total_tokens"], reverse=True),
    }


def record_usage_event(
    *,
    user_id: str,
    chat_id: str | None,
    run_id: str | None,
    request_kind: str,
    provider: str,
    model: str,
    usage: ProviderUsage | None,
) -> None:
    if usage is None:
        return
    with Session(engine) as write_session:
        write_session.add(
            UsageEvent(
                user_id=user_id,
                chat_id=chat_id,
                run_id=run_id,
                request_kind=request_kind,
                provider=provider,
                model=model,
                prompt_tokens=usage.prompt_tokens,
                completion_tokens=usage.completion_tokens,
                total_tokens=usage.total_tokens,
            )
        )
        write_session.commit()


class LoginPayload(BaseModel):
    identifier: str
    password: str


class ChatCreatePayload(BaseModel):
    title: str | None = None
    settings: RunSettingsPatch | None = None


class ChatRenamePayload(BaseModel):
    title: str


class MessageCreatePayload(BaseModel):
    content: str


class AttachmentManifestItem(BaseModel):
    id: str
    name: str
    reference_name: str | None = None
    mime_type: str
    size_bytes: int
    kind: str


class RunStartPayload(BaseModel):
    input: str
    attachment_manifest: list[AttachmentManifestItem] = Field(default_factory=list)
    config_override: RunSettingsPatch | None = None


class ToolResultPayload(BaseModel):
    results: list[ToolResult]


class AdminUserCreatePayload(BaseModel):
    username: str
    email: str
    password: str


app = FastAPI()

allowed_trusted_hosts = trusted_hosts()
if allowed_trusted_hosts:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_trusted_hosts)

allowed_cors_origins = cors_origins()
if allowed_cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    with Session(engine) as session:
        if should_seed_default_admin():
            seed_admin_user(session)
        sync_primary_admin(session)


@app.get("/")
def home(request: Request, session: db_session_dep):
    if optional_page_user(request, session):
        return RedirectResponse(url="/app", status_code=status.HTTP_303_SEE_OTHER)
    return RedirectResponse(url="/login", status_code=status.HTTP_303_SEE_OTHER)


@app.get("/login")
def login_page(request: Request, session: db_session_dep):
    if optional_page_user(request, session):
        return RedirectResponse(url="/app", status_code=status.HTTP_303_SEE_OTHER)
    return FileResponse(LOGIN_PAGE)


@app.get("/app")
def app_page(request: Request, session: db_session_dep):
    if optional_page_user(request, session) is None:
        return RedirectResponse(url="/login", status_code=status.HTTP_303_SEE_OTHER)
    return FileResponse(APP_PAGE)


@app.get("/admin")
def admin_page(request: Request, session: db_session_dep):
    if optional_page_user(request, session) is None:
        return RedirectResponse(url="/login", status_code=status.HTTP_303_SEE_OTHER)
    current_admin_user(request, session)
    return FileResponse(ADMIN_PAGE)


@app.get("/api/auth/me")
def auth_me(request: Request, session: db_session_dep):
    user = current_user(request, session)
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "is_admin": is_primary_admin(user),
        "created_at": user.created_at,
    }


@app.post("/api/auth/login")
def auth_login(
    payload: LoginPayload,
    request: Request,
    response: Response,
    session: db_session_dep,
):
    request_ip = client_ip(request) or "unknown"
    enforce_login_rate_limit(request_ip)
    user = authenticate_user(session, payload.identifier, payload.password)
    if user is None:
        register_login_attempt(request_ip, succeeded=False)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials.",
        )
    register_login_attempt(request_ip, succeeded=True)

    token, expires_at = create_session_record(
        session,
        user,
        user_agent=request.headers.get("user-agent"),
        ip_address=client_ip(request),
    )
    set_session_cookie(response, token, expires_at)
    return {
        "user": {
            "id": user.id,
            "username": user.username,
            "email": user.email,
            "is_admin": is_primary_admin(user),
        }
    }


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: Response, session: db_session_dep):
    revoke_session(session, request.cookies.get(SESSION_COOKIE_NAME))
    clear_session_cookie(response)
    return {"ok": True}


@app.get("/api/admin/overview")
def admin_overview(request: Request, session: db_session_dep):
    admin_user = current_admin_user(request, session)
    users = list(session.exec(select(User).order_by(User.created_at.desc())))
    users_by_id = {user.id: user for user in users}
    chats = list(session.exec(select(Chat)))
    messages = list(session.exec(select(Message)))
    usage_events = list(
        session.exec(select(UsageEvent).order_by(UsageEvent.created_at.desc()))
    )

    chat_by_id = {chat.id: chat for chat in chats}
    chat_counts: dict[str, int] = defaultdict(int)
    message_counts: dict[str, int] = defaultdict(int)
    for chat in chats:
        if chat.archived_at is None:
            chat_counts[chat.user_id] += 1
    for message in messages:
        chat = chat_by_id.get(message.chat_id)
        if chat is None or chat.archived_at is not None:
            continue
        message_counts[chat.user_id] += 1

    usage_by_user: dict[str, list[UsageEvent]] = defaultdict(list)
    for event in usage_events:
        usage_by_user[event.user_id].append(event)

    user_rows = []
    for user in users:
        usage_summary = usage_summary_from_events(usage_by_user.get(user.id, []))
        user_rows.append(
            {
                "id": user.id,
                "username": user.username,
                "email": user.email,
                "is_admin": is_primary_admin(user),
                "is_active": user.is_active,
                "created_at": user.created_at,
                "last_login_at": user.last_login_at,
                "chat_count": chat_counts.get(user.id, 0),
                "message_count": message_counts.get(user.id, 0),
                "usage": usage_summary,
            }
        )

    recent_events = [
        {
            "id": event.id,
            "user_id": event.user_id,
            "username": users_by_id.get(event.user_id).username if users_by_id.get(event.user_id) else "unknown",
            "email": users_by_id.get(event.user_id).email if users_by_id.get(event.user_id) else "",
            "provider": event.provider,
            "model": event.model,
            "request_kind": event.request_kind,
            "prompt_tokens": event.prompt_tokens,
            "completion_tokens": event.completion_tokens,
            "total_tokens": event.total_tokens,
            "created_at": event.created_at,
        }
        for event in usage_events[:40]
    ]

    return {
        "current_user": {
            "id": admin_user.id,
            "username": admin_user.username,
            "email": admin_user.email,
            "is_admin": True,
        },
        "primary_admin_email": PRIMARY_ADMIN_EMAIL,
        "users": user_rows,
        "usage": {
            **usage_summary_from_events(usage_events),
            "recent_events": recent_events,
        },
    }


@app.post("/api/admin/users")
def admin_create_user(
    payload: AdminUserCreatePayload,
    request: Request,
    session: db_session_dep,
):
    current_admin_user(request, session)
    username = payload.username.strip()
    email = payload.email.strip()
    password = payload.password

    if len(username) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters.")
    if "@" not in email:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")

    normalized_username = normalize_username(username)
    normalized_email = normalize_email(email)
    if session.exec(select(User).where(User.normalized_username == normalized_username)).first():
        raise HTTPException(status_code=409, detail="That username is already in use.")
    if session.exec(select(User).where(User.normalized_email == normalized_email)).first():
        raise HTTPException(status_code=409, detail="That email is already in use.")

    hashed_password, password_salt = hash_password(password)
    user = User(
        username=username,
        normalized_username=normalized_username,
        email=email,
        normalized_email=normalized_email,
        hashed_password=hashed_password,
        password_salt=password_salt,
        is_admin=normalized_email == PRIMARY_ADMIN_EMAIL,
    )
    session.add(user)
    session.commit()
    sync_primary_admin(session)
    session.refresh(user)
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "is_admin": is_primary_admin(user),
        "is_active": user.is_active,
        "created_at": user.created_at,
    }


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(
    user_id: str,
    request: Request,
    session: db_session_dep,
):
    admin_user = current_admin_user(request, session)
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    if user.id == admin_user.id or user.normalized_email == PRIMARY_ADMIN_EMAIL:
        raise HTTPException(status_code=400, detail="The primary admin user cannot be removed.")

    chats = list(session.exec(select(Chat).where(Chat.user_id == user.id)))
    chat_ids = [chat.id for chat in chats]
    if chat_ids:
        for message in list(session.exec(select(Message).where(Message.chat_id.in_(chat_ids)))):
            session.delete(message)
        for settings_record in list(session.exec(select(ChatSettings).where(ChatSettings.chat_id.in_(chat_ids)))):
            session.delete(settings_record)
    for chat in chats:
        session.delete(chat)
    for preference in list(session.exec(select(UserPreference).where(UserPreference.user_id == user.id))):
        session.delete(preference)
    for usage_event in list(session.exec(select(UsageEvent).where(UsageEvent.user_id == user.id))):
        session.delete(usage_event)
    for session_record in list(session.exec(select(SessionRecord).where(SessionRecord.user_id == user.id))):
        session.delete(session_record)
    session.delete(user)
    session.commit()
    return {"ok": True}


@app.get("/api/providers")
def list_providers(request: Request, session: db_session_dep):
    current_user(request, session)
    return {
        "providers": [capability.model_dump() for capability in provider_registry.capabilities()],
        "default_settings": settings_response(provider_registry.normalize_settings()),
    }


@app.get("/api/me/preferences")
def get_preferences(request: Request, session: db_session_dep):
    user = current_user(request, session)
    return settings_response(resolve_user_settings(session, user))


@app.patch("/api/me/preferences")
def update_preferences(
    payload: RunSettingsPatch,
    request: Request,
    session: db_session_dep,
):
    user = current_user(request, session)
    preference = get_or_create_user_preference(session, user)
    current_settings = settings_from_record(preference)
    next_settings = provider_registry.merge_settings(current_settings, payload)
    apply_settings_to_record(preference, next_settings)
    session.add(preference)
    session.commit()
    session.refresh(preference)
    return settings_response(settings_from_record(preference))


@app.get("/api/chats")
def list_chats(request: Request, session: db_session_dep):
    user = current_user(request, session)
    chats = list(
        session.exec(
            select(Chat)
            .where(Chat.user_id == user.id, Chat.archived_at.is_(None))
            .order_by(Chat.updated_at.desc())
        )
    )
    return {"chats": [build_chat_summary(session, chat) for chat in chats]}


@app.post("/api/chats")
def create_chat(
    payload: ChatCreatePayload,
    request: Request,
    session: db_session_dep,
):
    user = current_user(request, session)
    title = payload.title.strip() if payload.title and payload.title.strip() else "New chat"
    chat = Chat(user_id=user.id, title=title)
    session.add(chat)
    session.commit()
    session.refresh(chat)
    default_settings = resolve_user_settings(session, user)
    chat_settings = provider_registry.merge_settings(default_settings, payload.settings)
    session.add(
        ChatSettings(
            chat_id=chat.id,
            provider=chat_settings.provider,
            model=chat_settings.model,
            system_prompt=chat_settings.system_prompt,
            temperature=chat_settings.temperature,
            reasoning_effort=chat_settings.reasoning_effort,
        )
    )
    session.commit()
    return build_chat_summary(session, chat)


@app.get("/api/chats/{chat_id}")
def get_chat(chat_id: str, request: Request, session: db_session_dep):
    user = current_user(request, session)
    chat = get_chat_for_user(session, user, chat_id)
    messages = list_messages_for_chat(session, chat.id)
    return {
        "id": chat.id,
        "title": chat.title,
        "created_at": chat.created_at,
        "updated_at": chat.updated_at,
        "messages": [
            {
                "id": message.id,
                "role": message.role,
                "content": message.content,
                "created_at": message.created_at,
            }
            for message in messages
        ],
        "settings": settings_response(resolve_chat_settings(session, user, chat)),
    }


@app.get("/api/chats/{chat_id}/settings")
def get_chat_settings(chat_id: str, request: Request, session: db_session_dep):
    user = current_user(request, session)
    chat = get_chat_for_user(session, user, chat_id)
    return settings_response(resolve_chat_settings(session, user, chat))


@app.patch("/api/chats/{chat_id}/settings")
def update_chat_settings(
    chat_id: str,
    payload: RunSettingsPatch,
    request: Request,
    session: db_session_dep,
):
    user = current_user(request, session)
    chat = get_chat_for_user(session, user, chat_id)
    settings_record = get_or_create_chat_settings(session, user, chat)
    current_settings = settings_from_record(settings_record)
    next_settings = provider_registry.merge_settings(current_settings, payload)
    apply_settings_to_record(settings_record, next_settings)
    session.add(settings_record)
    session.commit()
    session.refresh(settings_record)
    return settings_response(settings_from_record(settings_record))


@app.patch("/api/chats/{chat_id}")
def rename_chat(
    chat_id: str,
    payload: ChatRenamePayload,
    request: Request,
    session: db_session_dep,
):
    user = current_user(request, session)
    chat = get_chat_for_user(session, user, chat_id)
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title cannot be empty.")
    chat.title = title[:120]
    chat.updated_at = utcnow()
    session.add(chat)
    session.commit()
    session.refresh(chat)
    return build_chat_summary(session, chat)


@app.delete("/api/chats/{chat_id}")
def delete_chat(chat_id: str, request: Request, session: db_session_dep):
    user = current_user(request, session)
    chat = get_chat_for_user(session, user, chat_id)
    chat.archived_at = utcnow()
    chat.updated_at = utcnow()
    session.add(chat)
    session.commit()
    return {"ok": True}


@app.post("/api/chats/{chat_id}/runs")
async def create_run(
    chat_id: str,
    payload: RunStartPayload,
    request: Request,
    session: db_session_dep,
):
    user = current_user(request, session)
    chat = get_chat_for_user(session, user, chat_id)
    content = payload.input.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message content cannot be empty.")

    chat_settings = resolve_chat_settings(session, user, chat)
    settings = provider_registry.merge_settings(chat_settings, payload.config_override)
    adapter = provider_registry.adapter_for(settings.provider)
    if adapter is None:
        raise HTTPException(status_code=400, detail="The selected provider is not supported.")

    capability = provider_registry.capability_for(settings.provider)
    if capability and not capability.configured:
        raise HTTPException(
            status_code=400,
            detail=f"{capability.label} is not configured on this server.",
        )
    if payload.attachment_manifest and capability and not capability.supports_browser_tools:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{capability.label} does not support browser-local file tools yet. "
                "Switch to a tool-capable provider such as OpenRouter."
            ),
        )

    user_message = Message(
        chat_id=chat.id,
        role="user",
        content=content,
        sequence=next_message_sequence(session, chat.id),
    )
    chat.updated_at = utcnow()
    session.add(user_message)
    session.add(chat)
    session.commit()

    run_id = uuid4().hex
    active_run = ActiveRun(id=run_id, user_id=user.id, chat_id=chat.id)
    active_runs[run_id] = active_run

    history = provider_history_from_messages(list_messages_for_chat(session, chat.id))
    tools = browser_tool_definitions() if payload.attachment_manifest else []
    if payload.attachment_manifest and history:
        manifest_lines = "\n".join(
            (
                f"- {(item.reference_name or item.name)}"
                + (f" (uploaded as {item.name})" if item.reference_name and item.reference_name != item.name else "")
                + f" ({item.kind}, {item.size_bytes} bytes)"
            )
            for item in payload.attachment_manifest
        )
        history[-1].content = (
            f"{history[-1].content}\n\n"
            f"{browser_tool_usage_guidance()}\n"
            f"{manifest_lines}"
        )

    async def gen():
        assistant_text = ""
        cached_tool_results: dict[str, ToolResult] = {}
        try:
            yield run_event(
                run_id,
                "run.started",
                chat_id=chat.id,
                attachment_manifest=[item.model_dump() for item in payload.attachment_manifest],
            )

            for _ in range(MAX_TOOL_ITERATIONS):
                turn = await adapter.complete_turn(
                    history=history,
                    settings=settings,
                    tools=tools or None,
                )
                record_usage_event(
                    user_id=user.id,
                    chat_id=chat.id,
                    run_id=run_id,
                    request_kind="chat_run",
                    provider=settings.provider,
                    model=settings.model,
                    usage=turn.usage,
                )
                if not turn.tool_calls and tools:
                    inline_tool_calls = parse_inline_tool_calls(turn.text)
                    if inline_tool_calls:
                        turn.tool_calls = [
                            ToolCall(
                                id=item["id"],
                                name=item["name"],
                                arguments=item["arguments"],
                            )
                            for item in inline_tool_calls
                        ]
                        turn.text = ""
                if turn.tool_calls:
                    pending_ids: set[str] = set()
                    reused_results: list[ToolResult] = []
                    for tool_call in turn.tool_calls:
                        signature = tool_call_signature(tool_call)
                        cached_result = cached_tool_results.get(signature)
                        if cached_result is None:
                            pending_ids.add(tool_call.id)
                            continue
                        reused_results.append(
                            ToolResult(
                                tool_call_id=tool_call.id,
                                name=tool_call.name,
                                output=cached_result.output,
                                summary_for_model=(
                                    f"{cached_result.summary_for_model}\n"
                                    "This exact tool request was already completed earlier in the run."
                                ).strip(),
                            )
                        )
                    if not pending_ids and not reused_results:
                        raise RuntimeError("The model requested a tool call without an id.")

                    history.append(
                        ProviderMessage(
                            role="assistant",
                            content=turn.text,
                            tool_calls=turn.tool_calls,
                        )
                    )
                    active_run.pending_tool_call_ids = pending_ids

                    for reused_result in reused_results:
                        history.append(
                            ProviderMessage(
                                role="tool",
                                content=tool_content_for_model(reused_result),
                                tool_call_id=reused_result.tool_call_id,
                                tool_name=reused_result.name,
                            )
                        )
                        yield run_event(
                            run_id,
                            "tool.call.completed",
                            tool_call_id=reused_result.tool_call_id,
                            name=reused_result.name,
                        )

                    for tool_call in turn.tool_calls:
                        if tool_call.id not in pending_ids:
                            continue
                        yield run_event(
                            run_id,
                            "tool.call.requested",
                            tool_call_id=tool_call.id,
                            name=tool_call.name,
                            arguments=tool_call.arguments,
                        )
                    if pending_ids:
                        yield run_event(
                            run_id,
                            "run.awaiting_tool_results",
                            pending_tool_call_ids=sorted(active_run.pending_tool_call_ids),
                        )

                    while active_run.pending_tool_call_ids:
                        results = await active_run.tool_result_queue.get()
                        for result in results:
                            if result.tool_call_id not in active_run.pending_tool_call_ids:
                                continue
                            active_run.pending_tool_call_ids.remove(result.tool_call_id)
                            matching_tool_call = next(
                                (
                                    candidate
                                    for candidate in turn.tool_calls
                                    if candidate.id == result.tool_call_id
                                ),
                                None,
                            )
                            if matching_tool_call is not None:
                                cached_tool_results[tool_call_signature(matching_tool_call)] = result
                            history.append(
                                ProviderMessage(
                                    role="tool",
                                    content=tool_content_for_model(result),
                                    tool_call_id=result.tool_call_id,
                                    tool_name=result.name,
                                )
                            )
                            yield run_event(
                                run_id,
                                "tool.call.completed",
                                tool_call_id=result.tool_call_id,
                                name=result.name,
                            )
                    if len(cached_tool_results) >= 2:
                        history.append(
                            ProviderMessage(
                                role="user",
                                content=(
                                    "You now have tool results for this request. "
                                    "If those results are sufficient, answer the user directly without "
                                    "requesting more tools."
                                ),
                            )
                        )
                    continue

                assistant_text = turn.text.strip()
                if not assistant_text:
                    raise RuntimeError("The model returned an empty response.")

                for chunk in iter_text_chunks(assistant_text):
                    yield run_event(run_id, "message.delta", delta=chunk)
                yield run_event(run_id, "message.completed", content=assistant_text)
                await persist_assistant_reply(
                    user=user,
                    chat=chat,
                    current_message=content,
                    assistant_text=assistant_text,
                    settings=settings,
                )
                yield run_event(run_id, "run.completed")
                return

            raise RuntimeError("The run reached the maximum number of tool iterations.")
        except Exception as exc:
            yield run_event(run_id, "run.failed", error=str(exc))
        finally:
            active_runs.pop(run_id, None)

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@app.post("/api/runs/{run_id}/tool-results")
async def submit_tool_results(
    run_id: str,
    payload: ToolResultPayload,
    request: Request,
    session: db_session_dep,
):
    user = current_user(request, session)
    active_run = active_runs.get(run_id)
    if active_run is None or active_run.user_id != user.id:
        raise HTTPException(status_code=404, detail="Run not found.")

    accepted = [
        result
        for result in payload.results
        if result.tool_call_id in active_run.pending_tool_call_ids
    ]
    if not accepted:
        raise HTTPException(status_code=400, detail="No matching pending tool calls were found.")

    await active_run.tool_result_queue.put(accepted)
    return {
        "accepted": len(accepted),
        "pending": len(active_run.pending_tool_call_ids),
    }


@app.post("/api/chats/{chat_id}/messages")
async def create_message(
    chat_id: str,
    payload: MessageCreatePayload,
    request: Request,
    session: db_session_dep,
):
    user = current_user(request, session)
    chat = get_chat_for_user(session, user, chat_id)
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message content cannot be empty.")
    settings = resolve_chat_settings(session, user, chat)
    adapter = provider_registry.adapter_for(settings.provider)
    if adapter is None:
        raise HTTPException(status_code=400, detail="The selected provider is not supported.")

    capability = provider_registry.capability_for(settings.provider)
    if capability and not capability.configured:
        raise HTTPException(
            status_code=400,
            detail=f"{capability.label} is not configured on this server.",
        )

    user_message = Message(
        chat_id=chat.id,
        role="user",
        content=content,
        sequence=next_message_sequence(session, chat.id),
    )
    chat.updated_at = utcnow()
    session.add(user_message)
    session.add(chat)
    session.commit()

    messages = list_messages_for_chat(session, chat.id)
    history = [message_to_conversation(message) for message in messages[:-1]]
    current_message = messages[-1].content

    async def gen():
        assistant_chunks: list[str] = []
        try:
            async for chunk in adapter.stream_text(
                history=history,
                user_input=current_message,
                settings=settings,
            ):
                assistant_chunks.append(chunk)
                yield chunk
        except Exception as exc:
            yield f"### Request failed\n\n{exc}"
            return

        assistant_text = "".join(assistant_chunks).strip()
        if not assistant_text:
            return

        await persist_assistant_reply(
            user=user,
            chat=chat,
            current_message=current_message,
            assistant_text=assistant_text,
            settings=settings,
        )

    return StreamingResponse(gen(), media_type="text/plain")
