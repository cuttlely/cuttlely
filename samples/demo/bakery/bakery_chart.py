"""Bakery demo helper: query the made-up bakery database and draw a bar chart. Standard library plus Pillow.

From Python:
    import sys; sys.path.insert(0, "<folder of this file>")
    from bakery_chart import query, bar_chart
    columns, rows = query("SELECT name, price FROM products")
    bar_chart("SELECT p.name, SUM(s.revenue) FROM weekly_sales s JOIN products p ON p.id = s.product_id GROUP BY p.name",
              "<image folder>/revenue.png", "Revenue by product, Jan to Jun 2026", "USD")

From a shell:
    python bakery_chart.py "SELECT ..." /path/to/chart.png "Title"

The first column of the query is the bar label and the second is the bar value. Bars keep the query's order.
"""
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "bakery.sqlite")
MAX_BARS = 24


def query(sql, params=()):
    """Runs one read-only query. Returns (column names, rows)."""
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        cur = con.execute(sql, params)
        columns = [d[0] for d in (cur.description or [])]
        return columns, cur.fetchall()
    finally:
        con.close()


def _money(value):
    return f"{value:,.0f}" if abs(value) >= 100 else f"{value:,.2f}"


def bar_chart(sql, out_path, title="", value_label=""):
    """Draws the query's first two columns as a horizontal bar chart and saves it as a PNG. Returns the path."""
    from PIL import Image, ImageDraw, ImageFont

    columns, rows = query(sql)
    if len(columns) < 2:
        raise ValueError("The query needs two columns: a label and a number.")
    rows = rows[:MAX_BARS]
    labels = [str(r[0]) for r in rows]
    values = [float(r[1] or 0) for r in rows]
    if not rows:
        raise ValueError("The query returned no rows.")

    font = ImageFont.load_default(size=18)
    small = ImageFont.load_default(size=15)
    big = ImageFont.load_default(size=24)
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    label_w = max(probe.textlength(label, font=font) for label in labels)
    left = int(min(max(label_w + 32, 140), 360))
    bar_h, gap, top, right = 30, 12, 84, 120
    width = 1000
    height = top + len(rows) * (bar_h + gap) + 56
    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)
    draw.text((24, 22), title or f"{columns[1]} by {columns[0]}", fill="#1f2937", font=big)
    if value_label:
        draw.text((24, 54), value_label, fill="#6b7280", font=small)
    peak = max(max(values), 0) or 1
    span = width - left - right
    for i, (label, value) in enumerate(zip(labels, values)):
        y = top + i * (bar_h + gap)
        w = max(2, int(span * max(value, 0) / peak))
        draw.text((left - 12 - probe.textlength(label, font=font), y + 5), label, fill="#374151", font=font)
        draw.rounded_rectangle((left, y, left + w, y + bar_h), radius=6, fill="#d97706" if i == 0 else "#f59e0b")
        draw.text((left + w + 10, y + 6), _money(value), fill="#111827", font=small)
    draw.text((24, height - 32), "Made-up demo data", fill="#9ca3af", font=small)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    img.save(out_path, "PNG")
    return out_path


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    print(bar_chart(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else ""))
