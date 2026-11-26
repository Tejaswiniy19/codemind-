"""Deterministic, non-executing project analysis adapters.

This module intentionally uses only Python's standard library. Source files are
treated as bytes/text data: no project code is imported, evaluated, or run.
"""

from __future__ import annotations

import ast
import io
import json
import os
import re
import zipfile
import zlib
from array import array
from bisect import bisect_right
from collections import Counter, defaultdict
from pathlib import PurePosixPath
from typing import Any, Dict, List, Optional, Set, Tuple


MAX_ARCHIVE_EXPANDED = int(os.environ.get("CODEMIND_MAX_EXPANDED_BYTES", 500 * 1024 * 1024))
MAX_SOURCE_FILE = int(os.environ.get("CODEMIND_MAX_ANALYSIS_FILE_BYTES", 512 * 1024))
MAX_TOTAL_ANALYSIS_BYTES = int(os.environ.get("CODEMIND_MAX_TOTAL_ANALYSIS_BYTES", 64 * 1024 * 1024))
MAX_ANALYZED_FILES = int(os.environ.get("CODEMIND_MAX_ANALYSIS_FILES", 20_000))
MAX_AST_NODES_PER_FILE = 100_000
MAX_SYMBOLS = 10_000
MAX_RELATIONSHIPS = 15_000
MAX_IMPORTS = 10_000
MAX_SYMBOLS_PER_FILE = 1_000
MAX_RELATIONSHIPS_PER_FILE = 1_500
MAX_PARSE_ERRORS = 500
MAX_FRAMEWORK_SIGNALS = 2_000
MAX_RESULT_JSON_BYTES = 8 * 1024 * 1024
IGNORED_PARTS = {
    ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build",
    "target", "__pycache__", ".venv", "venv", "coverage", ".next",
}
SOURCE_EXTENSIONS = {
    ".py": "Python",
    ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
    ".java": "Java",
}
KNOWN_UNSUPPORTED_CODE_EXTENSIONS = {
    ".go", ".rs", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".php", ".rb",
    ".swift", ".kt", ".kts", ".scala", ".sql", ".sh", ".dart", ".ex", ".exs",
}
MANIFEST_NAMES = {
    "package.json", "pyproject.toml", "requirements.txt", "pom.xml", "build.gradle",
    "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties",
}


