"""DESIGN.md 与 macos/src/styles/tokens.css 的 token 一致性校验。

DESIGN.md 第 2 节是唯一视觉真理来源，但文档与实现会悄悄漂移——本脚本 2026-08-20 首次
运行时就抓出 --bg-selected-table 在文档里还是旧青 rgba(78,201,212)、实现已换成
rgba(62,214,227) 的色相漂移。改完 token 后跑一遍，退出码非 0 即有不一致。

    python3 UI/tools/token-drift.py UI

数值先归一化再比较，所以 .05 与 0.05 不会被误报成漂移。

2026-08-21 补两个盲区（第三批复核抓出来的）：
  · 原正则 `--[a-z-]+` 匹配不到带数字的名字，--fs-11 / --lh-12 / --sp-1 / --dur-slow
    这些从来没被校验过；
  · 浅色只查 [data-theme="light"] 段，@media 系统态那份重复定义从不校验，
    缺一处就有一种主题组合失效。
仍未覆盖：只做 doc→impl 单向，CSS 里多出来的 token 不报——DESIGN.md 第 2.4 节对
圆角这类值本就写「数值见 §5」占位，反向全报会全是噪音。两侧 token 对等另见 token-parity.py。
"""
import re, sys, pathlib

def norm(v):
    v = re.sub(r'\s+', '', v.lower())
    # 0.50 / .5 / 0.5 统一成同一个数值串
    def fix(m):
        return repr(float(m.group(0))).rstrip('0').rstrip('.') or '0'
    return re.sub(r'(?<![\w#])\.?\d+\.?\d*', fix, v)

def toks(text):
    d = {}
    for line in text.splitlines():
        m = re.match(r'\s*(--[a-z0-9-]+):\s*([^;]+);', line)
        if m:
            d[m.group(1)] = norm(m.group(2))
    return d

def block(md, header):
    return re.search(re.escape(header) + r".*?```css\n(.*?)```", md, re.S).group(1)

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
design = (root / "DESIGN.md").read_text(encoding="utf-8")
css = (root / "macos/src/styles/tokens.css").read_text(encoding="utf-8")

def light_media(css):
    """@media (prefers-color-scheme: light) 内的系统态浅色段。"""
    m = re.search(r'@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{(.*?)\n  \}', css, re.S)
    return m.group(1) if m else ''

def drop_placeholders(d):
    """值是「/* 平台各自定义，见 §5 */」这类占位的项跳过——它们本来就由第 5 节给值。"""
    return {k: v for k, v in d.items() if '/*' not in v}

bare_root = css.split(':root {')[1].split('@media')[0]
doc_dark = toks(block(design, "### 2.1"))
doc_light = toks(block(design, "### 2.2 "))
# 2.3/2.4/2.5 是与主题无关的 token，全在裸 :root 里；此前从无门禁，
# 字号/行高/间距/阴影/层级/动效可以随便漂移都不会被发现。
doc_rest = {}
for header in ("### 2.3", "### 2.4", "### 2.5"):
    doc_rest.update(drop_placeholders(toks(block(design, header))))
pairs = [
    ("深色 2.1 → :root", doc_dark, toks(bare_root)),
    ("浅色 2.2 → [data-theme=light]", doc_light, toks(css.split(':root[data-theme="light"] {')[1])),
    # 系统态那段与手动态逐字重复，缺一处就有一种主题组合失效，所以两处都要校验
    ("浅色 2.2 → @media 系统态", doc_light, toks(light_media(css))),
    ("排版/间距/动效 2.3-2.5 → :root", doc_rest, toks(bare_root)),
]
total = 0
for name, doc, impl in pairs:
    diff = [(k, doc[k], impl[k]) for k in doc if k in impl and doc[k] != impl[k]]
    missing = [k for k in doc if k not in impl]
    total += len(diff) + len(missing)
    print(f"=== {name}: 文档 {len(doc)} 项，漂移 {len(diff)}，实现缺失 {len(missing)}")
    for k, a, b in diff:
        print(f"    漂移 {k}: DESIGN={a}  CSS={b}")
    for k in missing:
        print(f"    缺失 {k}")
print(f"\n总计 {total} 项不一致")
sys.exit(1 if total else 0)
