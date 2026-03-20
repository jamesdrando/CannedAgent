const PYODIDE_VERSION = "0.29.3";
const PYODIDE_BASE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const CORE_PACKAGES = ["numpy", "pandas"];
const OPTIONAL_PACKAGE_LABELS = {
    docx: "lxml",
    pdf: "PyMuPDF",
    xlsx: "openpyxl",
};

let pyodide = null;
let readyPromise = null;
const sessionFiles = new Map();
const loadedOptionalPackages = new Set();
const optionalPackagePromises = new Map();

function removeFsPath(path) {
    if (!pyodide) return;
    const { FS } = pyodide;
    try {
        const stat = FS.analyzePath(path);
        if (!stat.exists) return;
        FS.unlink(path);
    } catch (error) {
        // Ignore filesystem cleanup races during resets.
    }
}

function resetSessionFiles() {
    for (const file of sessionFiles.values()) {
        removeFsPath(file.path);
    }
    sessionFiles.clear();
}

async function ensureOptionalPackage(kind) {
    if (!OPTIONAL_PACKAGE_LABELS[kind] || loadedOptionalPackages.has(kind)) return;
    if (optionalPackagePromises.has(kind)) {
        await optionalPackagePromises.get(kind);
        return;
    }

    const promise = (async () => {
        await ensureReady();
        if (kind === "docx") {
            await pyodide.loadPackage(["lxml"]);
        } else if (kind === "pdf") {
            await pyodide.loadPackage(["PyMuPDF"]);
        } else if (kind === "xlsx") {
            await pyodide.loadPackage(["micropip"]);
            await pyodide.runPythonAsync(`
import micropip
await micropip.install("openpyxl==3.1.5")
            `);
        }
        loadedOptionalPackages.add(kind);
    })();

    optionalPackagePromises.set(kind, promise);
    try {
        await promise;
    } finally {
        optionalPackagePromises.delete(kind);
    }
}

function selectedFilesForTool(tool, args = {}) {
    if (tool === "files.read_text" || tool === "tables.preview" || tool === "tables.profile") {
        const file = sessionFiles.get(args.file_id);
        return file ? [file] : [];
    }

    if (tool === "files.describe" || tool === "python.execute") {
        const requestedIds = Array.isArray(args.file_ids) && args.file_ids.length
            ? args.file_ids
            : [...sessionFiles.keys()];
        return requestedIds
            .map((fileId) => sessionFiles.get(fileId))
            .filter(Boolean);
    }

    return [];
}

async function ensureToolDependencies(tool, args = {}) {
    const files = selectedFilesForTool(tool, args);
    const kinds = [...new Set(files.map((file) => file.kind).filter(Boolean))];
    for (const kind of kinds) {
        await ensureOptionalPackage(kind);
    }
}