def analyze_snapshot(archive_path: str) -> Dict[str, Any]:
    """Analyze a stored ZIP snapshot and return JSON-serializable evidence.

    Python uses the standard-library AST. JavaScript, TypeScript, and Java use
    bounded lexical patterns, so their output is marked as partial lexical
    analysis and must not be interpreted as complete semantic resolution.
    """
    documents: Dict[str, str] = {}
    language_counts: Counter[str] = Counter()
    file_extensions: Counter[str] = Counter()
    total_uncompressed = 0
    entry_count = 0
    ignored_count = 0
    oversized_count = 0
    budget_skipped_count = 0
    binary_skipped_count = 0
    analysis_input_bytes = 0
    project_paths: Set[str] = set()
    manifest_documents: Dict[str, str] = {}
    active_extensions: Counter[str] = Counter()

    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            for member in sorted(archive.infolist(), key=lambda item: item.filename):
                if member.is_dir():
                    continue
                entry_count += 1
                if entry_count > MAX_ANALYZED_FILES:
                    raise ValueError("Snapshot contains more files than the analysis limit.")
                total_uncompressed += member.file_size
                if total_uncompressed > MAX_ARCHIVE_EXPANDED:
                    raise ValueError("Snapshot exceeds the configured expanded-size analysis limit.")
                path = _normalize_path(member.filename)
                project_paths.add(path)
                extension = PurePosixPath(path).suffix.lower() or "[no extension]"
                file_extensions[extension] += 1
                parts = PurePosixPath(path).parts
                if any(part.lower() in IGNORED_PARTS for part in parts):
                    ignored_count += 1
                    continue
                active_extensions[extension] += 1
                extension = PurePosixPath(path).suffix.lower()
                language = SOURCE_EXTENSIONS.get(extension)
                base = PurePosixPath(path).name.lower()
                if language:
                    language_counts[language] += 1
                if not language and base not in MANIFEST_NAMES:
                    continue
                if member.file_size > MAX_SOURCE_FILE:
                    oversized_count += 1
                    continue
                if analysis_input_bytes + member.file_size > MAX_TOTAL_ANALYSIS_BYTES:
                    budget_skipped_count += 1
                    continue
                # ZIP metadata is attacker-controlled. Read selected entries
                # through a bounded stream and account for the bytes actually
                # produced, rather than trusting file_size for allocation.
                remaining_budget = MAX_TOTAL_ANALYSIS_BYTES - analysis_input_bytes
                read_limit = min(MAX_SOURCE_FILE, remaining_budget) + 1
                with archive.open(member, "r") as stream:
                    raw = stream.read(read_limit)
                if len(raw) > MAX_SOURCE_FILE:
                    oversized_count += 1
                    continue
                if len(raw) > remaining_budget:
                    budget_skipped_count += 1
                    continue
                analysis_input_bytes += len(raw)
                if b"\x00" in raw:
                    binary_skipped_count += 1
                    continue
                try:
                    source = raw.decode("utf-8-sig")
                    documents[path] = source
                    if base in MANIFEST_NAMES:
                        manifest_documents[path] = source
                except UnicodeDecodeError:
                    # Do not guess at encodings and risk misleading locations.
                    binary_skipped_count += 1
                    continue
    except (OSError, EOFError, zipfile.BadZipFile, RuntimeError, zlib.error) as exc:
        raise ValueError("The immutable source snapshot could not be safely analyzed.") from exc

    files: List[Dict[str, Any]] = []
    symbols: List[Dict[str, Any]] = []
    relationships: List[Dict[str, Any]] = []
    parse_errors: List[Dict[str, str]] = []
    module_to_files: Dict[str, Set[str]] = defaultdict(set)
    definitions_by_name: Dict[str, Set[str]] = defaultdict(set)
    pending_imports: List[Dict[str, Any]] = []
    framework_signals: List[Dict[str, Any]] = []
    limits = {"symbols_omitted": 0, "relationships_omitted": 0, "imports_omitted": 0, "parse_errors_omitted": 0, "framework_signals_omitted": 0, "ast_nodes_truncated_files": 0, "current_symbols": 0, "current_relationships": 0, "current_imports": 0}
    analyzed_source_files = 0
    python_parse_error_count = 0

    for path in sorted(documents):
        source = documents.pop(path)
        language = SOURCE_EXTENSIONS.get(PurePosixPath(path).suffix.lower())
        if not language:
            if PurePosixPath(path).name.lower() in MANIFEST_NAMES:
                role, confidence = _classify_role(path)
                files.append({
                    "path": path,
                    "language": "Configuration",
                    "lines": source.count("\n") + (1 if source and not source.endswith("\n") else 0),
                    "role": role,
                    "role_confidence": confidence,
                    "role_evidence": _role_evidence(path),
                    "parser": "manifest_inventory",
                })
            del source
            continue
        module = _module_name(path, language)
        if module:
            module_to_files[module].add(path)
        role, role_confidence = _classify_role(path)
        file_record: Dict[str, Any] = {
            "path": path,
            "language": language,
            "lines": source.count("\n") + (1 if source and not source.endswith("\n") else 0),
            "role": role,
            "role_confidence": role_confidence,
            "role_evidence": _role_evidence(path),
            "parser": "python_ast" if language == "Python" else "bounded_lexical_patterns",
        }
        files.append(file_record)
        analyzed_source_files += 1
        if language == "Python":
            try:
                tree = ast.parse(source, filename=path, type_comments=True)
            except (SyntaxError, ValueError, RecursionError, MemoryError, OverflowError):
                python_parse_error_count += 1
                if len(parse_errors) < MAX_PARSE_ERRORS:
                    parse_errors.append({"path": path, "reason": "Python syntax could not be parsed within analysis limits."})
                else:
                    limits["parse_errors_omitted"] += 1
                del source
                continue
            limits["current_symbols"] = limits["current_relationships"] = limits["current_imports"] = 0
            _python_file(path, tree, symbols, pending_imports, relationships, definitions_by_name, framework_signals, limits)
            del tree
        else:
            limits["current_symbols"] = limits["current_relationships"] = limits["current_imports"] = 0
            _lexical_file(path, source, language, symbols, pending_imports, relationships, definitions_by_name, framework_signals, limits)
        del source

    # Resolve only exact, statically visible imports. Dynamic/reflection-based
    # links remain unresolved rather than being fabricated.
    for item in pending_imports:
        source_path = item["source_path"]
        module = item["module"]
        target = _resolve_module(source_path, module, item["language"], module_to_files, project_paths)
        _append_limited(relationships, {
            "source_path": source_path,
            "target_path": target,
            "type": "imports",
            "target_module": module,
            "resolved": target is not None,
            "confidence": 0.9 if target else 0.25,
            "evidence": item["evidence"],
        }, MAX_RELATIONSHIPS, limits, "relationships_omitted")

    # Resolve calls only when the extracted name maps to a single file. The
    # result is still marked as a lexical/AST call-site inference.
    for call in relationships:
        if call.get("type") != "calls_symbol":
            continue
        candidates = definitions_by_name.get(call["target_name"], set()) - {call["source_path"]}
        if len(candidates) == 1:
            call["target_path"] = next(iter(candidates))
            call["resolved"] = True
            call["confidence"] = 0.55
        elif not candidates and call["target_name"] in definitions_by_name:
            call["target_path"] = call["source_path"]
            call["resolved"] = True
            call["confidence"] = 0.5
        else:
            call["target_path"] = None
            call["resolved"] = False
            call["confidence"] = 0.2

    frameworks = _detect_frameworks(manifest_documents, framework_signals)
    features, features_omitted = _discover_features(files, symbols, relationships)
    lang_coverage = _coverage(files, language_counts, ignored_count, oversized_count, budget_skipped_count, binary_skipped_count, active_extensions)
    total_symbols = len(symbols)
    total_relationships = len(relationships)
    key_file_roles = {"Build or dependency configuration", "Project documentation", "Likely application entry point", "Likely API route or handler", "Likely service or business logic", "Likely data model or persistence", "Likely UI component or page", "Test file", "Database migration"}
    key_file_candidates = [item for item in files if item["role"] in key_file_roles]
    key_files = [{"path": item["path"], "role": item["role"], "confidence": item["role_confidence"], "evidence": item.get("role_evidence")} for item in key_file_candidates[:200]]
    manifest_candidates = [item["path"] for item in files if item["role"] == "Build or dependency configuration"]
    manifests = manifest_candidates[:500]
    extension_items = sorted(file_extensions.items(), key=lambda item: (-item[1], item[0]))
    extension_output = dict(extension_items[:200])
    result = {
        "schema_version": 1,
        "analysis_mode": "static_only",
        "file_count": entry_count,
        "analyzed_files": len(files),
        "analyzed_source_files": analyzed_source_files,
        "skipped_ignored_files": ignored_count,
        "skipped_oversized_files": oversized_count,
        "skipped_analysis_budget_files": budget_skipped_count,
        "skipped_binary_or_non_utf8_files": binary_skipped_count,
        "analysis_input_bytes": analysis_input_bytes,
        "extensions": extension_output,
        "extensions_omitted": max(0, len(extension_items) - len(extension_output)),
        "manifests": manifests,
        "manifests_omitted": max(0, len(manifest_candidates) - len(manifests)),
        "key_files": key_files,
        "key_files_omitted": max(0, len(key_file_candidates) - len(key_files)),
        "languages": lang_coverage,
        "frameworks": frameworks,
        "files": files,
        "symbols": symbols,
        "relationships": relationships,
        "symbol_count": total_symbols,
        "relationship_count": total_relationships,
        "count_semantics": "Counts report extracted entities only. Candidates omitted by caps are counted separately; files cut off by the AST node limit may contain additional unobserved entities.",
        "symbols_omitted": limits["symbols_omitted"],
        "relationships_omitted": limits["relationships_omitted"],
        "imports_omitted": limits["imports_omitted"],
        "python_files_ast_capped": limits["ast_nodes_truncated_files"],
        "python_parse_error_count": python_parse_error_count,
        "parse_errors_omitted": limits["parse_errors_omitted"],
        "framework_signals_omitted": limits["framework_signals_omitted"],
        "results_truncated": any(limits[key] for key in limits if key.endswith("_omitted") or key == "ast_nodes_truncated_files") or features_omitted > 0 or len(key_file_candidates) > len(key_files) or len(manifest_candidates) > len(manifests) or len(extension_items) > len(extension_output),
        "analysis_incomplete": bool(oversized_count or budget_skipped_count or binary_skipped_count or python_parse_error_count or features_omitted or len(key_file_candidates) > len(key_files) or len(manifest_candidates) > len(manifests) or len(extension_items) > len(extension_output) or any(limits[key] for key in limits if key.endswith("_omitted") or key == "ast_nodes_truncated_files")),
        "payload_omitted": {"files": 0, "symbols": 0, "relationships": 0, "features": 0},
        "features": features,
        "features_omitted": features_omitted,
        "parse_errors": parse_errors[:500],
        "limitations": [
            "Python symbols and imports use the Python AST; Python runtime behavior is not executed.",
            "JavaScript, TypeScript, and Java parsing uses bounded lexical patterns, not a compiler-grade parser.",
            "Dynamic imports, reflection, dependency injection, generated code, and runtime-only links may be missing.",
            "Role and feature groupings are structural heuristics. Review source and runtime behavior before changing or removing files.",
        ],
    }
    # Keep the public response bounded even when a valid snapshot contains
    # many short paths and declarations. Drop lower-priority detail in a
    # deterministic order while retaining summary counts and evidence flags.
    for field in ("files", "symbols", "relationships", "features"):
        if len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= MAX_RESULT_JSON_BYTES:
            break
        values = result[field]
        keep = len(values) // 2
        result["payload_omitted"][field] += len(values) - keep
        result[field] = values[:keep]
        result["results_truncated"] = True
        result["analysis_incomplete"] = True
    while len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_RESULT_JSON_BYTES:
        reduced = False
        for field in ("files", "symbols", "relationships", "features"):
            values = result[field]
            if values:
                keep = len(values) // 2
                result["payload_omitted"][field] += len(values) - keep
                result[field] = values[:keep]
                reduced = True
                break
        if not reduced:
            # Fixed-size metadata and pathological individual path/evidence
            # strings should still fail safely rather than emit an oversized
            # response or spin forever.
            raise ValueError("Analysis result exceeds the configured response-size limit.")
        result["results_truncated"] = True
        result["analysis_incomplete"] = True
    return result


