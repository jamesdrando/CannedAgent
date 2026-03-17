from __future__ import annotations

import asyncio
import json
import os
import threading
from typing import AsyncIterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from src.internal.providers.base import (
    ConversationMessage,
    ProviderAdapter,
    ProviderCapability,
    ProviderModelCapability,
    RunSettings,
    SUPPORTED_REASONING_EFFORTS,
)


DEFAULT_OPENROUTER_MODEL = (
    os.getenv("OPENROUTER_DEFAULT_MODEL", "openrouter/free").strip()
    or "openrouter/free"
)
OPENROUTER_BASE_URL = (
    os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
    or "https://openrouter.ai/api/v1"
)


def _openrouter_models() -> list[ProviderModelCapability]:
    configured = os.getenv("OPENROUTER_MODELS", "").strip()
    model_ids = [value.strip() for value in configured.split(",") if value.strip()]
    if not model_ids:
        model_ids = [DEFAULT_OPENROUTER_MODEL]

    return [
        ProviderModelCapability(
            id=model_id,
            label=model_id,
            supports_temperature=True,
            supports_reasoning=True,
        )
        for model_id in model_ids
    ]


def _decode_content(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            item.get("text", "")
            for item in value
            if isinstance(item, dict) and item.get("type") == "text"
        )
    return ""


class OpenRouterProviderAdapter(ProviderAdapter):
    provider_id = "openrouter"
    label = "OpenRouter"

    def capability(self) -> ProviderCapability:
        return ProviderCapability(
            id=self.provider_id,
            label=self.label,
            configured=bool(os.getenv("OPENROUTER_API_KEY")),
            default_model=DEFAULT_OPENROUTER_MODEL,
            supports_system_prompt=True,
            supports_temperature=True,
            reasoning_efforts=list(SUPPORTED_REASONING_EFFORTS),
            allow_custom_models=True,
            models=_openrouter_models(),
        )

    def _headers(self) -> dict[str, str]:
        api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("OpenRouter is not configured on this server.")

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        site_url = os.getenv("OPENROUTER_SITE_URL", "").strip()
        app_name = os.getenv("OPENROUTER_APP_NAME", "jobber").strip()
        if site_url:
            headers["HTTP-Referer"] = site_url
        if app_name:
            headers["X-Title"] = app_name
        return headers

    def _messages(
        self,
        *,
        history: list[ConversationMessage],
        user_input: str | None,
        settings: RunSettings,
    ) -> list[dict[str, str]]:
        messages: list[dict[str, str]] = []
        if settings.system_prompt:
            messages.append({"role": "system", "content": settings.system_prompt})
        for message in history:
            messages.append(
                {
                    "role": message.role,
                    "content": message.content,
                }
            )
        if user_input is not None:
            messages.append({"role": "user", "content": user_input})
        return messages

    def _request_payload(
        self,
        *,
        history: list[ConversationMessage],
        user_input: str | None,
        settings: RunSettings,
        stream: bool,
    ) -> bytes:
        payload: dict[str, object] = {
            "model": settings.model or self.capability().default_model,
            "messages": self._messages(history=history, user_input=user_input, settings=settings),
            "stream": stream,
        }
        if settings.temperature is not None:
            payload["temperature"] = settings.temperature
        if settings.reasoning_effort:
            payload["reasoning"] = {"effort": settings.reasoning_effort}
        return json.dumps(payload).encode("utf-8")

    def _iter_stream(self, *, history: list[ConversationMessage], user_input: str, settings: RunSettings):
        request = Request(
            f"{OPENROUTER_BASE_URL}/chat/completions",
            data=self._request_payload(
                history=history,
                user_input=user_input,
                settings=settings,
                stream=True,
            ),
            headers=self._headers(),
            method="POST",
        )
        try:
            with urlopen(request, timeout=180) as response:
                for raw_line in response:
                    line = raw_line.decode("utf-8").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data:
                        continue
                    if data == "[DONE]":
                        break
                    event = json.loads(data)
                    for choice in event.get("choices", []):
                        delta = choice.get("delta", {})
                        text = _decode_content(delta.get("content"))
                        if text:
                            yield text
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(body or f"OpenRouter request failed with status {exc.code}.") from exc
        except URLError as exc:
            raise RuntimeError(f"OpenRouter request failed: {exc.reason}") from exc

    def _complete(self, *, history: list[ConversationMessage], user_input: str | None, settings: RunSettings) -> str:
        request = Request(
            f"{OPENROUTER_BASE_URL}/chat/completions",
            data=self._request_payload(
                history=history,
                user_input=user_input,
                settings=settings,
                stream=False,
            ),
            headers={**self._headers(), "Accept": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=180) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(body or f"OpenRouter request failed with status {exc.code}.") from exc
        except URLError as exc:
            raise RuntimeError(f"OpenRouter request failed: {exc.reason}") from exc

        choice = (payload.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        return _decode_content(message.get("content")).strip()

    async def stream_text(
        self,
        *,
        history: list[ConversationMessage],
        user_input: str,
        settings: RunSettings,
    ) -> AsyncIterator[str]:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[tuple[str, str | Exception | None]] = asyncio.Queue()

        def worker() -> None:
            try:
                for chunk in self._iter_stream(history=history, user_input=user_input, settings=settings):
                    asyncio.run_coroutine_threadsafe(queue.put(("chunk", chunk)), loop).result()
            except Exception as exc:  # pragma: no cover - background thread passthrough
                asyncio.run_coroutine_threadsafe(queue.put(("error", exc)), loop).result()
            finally:
                asyncio.run_coroutine_threadsafe(queue.put(("done", None)), loop).result()

        threading.Thread(target=worker, daemon=True).start()

        while True:
            event_type, payload = await queue.get()
            if event_type == "chunk" and isinstance(payload, str):
                yield payload
                continue
            if event_type == "error" and isinstance(payload, Exception):
                raise payload
            break

    async def generate_title(
        self,
        *,
        user_message: str,
        assistant_message: str,
        settings: RunSettings,
    ) -> str | None:
        title_prompt = (
            "Respond with one single line only for this message only: "
            "What is a good short chat title for this conversation? "
            "Respond only with the title itself.\n\n"
            f"User message:\n{user_message}\n\n"
            f"Assistant response:\n{assistant_message}"
        )
        return await asyncio.to_thread(
            self._complete,
            history=[],
            user_input=title_prompt,
            settings=settings,
        )
