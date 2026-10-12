#!/usr/bin/env python3
"""Typesets a math solution as PNG "sheet" images in the Milliy sertifikat style.

Runs inside Claude's code execution sandbox (Python + matplotlib, no LaTeX). Claude writes a
JSON description of the solution and calls:

    python render_solution.py solution.json OUTPUT_DIR

which writes yechim-1.png (and yechim-2.png ... when the solution needs more than one page), plus
yechim.json, a copy of the input the bot keeps as the text of the answer.
Formulas use matplotlib's mathtext with the Computer Modern font set, so they look like LaTeX.

JSON shape (all text fields may contain inline math between $...$):
{
  "topic": "Kvadrat funksiya",                 # short tag shown on the question box
  "question": ["Rasmda ... toping.", {"math": "..."}],   # paragraphs; {"math"} = display formula
  "figure": "savol.png",                       # optional: figure for the question (path)
  "options": {"A": "$2\\sqrt{2}$", "B": "...", "C": "...", "D": "..."},  # optional
  "given": ["$m=2\\ \\mathrm{kg}$", "$t=5\\ \\mathrm{s}$"],   # optional (physics): "Berilgan"
  "find": ["$F$ — ?"],                       # optional (physics): "Topish kerak"
  "steps": [
    {"title": "Parabola tenglamasi", "body": ["Ildizlari $-2$ va $4$:", {"math": "y=a(x+2)(x-4)"}]},
    {"title": "Tekshiruv", "check": true, "body": ["..."]}
  ],
  "answer": {"option": "B"}                    # or {"parts": [{"label": "a)", "value": "$\\dfrac{9}{8}$"}]}
                                               # or {"value": "$x = 2$"}
}
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Callable

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.font_manager import FontProperties  # noqa: E402
from matplotlib.mathtext import MathTextParser  # noqa: E402
from matplotlib.patches import Circle, FancyBboxPatch, Polygon, Rectangle  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- Branding -----------------------------------------------------------------------------
TITLE = "USTOZ AI"
SUBTITLE = "Masala yechimi · Milliy sertifikat tayyorlov"
AUTHOR = "Abdulaziz Madg‘oziyev"
HANDLE = "@matematikamilliysertifikatuz"

NAVY = "#0F2A5F"
NAVY_TEXT = "#1B3A80"
GOLD = "#E3A82B"
BOX_BG = "#EAF0FA"
INK = "#1A1A1A"
MUTED = "#8E9BB5"
TG_BLUE = "#2AA3E0"

# ---- Geometry (logical px; the PNG is rendered at SCALE x) ---------------------------------
W = 900
MARGIN = 92
CONTENT_W = W - 2 * MARGIN
# Pages stay roughly A4-shaped so Telegram doesn't shrink the text unreadably. A page may grow to
# MAX_PAGE_H_HARD rather than push a small remainder (e.g. just the answer box) onto its own page.
MAX_PAGE_H = 1280
MAX_PAGE_H_HARD = 1560
SCALE = 2
HEADER_H = 122
FOOTER_H = 70

BODY = 17
LEADING = 1.3

# ---- Fonts --------------------------------------------------------------------------------
# Fonts sit next to this script in the sandbox (uploaded files share a directory) or in ./fonts.
FONT_DIRS = [os.environ.get("SOLUTION_FONTS", ""), os.path.join(HERE, "fonts"), HERE]
for name in ("cmunrm.otf", "cmunbx.otf", "cmunti.otf", "cmunbi.otf"):
    for d in FONT_DIRS:
        path = os.path.join(d, name)
        if d and os.path.exists(path):
            font_manager.fontManager.addfont(path)
            break

SERIF = "CMU Serif"
plt.rcParams.update({
    "mathtext.fontset": "cm",
    "font.family": "serif",
    "font.serif": [SERIF, "DejaVu Serif"],
    "axes.unicode_minus": True,
})


def prop(size: float, bold: bool = False, italic: bool = False) -> FontProperties:
    # CMU's bold faces are registered as "expanded"; ask for that width or matplotlib picks regular.
    return FontProperties(family=SERIF, size=size, weight="bold" if bold else "normal",
                          style="italic" if italic else "normal", stretch="expanded" if bold else "normal")


# ---- Math preprocessing -------------------------------------------------------------------
# mathtext implements most of TeX math; map the common commands it lacks to ones it has.
REPLACEMENTS = [
    (r"\tfrac", r"\frac"),
    (r"\displaystyle", ""),
    (r"\limits", ""),
    (r"\nolimits", ""),
    (r"\left.", ""),
    (r"\right.", ""),
    (r"\Longrightarrow", r"\Rightarrow"),
    (r"\Longleftrightarrow", r"\Leftrightarrow"),
    (r"\implies", r"\Rightarrow"),
    (r"\iff", r"\Leftrightarrow"),
    (r"\dots", r"\ldots"),
    (r"\lvert", "|"),
    (r"\rvert", "|"),
    (r"\,", r"\/"),
    (r"\!", ""),
    (r"\bigl", r"\left"),
    (r"\bigr", r"\right"),
    (r"\Bigl", r"\left"),
    (r"\Bigr", r"\right"),
]


def fix_math(src: str) -> str:
    for a, b in REPLACEMENTS:
        src = src.replace(a, b)
    # Size modifiers (\big| \Bigg( ...): mathtext sizes delimiters itself only via \left/\right.
    src = re.sub(r"\\[bB]igg?(?![a-zA-Z])", "", src)
    # \left/\right must pair up in mathtext; if they don't (e.g. an evaluation bar "\right]_{a}^{b}"),
    # fall back to plain delimiters.
    if len(re.findall(r"\\left(?![a-zA-Z])", src)) != len(re.findall(r"\\right(?![a-zA-Z])", src)):
        src = re.sub(r"\\(?:left|right)(?![a-zA-Z])", "", src)
    src = re.sub(r"\\ge(?![a-zA-Z])", r"\\geq", src)
    src = re.sub(r"\\le(?![a-zA-Z])", r"\\leq", src)
    src = re.sub(r"\\(?:underbrace|overbrace)\{((?:[^{}]|\{[^{}]*\})*)\}(?:[_^]\{(?:[^{}]|\{[^{}]*\})*\})?",
                 r"\1", src)
    src = re.sub(r"\\boxed\{((?:[^{}]|\{[^{}]*\})*)\}", r"\1", src)
    src = re.sub(r"\\color\{[^}]*\}", "", src)
    src = src.replace(r"\cfrac", r"\dfrac").replace(r"\lVert", r"\Vert").replace(r"\rVert", r"\Vert")
    src = re.sub(r"\\square(?![a-zA-Z])", "□", src)
    src = re.sub(r"\\operatorname\{([^}]*)\}", r"\\mathrm{\1}", src)
    src = re.sub(r"\\(?:text|textrm|textnormal|mbox)\{([^}]*)\}", lambda m: r"\mathrm{" + m.group(1).replace(" ", r"\ ") + "}", src)
    src = re.sub(r"\\textbf\{([^}]*)\}", lambda m: r"\mathbf{" + m.group(1).replace(" ", r"\ ") + "}", src)
    return src


def uzbek_quotes(text: str) -> str:
    """Typesets Uzbek Latin apostrophes: o'/g' become o‘/g‘, other letter-apostrophes become ’."""
    text = re.sub(r"(?<=[oOgG])['ʻ`’](?=\w)", "‘", text)
    return re.sub(r"(?<=\w)['ʼ`](?=\w)", "’", text)


def fix_mixed(text: str) -> str:
    """Applies fix_math to each $...$ span and Uzbek typography to the text around them."""
    text = text.replace("✓", r"$\checkmark$").replace("✔", r"$\checkmark$")
    parts = re.split(r"(\$[^$]+\$)", text)
    return "".join("$" + fix_math(p[1:-1]) + "$" if p.startswith("$") and p.endswith("$") and len(p) > 1
                   else uzbek_quotes(p) for p in parts)


_parser = MathTextParser("path")


def check_math(src: str, where: str) -> None:
    """Fails with a readable message (for Claude to fix) if mathtext can't parse the formula."""
    try:
        _parser.parse(f"${src}$", dpi=72, prop=prop(BODY))
    except ValueError as err:
        first = str(err).strip().splitlines()
        raise SystemExit(f"FORMULA XATOSI ({where}): {src!r}\n{first[-1] if first else err}\n"
                         "Formulani mathtext qo'llaydigan buyruqlar bilan qayta yozing.")


