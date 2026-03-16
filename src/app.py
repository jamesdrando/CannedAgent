from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
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
from src.models import Chat, Message, User, utcnow


origins = [
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
]

MODEL = "gemini-3.1-flash-lite-preview"
STATIC_DIR = Path(__file__).resolve().parent / "static"
PAGES_DIR = Path(__file__).resolve().parent / "pages"
LOGIN_PAGE = PAGES_DIR / "login.html"
APP_PAGE = PAGES_DIR / "index.html"

db_session_dep = Annotated[Session, Depends(get_db_session)]


def get_client() -> genai.Client:
    return genai.Client()


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
    client: genai.Client,
    user_message: str,
    assistant_message: str,
) -> str:
    response = await client.aio.models.generate_content(
        model=MODEL,
        contents=(
            "Respond with one single line only for this message only: "
            "What is a good short chat title for this conversation? "
            "Respond only with the title itself.\n\n"
            f"User message:\n{user_message}\n\n"
            f"Assistant response:\n{assistant_message}"
        ),
        config=types.GenerateContentConfig(
            temperature=0.2,
            max_output_tokens=24,
        ),
    )
    return sanitize_generated_title(response.text or "")


def to_genai_content(message: Message) -> types.Content:
    role = "model" if message.role == "assistant" else "user"
    return types.Content(
        role=role,
        parts=[types.Part.from_text(text=message.content)],
    )


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


def optional_page_user(request: Request, session: Session) -> User | None:
    return get_user_for_session_token(session, request.cookies.get(SESSION_COOKIE_NAME))


def current_user(request: Request, session: Session) -> User:
    return require_user(session, request.cookies.get(SESSION_COOKIE_NAME))


class LoginPayload(BaseModel):
    identifier: str
    password: str


class ChatCreatePayload(BaseModel):
    title: str | None = None


class ChatRenamePayload(BaseModel):
    title: str


class MessageCreatePayload(BaseModel):
    content: str


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.on_event("startup")
def on_startup() -> None:
    init_db()
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
    user = authenticate_user(session, payload.identifier, payload.password)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials.",
        )

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
    }


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
    client: genai.Client = Depends(get_client),
):
    user = current_user(request, session)
    chat = get_chat_for_user(session, user, chat_id)
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message content cannot be empty.")

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
    history = [to_genai_content(message) for message in messages[:-1]]
    current_message = messages[-1].content

    async def gen():
        assistant_chunks: list[str] = []
        try:
            chat_session = client.aio.chats.create(
                model=MODEL,
                history=history,
                config=types.GenerateContentConfig(
                    system_instruction=(
                        "You are an AI coding agent. "
                        "Respond using GitHub-flavored Markdown. "
                        "Use fenced code blocks for code, bullets for lists, and short headings when helpful."
                    ),
                ),
            )
            stream = await chat_session.send_message_stream(current_message)
            async for chunk in stream:
                if chunk.text:
                    assistant_chunks.append(chunk.text)
                    yield chunk.text
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

            if persisted_chat.title == "New chat" and assistant_message.sequence == 2:
                try:
                    persisted_chat.title = await generate_chat_title(
                        client,
                        current_message,
                        assistant_text,
                    )
                except Exception:
                    persisted_chat.title = chat_title_from_content(current_message)
                persisted_chat.updated_at = utcnow()
                write_session.add(persisted_chat)
                write_session.commit()

    return StreamingResponse(gen(), media_type="text/plain")
