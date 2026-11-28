"""Bounded, read-only sample of one visible XLSX worksheet. Never resolve package relationships as host paths."""

import io
import json
import mimetypes
import re
from datetime import date, datetime, time
from decimal import Decimal, localcontext
from xml.etree import ElementTree as ET
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile

from read_extract import _col_index

S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
P = "{http://schemas.openxmlformats.org/package/2006/relationships}"
MAX_ROWS, MAX_COLS = 5000, 64
MAX_PART, MAX_TOTAL = 4 * 1024**2, 16 * 1024**2


def xml(archive, name):
    # Feed the same decoded text that we validate to the parser; UTF-16/NUL,
    # DTDs and entity declarations are outside the supported spreadsheet format.
    text = archive.read(name).decode("utf-8-sig")
    if "\0" in text or "<!DOCTYPE" in text or "<!ENTITY" in text:
        raise ValueError
    return ET.fromstring(text)


def inspect(archive):
    parts = archive.infolist()
    names = {part.filename for part in parts}
    if (
        len(parts) > 256
        or len(parts) != len(names)
        or sum(p.file_size for p in parts) > MAX_TOTAL
    ):
        raise ValueError
    for part in parts:
        name = part.filename
        pieces = name.rstrip("/").split("/")
        if (
            part.file_size > MAX_PART
            or part.flag_bits & 1
            or part.compress_type not in {ZIP_STORED, ZIP_DEFLATED}
            or "\\" in name
            or any(v in ("", ".", "..") for v in pieces)
            or re.search(
                r"(?:^|/)(?:externallinks|embeddings|querytables|macrosheets|activex)(?:/|$)|\.bin$|/connections\.xml$",
                name,
                re.I,
            )
        ):
            raise ValueError
        if name.endswith((".xml", ".rels")):
            tree = xml(archive, name)
        if name == "[Content_Types].xml":
            types = tree
            for declared in types:
                if "macroenabled" not in declared.get("ContentType", "").lower():
                    continue
                extension = declared.get("Extension")
                if declared.get("PartName", "").lstrip("/") in names or (
                    extension
                    and any(p.lower().endswith("." + extension.lower()) for p in names)
                ):
                    raise ValueError
        if name.endswith(".rels"):
            for rel in tree.iter(P + "Relationship"):
                target = rel.get("Target", "")
                if (
                    "\\" in target
                    or rel.get("TargetMode", "Internal").lower() != "internal"
                    or re.match(r"(?:[a-z][a-z0-9+.-]*:|//)", target, re.I)
                ):
                    raise ValueError
    if "[Content_Types].xml" not in names:
        raise ValueError


def dimensions(archive, part):
    sheet = xml(archive, part)
    if sheet.find(".//" + S + "f") is not None:
        raise ValueError
    height = width = 0
    for row in sheet.findall("./" + S + "sheetData/" + S + "row"):
        idx = int(row.get("r", height + 1))
        if not height < idx <= MAX_ROWS:
            raise ValueError
        height = idx
        column = 0
        for cell in row.findall(S + "c"):
            ref = cell.get("r")
            if ref:
                match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]{0,6})", ref)
                if not match or int(match[2]) != idx:
                    raise ValueError
                pos = _col_index(ref) + 1
            else:
                pos = column + 1
            if not column < pos <= MAX_COLS:
                raise ValueError
            column = pos
        width = max(width, column)
    return height, width


def text(value):
    if value is None:
        return ""
    if isinstance(value, (date, datetime, time)):
        return value.isoformat()
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value)


def number(text):
    if not re.fullmatch(
        r"[+-]?(?:\d{1,24}(?:\.\d{1,18})?|\.\d{1,18})(?:[eE][+-]?\d{1,2})?", text
    ):
        return None
    return Decimal(text)


def summarize(names, selected, rows):
    header = rows[0] if rows else []
    data = rows[1:]
    # The shipped CSV sampler aggregates named amounts. When a sheet has no
    # numeric amount column, its count still provides an exact aggregate.
    candidates = [i for i, h in enumerate(header) if h.casefold() == "amount"]
    aggregate = {"operation": "count", "rows": len(data)}
    with localcontext() as ctx:
        ctx.prec = 256
        for col in candidates:
            cells = [r[col].strip() for r in data if col < len(r) and r[col].strip()]
            numbers = [number(c) for c in cells]
            if numbers and None not in numbers:
                total = format(sum(numbers), "f")
                aggregate = {
                    "operation": "sum",
                    "column": header[col],
                    "observations": len(numbers),
                    "value": total,
                }
                break

    def preview(row):
        return [s[:32] for s in row[:8]]

    first, last = data[:5], data[-5:]
    report = {
        "sheets": names,
        "sheet": selected,
        "headers": preview(header),
        "row_count": len(data),
        "first": list(map(preview, first)),
        "last": list(map(preview, last)),
        "aggregate": aggregate,
        "preview_truncated": any(
            len(r) > 8 or any(len(s) > 32 for s in r[:8])
            for r in [header, *first, *last]
        ),
    }
    if "column" in aggregate and len(aggregate["column"]) > 128:
        raise ValueError

    def output():
        return json.dumps(report, ensure_ascii=False, separators=(",", ":"))

    while len(output()) > 4000 and (report["first"] or report["last"]):
        report["preview_truncated"] = True
        if report["first"]:
            report["first"].pop()
        if report["last"]:
            report["last"].pop(0)
    result = output()
    if len(result) > 4000:
        raise ValueError
    return result


def sample_workbook(data, selected=None):
    # The application already ships this reader for XLSX reports. Its wheel directory is
    # operator-configured, never affected by the workbook or a model-supplied path.
    mimetypes.knownfiles = []
    mimetypes.init()
    from openpyxl import load_workbook

    with ZipFile(io.BytesIO(data)) as archive:
        inspect(archive)
        book = xml(archive, "xl/workbook.xml")
        rels = {
            r.get("Id"): r.get("Target", "")
            for r in xml(archive, "xl/_rels/workbook.xml.rels").iter(P + "Relationship")
            if r.get("Type") == R[1:-1] + "/worksheet"
        }
        sheets = {}
        for sheet in book.findall("./" + S + "sheets/" + S + "sheet"):
            if sheet.get("state", "visible") != "visible":
                continue
            name = sheet.get("name", "")
            target = rels.get(sheet.get(R + "id"), "")
            if not name or name in sheets or len(name) > 31:
                raise ValueError
            part = target[1:] if target.startswith("/") else "xl/" + target
            if not re.fullmatch(r"xl/worksheets/[A-Za-z0-9_.-]+\.xml", part):
                raise ValueError
            sheets[name] = part
        if not sheets or len(sheets) > 16:
            raise ValueError
        if selected is None:
            selected = next(iter(sheets))
        if selected not in sheets:
            raise ValueError
        height, width = dimensions(archive, sheets[selected])
    workbook = load_workbook(
        io.BytesIO(data), read_only=True, data_only=False, keep_links=False
    )
    try:
        sheet = workbook[selected]
        rows = (
            [
                list(map(text, row))
                for row in sheet.iter_rows(
                    min_row=1,
                    max_row=height,
                    min_col=1,
                    max_col=width,
                    values_only=True,
                )
            ]
            if height and width
            else []
        )
        while rows and not any(rows[-1]):
            rows.pop()
        return summarize(list(sheets), selected, rows)
    finally:
        workbook.close()
