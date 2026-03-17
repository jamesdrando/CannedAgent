from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True)
    username: str = Field(index=True, unique=True)
    normalized_username: str = Field(index=True, unique=True)
    email: str = Field(unique=True)
    normalized_email: str = Field(index=True, unique=True)
    hashed_password: str
    password_salt: str
    is_admin: bool = False
    is_active: bool = True
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    last_login_at: Optional[datetime] = None
    password_updated_at: datetime = Field(default_factory=utcnow)
    reset_password_token: Optional[str] = None
    reset_password_sent_at: Optional[datetime] = None


class SessionRecord(SQLModel, table=True):
    __tablename__ = "session_records"

    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    token_hash: str = Field(index=True, unique=True)
    created_at: datetime = Field(default_factory=utcnow)
    expires_at: datetime = Field(index=True)
    last_seen_at: datetime = Field(default_factory=utcnow)
    revoked_at: Optional[datetime] = None
    user_agent: Optional[str] = None
    ip_address: Optional[str] = None


class Chat(SQLModel, table=True):
    __tablename__ = "chats"

    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    title: str = Field(default="New chat")
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow, index=True)
    archived_at: Optional[datetime] = None


class Message(SQLModel, table=True):
    __tablename__ = "messages"

    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True)
    chat_id: str = Field(foreign_key="chats.id", index=True)
    role: str = Field(index=True)
    content: str
    sequence: int = Field(index=True)
    created_at: datetime = Field(default_factory=utcnow)


class UserPreference(SQLModel, table=True):
    __tablename__ = "user_preferences"

    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True, unique=True)
    provider: str
    model: str
    system_prompt: str
    temperature: Optional[float] = None
    reasoning_effort: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class ChatSettings(SQLModel, table=True):
    __tablename__ = "chat_settings"

    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True)
    chat_id: str = Field(foreign_key="chats.id", index=True, unique=True)
    provider: str
    model: str
    system_prompt: str
    temperature: Optional[float] = None
    reasoning_effort: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