# ---- Measuring ----------------------------------------------------------------------------
# Layout units are points: pages are W/72 inches wide, so a 17.5 pt font is 17.5 units tall.
_fig = plt.figure(figsize=(W / 72, 4), dpi=72)
_renderer = _fig.canvas.get_renderer()


def measure(text: str, fp: FontProperties) -> tuple[float, float, float]:
    """Width, height and descent of a (possibly mixed text/$math$) string, in layout units."""
    return _renderer.get_text_width_height_descent(text, fp, ismath="$" in text)


# ---- Layout model ---------------------------------------------------------------------------
@dataclass
class Item:
    """A drawable block with a fixed height; draw(ax, y) paints it with its top at y."""
    height: float
    draw: Callable[[plt.Axes, float], None]
    keep_with_next: bool = False
    space: bool = False
    baseline: float = 0.0  # text lines: distance from the item's top to the text baseline


def wrap(text: str, fp: FontProperties, width: float, first_indent: float = 0) -> list[str]:
    tokens = re.findall(r"\$[^$]+\$[^\s$]*|\S+", text)
    lines: list[str] = []
    line = ""
    avail = width - first_indent
    for tok in tokens:
        cand = f"{line} {tok}" if line else tok
        if not line or measure(cand, fp)[0] <= avail:
            line = cand
        else:
            lines.append(line)
            line = tok
            avail = width
    if line:
        lines.append(line)
    return lines or [""]


