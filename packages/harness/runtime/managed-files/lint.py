import json, ast, tomllib


def _lint_json_inproc(content: str) -> tuple[bool, str]:
    """In-process JSON syntax check. Returns (ok, error_message)."""
    try:
        json.loads(content)
        return True, ""
    except json.JSONDecodeError as e:
        return False, f"JSONDecodeError: {e.msg} (line {e.lineno}, column {e.colno})"
    except Exception as e:  # noqa: BLE001 — any parse failure is a lint failure
        return False, f"{type(e).__name__}: {e}"


def _lint_yaml_inproc(content: str) -> tuple[bool, str]:
    """In-process YAML syntax check; ``__SKIP__`` when ruamel.yaml is missing. Syntax-only
    (``YAML.parse``), NOT ``safe_load``: loading rejects valid multi-doc streams and
    app tags (``!Sub``, ``!vault``), and this is a fail-closed WRITE gate."""
    try:
        from ruamel.yaml import YAML
        from ruamel.yaml.error import YAMLError
    except ImportError:
        return True, "__SKIP__"
    try:
        for _event in YAML(typ="safe").parse(content):
            pass
        return True, ""
    except YAMLError as e:
        return False, f"YAMLError: {e}"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


def _lint_toml_inproc(content: str) -> tuple[bool, str]:
    """In-process TOML syntax check (stdlib tomllib)."""
    try:
        tomllib.loads(content)
        return True, ""
    except Exception as e:  # TOMLDecodeError is a ValueError subclass
        return False, f"{type(e).__name__}: {e}"


def _lint_python_inproc(content: str) -> tuple[bool, str]:
    """In-process Python syntax check via ast.parse (py_compile's scope, no subprocess). Parses the
    bytes, as py_compile does, so a legacy ``coding:`` cookie is honoured for a file the edit paths
    read with surrogateescape."""
    try:
        ast.parse(content.encode("utf-8", "surrogateescape"))
        return True, ""
    except SyntaxError as e:
        loc = f" (line {e.lineno}, column {e.offset})" if e.lineno else ""
        return False, f"{type(e).__name__}: {e.msg}{loc}"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"
