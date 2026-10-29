import html, subprocess, sys

FONT = '"Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC",system-ui,sans-serif'
C = dict(
    ink="#1b2231", ink2="#5b6577", ink3="#8c96a8",
    bg="#f5f7fb", card="#ffffff", line="#e2e7f0",
    blue="#3b6ef6", blueSoft="#eaf0ff",
    teal="#0d9488", tealSoft="#e6f7f5",
    amber="#d97706", amberSoft="#fef4e6",
    violet="#7c5cf0", violetSoft="#efeafe",
)

def esc(s): return html.escape(s, quote=True)

def text(x, y, s, size=13, fill=C["ink"], weight=400, anchor="start", ls=0):
    return (f'<text x="{x}" y="{y}" font-family={FONT!r} font-size="{size}" fill="{fill}" '
            f'font-weight="{weight}" text-anchor="{anchor}" letter-spacing="{ls}">{esc(s)}</text>')

def mono(x, y, s, size=12, fill=C["ink2"], anchor="start"):
    return (f'<text x="{x}" y="{y}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" '
            f'font-size="{size}" fill="{fill}" text-anchor="{anchor}">{esc(s)}</text>')

def card(x, y, w, h, fill=C["card"], stroke=C["line"], r=12, shadow=True):
    filt = ' filter="url(#soft)"' if shadow else ''
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="1"{filt}/>')

def pill(x, y, w, h, label, fg, bg, size=12, weight=500):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{h/2}" fill="{bg}"/>'
            + text(x + w/2, y + h/2 + 4, label, size=size, fill=fg, weight=weight, anchor="middle"))

def arrow(pts, color=C["ink3"], width=1.6, dash=None, head=True, marker="ah"):
    d = " ".join(f"{'M' if i==0 else 'L'}{x},{y}" for i,(x,y) in enumerate(pts))
    dash_attr = f' stroke-dasharray="{dash}"' if dash else ''
    mk = f' marker-end="url(#{marker})"' if head else ''
    return (f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" '
            f'stroke-linecap="round" stroke-linejoin="round"{dash_attr}{mk}/>')

def defs():
    markers = ""
    for name, color in (("ah", C["ink3"]), ("ahb", C["blue"]), ("aht", C["teal"]), ("aha", C["amber"]), ("ahv", C["violet"])):
        markers += (f'<marker id="{name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" '
                    f'orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="{color}"/></marker>')
    return f'''<defs>
<filter id="soft" x="-12%" y="-30%" width="124%" height="170%">
  <feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="#1b2231" flood-opacity="0.06"/>
</filter>
<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">
  <circle cx="1.2" cy="1.2" r="1.1" fill="#dfe5f0"/>
</pattern>
{markers}
</defs>'''

def page(w, h, body, bg=C["bg"]):
    return f'''<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{{margin:0;padding:0;background:{bg};}}
  svg{{display:block;}}
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
{defs()}
<rect width="{w}" height="{h}" fill="{bg}"/>
<rect width="{w}" height="{h}" fill="url(#dots)" opacity="0.55"/>
{body}
</svg></body></html>'''

# ---------------- Diagram A: pipeline ----------------
def diagram_a():
    W, H = 1040, 380
    b = []
    b.append(text(40, 50, "一次搜索的数据通路", size=18, weight=600))
    b.append(text(40, 73, "137 个会话日志 → 3 MB 侧车索引 → 内存匹配 → 侧栏面板", size=12.5, fill=C["ink3"]))

    items = [
        (40,  190, "磁盘", C["teal"], "137 个会话日志", ["多帧 zstd", "共 192 MB"], "不是明文，没法 grep"),
        (300, 190, "Host", C["blue"], "scan.mjs", ["按帧解压", "只解析命中行"], "全量 2.1s / 增量 4ms"),
        (560, 190, "磁盘", C["teal"], "侧车索引", ["每会话 1 个 JSON", "共 3 MB"], "只存提取出的文本"),
        (820, 190, "Host", C["blue"], "内存匹配", ["子串匹配 + 排序", "全命中优先"], "0.4–0.8ms / 次"),
    ]
    y = 108
    for x, w, tag, tint, title, lines, foot in items:
        b.append(f'<rect x="{x}" y="{y}" width="{w}" height="152" rx="14" fill="{C["card"]}" stroke="{C["line"]}" filter="url(#soft)"/>')
        b.append(f'<rect x="{x}" y="{y+14}" width="3" height="{152-28}" rx="1.5" fill="{tint}"/>')
        b.append(text(x + 18, y + 28, tag, size=11, fill=tint, weight=600, ls=1))
        b.append(text(x + 18, y + 56, title, size=16, weight=600))
        yy = y + 82
        for ln in lines:
            b.append(text(x + 18, yy, ln, size=12.5, fill=C["ink2"])); yy += 21
        b.append(f'<line x1="{x+18}" y1="{y+114}" x2="{x+w-18}" y2="{y+114}" stroke="{C["line"]}"/>')
        b.append(text(x + 18, y + 136, foot, size=11.5, fill=C["ink3"]))

    pairs = [(230, 300), (490, 560), (750, 820)]
    labels = ["逐帧解码", "写入文本", "读进内存"]
    for (x1, x2), lab in zip(pairs, labels):
        cy = y + 76
        b.append(arrow([(x1 + 10, cy), (x2 - 10, cy)], color="#aab3c4", width=1.7))
        b.append(text((x1 + x2) / 2, cy - 12, lab, size=11.5, fill=C["ink3"], anchor="middle"))

    # panel callout under last stage
    bx, by = 800, 300
    b.append(f'<rect x="{bx}" y="{by}" width="220" height="58" rx="12" fill="{C["blueSoft"]}" stroke="#cddaff"/>')
    b.append(text(bx + 16, by + 24, "侧栏面板", size=13, weight=600, fill=C["blue"]))
    b.append(text(bx + 16, by + 44, "GET /search → JSON", size=11.5, fill=C["ink2"]))
    b.append(arrow([(bx + 110, y + 152), (bx + 110, by - 6)], color=C["blue"], width=1.7, marker="ahb"))

    # background backfill loop
    b.append(arrow([(655, y + 152), (655, 280), (395, 280), (395, y + 160)],
                   color=C["teal"], width=1.4, dash="5 5", marker="aht"))
    b.append(text(525, 304, "后台增量：尾部续读 + 子进程分批回填（≤2 worker）", size=11.5, fill=C["teal"], anchor="middle"))

    b.append(text(40, 308, "冷启动：stat 134 个日志 + 读 137 个侧车 ≈ 3ms", size=11.5, fill=C["ink3"]))
    b.append(text(40, 328, "之后的查询不碰日志，也不重建索引", size=11.5, fill=C["ink3"]))
    return page(W, H, "\n".join(b))

