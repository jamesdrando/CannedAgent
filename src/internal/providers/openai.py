from __future__ import annotations

import asyncio
import json
import os
import threading
from uuid import uuid4
from typing import AsyncIterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from src.internal.providers.base import (
    ConversationMessage,
    ProviderAdapter,
    ProviderCapability,
    ProviderModelCapability,
    ProviderMessage,
    ProviderTurn,
    RunSettings,
    ToolCall,
    ToolDefinition,
)


OPENAI_BASE_URL = (
    os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    or "https://api.openai.com/v1"
)


def _allowed_openai_models() -> list[str]:
    configured = os.getenv("OPENAI_ALLOWED_MODELS", "").strip()
    model_ids = [value.strip() for value in configured.split(",") if value.strip()]
    if not model_ids:
        model_ids = ["gpt-5-nano"]
    return model_ids


def _default_openai_model() -> str:
    configured = os.getenv("OPENAI_DEFAULT_MODEL", "").strip()
    allowed_models = _allowed_openai_models()
    if configured and configured in allowed_models:
        return configured
    return allowed_models[0]


def _openai_models() -> list[ProviderModelCapability]:
    return [
        ProviderModelCapability(
            id=model_id,
            label=model_id,
            supports_temperature=False,
            supports_reasoning=False,
        )
        for model_id in _allowed_openai_models()
    ]


def _decode_content(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            item.get("text", "")
            for item in value
            if isinstance(item, dict) and item.get("type") in {"text", "output_text"}
        )
    return ""


def _wire_tool_name(name: str) -> str:
    return name.replace(".", "_")


def _canonical_tool_name(name: str) -> str:
    known_names = {
        "files_list": "files.list",
        "files_describe": "files.describe",
        "files_read_text": "files.read_text",
        "tables_preview": "tables.preview",
        "tables_profile": "tables.profile",
        "python_execute": "python.execute",
    }
    return known_names.get(name, name)


class OpenAIProviderAdapter(ProviderAdapter):
    provider_id = "openai"
    label = "OpenAI"

    def capability(self) -> ProviderCapability:
        return ProviderCapability(
            id=self.provider_id,
            label=self.label,
            configured=bool(os.getenv("OPENAI_API_KEY")),
            default_model=_default_openai_model(),
            supports_system_prompt=True,
            supports_temperature=False,
            supports_browser_tools=True,
            reasoning_efforts=[],
            allow_custom_models=False,
            models=_openai_models(),
        )

    def _headers(self) -> dict[str, str]:
        api_key = os.getenv("OPENAI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("OpenAI is not configured on this server.")

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        return headers

    def _enforced_model(self, requested_model: str | None = None) -> str:
        allowed_models = _allowed_openai_models()
        requested = (requested_model or "").strip()
        if requested and requested in allowed_models:
            return requested
        return _default_openai_model()

    def _messages(
        self,
        *,
        history: list[ConversationMessage] | list[ProviderMessage],
        user_input: str | None,
        settings: RunSettings,
    ) -> list[dict]:
        messages: list[dict] = []
        if settings.effective_system_prompt:
            messages.append({"role": "system", "content": settings.effective_system_prompt})
        for message in history:
            if isinstance(message, ProviderMessage) and message.role == "assistant" and message.tool_calls:
                messages.append(
                    {
                        "role": "assistant",
                        "content": message.content or "",
                        "tool_calls": [
                            {
                                "id": tool_call.id,
                                "type": "function",
                                "function": {
                                    "name": _wire_tool_name(tool_call.name),
                                    "arguments": json.dumps(tool_call.arguments),
                                },
                            }
                            for tool_call in message.tool_calls
                        ],
                    }
                )
                continue
            if isinstance(message, ProviderMessage) and message.role == "tool":
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": message.tool_call_id,
                        "content": message.content or "",
                    }
                )
                continue
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
        history: list[ConversationMessage] | list[ProviderMessage],
        user_input: str | None,
        settings: RunSettings,
        stream: bool,
        tools: list[ToolDefinition] | None = None,
    ) -> bytes:
        payload: dict[str, object] = {
            "model": self._enforced_model(settings.model),
            "messages": self._messages(history=history, user_input=user_input, settings=settings),
            "stream": stream,
            "parallel_tool_calls": False,
        }
        if tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": _wire_tool_name(tool.name),
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                }
                for tool in tools
            ]
            payload["tool_choice"] = "auto"
        return json.dumps(payload).encode("utf-8")

    def _iter_stream(self, *, history: list[ConversationMessage], user_input: str, settings: RunSettings):
        request = Request(
            f"{OPENAI_BASE_URL}/chat/completions",
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
            raise RuntimeError(body or f"OpenAI request failed with status {exc.code}.") from exc
        except URLError as exc:
            raise RuntimeError(f"OpenAI request failed: {exc.reason}") from exc

    def _complete(
        self,
        *,
        history: list[ConversationMessage] | list[ProviderMessage],
        user_input: str | None,
        settings: RunSettings,
        tools: list[ToolDefinition] | None = None,
    ) -> dict:
        request = Request(
            f"{OPENAI_BASE_URL}/chat/completions",
            data=self._request_payload(
                history=history,
                user_input=user_input,
                settings=settings,
                stream=False,
                tools=tools,
            ),
            headers={**self._headers(), "Accept": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=180) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(body or f"OpenAI request failed with status {exc.code}.") from exc
        except URLError as exc:
            raise RuntimeError(f"OpenAI request failed: {exc.reason}") from exc

    def _to_provider_turn(self, payload: dict) -> ProviderTurn:
        choice = (payload.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        tool_calls: list[ToolCall] = []
        for raw_call in message.get("tool_calls") or []:
            function = raw_call.get("function") or {}
            raw_arguments = function.get("arguments") or "{}"
            try:
                arguments = json.loads(raw_arguments) if raw_arguments else {}
            except json.JSONDecodeError:
                arguments = {"raw_arguments": raw_arguments}
            tool_calls.append(
                ToolCall(
                    id=raw_call.get("id") or uuid4().hex,
                    name=_canonical_tool_name(function.get("name") or ""),
                    arguments=arguments,
                )
            )
        return ProviderTurn(
            text=_decode_content(message.get("content")).strip(),
            tool_calls=tool_calls,
        )

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

    async def complete_turn(
        self,
        *,
        history: list[ProviderMessage],
        settings: RunSettings,
        tools: list[ToolDefinition] | None = None,
    ) -> ProviderTurn:
        return await asyncio.to_thread(
            lambda: self._to_provider_turn(
                self._complete(
                    history=history,
                    user_input=None,
                    settings=settings,
                    tools=tools,
                )
            )
        )

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
        return (
            await asyncio.to_thread(
                lambda: self._to_provider_turn(
                    self._complete(
                        history=[],
                        user_input=title_prompt,
                        settings=settings,
                    )
                )
            )
        ).text