async function ensureReady() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
        importScripts(`${PYODIDE_BASE_URL}pyodide.js`);
        pyodide = await loadPyodide({ indexURL: PYODIDE_BASE_URL });
        await pyodide.loadPackage(CORE_PACKAGES);
        await pyodide.runPythonAsync(`
import ast
import io
import json
import math
import statistics
import zipfile
from collections import Counter
from contextlib import redirect_stdout
from pathlib import Path

import numpy as np
import pandas as pd

TEXT_KINDS = {"txt", "md", "json", "csv", "tsv"}
TABLE_KINDS = {"csv", "tsv", "json", "xlsx"}
ALLOWED_IMPORTS = {
    "collections",
    "csv",
    "datetime",
    "fitz",
    "io",
    "json",
    "lxml",
    "math",
    "numpy",
    "openpyxl",
    "pandas",
    "pathlib",
    "re",
    "statistics",
    "textwrap",
}
BLOCKED_IMPORT_PREFIXES = {
    "asyncio",
    "http",
    "importlib",
    "js",
    "micropip",
    "os",
    "pyodide",
    "requests",
    "socket",
    "subprocess",
    "sys",
    "urllib",
}
BLOCKED_CALLS = {"eval", "exec", "compile", "__import__", "input", "breakpoint"}
_NATIVE_IMPORT = __import__

def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root in BLOCKED_IMPORT_PREFIXES or root not in ALLOWED_IMPORTS:
        raise ImportError(f"Import '{root}' is not allowed.")
    return _NATIVE_IMPORT(name, globals, locals, fromlist, level)

SAFE_BUILTINS = {
    "__import__": _safe_import,
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "bytes": bytes,
    "dict": dict,
    "enumerate": enumerate,
    "Exception": Exception,
    "filter": filter,
    "float": float,
    "getattr": getattr,
    "hasattr": hasattr,
    "int": int,
    "isinstance": isinstance,
    "len": len,
    "list": list,
    "map": map,
    "max": max,
    "min": min,
    "next": next,
    "object": object,
    "open": open,
    "pow": pow,
    "print": print,
    "range": range,
    "reversed": reversed,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "type": type,
    "ValueError": ValueError,
    "zip": zip,
}

def _json_safe(value):
    if isinstance(value, dict):
        return {str(key): _json_safe(val) for key, val in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [_json_safe(item) for item in value]
    if value is None:
        return None
    if isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (np.generic,)):
        return value.item()
    if pd.isna(value):
        return None
    return str(value)

def _select_files(payload, file_ids):
    files = payload["files"]
    if not file_ids:
        return files
    wanted = set(file_ids)
    return [item for item in files if item["id"] in wanted]

def _resolve_file_reference(available_files, file_ref):
    if file_ref in available_files:
        return available_files[file_ref]
    matches = [item for item in available_files.values() if item["name"] == file_ref]
    if not matches:
        raise ValueError(f"Unknown file reference: {file_ref}")
    if len(matches) > 1:
        raise ValueError(f"Ambiguous file reference: {file_ref}")
    return matches[0]

def _load_json_table(path):
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        data = json.load(handle)
    if isinstance(data, list):
        return pd.DataFrame(data)
    if isinstance(data, dict):
        if all(isinstance(value, list) for value in data.values()):
            return pd.DataFrame(data)
        return pd.json_normalize(data)
    raise ValueError("JSON content is not tabular.")

def _load_dataframe(file_meta):
    kind = file_meta["kind"]
    path = file_meta["path"]
    if kind == "csv":
        return pd.read_csv(path)
    if kind == "tsv":
        return pd.read_csv(path, sep="\\t")
    if kind == "xlsx":
        return pd.read_excel(path, engine="openpyxl")
    if kind == "json":
        return _load_json_table(path)
    raise ValueError(f"{file_meta['name']} is not a structured table file.")

def _extract_docx_text(path):
    from lxml import etree

    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml")
    root = etree.fromstring(xml)
    text_nodes = root.xpath("//w:t/text()", namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"})
    return "\\n".join(fragment.strip() for fragment in text_nodes if fragment and fragment.strip())

def _extract_pdf_text(path):
    import fitz

    document = fitz.open(path)
    text_parts = []
    try:
        for page in document:
            text_parts.append(page.get_text("text"))
    finally:
        document.close()
    return "\\n".join(part.strip() for part in text_parts if part.strip())

def _read_text(file_meta, max_chars=6000):
    path = file_meta["path"]
    kind = file_meta["kind"]
    if kind in {"txt", "md", "csv", "tsv"}:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    elif kind == "json":
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            text = json.dumps(json.load(handle), indent=2)
    elif kind == "docx":
        text = _extract_docx_text(path)
    elif kind == "pdf":
        text = _extract_pdf_text(path)
    else:
        raise ValueError(f"Text extraction is not available for {file_meta['name']}.")
    return text[:max_chars]

def tool_files_describe(payload, args):
    items = []
    for file_meta in _select_files(payload, args.get("file_ids")):
        description = {
            "id": file_meta["id"],
            "name": file_meta["name"],
            "kind": file_meta["kind"],
            "size_bytes": file_meta["size_bytes"],
            "path": file_meta["path"],
        }
        if file_meta["kind"] in TABLE_KINDS:
            try:
                dataframe = _load_dataframe(file_meta)
                description["rows"] = int(len(dataframe.index))
                description["columns"] = [str(column) for column in dataframe.columns[:16]]
            except Exception as exc:
                description["note"] = str(exc)
        elif file_meta["kind"] in {"txt", "md", "json", "pdf", "docx"}:
            excerpt = _read_text(file_meta, 600)
            description["excerpt"] = excerpt
        items.append(description)
    summary = "; ".join(
        f"{item['name']} ({item['kind']})"
        + (f" rows={item['rows']}" if "rows" in item else "")
        for item in items
    )
    return {"output": {"files": items}, "summary_for_model": summary}

def tool_files_read_text(payload, args):
    file_id = args["file_id"]
    file_meta = next((item for item in payload["files"] if item["id"] == file_id), None)
    if file_meta is None:
        raise ValueError("Unknown file id.")
    max_chars = int(args.get("max_chars") or 6000)
    text = _read_text(file_meta, min(max_chars, 24000))
    return {
        "output": {
            "file": {
                "id": file_meta["id"],
                "name": file_meta["name"],
                "kind": file_meta["kind"],
            },
            "text": text,
        },
        "summary_for_model": f"Extracted text from {file_meta['name']} ({len(text)} chars).",
    }

def tool_tables_preview(payload, args):
    file_id = args["file_id"]
    file_meta = next((item for item in payload["files"] if item["id"] == file_id), None)
    if file_meta is None:
        raise ValueError("Unknown file id.")
    dataframe = _load_dataframe(file_meta)
    rows = max(1, min(int(args.get("rows") or 8), 25))
    preview = dataframe.head(rows).replace({np.nan: None}).to_dict(orient="records")
    return {
        "output": {
            "file": {
                "id": file_meta["id"],
                "name": file_meta["name"],
                "kind": file_meta["kind"],
            },
            "columns": [str(column) for column in dataframe.columns],
            "row_count": int(len(dataframe.index)),
            "preview": _json_safe(preview),
        },
        "summary_for_model": f"{file_meta['name']} has {len(dataframe.index)} rows and {len(dataframe.columns)} columns.",
    }

def tool_tables_profile(payload, args):
    file_id = args["file_id"]
    file_meta = next((item for item in payload["files"] if item["id"] == file_id), None)
    if file_meta is None:
        raise ValueError("Unknown file id.")
    dataframe = _load_dataframe(file_meta)
    max_columns = max(1, min(int(args.get("max_columns") or 16), 32))
    profile = {}
    for column in list(dataframe.columns)[:max_columns]:
        series = dataframe[column]
        column_profile = {
            "dtype": str(series.dtype),
            "null_count": int(series.isna().sum()),
            "non_null_count": int(series.notna().sum()),
        }
        if pd.api.types.is_numeric_dtype(series):
            numeric = series.dropna()
            if not numeric.empty:
                column_profile["min"] = _json_safe(numeric.min())
                column_profile["max"] = _json_safe(numeric.max())
                column_profile["mean"] = _json_safe(float(numeric.mean()))
        else:
            column_profile["top_values"] = _json_safe(
                series.dropna().astype(str).value_counts().head(5).to_dict()
            )
        profile[str(column)] = column_profile
    return {
        "output": {
            "file": {
                "id": file_meta["id"],
                "name": file_meta["name"],
                "kind": file_meta["kind"],
            },
            "row_count": int(len(dataframe.index)),
            "column_count": int(len(dataframe.columns)),
            "profile": profile,
        },
        "summary_for_model": f"Profiled {file_meta['name']} with {len(dataframe.columns)} columns.",
    }

def _validate_python(code):
    tree = ast.parse(code, mode="exec")
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.name.split(".")[0]
                if name in BLOCKED_IMPORT_PREFIXES or name not in ALLOWED_IMPORTS:
                    raise ValueError(f"Import '{name}' is not allowed.")
        if isinstance(node, ast.ImportFrom):
            module = (node.module or "").split(".")[0]
            if module in BLOCKED_IMPORT_PREFIXES or module not in ALLOWED_IMPORTS:
                raise ValueError(f"Import '{module or node.module}' is not allowed.")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in BLOCKED_CALLS:
                raise ValueError(f"Call to '{node.func.id}' is not allowed.")

def tool_python_execute(payload, args):
    code = args["code"]
    _validate_python(code)
    selected = _select_files(payload, args.get("file_ids"))
    available_files = {
        item["id"]: {
            "name": item["name"],
            "kind": item["kind"],
            "path": item["path"],
            "size_bytes": item["size_bytes"],
        }
        for item in selected
    }
    def list_files():
        return list(available_files.values())

    def file_info(file_ref):
        return dict(_resolve_file_reference(available_files, file_ref))

    def read_table(file_ref):
        return _load_dataframe(_resolve_file_reference(available_files, file_ref))

    def read_text(file_ref, max_chars=6000):
        file_meta = _resolve_file_reference(available_files, file_ref)
        return _read_text(file_meta, min(int(max_chars or 6000), 24000))

    stdout = io.StringIO()
    globals_dict = {
        "__builtins__": SAFE_BUILTINS,
        "files": available_files,
        "pd": pd,
        "np": np,
        "json": json,
        "math": math,
        "statistics": statistics,
        "Path": Path,
        "Counter": Counter,
        "list_files": list_files,
        "file_info": file_info,
        "read_table": read_table,
        "read_text": read_text,
    }
    locals_dict = {}
    with redirect_stdout(stdout):
        exec(compile(code, "<jobbr-python>", "exec"), globals_dict, locals_dict)
    result_value = locals_dict.get("result")
    text_output = stdout.getvalue().strip()
    result_payload = {
        "stdout": text_output[:12000],
        "result": _json_safe(result_value),
        "files": available_files,
    }
    summary = text_output[:4000] if text_output else json.dumps(_json_safe(result_value))[:4000]
    if not summary:
        summary = "Python completed without stdout. Inspect the structured result payload."
    return {"output": result_payload, "summary_for_model": summary}

def invoke_tool_json(tool_name, payload_json):
    payload = json.loads(payload_json)
    args = payload.get("args") or {}
    if tool_name == "files.describe":
        result = tool_files_describe(payload, args)
    elif tool_name == "files.read_text":
        result = tool_files_read_text(payload, args)
    elif tool_name == "tables.preview":
        result = tool_tables_preview(payload, args)
    elif tool_name == "tables.profile":
        result = tool_tables_profile(payload, args)
    elif tool_name == "python.execute":
        result = tool_python_execute(payload, args)
    else:
        raise ValueError(f"Unsupported tool: {tool_name}")
    return json.dumps(_json_safe(result))
        `);
        return {
            version: PYODIDE_VERSION,
            core_packages: CORE_PACKAGES,
            optional_packages_loaded: [...loadedOptionalPackages].map((kind) => OPTIONAL_PACKAGE_LABELS[kind]),
        };
    })();
    return readyPromise;
}

