from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import AsyncIterator, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


SUPPORTED_REASONING_EFFORTS = ("low", "medium", "high")
DEFAULT_PROVIDER_ID = os.getenv("DEFAULT_PROVIDER", "gemini").strip().lower() or "gemini"
DEFAULT_SYSTEM_PROMPT = (
    os.getenv(
        "DEFAULT_SYSTEM_PROMPT",
        "You are an AI agent. Respond using GitHub-flavored Markdown.",
    ).strip()
    or "You are an AI agent. Respond using GitHub-flavored Markdown."
)


def _clean_string(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


class ConversationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str

    model_config = ConfigDict(extra="forbid")


class RunSettings(BaseModel):
    provider: str = DEFAULT_PROVIDER_ID
    model: str = ""
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    temperature: float | None = Field(default=None, ge=0, le=2)
    reasoning_effort: Literal["low", "medium", "high"] | None = None

    model_config = ConfigDict(extra="forbid")

    @field_validator("provider", "model", mode="before")
    @classmethod
    def validate_short_strings(cls, value: str | None) -> str:
        return _clean_string(value) or ""

    @field_validator("system_prompt", mode="before")
    @classmethod
    def validate_system_prompt(cls, value: str | None) -> str:
        return _clean_string(value) or DEFAULT_SYSTEM_PROMPT


class RunSettingsPatch(BaseModel):
    provider: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
    reasoning_effort: Literal["low", "medium", "high"] | None = None

    model_config = ConfigDict(extra="forbid")

    @field_validator("provider", "model", "system_prompt", mode="before")
    @classmethod
    def validate_optional_strings(cls, value: str | None) -> str | None:
        return _clean_string(value)


class ProviderModelCapability(BaseModel):
    id: str
    label: str
    supports_temperature: bool = True
    supports_reasoning: bool = False

    model_config = ConfigDict(extra="forbid")


class ProviderCapability(BaseModel):
    id: str
    label: str
    configured: bool
    default_model: str
    supports_system_prompt: bool = True
    supports_temperature: bool = True
    reasoning_efforts: list[str] = Field(default_factory=list)
    allow_custom_models: bool = True
    models: list[ProviderModelCapability] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ProviderAdapter(ABC):
    provider_id: str
    label: str

    @abstractmethod
    def capability(self) -> ProviderCapability:
        raise NotImplementedError

    @abstractmethod
    async def stream_text(
        self,
        *,
        history: list[ConversationMessage],
        user_input: str,
        settings: RunSettings,
    ) -> AsyncIterator[str]:
        raise NotImplementedError

    async def generate_title(
        self,
        *,
        user_message: str,
        assistant_message: str,
        settings: RunSettings,
    ) -> str | None:
        return None
