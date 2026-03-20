from __future__ import annotations

from src.internal.providers.base import ToolDefinition


BROWSER_TOOL_DEFINITIONS: list[ToolDefinition] = [
    ToolDefinition(
        name="files.list",
        description=(
            "List browser-local files available for this page session. "
            "Use this first to inspect available file ids, reference names, original names, kinds, sizes, and sandbox paths."
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
            "without exposing full raw contents. File references can be ids or reference names from files.list."
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
            "Use this when you need selected excerpts instead of a structured table preview. "
            "The file_id field accepts either a file id or a reference name from files.list."
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
            "Preview a structured file such as CSV, TSV, JSON table data, XLS, or XLSX. "
            "Returns headers, row count hints, and a bounded sample. "
            "The file_id field accepts either a file id or a reference name from files.list."
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
            "and column dtypes without exposing full raw rows. "
            "The file_id field accepts either a file id or a reference name from files.list."
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
            "`pd`, `np`, `math`, `statistics`, `files`, `list_files()`, `file_info()`, "
            "`read_table(file_id_or_name)`, and `read_text(file_id_or_name)` are preloaded, so imports are optional. "
            "File ids and reference names from files.list work with those helpers; if you use raw pandas/open calls, "
            "first resolve the real sandbox path with `file_info(file_ref)['path']`. "
            "The tool returns structured output shaped like {'stdout': str, 'result': json, 'files': {...}}. "
            "Assign a value to `result` or leave a final bare expression when you want a structured return value. "
            "Example: df = read_table('data.csv'); s = pd.to_numeric(df['Electric Range'], errors='coerce'); "
            "result = {'mean': float(s.dropna().mean()), 'count_non_null': int(s.notna().sum())}. "
            "Use this as the default computation tool for attached datasets when the user asks for derived numbers "
            "such as averages, deltas, percent changes, regressions, forecasts, filters, rankings, or aggregations. "
            "Use raw Python only when the other file/table tools are insufficient and do not attempt network, "
            "process, or package-management access."
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