def paragraph(text: str, fp: FontProperties, x: float, width: float, color: str = INK,
              lead: str | None = None, lead_fp: FontProperties | None = None) -> list[Item]:
    """Wrapped paragraph, one Item per line so pages can break between lines."""
    text = fix_mixed(text)
    for span in re.findall(r"\$([^$]+)\$", text):
        check_math(span, "matn")
    lead_w = measure(lead + " ", lead_fp)[0] if lead else 0
    lines = wrap(text, fp, width, lead_w)
    size = fp.get_size_in_points()
    items: list[Item] = []
    for i, ln in enumerate(lines):
        _, h, d = measure(ln, fp)
        ascent = max(size * 0.95, h - d)
        line_h = max(size * LEADING, ascent + d + size * 0.3)

        baseline = (line_h - size * LEADING) / 2 + ascent + size * 0.22

        def draw(ax, y, ln=ln, i=i, baseline=baseline):
            base = y + baseline
            x0 = x
            if i == 0 and lead:
                ax.text(x0, base, lead, fontproperties=lead_fp, color=NAVY_TEXT, va="baseline")
                x0 += lead_w
            ax.text(x0, base, ln, fontproperties=fp, color=color, va="baseline")

        items.append(Item(line_h, draw, baseline=baseline))
    return items


def display_math(src: str, x: float, width: float, size: float = BODY * 1.08) -> Item:
    src = fix_math(src)
    check_math(src, "formula")
    fp = prop(size)
    w, h, d = measure(f"${src}$", fp)
    if w > width:  # shrink very long formulas to fit the column
        fp = prop(size * width / w)
        w, h, d = measure(f"${src}$", fp)
    pad = size * 0.4
    height = h + 2 * pad

    def draw(ax, y):
        ax.text(x + (width - w) / 2, y + pad + (h - d), f"${src}$", fontproperties=fp, color=INK,
                va="baseline")

    return Item(height, draw)


def spacer(h: float) -> Item:
    return Item(h, lambda ax, y: None, space=True)