def _normalize_path(value: str) -> str:
    path = value.replace("\\", "/")
    parts = path.split("/")
    if (not path or path.startswith("/") or len(path) > 1024
            or ":" in path or any(char in '<>"|?*' for char in path)
            or any(part in ("", ".", "..") for part in parts)
            or any(len(part) > 255 or part.endswith((".", " ")) for part in parts)
            or any(ord(char) < 32 for char in path)):
        raise ValueError("Unsafe path in source snapshot.")
    return "/".join(parts)


def _module_name(path: str, language: str) -> str:
    pure = PurePosixPath(path)
    stem = pure.stem
    if language == "Python" and stem == "__init__":
        stem = ""
    parts = list(pure.parent.parts) + ([stem] if stem else [])
    if parts and parts[0] == "src":
        parts = parts[1:]
    return ".".join(part for part in parts if part)


def _classify_role(path: str) -> Tuple[str, float]:
    parts = [part.lower() for part in PurePosixPath(path).parts]
    name = parts[-1]
    if name in MANIFEST_NAMES or name in {"dockerfile", "docker-compose.yml", "compose.yml", "makefile"}:
        return "Build or dependency configuration", 0.98
    if name.startswith("readme"):
        return "Project documentation", 0.98
    if name in {"main.py", "app.py", "manage.py", "asgi.py", "wsgi.py", "main.js", "main.jsx", "main.ts", "main.tsx", "index.js", "index.jsx", "index.ts", "index.tsx", "server.js", "server.ts", "main.go", "application.java", "program.cs"}:
        return "Likely application entry point", 0.62
    if any(part in {"route", "routes", "router", "routers", "controller", "controllers", "handler", "handlers", "api"} for part in parts[:-1]):
        return "Likely API route or handler", 0.42
    if any(part in {"service", "services", "usecases", "use_cases"} for part in parts[:-1]):
        return "Likely service or business logic", 0.42
    if any(part in {"model", "models", "entity", "entities", "schema", "schemas", "repository", "repositories"} for part in parts[:-1]):
        return "Likely data model or persistence", 0.42
    if any(part in {"component", "components", "page", "pages", "view", "views"} for part in parts[:-1]):
        return "Likely UI component or page", 0.42
    if any(part in {"test", "tests", "__tests__"} for part in parts[:-1]) or name.startswith("test_") or ".test." in name or ".spec." in name:
        return "Test file", 0.86
    if "migration" in parts[:-1] or "migrations" in parts[:-1]:
        return "Database migration", 0.82
    return "Source module", 0.2


