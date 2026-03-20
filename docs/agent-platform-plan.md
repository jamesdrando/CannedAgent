# Agent Platform Plan

This document breaks the next evolution of CannedAgent into phases that fit the current codebase without turning it into a framework rewrite.

## Current shape

- The app is a single FastAPI service.
- The chat runtime is hard-wired to Google Gemini inside [src/app.py](/home/drandall/CannedAgent/src/app.py).
- The frontend is a single, well-composed chat screen in [src/pages/index.html](/home/drandall/CannedAgent/src/pages/index.html) with state management in [src/static/js/app.js](/home/drandall/CannedAgent/src/static/js/app.js).
- `src/internal/tools` and `src/internal/skills` are effectively empty, so we still have a clean chance to define the right boundaries.

## Design decisions

### 1. Use one unified app route, not separate routes per provider

Keep one chat/run API surface and hide provider differences behind adapters.

Recommended direction:

- Keep the app-facing API provider-agnostic.
- Use JSON request bodies, not query params.
- Avoid `/api/openrouter/...`, `/api/gemini/...`, etc.

Why:

- Query params are a bad fit for long system prompts, reasoning config, and future tool policies.
- Provider-specific routes leak vendor differences into the UI and multiply frontend state.
- A single route keeps the current UI simple and makes future providers cheap to add.

## 2. Introduce a run config model early

The app needs a first-class config object even before tools land.

Suggested shape:

```python
class RunConfig(BaseModel):
    provider: str
    model: str
    system_prompt: str | None = None
    temperature: float | None = None
    reasoning_effort: str | None = None
    reasoning_max_tokens: int | None = None
    allowed_tool_ids: list[str] = []
    workspace_profile_id: str | None = None
```

Notes:

- `system_prompt` must be user-controlled.
- `temperature` belongs here.
- OpenRouter reasoning should map to a normalized internal field, not provider-specific UI flags.
- We should support both defaults and per-chat overrides.

## 3. Preserve the current UI by adding a compact settings surface

Do not add a new settings page for daily use.

Recommended UX:

- Add a single "run settings" control to the conversation header or composer area.
- Open a right-side drawer on desktop.
- Open a bottom sheet on mobile.
- Keep the main chat composition flow untouched when the drawer is closed.

Contents of the settings surface:

- Provider
- Model
- System prompt
- Temperature
- Reasoning level
- Future tool policy / workspace target

This keeps the feel of the current UI while making advanced controls available only when needed.

## 4. Switch the internal runtime concept from "message" to "run"

The current endpoint is message-centric. Tools and agent execution will be run-centric.

Recommended public API direction:

- Keep the current message flow working while introducing a run abstraction.
- Migrate the frontend to a run endpoint before tool execution lands.

Suggested endpoint shape:

```text
POST /api/chats/{chat_id}/runs
GET  /api/chats/{chat_id}/settings
PATCH /api/chats/{chat_id}/settings
GET  /api/providers
GET  /api/me/preferences
PATCH /api/me/preferences
```

Suggested run request:

```json
{
  "input": "Build a login form",
  "config_override": {
    "provider": "openrouter",
    "model": "anthropic/claude-sonnet-4",
    "system_prompt": "You are a careful coding agent...",
    "temperature": 0.2,
    "reasoning_effort": "medium"
  }
}
```

## 5. Move streaming to structured events before tools

The current plain text stream is fine for chat-only responses, but it will become a dead end for agentic behavior.

Before tools, move to one of:

- SSE with typed events
- NDJSON with typed event objects

Recommended event types:

- `message.delta`
- `message.completed`
- `tool.call.started`
- `tool.call.stdout`
- `tool.call.completed`
- `run.status`
- `run.completed`
- `run.failed`

This is the main architectural move that keeps phase 2 from becoming a rewrite.

## Phase 0: Providers and configuration

Goal: make model/runtime choice a user-controlled feature without disrupting the existing experience.

### 0a. Extract provider adapters

Create a provider layer:

```text
src/internal/providers/
  __init__.py
  base.py
  gemini.py
  openrouter.py
  registry.py
```

Suggested interface:

```python
class ProviderAdapter(Protocol):
    provider_id: str

    async def stream_run(
        self,
        *,
        history: list[dict],
        user_input: str,
        config: RunConfig,
    ) -> AsyncIterator[RunEvent]:
        ...
```

What changes:

- Remove direct Gemini orchestration from the route handler.
- Move all provider-specific request/response mapping into adapters.
- Keep `src/app.py` focused on auth, persistence, and HTTP concerns.

### 0b. Add config persistence

Persist:

- user defaults
- chat-level effective settings snapshot

Recommended data additions:

- `UserPreferences` table or JSON field for defaults
- `ChatSettings` table or JSON field for per-chat settings

The important behavior is:

- new chats inherit user defaults
- a chat can diverge from the defaults without surprise
- old chats remain reproducible even after defaults change

### 0c. Add OpenRouter support

OpenRouter should be the second provider after Gemini.

Why it fits:

- It gives access to multiple upstream model families behind one integration.
- It normalizes request/response shape across many providers.
- It supports streaming and a unified reasoning config.

Implementation notes:

- Treat OpenRouter as one provider adapter in our system.
- The model picker should expose full model IDs.
- Reasoning should be exposed as normalized app fields, then translated by the adapter.
- If a selected model ignores a parameter, the adapter should degrade gracefully and report capabilities.

### 0d. Add provider capability discovery

Create a backend endpoint that returns supported providers, models, and config capabilities to the frontend.

Example capability payload:

```json
{
  "providers": [
    {
      "id": "gemini",
      "label": "Google Gemini",
      "models": [
        {
          "id": "gemini-3.1-flash-lite-preview",
          "label": "Gemini 3.1 Flash Lite",
          "supports_temperature": true,
          "supports_reasoning": false
        }
      ]
    },
    {
      "id": "openrouter",
      "label": "OpenRouter",
      "models": [
        {
          "id": "openai/gpt-5",
          "supports_temperature": true,
          "supports_reasoning": true
        }
      ]
    }
  ]
}
```

This lets the UI stay clean without hard-coding vendor rules into browser logic.

## Phase 1: Controlled execution environments

Goal: give agents a place to edit code and run commands without giving them uncontrolled host access.

### 1a. Use Podman first

Start with Podman, not Firecracker.

Why:

- It is much simpler to operationalize.
- Rootless execution is a strong baseline.
- It is enough for a single-tenant or lightly shared first release.

### 1b. Treat the runtime as a remote workspace service

Do not let the web app talk to Docker or Podman sockets directly from request handlers.

Instead:

- web app creates a workspace request
- workspace control plane provisions the environment
- tools operate against that workspace through a narrow API

Suggested components:

```text
app server
  -> workspace manager
  -> podman host
```

Workspace manager responsibilities:

- create workspace
- attach repo or starter template
- enforce cpu/memory/time limits
- mount writable project volume only
- disable privileged mode
- disable host socket access
- control outbound network policy
- destroy expired workspaces

### 1c. Define a strict workspace contract

Every workspace should be defined by an explicit profile:

```json
{
  "id": "python-web-safe",
  "base_image": "ghcr.io/our/workspace-python-web:latest",
  "cpu_limit": 2,
  "memory_mb": 2048,
  "network_mode": "restricted",
  "filesystem_policy": {
    "workspace_root": "/workspace",
    "writable_paths": ["/workspace"],
    "read_only_paths": ["/usr", "/bin", "/lib"]
  },
  "allowed_tools": ["read_file", "write_file", "run_tests", "list_files"]
}
```

This becomes the bridge between product UX and enforcement.

### 1d. Add auditability from day one

Log:

- workspace creation
- tool invocation
- command arguments
- stdout/stderr summaries
- file write operations
- approval events

If we do not add this early, trust and debugging get painful fast.

### 1e. Firecracker later if needed

Move to Firecracker only if:

- you want strong multi-tenant isolation between unrelated users
- you need VM-grade security boundaries
- Podman hardening is no longer enough for the threat model

Firecracker is a better isolation story, but it is not the easiest first platform.

## Phase 2: Tools, harness, and skills

Goal: turn the app from "chat with a model" into "controlled agent runtime".

### 2a. Create a tool registry

Suggested structure:

```text
src/internal/tools/
  __init__.py
  core.py
  registry.py
  filesystem.py
  process.py
  git.py
  search.py
  deploy.py
```

Each tool should declare:

- stable tool ID
- JSON schema input
- timeout
- workspace requirements
- approval policy
- redactable output behavior

### 2b. Introduce a harness loop

The harness should own:

- model call
- tool call execution
- retries / repair loops
- step budget
- token budget
- approval gating
- event streaming back to the UI

This must be separate from provider adapters. Providers generate tool calls; the harness decides whether and how they run.

### 2c. Skills are policy bundles, not just prompts

Recommended skill contents:

- system prompt fragment
- allowed tools
- workspace profile
- starter files / templates
- optional post-run checks

That makes a skill a repeatable operating mode instead of a text snippet.

### 2d. Launch with a deliberately small toolset

First tools should be:

- list files
- read file
- write file
- apply patch
- run tests
- search code

Delay risky tools until later:

- arbitrary shell
- package install without approval
- unrestricted network
- host git credential access
- deploy-anything commands

## Suggested delivery order

### Milestone A

- extract provider adapters
- add run config model
- add user defaults

### Milestone B

- add OpenRouter
- add settings drawer in the current UI
- add provider capability endpoint

### Milestone C

- migrate stream format to structured events
- introduce run abstraction

### Milestone D

- add workspace manager with rootless Podman
- support remote workspace provisioning

### Milestone E

- add file and test tools
- add harness loop
- add skill definitions and policy enforcement

## Strong recommendations

- Do not use query params for provider configuration.
- Do not create separate provider routes.
- Do not let the browser or chat route know provider-specific parameter names.
- Do not expose Docker or Podman sockets to the model.
- Do not wait until tools land to adopt structured streaming.

## Short version

The least explosive path is:

1. one provider-agnostic API
2. one normalized config model
3. one compact settings drawer in the current UI
4. Podman-backed remote workspaces before arbitrary tools
5. a harness plus tool registry after the workspace boundary exists
