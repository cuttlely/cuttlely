"""Run the packaged CSV/TSV sampler over this turn's verified bytes; never open a model-selected path."""

import base64
import io
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

LIMIT = 4 * 1024 * 1024


def main():
    from confine import confine
    from workbook_sample import sample_workbook

    # This is a fixed first-party install path, never one supplied by an upload or profile.
    root = HERE.parents[3]
    script = root / "samples" / "scripts" / "sample_csv.py"
    if (
        script.is_symlink()
        or script.parent.is_symlink()
        or script.parent.parent.is_symlink()
    ):
        raise ValueError
    sys.path.insert(0, str(script.parent))
    from sample_csv import sample

    sys.path.pop(0)
    # confine() admits read access to existing installed dependency directories.
    # Keep the already packaged XLSX wheels available without granting the upload any path.
    assets = Path(
        os.environ.get("CUTTLELY_NATIVE_REPORT_ASSETS", "/opt/cuttlely-report-assets")
    )
    if assets.is_dir():
        sys.path.insert(0, str(assets))

    confine(Path.cwd(), None, None)
    raw = sys.stdin.buffer.read(6 * 1024 * 1024 + 1)
    if len(raw) > 6 * 1024 * 1024:
        raise ValueError
    record = json.loads(raw)
    if not isinstance(record, dict) or set(record) not in (
        {"source", "data"},
        {"source", "data", "sheet"},
    ):
        raise ValueError
    source = record["source"]
    if (
        not isinstance(source, str)
        or not source.startswith("uploads/")
        or len(source) > 512
        or "/" in source[8:]
        or "\\" in source
        or any(ord(c) < 32 for c in source)
        or Path(source).suffix.lower() not in {".tsv", ".csv", ".xlsx"}
    ):
        raise ValueError
    data = base64.b64decode(record["data"], validate=True)
    if len(data) > LIMIT:
        raise ValueError
    if source.lower().endswith(".xlsx"):
        output = sample_workbook(data, record.get("sheet"))
        print(json.dumps({"output": output}))
        return
    if "sheet" in record:
        raise ValueError
    with io.TextIOWrapper(
        io.BytesIO(data), encoding="utf-8", errors="replace", newline=""
    ) as handle:
        output = sample(handle, source, len(data))
    print(json.dumps({"output": output}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"error": "The verified input could not be sampled."}))