def _role_evidence(path: str) -> Dict[str, str]:
    """Return the concrete filename/path clue behind a heuristic role."""
    parts = [part.lower() for part in PurePosixPath(path).parts]
    name = parts[-1]
    if name in MANIFEST_NAMES or name in {"dockerfile", "docker-compose.yml", "compose.yml", "makefile"}:
        clue = "Recognized build, dependency, or container configuration filename: " + name
    elif name.startswith("readme"):
        clue = "Filename starts with README."
    elif name in {"main.py", "app.py", "manage.py", "asgi.py", "wsgi.py", "main.js", "main.jsx", "main.ts", "main.tsx", "index.js", "index.jsx", "index.ts", "index.tsx", "server.js", "server.ts", "main.go", "application.java", "program.cs"}:
        clue = "Filename matches a conventional application entry-point name: " + name
    elif any(part in {"route", "routes", "router", "routers", "controller", "controllers", "handler", "handlers", "api"} for part in parts[:-1]):
        clue = "Path contains a route, controller, handler, or API directory."
    elif any(part in {"service", "services", "usecases", "use_cases"} for part in parts[:-1]):
        clue = "Path contains a service or use-case directory."
    elif any(part in {"model", "models", "entity", "entities", "schema", "schemas", "repository", "repositories"} for part in parts[:-1]):
        clue = "Path contains a model, schema, entity, or repository directory."
    elif any(part in {"component", "components", "page", "pages", "view", "views"} for part in parts[:-1]):
        clue = "Path contains a UI component, page, or view directory."
    elif any(part in {"test", "tests", "__tests__"} for part in parts[:-1]) or name.startswith("test_") or ".test." in name or ".spec." in name:
        clue = "Path or filename matches a common test-file convention."
    elif "migration" in parts[:-1] or "migrations" in parts[:-1]:
        clue = "Path contains a migration directory."
    else:
        clue = "No recognized role naming pattern; treated as a source module."
    return {"path": path, "method": "path_heuristic", "claim": clue}


