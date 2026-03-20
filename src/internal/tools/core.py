from __future__ import annotations

from src.internal.providers.base import ToolDefinition


BROWSER_TOOL_DEFINITIONS: list[ToolDefinition] = [
    ToolDefinition(
        name="files.list",
        description=(
            "List browser-local files available for this page session. "
            "Use this first to inspect available file ids, names, kinds, sizes, and sandbox paths."
        ),
        parameters={
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    ),
    ToolDefinition(
        name="files.describe",
        description=(
            "Return metadata and a short content-oriented description for one or more browser-local files "
            "without exposing full raw contents."
        ),
        parameters={
            "type": "object",
            "properties": {
                "file_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                },
            },
            "required": ["file_ids"],
            "additionalProperties": False,
        },
    ),
    ToolDefinition(
        name="files.read_text",
        description=(
            "Extract bounded text from a text-like, PDF, or DOCX file. "
            "Use this when you need selected excerpts instead of a structured table preview."
        ),
        parameters={
            "type": "object",
            "properties": {
                "file_id": {"type": "string"},
                "max_chars": {"type": "integer", "minimum": 200, "maximum": 24000},
            },
            "required": ["file_id"],
            "additionalProperties": False,
        },
    ),
    ToolDefinition(
        name="tables.preview",
        description=(
            "Preview a structured file such as CSV, TSV, JSON table data, or XLSX. "
            "Returns headers, row count hints, and a bounded sample."
        ),
        parameters={
            "type": "object",
            "properties": {
                "file_id": {"type": "string"},
                "rows": {"type": "integer", "minimum": 1, "maximum": 25},
            },
            "required": ["file_id"],
            "additionalProperties": False,
        },
    ),
    ToolDefinition(
        name="tables.profile",
        description=(
            "Profile a structured dataset and return bounded summary statistics, null counts, "
            "and column dtypes without exposing full raw rows."
        ),
        parameters={
            "type": "object",
            "properties": {
                "file_id": {"type": "string"},
                "max_columns": {"type": "integer", "minimum": 1, "maximum": 32},
            },
            "required": ["file_id"],
            "additionalProperties": False,
        },
    ),
    ToolDefinition(
        name="python.execute",
        description=(
            "Execute constrained Python against browser-local files in the in-page Pyodide sandbox. "
            "Available files live under /session and can be discovered via files.list. "
            "Use only safe, bounded analysis code and do not attempt network, process, or package-management access."
        ),
        parameters={
            "type": "object",
            "properties": {
                "code": {"type": "string", "minLength": 1},
                "file_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                },
            },
            "required": ["code"],
            "additionalProperties": False,
        },
    ),
]


def browser_tool_definitions() -> list[ToolDefinition]:
    return [tool.model_copy(deep=True) for tool in BROWSER_TOOL_DEFINITIONS]
