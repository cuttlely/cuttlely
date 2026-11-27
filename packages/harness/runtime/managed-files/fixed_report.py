"""Render a verified aggregate table. The payload cannot supply a path, template or executable."""

import base64
import json
import mimetypes
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FORMATS = ("pdf", "docx", "xlsx")
ASSETS = Path(os.environ.get("CUTTLELY_NATIVE_REPORT_ASSETS", "/opt/cuttlely-report-assets")).resolve()
sys.path[:0] = [str(HERE), str(HERE.parents[1] / "presets" / "assets"), str(ASSETS)]
from confine import confine


class ReportError(ValueError):
    """An operator-safe explanation without private input values."""


def checked(record):
    if not isinstance(record, dict) or set(record) != {"formats", "metric", "rows"}:
        raise ValueError
    formats, metric, rows = record["formats"], record["metric"], record["rows"]
    if (not isinstance(formats, list) or not 1 <= len(formats) <= 3 or
            any(x not in FORMATS for x in formats) or len(set(formats)) != len(formats)):
        raise ValueError
    if not isinstance(metric, str) or not 1 <= len(metric) <= 750 or not isinstance(rows, list) or not 1 <= len(rows) <= 250:
        raise ValueError
    table = [["Group", "Source rows", "Included", metric]]
    for row in rows:
        if not isinstance(row, list) or len(row) != 4:
            raise ValueError
        group, source, count, value = row
        if not isinstance(group, str) or len(group) > 750:
            raise ValueError
        if type(source) is not int or type(count) is not int or not 0 <= count <= source <= 50000:
            raise ValueError
        if value is not None and (not isinstance(value, str) or not re.fullmatch(r"-?\d{1,24}(?:\.\d{1,8})?", value, flags=re.ASCII)):
            raise ValueError
        table.append([group, source, count, "" if value is None else value])
    return formats, table


def pdf_layout(table):
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    fonts = ("ReportRegular", "ReportBold")
    font_dir = Path("/usr/share/fonts/truetype/dejavu")
    for name, filename in zip(fonts, ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf")):
        font = TTFont(name, str(font_dir / filename))
        pdfmetrics.registerFont(font)
    # Return a clear failure if this fixed font cannot draw a supplied label.
    for index, row in enumerate(table):
        glyphs = pdfmetrics.getFont(fonts[1] if index == 0 else fonts[0]).face.charToGlyph
        if any(not glyphs.get(ord(char)) for value in row for char in str(value)):
            raise ReportError("The PDF font cannot display a label. Request the workbook or document format.")
    return {"font_pair": fonts, "table_widths": (120, 63, 62, 217)}


def main():
    record = sys.stdin.buffer.read(512 * 1024 + 1)
    if len(record) > 512 * 1024:
        raise ValueError
    formats, table = checked(json.loads(record))
    if not ASSETS.is_dir():
        raise ImportError
    confine(Path.cwd(), None, None)
    # The workbook writer uses MIME defaults; keep the system MIME registry outside the worker.
    mimetypes.knownfiles = []
    mimetypes.init()
    import cuttlely_assets as kit

    results = {}
    for fmt in formats:
        destination = Path.cwd() / ("report." + fmt)
        if fmt == "pdf":
            kit.pdf_report(destination, "CSV analysis", [kit.Table(table)], **pdf_layout(table))
        elif fmt == "docx":
            kit.docx_report(destination, "CSV analysis", [kit.Table(table)])
        else:
            kit.xlsx_table(destination, table, sheet="Analysis", literal_text=True)
        if not 0 < destination.stat().st_size <= 10 * 1024**2:
            raise ReportError("The document exceeds the attachment limit.")
        results[fmt] = base64.b64encode(destination.read_bytes()).decode("ascii")
    print(json.dumps({"documents": results}))


if __name__ == "__main__":
    try:
        main()
    except (ImportError, OSError):
        print(json.dumps({"error": "The restricted report renderer or its fonts are unavailable on this deployment."}))
    except ReportError as error:
        print(json.dumps({"error": str(error)}))
    except (TypeError, ValueError):
        print(json.dumps({"error": "The aggregate table could not be rendered."}))
