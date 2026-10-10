#!/usr/bin/env python3
"""Sample a CSV or TSV from disk for the Cuttlely upload harness.

Prints the path, size, row count, headers, the first and last five rows, and
a short amount-by-region aggregate when those columns exist. Refuses to print
the file. Stdout is capped at 4000 characters.

Usage: python sample_csv.py <path>
"""
from __future__ import annotations

import csv
import sys
from collections import defaultdict
from pathlib import Path

MAX_CHARS = 4000


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: sample_csv.py <path>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]).resolve()
    if not path.is_file():
        print(f"error: not a file: {path}", file=sys.stderr)
        return 1

    size = path.stat().st_size
    headers: list[str] = []
    first5: list[list[str]] = []
    last5: list[list[str]] = []
    row_count = 0
    region_sum: dict[str, float] = defaultdict(float)
    region_n: dict[str, int] = defaultdict(int)
    amount_idx = None
    region_idx = None
    delimiter = "\t" if path.suffix.lower() == ".tsv" else ","

    with path.open(newline="", encoding="utf-8", errors="replace") as handle:
        reader = csv.reader(handle, delimiter=delimiter)
        try:
            headers = next(reader)
        except StopIteration:
            headers = []
        if headers:
            try:
                amount_idx = headers.index("amount")
            except ValueError:
                amount_idx = None
            try:
                region_idx = headers.index("region")
            except ValueError:
                region_idx = None

        for row in reader:
            row_count += 1
            if len(first5) < 5:
                first5.append(row)
            last5.append(row)
            if len(last5) > 5:
                last5.pop(0)
            if amount_idx is not None and region_idx is not None and len(row) > max(amount_idx, region_idx):
                try:
                    amt = float(row[amount_idx])
                except ValueError:
                    continue
                region = row[region_idx]
                region_sum[region] += amt
                region_n[region] += 1

    lines: list[str] = []
    lines.append(f"path={path}")
    lines.append(f"size_bytes={size}")
    lines.append(f"row_count={row_count}")
    lines.append(f"headers={headers}")
    lines.append("first_5_rows:")
    for row in first5:
        lines.append(f"  {row}")
    lines.append("last_5_rows:")
    for row in last5:
        lines.append(f"  {row}")
    lines.append("amount_by_region_top5 (sum, mean, n):")
    ranked = sorted(region_sum.items(), key=lambda item: item[1], reverse=True)[:5]
    for region, total in ranked:
        n = region_n[region]
        mean = total / n if n else 0.0
        lines.append(f"  {region}: sum={total:.2f} mean={mean:.2f} n={n}")
    lines.append("NOTE: full file intentionally omitted; refuse to dump all rows.")

    text = "\n".join(lines) + "\n"
    if len(text) > MAX_CHARS:
        text = text[: MAX_CHARS - 80] + "\n...[TRUNCATED by sample_csv.py hard cap]\n"
    sys.stdout.write(text[:MAX_CHARS])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