def _python_file(path: str, tree: ast.AST, symbols: List[Dict[str, Any]], imports: List[Dict[str, Any]], relationships: List[Dict[str, Any]], names: Dict[str, Set[str]], framework_signals: List[Dict[str, Any]], limits: Dict[str, int]) -> None:
    nodes, nodes_truncated = _bounded_ast_nodes(tree, MAX_AST_NODES_PER_FILE)
    if nodes_truncated:
        limits["ast_nodes_truncated_files"] += 1
    for node in nodes:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            kind = "class" if isinstance(node, ast.ClassDef) else ("async_function" if isinstance(node, ast.AsyncFunctionDef) else "function")
            qualified = node.name
            symbol = _symbol(path, qualified, kind, node.lineno, getattr(node, "end_lineno", node.lineno), "python_ast", node.name)
            if _append_limited(symbols, symbol, MAX_SYMBOLS, limits, "symbols_omitted", "current_symbols", MAX_SYMBOLS_PER_FILE):
                names[node.name].add(path)
            for decorator in getattr(node, "decorator_list", []):
                decorator_name = _ast_name(decorator.func if isinstance(decorator, ast.Call) else decorator)
                if decorator_name and re.search(r"\.(get|post|put|patch|delete|route|api_route)$", decorator_name):
                    route = _literal_first_arg(decorator)
                    _append_limited(framework_signals, {"name": _framework_from_decorator(decorator_name), "path": path, "line": decorator.lineno, "detail": "route decorator"}, MAX_FRAMEWORK_SIGNALS, limits, "framework_signals_omitted")
                    if route:
                        _append_limited(relationships, {
                            "source_path": path, "target_path": None, "type": "defines_route",
                            "target_name": route, "resolved": False, "confidence": 0.92,
                            "evidence": {"path": path, "line_start": decorator.lineno, "line_end": decorator.lineno, "method": "python_ast", "claim": "Route decorator with literal path"},
                        }, MAX_RELATIONSHIPS, limits, "relationships_omitted", "current_relationships", MAX_RELATIONSHIPS_PER_FILE)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            if isinstance(node, ast.Import):
                module_names = [alias.name for alias in node.names]
            else:
                base = ("." * node.level) + (node.module or "")
                if node.module:
                    module_names = [base]
                else:
                    module_names = [base + alias.name for alias in node.names if alias.name != "*"] or [base]
            for module in module_names:
                if module:
                    _append_limited(imports, {"source_path": path, "module": module, "language": "Python", "evidence": {"path": path, "line_start": node.lineno, "line_end": node.lineno, "method": "python_ast", "claim": "Python import statement"}}, MAX_IMPORTS, limits, "imports_omitted", "current_imports", MAX_RELATIONSHIPS_PER_FILE)
        elif isinstance(node, ast.Call):
            name = _ast_name(node.func)
            if name:
                leaf = name.rsplit(".", 1)[-1]
                _append_limited(relationships, {
                    "source_path": path, "target_path": None, "type": "calls_symbol",
                    "target_name": leaf, "resolved": False, "confidence": 0.2,
                    "evidence": {"path": path, "line_start": node.lineno, "line_end": node.lineno, "method": "python_ast", "claim": "Call expression; target resolution is name-based"},
                }, MAX_RELATIONSHIPS, limits, "relationships_omitted", "current_relationships", MAX_RELATIONSHIPS_PER_FILE)
        # Signal common frameworks from AST identifiers without importing packages.
        if isinstance(node, ast.Name) and node.id in {"FastAPI", "Flask", "Django"}:
            _append_limited(framework_signals, {"name": node.id, "path": path, "line": getattr(node, "lineno", 1), "detail": "framework identifier"}, MAX_FRAMEWORK_SIGNALS, limits, "framework_signals_omitted")