def rounded(ax, x, y, w, h, r, fc, ec="none", lw=1.2, z=0):
    ax.add_patch(FancyBboxPatch((x + r, y + r), w - 2 * r, h - 2 * r,
                                boxstyle=f"round,pad={r}", fc=fc, ec=ec, lw=lw, zorder=z))


# ---- Sections -----------------------------------------------------------------------------
def body_items(body: list, x: float, width: float) -> list[Item]:
    items: list[Item] = []
    for part in body:
        if isinstance(part, dict) and "math" in part:
            items.append(display_math(part["math"], x, width))
        else:
            items.extend(paragraph(str(part), prop(BODY), x, width))
    return items


def question_section(sol: dict) -> list[Item]:
    figure = sol.get("figure")
    img = plt.imread(figure) if figure and os.path.exists(figure) else None
    pad_x, pad_y = 24, 16
    inner_x = MARGIN + 8 + pad_x
    inner_w = CONTENT_W - 8 - 2 * pad_x
    text_w = inner_w * (0.56 if img is not None else 1)

    fp = prop(BODY + 0.5)
    q = sol.get("question") or []
    if isinstance(q, str):
        q = [q]
    q = list(q)
    if q and isinstance(q[0], str):  # the template prints "Savol." itself
        q[0] = re.sub(r"^\s*Savol[.:]?\s*", "", q[0])
    lines: list[Item] = []
    first = True
    for part in q:
        if isinstance(part, dict) and "math" in part:
            lines.append(display_math(part["math"], inner_x, text_w))
        else:
            lines.extend(paragraph(str(part), fp, inner_x, text_w,
                                   lead="Savol." if first else None, lead_fp=prop(BODY + 0.5, bold=True)))
        first = False

    tag_h = 30
    text_h = sum(i.height for i in lines)
    fig_h = 0.0
    if img is not None:
        fig_w = inner_w - text_w - 18
        fig_h = min(fig_w * img.shape[0] / img.shape[1], 290)
        fig_w = fig_h * img.shape[1] / img.shape[0]
    options = sol.get("options") or {}
    opt_h = 62 if options else 0
    content_h = max(text_h, fig_h)
    box_h = pad_y + tag_h * 0.6 + content_h + (opt_h + 10 if options else 0) + pad_y

    def draw(ax, y):
        ax.add_patch(Rectangle((MARGIN, y), CONTENT_W, box_h, fc=BOX_BG, ec="none", zorder=0))
        ax.add_patch(Rectangle((MARGIN, y), 7, box_h, fc=NAVY, ec="none", zorder=1))
        topic = uzbek_quotes(str(sol.get("topic") or ""))
        if topic:
            tw = measure(topic, prop(17, bold=True))[0] + 28
            ax.add_patch(Rectangle((MARGIN + CONTENT_W - tw, y), tw, tag_h, fc=NAVY, ec="none", zorder=1))
            ax.text(MARGIN + CONTENT_W - tw / 2, y + tag_h / 2 + 6, topic, fontproperties=prop(17, bold=True),
                    color="white", ha="center", va="baseline", zorder=2)
        ty = y + pad_y + tag_h * 0.6
        if img is not None:
            fy = ty + max(0, (content_h - fig_h) / 2)
            fx = inner_x + inner_w - fig_w
            ax.imshow(img, extent=(fx, fx + fig_w, fy + fig_h, fy), zorder=2, interpolation="antialiased")
        ty += max(0, (content_h - text_h) / 2) if img is not None else 0
        for it in lines:
            it.draw(ax, ty)
            ty += it.height
        if options:
            oy = y + box_h - pad_y - opt_h + 6
            draw_options(ax, inner_x, oy, inner_w, options, chosen=None)

    return [Item(box_h, draw)]


