"""Cuttlely assets style kit: one look for the PNG, PDF, DOCX, XLSX and CSV files the 'assets' specialist makes.

    import cuttlely_assets as kit
    kit.apply_chart_theme()                      # matplotlib and seaborn
    fig, ax = kit.bar_chart(["Jan", "Feb"], [12, 19], title="Orders")
    kit.save_png(fig, out / "orders.png")
    kit.pdf_report(out / "report.pdf", "Q1 report", [kit.Heading("Orders"), kit.Text("Up 12%."), kit.Table(rows)])
    kit.docx_report(out / "memo.docx", "Q1 memo", [...])
    kit.xlsx_table(out / "orders.xlsx", rows, sheet="Orders")
    kit.csv_table(out / "orders.csv", rows)

The harness copies this file into the specialist's working directory. Only matplotlib, seaborn, reportlab,
python-docx and openpyxl are used, and each is imported when its writer is called.
"""

import csv
from dataclasses import dataclass
from pathlib import Path

# Palette: ink and paper for text and backgrounds, one accent, and a categorical series that keeps contrast on white.
PALETTE = {
    "ink": "#1F2333",
    "muted": "#5B6275",
    "paper": "#FFFFFF",
    "surface": "#F5F6FC",
    "rule": "#D9DCE8",
    "accent": "#6A3DF2",
    "positive": "#1E8E5A",
    "negative": "#C2413A",
}
SERIES = ["#6A3DF2", "#1E8E5A", "#E08A1E", "#2F7FD8", "#C2413A", "#7A8396"]

# Fonts in order of preference. The Docker image installs Inter, Noto Sans and DejaVu Sans.
FONTS = {"sans": ["Inter", "Noto Sans", "DejaVu Sans"], "mono": ["DejaVu Sans Mono", "Noto Sans Mono"]}

CHART_THEME = {
    "figure.facecolor": PALETTE["paper"],
    "axes.facecolor": PALETTE["paper"],
    "axes.edgecolor": PALETTE["rule"],
    "axes.labelcolor": PALETTE["ink"],
    "axes.titlesize": 13,
    "axes.titleweight": "semibold",
    "axes.titlelocation": "left",
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.grid": True,
    "axes.grid.axis": "y",
    "grid.color": PALETTE["rule"],
    "grid.linewidth": 0.8,
    "xtick.color": PALETTE["muted"],
    "ytick.color": PALETTE["muted"],
    "text.color": PALETTE["ink"],
    "legend.frameon": False,
    "savefig.dpi": 160,
    "savefig.bbox": "tight",
}

# Table theme shared by the PDF, DOCX and XLSX writers.
TABLE_THEME = {
    "header_fill": PALETTE["accent"],
    "header_text": PALETTE["paper"],
    "band_fill": PALETTE["surface"],
    "rule": PALETTE["rule"],
    "font_size": 9.5,
}

CSV_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


@dataclass
class Heading:
    text: str


@dataclass
class Text:
    text: str


@dataclass
class Table:
    rows: list
    header: bool = True


@dataclass
class Image:
    path: str
    width_cm: float = 15.0


def _hex(color):
    return color.lstrip("#").upper()


def available_font(kind="sans"):
    """The first font in FONTS[kind] that matplotlib can find, else matplotlib's default."""
    from matplotlib import font_manager

    names = {entry.name for entry in font_manager.fontManager.ttflist}
    for name in FONTS[kind]:
        if name in names:
            return name
    return font_manager.FontProperties().get_name()


