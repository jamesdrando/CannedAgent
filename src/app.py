from __future__ import annotations

import os
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlmodel import Session, select

from src.auth import (
    SESSION_COOKIE_NAME,
    authenticate_user,
    clear_session_cookie,
    client_ip,
    create_session_record,
    get_user_for_session_token,
    require_user,
    revoke_session,
    seed_admin_user,
    set_session_cookie,
)
from src.db import engine, get_db_session, init_db
from src.internal.providers import (
    ConversationMessage,
    ProviderRegistry,
    RunSettings,
    RunSettingsPatch,
)
from src.models import Chat, ChatSettings, Message, User, UserPreference, utcnow


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

provider_registry = ProviderRegistry()
db_session_dep = Annotated[Session, Depends(get_db_session)]
login_attempts: dict[str, deque[float]] = defaultdict(deque)


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


def optional_page_user(request: Request, session: Session) -> User | None:
    return get_user_for_session_token(session, request.cookies.get(SESSION_COOKIE_NAME))


def current_user(request: Request, session: Session) -> User:
    return require_user(session, request.cookies.get(SESSION_COOKIE_NAME))


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
    if should_seed_default_admin():
        with Session(engine) as session:
            seed_admin_user(session)


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


@app.get("/api/auth/me")
def auth_me(request: Request, session: db_session_dep):
    user = current_user(request, session)
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "is_admin": user.is_admin,
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
            "is_admin": user.is_admin,
        }
    }


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: Response, session: db_session_dep):
    revoke_session(session, request.cookies.get(SESSION_COOKIE_NAME))
    clear_session_cookie(response)
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

    return StreamingResponse(gen(), media_type="text/plain")