def draw_options(ax, x, y, width, options: dict, chosen: str | None, h: float = 50, gap: float = 14):
    keys = [k for k in ("A", "B", "C", "D", "E") if k in options]
    n = len(keys)
    bw = (width - gap * (n - 1)) / n
    for i, k in enumerate(keys):
        bx = x + i * (bw + gap)
        sel = k == chosen
        rounded(ax, bx, y, bw, h, 7, fc=NAVY if sel else "white", ec=NAVY_TEXT, lw=1.1, z=3)
        val = fix_mixed(str(options[k]))
        label = f"{k})"
        fp_l = prop(BODY, bold=True)
        fp_v = prop(BODY)
        lw = measure(label + " ", fp_l)[0]
        vw, vh, vd = measure(val, fp_v)
        if lw + vw > bw - 16:
            fp_v = prop(BODY * (bw - 16 - lw) / vw)
            vw, vh, vd = measure(val, fp_v)
        total = lw + vw
        base = y + h / 2 + (vh - vd) / 2 - 1
        color = "white" if sel else NAVY_TEXT
        ax.text(bx + (bw - total) / 2, base, label, fontproperties=fp_l, color=color, va="baseline", zorder=4)
        ax.text(bx + (bw - total) / 2 + lw, base, val, fontproperties=fp_v,
                color="white" if sel else INK, va="baseline", zorder=4)


def given_section(sol: dict) -> list[Item]:
    """Physics-style "Berilgan / Topish kerak" block: known quantities and what to find."""
    rows = [("Berilgan:", sol.get("given") or []), ("Topish kerak:", sol.get("find") or [])]
    rows = [(label, [str(v) for v in values]) for label, values in rows if values]
    if not rows:
        return []
    pad_x, pad_y = 22, 12
    label_fp = prop(BODY + 0.5, bold=True)
    label_w = max(measure(label + " ", label_fp)[0] for label, _ in rows)
    x = MARGIN + pad_x + label_w
    width = CONTENT_W - 2 * pad_x - label_w
    blocks = []
    for label, values in rows:
        # Wide gaps between quantities; each one stays on a single line.
        text = "; ".join(values)
        blocks.append((label, paragraph(text, prop(BODY + 0.5), x, width)))
    inner_h = sum(it.height for _, lines in blocks for it in lines) + 6 * (len(blocks) - 1)
    box_h = inner_h + 2 * pad_y

    def draw(ax, y):
        ax.add_patch(Rectangle((MARGIN, y), CONTENT_W, box_h, fc="white", ec=NAVY_TEXT, lw=1.1, zorder=0))
        ax.add_patch(Rectangle((MARGIN, y), 5, box_h, fc=GOLD, ec="none", zorder=1))
        ty = y + pad_y
        for i, (label, lines) in enumerate(blocks):
            if i:
                ax.add_patch(Rectangle((MARGIN + pad_x, ty + 2), CONTENT_W - 2 * pad_x, 0.8,
                                       fc="#C9D3E6", ec="none", zorder=1))
                ty += 6
            ax.text(MARGIN + pad_x, ty + lines[0].baseline, label, fontproperties=label_fp, color=NAVY_TEXT, va="baseline")
            for it in lines:
                it.draw(ax, ty)
                ty += it.height

    return [Item(box_h, draw), spacer(14)]


def yechim_heading() -> Item:
    def draw(ax, y):
        ax.text(MARGIN, y + 38, "Yechim", fontproperties=prop(32, bold=True), color=NAVY_TEXT, va="baseline")
        ax.add_patch(Rectangle((MARGIN, y + 54), 92, 3.5, fc=GOLD, ec="none"))

    return Item(66, draw, keep_with_next=True)


def step_title(n: int, title: str, check: bool) -> Item:
    title = fix_mixed(title)
    for span in re.findall(r"\$([^$]+)\$", title):
        check_math(span, "sarlavha")
    fp = prop(BODY + 2.5, bold=True)

    def draw(ax, y):
        cy = y + 18
        ax.add_patch(Circle((MARGIN + 11, cy), 11, fc=NAVY_TEXT, ec="none", zorder=2))
        mark = "✓" if check else str(n)
        ax.text(MARGIN + 11, cy + 4.6, mark, fontproperties=FontProperties(family="DejaVu Sans", size=12, weight="bold") if check else prop(13.5, bold=True),
                color="white", ha="center", va="baseline", zorder=3)
        ax.text(MARGIN + 30, cy + 6.5, title, fontproperties=fp, color=NAVY_TEXT, va="baseline")

    return Item(33, draw, keep_with_next=True)


