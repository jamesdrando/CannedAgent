from __future__ import annotations

import os
from typing import AsyncIterator

from src.internal.providers.base import (
    ConversationMessage,
    ProviderAdapter,
    ProviderCapability,
    ProviderModelCapability,
    RunSettings,
)


DEFAULT_GEMINI_MODEL = (
    os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite-preview").strip()
    or "gemini-3.1-flash-lite-preview"
)


def _gemini_model_capabilities() -> list[ProviderModelCapability]:
    configured = os.getenv("GEMINI_MODELS", "").strip()
    model_ids = [value.strip() for value in configured.split(",") if value.strip()]
    if not model_ids:
        model_ids = [DEFAULT_GEMINI_MODEL]
    return [
        ProviderModelCapability(
            id=model_id,
            label=model_id.replace("-", " ").title(),
            supports_temperature=True,
            supports_reasoning=False,
        )
        for model_id in model_ids
    ]


def _to_genai_content(types_module, message: ConversationMessage):
    role = "model" if message.role == "assistant" else "user"
    return types_module.Content(
        role=role,
        parts=[types_module.Part.from_text(text=message.content)],
    )


class GeminiProviderAdapter(ProviderAdapter):
    provider_id = "gemini"
    label = "Google Gemini"

    def capability(self) -> ProviderCapability:
        return ProviderCapability(
            id=self.provider_id,
            label=self.label,
            configured=bool(os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")),
            default_model=DEFAULT_GEMINI_MODEL,
            supports_system_prompt=True,
            supports_temperature=True,
            reasoning_efforts=[],
            allow_custom_models=True,
            models=_gemini_model_capabilities(),
        )

    async def stream_text(
        self,
        *,
        history: list[ConversationMessage],
        user_input: str,
        settings: RunSettings,
    ) -> AsyncIterator[str]:
        try:
            from google import genai
            from google.genai import types
        except ModuleNotFoundError as exc:
            raise RuntimeError("Gemini support is not installed on this server.") from exc

        api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        client = genai.Client(api_key=api_key) if api_key else genai.Client()
        model = settings.model or self.capability().default_model
        history_items = [_to_genai_content(types, message) for message in history]

        chat_session = client.aio.chats.create(
            model=model,
            history=history_items,
            config=types.GenerateContentConfig(
                system_instruction=settings.system_prompt,
                temperature=settings.temperature,
            ),
        )
        stream = await chat_session.send_message_stream(user_input)
        async for chunk in stream:
            if chunk.text:
                yield chunk.text

    async def generate_title(
        self,
        *,
        user_message: str,
        assistant_message: str,
        settings: RunSettings,
    ) -> str | None:
        try:
            from google import genai
            from google.genai import types
        except ModuleNotFoundError:
            return None

        api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        client = genai.Client(api_key=api_key) if api_key else genai.Client()
        response = await client.aio.models.generate_content(
            model=settings.model or self.capability().default_model,
            contents=(
                "Respond with one single line only for this message only: "
                "What is a good short chat title for this conversation? "
                "Respond only with the title itself.\n\n"
                f"User message:\n{user_message}\n\n"
                f"Assistant response:\n{assistant_message}"
            ),
            config=types.GenerateContentConfig(
                system_instruction=settings.system_prompt,
                temperature=0.2,
                max_output_tokens=24,
            ),
        )
        return response.text