def apply_chart_theme():
    """Apply the palette, fonts and chart theme to matplotlib (and seaborn, when it is installed)."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from cycler import cycler

    plt.rcParams.update(CHART_THEME)
    plt.rcParams["font.family"] = available_font("sans")
    plt.rcParams["axes.prop_cycle"] = cycler(color=SERIES)
    try:
        import seaborn as sns

        sns.set_theme(style="whitegrid", palette=SERIES, rc={**CHART_THEME, "font.family": plt.rcParams["font.family"]})
    except ImportError:
        pass
    return plt


def bar_chart(labels, values, title="", ylabel="", size=(6.4, 3.6)):
    plt = apply_chart_theme()
    fig, ax = plt.subplots(figsize=size)
    ax.bar(labels, values, color=SERIES[0], width=0.6)
    if title:
        ax.set_title(title)
    if ylabel:
        ax.set_ylabel(ylabel)
    return fig, ax


def line_chart(x, series, title="", ylabel="", size=(6.4, 3.6)):
    """series: {"name": [values...]}."""
    plt = apply_chart_theme()
    fig, ax = plt.subplots(figsize=size)
    for name, values in series.items():
        ax.plot(x, values, linewidth=2, label=name)
    if len(series) > 1:
        ax.legend(loc="upper left")
    if title:
        ax.set_title(title)
    if ylabel:
        ax.set_ylabel(ylabel)
    return fig, ax


def save_png(fig, path):
    import matplotlib.pyplot as plt

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, format="png")
    plt.close(fig)
    return path


def _rows(rows):
    return [["" if cell is None else cell for cell in row] for row in rows]


def pdf_report(path, title, blocks, subtitle=""):
    """A4 PDF with the kit's type and table theme. blocks: Heading, Text, Table and Image items."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import cm
    from reportlab.platypus import Image as PdfImage
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer
    from reportlab.platypus import Table as PdfTable
    from reportlab.platypus import TableStyle

    font, bold = _pdf_fonts()
    styles = getSampleStyleSheet()
    ink = colors.HexColor(PALETTE["ink"])
    title_style = ParagraphStyle("KitTitle", parent=styles["Title"], fontName=bold, fontSize=20, leading=24, textColor=ink, alignment=0)
    sub_style = ParagraphStyle("KitSub", parent=styles["Normal"], fontName=font, fontSize=10, textColor=colors.HexColor(PALETTE["muted"]))
    head_style = ParagraphStyle("KitHead", parent=styles["Heading2"], fontName=bold, fontSize=13, textColor=ink, spaceBefore=10)
    body_style = ParagraphStyle("KitBody", parent=styles["BodyText"], fontName=font, fontSize=10, leading=14, textColor=ink)
    story = [Paragraph(_escape(title), title_style)]
    if subtitle:
        story.append(Paragraph(_escape(subtitle), sub_style))
    story.append(Spacer(1, 0.4 * cm))
    for block in blocks:
        if isinstance(block, Heading):
            story.append(Paragraph(_escape(block.text), head_style))
        elif isinstance(block, Text):
            story.append(Paragraph(_escape(block.text), body_style))
        elif isinstance(block, Table):
            rows = [[str(cell) for cell in row] for row in _rows(block.rows)]
            table = PdfTable(rows, repeatRows=1 if block.header else 0, hAlign="LEFT")
            commands = [
                ("FONTNAME", (0, 0), (-1, -1), font),
                ("FONTSIZE", (0, 0), (-1, -1), TABLE_THEME["font_size"]),
                ("TEXTCOLOR", (0, 0), (-1, -1), ink),
                ("LINEBELOW", (0, 0), (-1, -1), 0.5, colors.HexColor(TABLE_THEME["rule"])),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor(TABLE_THEME["band_fill"])]),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
            if block.header:
                commands += [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(TABLE_THEME["header_fill"])),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor(TABLE_THEME["header_text"])),
                    ("FONTNAME", (0, 0), (-1, 0), bold),
                ]
            table.setStyle(TableStyle(commands))
            story += [Spacer(1, 0.2 * cm), table, Spacer(1, 0.3 * cm)]
        elif isinstance(block, Image):
            image = PdfImage(str(block.path))
            scale = (block.width_cm * cm) / image.imageWidth
            image.drawWidth, image.drawHeight = image.imageWidth * scale, image.imageHeight * scale
            story += [Spacer(1, 0.2 * cm), image, Spacer(1, 0.3 * cm)]
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    SimpleDocTemplate(str(path), pagesize=A4, title=title, leftMargin=2 * cm, rightMargin=2 * cm).build(story)
    return path


_PDF_FONTS = None


def _pdf_fonts():
    """Register the first kit sans font reportlab can load from disk. Falls back to Helvetica."""
    global _PDF_FONTS
    if _PDF_FONTS:
        return _PDF_FONTS
    _PDF_FONTS = ("Helvetica", "Helvetica-Bold")
    try:
        from matplotlib import font_manager
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont

        for name in FONTS["sans"]:
            regular = font_manager.findfont(font_manager.FontProperties(family=name), fallback_to_default=False)
            bold = font_manager.findfont(font_manager.FontProperties(family=name, weight="bold"), fallback_to_default=False)
            if not regular.lower().endswith(".ttf") or not bold.lower().endswith(".ttf"):
                continue
            pdfmetrics.registerFont(TTFont("Kit", regular))
            pdfmetrics.registerFont(TTFont("Kit-Bold", bold))
            _PDF_FONTS = ("Kit", "Kit-Bold")
            break
    except Exception:
        pass
    return _PDF_FONTS