def answer_section(sol: dict) -> list[Item]:
    ans = sol.get("answer") or {}
    options = sol.get("options") or {}
    h = 96

    def draw(ax, y):
        ax.add_patch(Rectangle((MARGIN, y), CONTENT_W, h, fc="white", ec=NAVY, lw=1.6, zorder=1))
        ax.text(MARGIN + 26, y + h / 2 + 6, "Javob:", fontproperties=prop(BODY + 2, bold=True), color=NAVY_TEXT,
                va="baseline", zorder=2)
        left = MARGIN + 150
        width = CONTENT_W - 150 - 20
        if ans.get("option") and options:
            draw_options(ax, left, y + (h - 46) / 2, width, options, chosen=str(ans["option"]).strip("() ").upper()[:1],
                         h=46, gap=6)
            return
        parts = ans.get("parts") or ([{"label": "", "value": ans["value"]}] if ans.get("value") else [])
        x = MARGIN + CONTENT_W - 20
        for part in reversed(parts):
            val = fix_mixed(str(part.get("value", "")))
            if "$" not in val and re.search(r"[\\^_{}]", val):
                val = f"${val}$"
            fp = prop(BODY + 2)
            vw, vh, vd = measure(val, fp)
            bw, bh = max(vw + 36, 74), max(vh + 26, 52)
            if bh > h - 16:
                fp = prop((BODY + 2) * (h - 30) / vh)
                vw, vh, vd = measure(val, fp)
                bw, bh = max(vw + 36, 74), h - 16
            bx = x - bw
            rounded(ax, bx, y + (h - bh) / 2, bw, bh, 7, fc=NAVY, z=2)
            ax.text(bx + bw / 2 - vw / 2, y + h / 2 + (vh - vd) / 2 - vd / 2 + 1, val, fontproperties=fp, color="white",
                    va="baseline", zorder=3)
            x = bx - 10
            label = part.get("label")
            if label:
                lw = measure(label, prop(BODY + 2, bold=True))[0]
                ax.text(x - lw, y + h / 2 + 6, label, fontproperties=prop(BODY + 2, bold=True), color=NAVY_TEXT,
                        va="baseline", zorder=3)
                x -= lw + 26

    return [Item(h, draw)]


# ---- Page chrome --------------------------------------------------------------------------
def today_tashkent() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=5)).strftime("%d.%m.%Y")


def draw_header(ax, page: int, pages: int):
    ax.add_patch(Rectangle((0, 0), W, HEADER_H - 6, fc=NAVY, ec="none", zorder=0))
    ax.add_patch(Rectangle((0, HEADER_H - 6), W, 6, fc=GOLD, ec="none", zorder=0))
    ax.text(MARGIN + 13, 58, TITLE, fontproperties=prop(31, bold=True), color="white", va="baseline")
    ax.text(MARGIN + 13, 88, SUBTITLE, fontproperties=prop(17), color=MUTED, va="baseline")
    badge = today_tashkent()
    bw = measure(badge, prop(21, bold=True))[0] + 26
    rounded(ax, W - 92 - bw, 33, bw, 34, 4, fc=GOLD)
    ax.text(W - 92 - bw / 2, 58, badge, fontproperties=prop(21, bold=True), color=NAVY, ha="center", va="baseline")
    if pages > 1:
        ax.text(W - 92 - bw / 2, 96, f"{page}/{pages}-sahifa", fontproperties=prop(17, bold=True), color="white",
                ha="center", va="baseline")


