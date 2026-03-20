from __future__ import annotations

from src.internal.providers.base import (
    DEFAULT_PROVIDER_ID,
    DEFAULT_USER_SYSTEM_PROMPT,
    ProviderCapability,
    RunSettings,
    RunSettingsPatch,
    normalize_user_system_prompt,
)
from src.internal.providers.gemini import GeminiProviderAdapter
from src.internal.providers.openai import OpenAIProviderAdapter
from src.internal.providers.openrouter import OpenRouterProviderAdapter


class ProviderRegistry:
    def __init__(self) -> None:
        adapters = [
            OpenAIProviderAdapter(),
            GeminiProviderAdapter(),
            OpenRouterProviderAdapter(),
        ]
        self._adapters = {adapter.provider_id: adapter for adapter in adapters}

    def capabilities(self) -> list[ProviderCapability]:
        return [adapter.capability() for adapter in self._adapters.values()]

    def adapter_for(self, provider_id: str):
        return self._adapters.get(provider_id)

    def capability_for(self, provider_id: str) -> ProviderCapability | None:
        adapter = self.adapter_for(provider_id)
        return adapter.capability() if adapter else None

    def default_capability(self) -> ProviderCapability:
        preferred = self.capability_for(DEFAULT_PROVIDER_ID)
        if preferred and preferred.configured:
            return preferred

        for capability in self.capabilities():
            if capability.configured:
                return capability

        fallback = preferred
        if fallback:
            return fallback

        first_adapter = next(iter(self._adapters.values()))
        return first_adapter.capability()

    def normalize_settings(self, value: RunSettings | RunSettingsPatch | dict | None = None) -> RunSettings:
        data: dict = {}
        if isinstance(value, (RunSettings, RunSettingsPatch)):
            data = value.model_dump(exclude_unset=True)
        elif isinstance(value, dict):
            data = dict(value)

        capability = self.capability_for(str(data.get("provider") or "").strip()) or self.default_capability()
        provider = capability.id
        model = str(data.get("model") or "").strip() or capability.default_model
        if not capability.allow_custom_models:
            allowed_model_ids = {model.id for model in capability.models}
            if model not in allowed_model_ids:
                model = capability.default_model
        system_prompt = normalize_user_system_prompt(data.get("system_prompt")) or DEFAULT_USER_SYSTEM_PROMPT
        temperature = data.get("temperature")
        reasoning_effort = data.get("reasoning_effort")

        if not capability.supports_temperature:
            temperature = None
        if reasoning_effort not in capability.reasoning_efforts:
            reasoning_effort = None

        return RunSettings(
            provider=provider,
            model=model,
            system_prompt=system_prompt,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    def merge_settings(self, base: RunSettings, override: RunSettingsPatch | None) -> RunSettings:
        if override is None:
            return self.normalize_settings(base)

        data = base.model_dump()
        override_data = override.model_dump(exclude_unset=True)
        if "provider" in override_data and "model" not in override_data:
            data["model"] = ""
        for key, value in override_data.items():
            data[key] = value
        return self.normalize_settings(data)