# ---------------- Diagram B: steps ----------------
def diagram_b():
    W, H = 620, 580
    b = []
    b.append(text(40, 50, "一次搜索发生了什么", size=18, weight=600))
    b.append(text(40, 73, "从敲下「优化」到会话打开，8 步；括号里是本机实测", size=12.5, fill=C["ink3"]))

    steps = [
        ("面板", "敲下关键词，260ms 后发请求", "GET /search?q=优化&fields=…&sort=…"),
        ("Host", "构建匹配器", "区分大小写 / 整词 / 正则三个开关，工作区与分组也在这里"),
        ("Host", "读侧车，在内存里做子串匹配", "不读日志、不重建索引（2–9ms，长查询 31ms）"),
        ("Host", "排序、截断、补标题", "时间线按时间倒序；分组模式按会话聚合，带命中数"),
        ("面板", "渲染结果：片段高亮、分组、分页", "每页 24 条，命中词在片段里保持可见"),
        ("Host", "返回会话内容与命中位置", "命中前 100 字 + 后 100 字，供悬停预览"),
        ("面板", "点结果 → 打开会话", "归档会话先解归档再打开"),
        ("面板", "滚到命中消息并高亮", "窗口没加载的旧消息不高亮，不阻塞打开"),
    ]
    rail_x = 64
    y0, step = 132, 56
    b.append(f'<line x1="{rail_x}" y1="{y0-18}" x2="{rail_x}" y2="{y0 + step*len(steps) - 34}" stroke="{C["line"]}" stroke-width="1.6"/>')
    for i, (lane, title, note) in enumerate(steps):
        y = y0 + i * step
        tint = C["blue"] if lane == "面板" else C["violet"]
        soft = C["blueSoft"] if lane == "面板" else C["violetSoft"]
        b.append(f'<circle cx="{rail_x}" cy="{y}" r="11.5" fill="#fff" stroke="{tint}" stroke-width="1.4"/>')
        b.append(text(rail_x, y + 4, str(i + 1), size=11, fill=tint, anchor="middle", weight=600))
        b.append(f'<rect x="{rail_x+26}" y="{y-11}" width="46" height="22" rx="11" fill="{soft}"/>')
        b.append(text(rail_x + 49, y + 4, lane, size=11, fill=tint, weight=600, anchor="middle"))
        b.append(text(rail_x + 88, y + 5, title, size=13.5, fill=C["ink"], weight=500))
        b.append(text(rail_x + 88, y + 24, note, size=11.5, fill=C["ink3"]))
    return page(W, H, "\n".join(b))

import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent
SIZE = {"flow": (1040, 380), "sequence": (620, 580)}
CHROME = "google-chrome"

for name, build in (("flow", diagram_a), ("sequence", diagram_b)):
    page_path = OUT / "src" / f"{name}.html"
    page_path.write_text(build(), encoding="utf-8")
    w, h = SIZE[name]
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--no-sandbox", "--force-device-scale-factor=2",
                    f"--window-size={w},{h}",
                    f"--screenshot={OUT / (name + '.png')}", page_path.as_uri()], check=True)
    print("wrote", OUT / (name + ".png"))