def _lexical_file(path: str, source: str, language: str, symbols: List[Dict[str, Any]], imports: List[Dict[str, Any]], relationships: List[Dict[str, Any]], names: Dict[str, Set[str]], framework_signals: List[Dict[str, Any]], limits: Dict[str, int]) -> None:
    line_starts = array("I", [0])
    line_starts.extend(index + 1 for index, character in enumerate(source) if character == "\n")
    if language in {"JavaScript", "TypeScript"}:
        import_pattern = re.compile(r"^\s*(?:import\s+(?:[^'\";]*?\s+from\s+)?|export\s+[^'\";]*?\s+from\s+|(?:const|let|var)\s+[^=]+?=\s*require\s*\()\s*['\"]([^'\"]+)['\"]", re.MULTILINE)
        for match in import_pattern.finditer(source):
            specifier = match.group(1)
            line = bisect_right(line_starts, match.start())
            _append_limited(imports, {"source_path": path, "module": specifier, "language": language, "evidence": {"path": path, "line_start": line, "line_end": line, "method": "lexical_pattern", "claim": "JavaScript/TypeScript import specifier"}}, MAX_IMPORTS, limits, "imports_omitted", "current_imports", MAX_RELATIONSHIPS_PER_FILE)
        patterns = [
            ("class", re.compile(r"\bclass\s+([A-Za-z_$][\w$]*)")),
            ("function", re.compile(r"\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(")),
            ("function", re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>")),
        ]
        for kind, pattern in patterns:
            for match in pattern.finditer(source):
                name = match.group(1)
                line = bisect_right(line_starts, match.start())
                if _append_limited(symbols, _symbol(path, name, kind, line, line, "lexical_pattern", name), MAX_SYMBOLS, limits, "symbols_omitted", "current_symbols", MAX_SYMBOLS_PER_FILE):
                    names[name].add(path)
        for match in re.finditer(r"\b(?:app|router|server)\.(get|post|put|patch|delete|use)\s*\(\s*['\"]([^'\"]+)['\"]", source):
            line = bisect_right(line_starts, match.start())
            _append_limited(relationships, {"source_path": path, "target_path": None, "type": "defines_route", "target_name": match.group(2), "resolved": False, "confidence": 0.72, "evidence": {"path": path, "line_start": line, "line_end": line, "method": "lexical_pattern", "claim": "Route-like call with a literal path"}}, MAX_RELATIONSHIPS, limits, "relationships_omitted", "current_relationships", MAX_RELATIONSHIPS_PER_FILE)
            _append_limited(framework_signals, {"name": "Express-like", "path": path, "line": line, "detail": "route-like app/router call"}, MAX_FRAMEWORK_SIGNALS, limits, "framework_signals_omitted")
        return

    # Java declarations/imports are lexical candidates, not compiler-resolved
    # symbols. Work line by line to bound regex backtracking on source text.
    import_pattern = re.compile(r"^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;")
    type_pattern = re.compile(r"\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)")
    method_pattern = re.compile(r"^\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\s+)*[A-Za-z_$][\w.$<>?,\[\] ]*\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[\w.$, ]+)?\s*\{")
    for line_number, line in enumerate(io.StringIO(source), 1):
        if len(line) > 8192:
            continue
        match = import_pattern.search(line)
        if match:
            _append_limited(imports, {"source_path": path, "module": match.group(1), "language": "Java", "evidence": {"path": path, "line_start": line_number, "line_end": line_number, "method": "lexical_pattern", "claim": "Java import declaration"}}, MAX_IMPORTS, limits, "imports_omitted", "current_imports", MAX_RELATIONSHIPS_PER_FILE)
        for match in type_pattern.finditer(line):
            kind, name = match.group(1), match.group(2)
            if _append_limited(symbols, _symbol(path, name, kind, line_number, line_number, "lexical_pattern", name), MAX_SYMBOLS, limits, "symbols_omitted", "current_symbols", MAX_SYMBOLS_PER_FILE):
                names[name].add(path)
        match = method_pattern.search(line)
        if match:
            name = match.group(1)
            if name not in {"if", "for", "while", "switch", "catch", "return", "new"}:
                if _append_limited(symbols, _symbol(path, name, "method_candidate", line_number, line_number, "lexical_pattern", name), MAX_SYMBOLS, limits, "symbols_omitted", "current_symbols", MAX_SYMBOLS_PER_FILE):
                    names[name].add(path)


def _symbol(path: str, name: str, kind: str, start: int, end: int, parser: str, display_name: str) -> Dict[str, Any]:
    return {
        "id": f"{path}::{name}@{start}",
        "name": display_name,
        "qualified_name": name,
        "kind": kind,
        "path": path,
        "line_start": start,
        "line_end": max(start, end),
        "confidence": 0.98 if parser == "python_ast" else 0.6,
        "evidence": {"path": path, "line_start": start, "line_end": max(start, end), "method": parser, "claim": f"{kind.replace('_', ' ')} declaration"},
    }


def _append_limited(collection: List[Any], value: Any, total_limit: int, limits: Dict[str, int], omitted_key: str, per_file_key: Optional[str] = None, per_file_limit: Optional[int] = None) -> bool:
    if len(collection) >= total_limit or (per_file_key is not None and per_file_limit is not None and limits.get(per_file_key, 0) >= per_file_limit):
        limits[omitted_key] += 1
        return False
    collection.append(value)
    if per_file_key is not None:
        limits[per_file_key] = limits.get(per_file_key, 0) + 1
    return True


def _bounded_ast_nodes(root: ast.AST, maximum: int) -> Tuple[List[ast.AST], bool]:
    """Walk a parsed AST with bounded queue and result memory."""
    stack: List[ast.AST] = [root]
    result: List[ast.AST] = []
    truncated = False
    while stack and len(result) < maximum:
        node = stack.pop()
        result.append(node)
        remaining = maximum - len(result) - len(stack)
        children: List[ast.AST] = []
        for child in ast.iter_child_nodes(node):
            if len(children) >= remaining:
                truncated = True
                break
            children.append(child)
        stack.extend(reversed(children))
    if stack:
        truncated = True
    return result, truncated


def _ast_name(node: ast.AST) -> Optional[str]:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _ast_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return None


def _literal_first_arg(node: ast.AST) -> Optional[str]:
    if isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
        return node.args[0].value[:300]
    return None


def _framework_from_decorator(name: str) -> str:
    return "Python route decorator"


def _resolve_module(source_path: str, module: str, language: str, module_to_files: Dict[str, Set[str]], project_paths: Set[str]) -> Optional[str]:
    if language == "Python":
        if module.startswith("."):
            package_parts = _module_name(source_path, "Python").split(".")[:-1]
            level = len(module) - len(module.lstrip("."))
            package_parts = package_parts[:max(0, len(package_parts) - level + 1)]
            relative_parts = package_parts + [part for part in module.lstrip(".").split(".") if part]
            normalized = ".".join(relative_parts)
        else:
            normalized = module
        direct = module_to_files.get(normalized, set())
        if len(direct) == 1:
            return next(iter(direct))
        suffix_matches = {
            path for module_name, paths in module_to_files.items()
            if module_name.endswith("." + normalized)
            for path in paths
        }
        if len(suffix_matches) == 1:
            return next(iter(suffix_matches))
        path_base = normalized.replace(".", "/")
        candidates = {path_base + ".py", path_base + "/__init__.py"}
        matches = candidates.intersection(project_paths)
        if len(matches) == 1:
            return next(iter(matches))
        return None
    if language in {"JavaScript", "TypeScript"} and module.startswith("."):
        parent = PurePosixPath(source_path).parent
        base = str(parent.joinpath(module)).replace("\\", "/")
        base_path = PurePosixPath(base)
        candidates = [base]
        candidates.extend(str(base_path) + ext for ext in (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"))
        candidates.extend(str(base_path / ("index" + ext)) for ext in (".js", ".jsx", ".ts", ".tsx"))
        matches = [candidate for candidate in candidates if candidate in project_paths]
        return matches[0] if len(set(matches)) == 1 else None
    if language == "Java":
        qualified = module[:-2] if module.endswith(".*") else module
        package, _, type_name = qualified.rpartition(".")
        candidate = f"{package.replace('.', '/')}/{type_name}.java" if package else f"{type_name}.java"
        if candidate in project_paths:
            return candidate
        suffix_matches = [path for path in project_paths if path.endswith("/" + candidate)]
        return suffix_matches[0] if len(suffix_matches) == 1 else None
    return None


def _detect_frameworks(documents: Dict[str, str], signals: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    found: Dict[str, Dict[str, Any]] = {}

    def add(name: str, path: str, line: Optional[int], method: str, claim: str, confidence: float) -> None:
        entry = found.setdefault(name, {"name": name, "confidence": confidence, "evidence": []})
        entry["confidence"] = max(entry["confidence"], confidence)
        if len(entry["evidence"]) < 20:
            entry["evidence"].append({"path": path, "line": line, "method": method, "claim": claim})

    for path, source in documents.items():
        base = PurePosixPath(path).name.lower()
        if base == "package.json":
            try:
                data = json.loads(source)
            except (ValueError, TypeError, RecursionError, MemoryError):
                continue
            dependencies = {}
            for field in ("dependencies", "devDependencies", "peerDependencies"):
                dependencies.update(data.get(field, {}) if isinstance(data.get(field), dict) else {})
            for dependency, framework in (("react", "React"), ("next", "Next.js"), ("express", "Express"), ("vite", "Vite"), ("vue", "Vue"), ("angular", "Angular"), ("@angular/core", "Angular"), ("nestjs", "NestJS"), ("@nestjs/core", "NestJS")):
                if dependency in dependencies:
                    add(framework, path, None, "package_manifest", f"Declared dependency: {dependency}", 0.98)
        elif base == "requirements.txt":
            for line_number, line in enumerate(source.splitlines(), 1):
                package = re.split(r"[<=>~!;\[]", line.strip().lower(), maxsplit=1)[0].replace("_", "-")
                mapping = {"fastapi": "FastAPI", "django": "Django", "flask": "Flask", "starlette": "Starlette"}
                if package in mapping:
                    add(mapping[package], path, line_number, "requirements_manifest", "Declared Python dependency", 0.98)
        elif base == "pyproject.toml":
            # String inspection is intentional: no TOML plugins/config are loaded.
            for package, framework in (("fastapi", "FastAPI"), ("django", "Django"), ("flask", "Flask"), ("starlette", "Starlette")):
                match = re.search(r"(?im)^\s*[\"']?" + re.escape(package) + r"[\"']?\s*=", source)
                if match:
                    line = source.count("\n", 0, match.start()) + 1
                    add(framework, path, line, "pyproject_text", "Declared Python dependency", 0.92)
        elif base in {"pom.xml", "build.gradle", "build.gradle.kts"}:
            for expression, framework in ((r"spring-boot|org\.springframework", "Spring"), (r"quarkus", "Quarkus"), (r"micronaut", "Micronaut")):
                match = re.search(expression, source, re.IGNORECASE)
                if match:
                    line = source.count("\n", 0, match.start()) + 1
                    add(framework, path, line, "build_manifest_text", "Framework marker in build manifest", 0.8)

    for signal in signals:
        name = signal["name"]
        if name in {"FastAPI", "FastAPI or Flask-style routing"}:
            canonical = "FastAPI"
        elif name == "Flask":
            canonical = "Flask"
        elif name == "Django":
            canonical = "Django"
        else:
            canonical = name
        add(canonical, signal["path"], signal.get("line"), "source_pattern", signal.get("detail", "Source-level framework marker"), 0.65)
    return sorted(found.values(), key=lambda value: value["name"].lower())


def _coverage(files: List[Dict[str, Any]], language_counts: Counter[str], ignored: int, oversized: int, budget_skipped: int, binary_skipped: int, file_extensions: Counter[str]) -> Dict[str, Any]:
    stats: Dict[str, Dict[str, Any]] = {}
    for file in files:
        language = file["language"]
        if language == "Configuration":
            continue
        entry = stats.setdefault(language, {"analyzed_files": 0, "parser": file["parser"], "depth": "AST" if language == "Python" else "lexical candidates", "limitations": []})
        entry["analyzed_files"] += 1
    for language, entry in stats.items():
        if language != "Python":
            entry["limitations"] = ["Token patterns can miss syntax forms and produce false positives.", "Imports and declarations are not compiler-resolved."]
        else:
            entry["limitations"] = ["Static AST does not cover runtime-generated imports, reflection, or dynamic execution paths."]
    return {
        "supported_languages": stats,
        "detected_languages": dict(language_counts),
        "unsupported_language_extensions": {extension: file_extensions[extension] for extension in sorted(KNOWN_UNSUPPORTED_CODE_EXTENSIONS) if file_extensions.get(extension)},
        "skipped_ignored_files": ignored,
        "skipped_oversized_files": oversized,
        "skipped_analysis_budget_files": budget_skipped,
        "skipped_binary_or_non_utf8_files": binary_skipped,
    }


def _discover_features(files: List[Dict[str, Any]], symbols: List[Dict[str, Any]], relationships: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
    groups: Dict[str, Dict[str, Any]] = {}
    group_by_path: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    omitted_groups = 0
    for file in files:
        path = file["path"]
        parts = PurePosixPath(path).parts
        role = file["role"]
        if role.startswith("Likely API"):
            label = "API and routing"
            confidence = 0.35
        elif role.startswith("Likely UI"):
            label = "User interface"
            confidence = 0.35
        elif role.startswith("Likely service"):
            label = "Application services"
            confidence = 0.35
        elif role.startswith("Likely data"):
            label = "Data and persistence"
            confidence = 0.35
        elif len(parts) > 1 and parts[0].lower() not in IGNORED_PARTS:
            label = parts[0]
            confidence = 0.22
        else:
            continue
        entry = groups.get(label)
        if entry is None:
            if len(groups) >= 100:
                omitted_groups += 1
                continue
            entry = {"name": label, "grouping_basis": "file_role_or_top_level_directory", "files": [], "observed_symbols": 0, "confidence": confidence, "evidence": [], "_file_set": set()}
            groups[label] = entry
        if path not in entry["_file_set"]:
            entry["_file_set"].add(path)
            entry["files"].append(path)
            group_by_path[path].append(entry)
            if len(entry["evidence"]) < 30:
                entry["evidence"].append({"path": path, "method": "path_role_heuristic", "claim": role})
    for symbol in symbols:
        for group in group_by_path.get(symbol["path"], []):
            group["observed_symbols"] += 1
    results = sorted(groups.values(), key=lambda item: (-len(item["files"]), item["name"].lower()))
    for group in results:
        group["observed_file_count"] = len(group["files"])
        group["observed_symbol_count"] = group["observed_symbols"]
        group.pop("_file_set", None)
    return results, omitted_groups