def _escape(text):
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def docx_report(path, title, blocks, subtitle=""):
    """Word document with the kit's fonts, colors and table theme. blocks: Heading, Text, Table and Image items."""
    import docx
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt, RGBColor

    document = docx.Document()
    font = FONTS["sans"][0]
    normal = document.styles["Normal"]
    normal.font.name = font
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = RGBColor.from_string(_hex(PALETTE["ink"]))
    for style_name in ("Title", "Heading 1", "Heading 2"):
        style = document.styles[style_name]
        style.font.name = font
        style.font.color.rgb = RGBColor.from_string(_hex(PALETTE["ink"]))
    document.add_heading(title, level=0)
    if subtitle:
        run = document.add_paragraph().add_run(subtitle)
        run.font.color.rgb = RGBColor.from_string(_hex(PALETTE["muted"]))
    for block in blocks:
        if isinstance(block, Heading):
            document.add_heading(block.text, level=1)
        elif isinstance(block, Text):
            document.add_paragraph(block.text)
        elif isinstance(block, Table):
            rows = _rows(block.rows)
            if not rows:
                continue
            table = document.add_table(rows=len(rows), cols=max(len(row) for row in rows))
            table.style = "Table Grid"
            for r, row in enumerate(rows):
                for c, value in enumerate(row):
                    cell = table.cell(r, c)
                    cell.text = str(value)
                    fill = None
                    if block.header and r == 0:
                        fill = TABLE_THEME["header_fill"]
                        for paragraph in cell.paragraphs:
                            for run in paragraph.runs:
                                run.font.bold = True
                                run.font.color.rgb = RGBColor.from_string(_hex(TABLE_THEME["header_text"]))
                    elif r % 2 == 0:
                        fill = TABLE_THEME["band_fill"]
                    if fill:
                        shading = OxmlElement("w:shd")
                        shading.set(qn("w:val"), "clear")
                        shading.set(qn("w:fill"), _hex(fill))
                        cell._tc.get_or_add_tcPr().append(shading)
        elif isinstance(block, Image):
            document.add_picture(str(block.path), width=Cm(block.width_cm))
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    document.save(path)
    return path


def xlsx_table(path, rows, sheet="Sheet1", header=True):
    """One-sheet workbook: header row in the accent color, banded rows, frozen header, fitted column widths."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    rows = _rows(rows)
    book = Workbook()
    ws = book.active
    ws.title = sheet[:31] or "Sheet1"
    for row in rows:
        ws.append(row)
    font = FONTS["sans"][0]
    rule = Side(style="thin", color=_hex(TABLE_THEME["rule"]))
    band = PatternFill("solid", fgColor=_hex(TABLE_THEME["band_fill"]))
    for r, row in enumerate(ws.iter_rows(), start=1):
        for cell in row:
            cell.font = Font(name=font, size=10, color=_hex(PALETTE["ink"]))
            cell.border = Border(bottom=rule)
            if header and r == 1:
                cell.font = Font(name=font, size=10, bold=True, color=_hex(TABLE_THEME["header_text"]))
                cell.fill = PatternFill("solid", fgColor=_hex(TABLE_THEME["header_fill"]))
                cell.alignment = Alignment(vertical="center")
            elif r % 2 == 1:
                cell.fill = band
    if header and rows:
        ws.freeze_panes = "A2"
    for c in range(1, ws.max_column + 1):
        width = max((len(str(ws.cell(r, c).value or "")) for r in range(1, ws.max_row + 1)), default=8)
        ws.column_dimensions[get_column_letter(c)].width = min(max(width + 2, 8), 60)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    book.save(path)
    return path


def csv_cell(value):
    """A text cell that starts like a formula gets a leading apostrophe, so a spreadsheet shows it as text."""
    if value is None:
        return ""
    if isinstance(value, str) and value.startswith(CSV_FORMULA_START):
        return "'" + value
    return value


def csv_table(path, rows):
    """UTF-8 CSV with a header row as given. Text that starts like a spreadsheet formula is kept as text."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        for row in rows:
            writer.writerow([csv_cell(cell) for cell in row])
    return path

