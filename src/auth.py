from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException, Request, Response, status
from sqlmodel import Session, select

from src.models import SessionRecord, User, utcnow


SESSION_COOKIE_NAME = "canned_agent_session"
SESSION_TTL_DAYS = 14
PBKDF2_ITERATIONS = 310_000
APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
DEFAULT_COOKIE_SECURE = APP_ENV == "production"
DEFAULT_COOKIE_SAMESITE = "strict" if APP_ENV == "production" else "lax"
SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", str(int(DEFAULT_COOKIE_SECURE))).strip().lower() in {"1", "true", "yes"}
SESSION_COOKIE_SAMESITE = os.getenv("SESSION_COOKIE_SAMESITE", DEFAULT_COOKIE_SAMESITE).strip().lower()
SESSION_COOKIE_DOMAIN = os.getenv("SESSION_COOKIE_DOMAIN", "").strip() or None


def ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def normalize_email(value: str) -> str:
    return value.strip().lower()


def normalize_username(value: str) -> str:
    return value.strip().lower()


PRIMARY_ADMIN_EMAIL = normalize_email(
    os.getenv("PRIMARY_ADMIN_EMAIL", "jamesdavidrandall7@gmail.com")
)


def _pbkdf2_hash(password: str, salt: bytes) -> str:
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PBKDF2_ITERATIONS,
    )
    return base64.b64encode(digest).decode("utf-8")


def hash_password(password: str) -> tuple[str, str]:
    salt = secrets.token_bytes(16)
    return _pbkdf2_hash(password, salt), base64.b64encode(salt).decode("utf-8")


def verify_password(password: str, password_salt: str, hashed_password: str) -> bool:
    salt = base64.b64decode(password_salt.encode("utf-8"))
    return hmac.compare_digest(_pbkdf2_hash(password, salt), hashed_password)


def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session_record(
    session: Session,
    user: User,
    *,
    user_agent: str | None,
    ip_address: str | None,
) -> tuple[str, datetime]:
    raw_token = secrets.token_urlsafe(32)
    expires_at = utcnow() + timedelta(days=SESSION_TTL_DAYS)
    session_record = SessionRecord(
        user_id=user.id,
        token_hash=hash_session_token(raw_token),
        expires_at=expires_at,
        user_agent=user_agent,
        ip_address=ip_address,
    )
    session.add(session_record)
    user.last_login_at = utcnow()
    user.updated_at = utcnow()
    session.add(user)
    session.commit()
    return raw_token, expires_at


def set_session_cookie(response: Response, token: str, expires_at: datetime) -> None:
    max_age = int((ensure_utc(expires_at) - utcnow()).total_seconds())
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        max_age=max_age,
        expires=max_age,
        path="/",
        domain=SESSION_COOKIE_DOMAIN,
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/", domain=SESSION_COOKIE_DOMAIN)


def authenticate_user(session: Session, identifier: str, password: str) -> Optional[User]:
    normalized_identifier = identifier.strip()
    if not normalized_identifier:
        return None

    if "@" in normalized_identifier:
        statement = select(User).where(
            User.normalized_email == normalize_email(normalized_identifier)
        )
    else:
        statement = select(User).where(
            User.normalized_username == normalize_username(normalized_identifier)
        )

    user = session.exec(statement).first()
    if not user or not user.is_active:
        return None

    if not verify_password(password, user.password_salt, user.hashed_password):
        return None

    return user


def get_user_for_session_token(session: Session, token: str | None) -> Optional[User]:
    if not token:
        return None

    session_record = session.exec(
        select(SessionRecord).where(SessionRecord.token_hash == hash_session_token(token))
    ).first()
    if not session_record:
        return None

    now = utcnow()
    revoked_at = ensure_utc(session_record.revoked_at) if session_record.revoked_at else None
    expires_at = ensure_utc(session_record.expires_at)
    if revoked_at is not None or expires_at <= now:
        return None

    user = session.get(User, session_record.user_id)
    if not user or not user.is_active:
        return None

    session_record.last_seen_at = now
    session.add(session_record)
    session.commit()
    session.refresh(user)
    return user


def require_user(session: Session, token: str | None) -> User:
    user = get_user_for_session_token(session, token)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
        )
    return user


def revoke_session(session: Session, token: str | None) -> None:
    if not token:
        return

    session_record = session.exec(
        select(SessionRecord).where(SessionRecord.token_hash == hash_session_token(token))
    ).first()
    if session_record and session_record.revoked_at is None:
        session_record.revoked_at = utcnow()
        session.add(session_record)
        session.commit()


def is_primary_admin(user: User | None) -> bool:
    if user is None or not user.is_active:
        return False
    return user.normalized_email == PRIMARY_ADMIN_EMAIL


def sync_primary_admin(session: Session) -> None:
    users = list(session.exec(select(User)))
    changed = False
    for user in users:
        should_be_admin = is_primary_admin(user)
        if user.is_admin == should_be_admin:
            continue
        user.is_admin = should_be_admin
        user.updated_at = utcnow()
        session.add(user)
        changed = True
    if changed:
        session.commit()


def seed_admin_user(session: Session) -> None:
    existing = session.exec(
        select(User).where(User.normalized_email == normalize_email("admin@example.com"))
    ).first()
    if existing:
        return

    hashed_password, password_salt = hash_password("password123")
    admin_user = User(
        username="admin",
        normalized_username=normalize_username("admin"),
        email="admin@example.com",
        normalized_email=normalize_email("admin@example.com"),
        hashed_password=hashed_password,
        password_salt=password_salt,
        is_admin=True,
    )
    session.add(admin_user)
    session.commit()


def client_ip(request: Request) -> str | None:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    if request.client:
        return request.client.host
    return None