def draw_footer(ax, y):
    ax.add_patch(Rectangle((MARGIN, y), CONTENT_W, 1.2, fc=NAVY_TEXT, ec="none"))
    base = y + 36
    ax.text(MARGIN + 8, base, AUTHOR, fontproperties=prop(20, bold=True), color=NAVY_TEXT, va="baseline")
    hw = measure(HANDLE, prop(20, bold=True))[0]
    hx = MARGIN + CONTENT_W - hw
    ax.text(hx, base, HANDLE, fontproperties=prop(20, bold=True), color=NAVY_TEXT, va="baseline")
    cx, cy, r = hx - 22, base - 7, 12
    ax.add_patch(Circle((cx, cy), r, fc=TG_BLUE, ec="none"))
    ax.add_patch(Polygon([(cx - 6.5, cy + 0.5), (cx + 6.5, cy - 5), (cx + 3.5, cy + 6), (cx - 0.5, cy + 2.5)],
                         closed=True, fc="white", ec="none"))


# ---- Pagination and rendering ----------------------------------------------------------------
def build(sol: dict) -> list[Item]:
    items: list[Item] = []
    if sol.get("question"):
        items += question_section(sol)
        items.append(spacer(22))
    items += given_section(sol)
    items.append(yechim_heading())
    for i, step in enumerate(sol.get("steps") or [], start=1):
        check = bool(step.get("check"))
        items.append(step_title(i, str(step.get("title", "")), check))
        items += body_items(step.get("body") or [], MARGIN, CONTENT_W)
        items.append(spacer(14))
    if sol.get("answer"):
        items.append(spacer(12))
        items += answer_section(sol)
    return items


def paginate(items: list[Item]) -> list[list[Item]]:
    chrome = HEADER_H + 36 + FOOTER_H + 24
    total = sum(i.height for i in items)
    if total <= MAX_PAGE_H_HARD - chrome:
        return [items]
    room = MAX_PAGE_H - chrome
    pages: list[list[Item]] = [[]]
    used = 0.0
    i = 0
    while i < len(items):
        it = items[i]
        # Keep headings with the first line that follows them.
        need = it.height + (items[i + 1].height if it.keep_with_next and i + 1 < len(items) else 0)
        if used + need > room and pages[-1]:
            pages.append([])
            used = 0.0
            if it.space:  # no blank gap at the top of a page
                i += 1
                continue
        pages[-1].append(it)
        used += it.height
        i += 1
    # Fold a short last page back into the previous one when the result still fits.
    if len(pages) > 1 and sum(i.height for i in pages[-2] + pages[-1]) <= MAX_PAGE_H_HARD - chrome:
        pages[-2] += [i for i in pages.pop() if not i.space or pages[-2]]
    return pages


def render(sol: dict, out_dir: str) -> list[str]:
    pages = paginate(build(sol))
    paths = []
    for n, page in enumerate(pages, start=1):
        content_h = sum(i.height for i in page)
        H = HEADER_H + 36 + content_h + 24 + FOOTER_H
        fig = plt.figure(figsize=(W / 72, H / 72), dpi=72 * SCALE)
        ax = fig.add_axes((0, 0, 1, 1))
        ax.set_xlim(0, W)
        ax.set_ylim(H, 0)
        ax.axis("off")
        fig.patch.set_facecolor("white")
        draw_header(ax, n, len(pages))
        y = HEADER_H + 36
        for it in page:
            it.draw(ax, y)
            y += it.height
        draw_footer(ax, y + 24)
        path = os.path.join(out_dir, f"yechim-{n}.png")
        fig.savefig(path, dpi=72 * SCALE, facecolor="white")
        plt.close(fig)
        paths.append(path)
    return paths


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Foydalanish: python render_solution.py solution.json OUTPUT_DIR")
    with open(sys.argv[1], encoding="utf-8") as f:
        sol = json.load(f)
    for path in render(sol, sys.argv[2]):
        print("OK", path)
    # The bot keeps the text of the solution so follow-up questions can refer to it.
    with open(os.path.join(sys.argv[2], "yechim.json"), "w", encoding="utf-8") as f:
        json.dump(sol, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