function listFilesOutput() {
    const files = [...sessionFiles.values()].map((file) => ({
        id: file.id,
        name: file.name,
        kind: file.kind,
        size_bytes: file.size_bytes,
        mime_type: file.mime_type,
        path: file.path,
    }));
    const summaryForModel = files.length
        ? files.map((file) => `${file.name} (${file.kind}) at ${file.path}`).join("; ")
        : "No browser-local files are currently loaded.";
    return {
        output: { files },
        summary_for_model: summaryForModel,
    };
}

function ensureDirectory(path) {
    const { FS, PATH } = pyodide;
    const directory = PATH.dirname(path);
    if (!FS.analyzePath(directory).exists) {
        FS.mkdirTree(directory);
    }
}

async function addFile(file, bytes) {
    await ensureReady();
    ensureDirectory(file.path);
    removeFsPath(file.path);
    pyodide.FS.writeFile(file.path, new Uint8Array(bytes));
    sessionFiles.set(file.id, file);
    return {
        id: file.id,
        path: file.path,
    };
}

async function invokePythonTool(tool, args) {
    await ensureReady();
    const payload = JSON.stringify({
        args,
        files: [...sessionFiles.values()].map((file) => ({
            id: file.id,
            name: file.name,
            kind: file.kind,
            size_bytes: file.size_bytes,
            mime_type: file.mime_type,
            path: file.path,
        })),
    });
    pyodide.globals.set("JOBBR_TOOL_NAME", tool);
    pyodide.globals.set("JOBBR_TOOL_PAYLOAD", payload);
    const raw = await pyodide.runPythonAsync("invoke_tool_json(JOBBR_TOOL_NAME, JOBBR_TOOL_PAYLOAD)");
    pyodide.globals.delete("JOBBR_TOOL_NAME");
    pyodide.globals.delete("JOBBR_TOOL_PAYLOAD");
    return JSON.parse(raw);
}

self.onmessage = async (event) => {
    const { id, type, args } = event.data || {};
    try {
        if (type === "init") {
            const output = await ensureReady();
            self.postMessage({ id, ok: true, output });
            return;
        }

        if (type === "reset_session") {
            await ensureReady();
            resetSessionFiles();
            self.postMessage({ id, ok: true, output: { cleared: true } });
            return;
        }

        if (type === "add_file") {
            const output = await addFile(args.file, args.bytes);
            self.postMessage({ id, ok: true, output });
            return;
        }

        if (type === "tool") {
            let output;
            if (args.tool === "files.list") {
                output = listFilesOutput();
            } else {
                await ensureToolDependencies(args.tool, args.args || {});
                output = await invokePythonTool(args.tool, args.args || {});
            }
            self.postMessage({ id, ok: true, output });
            return;
        }

        throw new Error(`Unsupported worker message type: ${type}`);
    } catch (error) {
        self.postMessage({
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
