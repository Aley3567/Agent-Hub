"""macos 与 windows 两侧 tokens.css 的 token 对等校验。

DESIGN.md 第 5 节的底线是「两侧的功能、信息架构、文案、token 命名完全一致，差异只在平台
差异表列出的维度里」。这条底线有两种破法，本脚本都查：

  1. **token 名不一致** —— 少一个名字，引用它的组件会静默拿到空值，不报错但样式塌掉。
  2. **不该有差异的值出现了差异** —— 深色色值、字号、间距、阴影、层级在第 5 节里没有
     被列为平台差异，所以两侧必须逐字相同。

反过来，第 5 节明文允许差异的维度（圆角、字体、动效 ×0.85、焦点环、控件密度、标题栏高、
Windows 无 vibrancy 的 --sidebar-bg，以及整个浅色层级）只做报告不判违规——把它们的实际
差异打印出来，方便人工确认差异方向是对的。

    python3 UI/tools/token-parity.py UI

退出码非 0 即有违规。
"""
import re, sys, pathlib

# 第 5 节平台差异表明文允许值不同的 token。允许缺失的另列，见 PLATFORM_ONLY。
VALUE_MAY_DIFFER = {
    '--radius-sm', '--radius-md', '--radius-lg',            # 圆角行：Fluent 更方
    '--font-ui', '--font-mono',                              # 字体行
    '--dur-instant', '--dur-fast', '--dur-normal',           # 动效行：全部 ×0.85
    '--dur-slow', '--dur-progress-loop',
    '--focus-ring-w', '--focus-ring-offset',                 # 焦点环行：1px / offset 1px
    '--row-h', '--control-h-sm', '--control-h-md',           # 控件密度行：各 −2px
    '--icon-btn-size', '--badge-h',
    '--titlebar-h',                                          # 标题栏行：32px vs 38px
    '--sidebar-bg',                                          # 背景材质行：Windows 不透明
}
# 浅色「层级」——第 5 节浅色行允许两侧不同的那一类。accent 与语义色不在其中。
LIGHT_LAYER_MAY_DIFFER = {
    '--bg-base', '--bg-surface', '--bg-elevated', '--bg-inset',
    '--bg-hover', '--bg-active',                              # 叠加色，随层级走
    '--border-subtle', '--border-default', '--border-strong',
    '--sidebar-bg',
}
# 只该存在于单侧的 token
PLATFORM_ONLY = {
    '--sidebar-blur': 'macos',          # vibrancy 模糊半径，Windows 不做 blur 兜底
    '--titlebar-inset-left': 'macos',   # 给红绿灯留位，Windows 窗口控件在右侧
    '--scrollbar-w': 'windows',         # 滚动条行：Windows 8px 常显，macOS 隐藏
    '--win-caption-w': 'windows',       # 标题栏行：自绘窗口控件 46×32
    '--win-close-hover-bg': 'windows',  # 标题栏行：close hover #c42b1c
    '--win-close-hover-fg': 'windows',
    '--win-close-press-bg': 'windows',
}

def norm(v):
    v = re.sub(r'\s+', '', v.lower())
    def fix(m):
        return repr(float(m.group(0))).rstrip('0').rstrip('.') or '0'
    return re.sub(r'(?<![\w#])\.?\d+\.?\d*', fix, v)

def toks(text):
    d = {}
    for line in text.splitlines():
        m = re.match(r'\s*(--[a-z-]+):\s*([^;]+);', line)
        if m:
            d[m.group(1)] = norm(m.group(2))
    return d

def dark_block(css):
    """裸 :root 段 —— 深色主题 + 全部与主题无关的 token 都在这里。"""
    return css.split(':root {')[1].split('@media')[0]

def light_block(css):
    """手动态浅色段。系统态那段与它逐字相同，校验一处即可。"""
    part = css.split(':root[data-theme="light"] {')
    return part[1] if len(part) > 1 else ''

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
mac = (root / 'macos/src/styles/tokens.css').read_text(encoding='utf-8')
win = (root / 'windows/src/styles/tokens.css').read_text(encoding='utf-8')

violations = 0

# ── 1. token 名集合 ────────────────────────────────────────────────
m_all, w_all = toks(mac), toks(win)
only_mac = sorted(set(m_all) - set(w_all))
only_win = sorted(set(w_all) - set(m_all))
print(f"=== token 名：macos {len(m_all)} 个，windows {len(w_all)} 个")
for k in only_mac:
    if PLATFORM_ONLY.get(k) == 'macos':
        print(f"    仅 macos（平台专属，允许）{k}")
    else:
        print(f"    违规·windows 缺失 {k}")
        violations += 1
for k in only_win:
    if PLATFORM_ONLY.get(k) == 'windows':
        print(f"    仅 windows（平台专属，允许）{k}")
    else:
        print(f"    违规·macos 缺失 {k}")
        violations += 1

# ── 2. 深色段与主题无关 token 的值 ────────────────────────────────
m_dark, w_dark = toks(dark_block(mac)), toks(dark_block(win))
shared = sorted(set(m_dark) & set(w_dark))
diff_bad = [(k, m_dark[k], w_dark[k]) for k in shared
            if m_dark[k] != w_dark[k] and k not in VALUE_MAY_DIFFER]
diff_ok = [(k, m_dark[k], w_dark[k]) for k in shared
           if m_dark[k] != w_dark[k] and k in VALUE_MAY_DIFFER]
print(f"\n=== 深色段（含全部与主题无关的 token）：共有 {len(shared)} 项")
print(f"    不该差异却差异了：{len(diff_bad)}；第 5 节允许的差异：{len(diff_ok)}")
for k, a, b in diff_bad:
    print(f"    违规 {k}: macos={a}  windows={b}")
    violations += 1
for k, a, b in diff_ok:
    print(f"    允许 {k}: macos={a}  windows={b}")

# ── 3. 浅色段 ─────────────────────────────────────────────────────
# 第 5 节浅色行说的是「层级」——背景四层与边框三档（macOS 为避免大面积同亮度灰纸感做了
# 专属覆盖，Windows 走 Fluent/Mica 的平台层级）。accent、violet、语义色、文字色**不在**
# 平台差异表里，两侧必须一致。
m_light, w_light = toks(light_block(mac)), toks(light_block(win))
if not w_light:
    print("\n=== 浅色段：违规·windows 侧找不到 :root[data-theme=\"light\"] 段")
    print("    三态主题缺了手动浅色态，系统深色 + 手动浅色的组合会失效")
    violations += 1
else:
    l_shared = sorted(set(m_light) & set(w_light))
    l_bad = [(k, m_light[k], w_light[k]) for k in l_shared
             if m_light[k] != w_light[k] and k not in LIGHT_LAYER_MAY_DIFFER]
    l_ok = [(k, m_light[k], w_light[k]) for k in l_shared
            if m_light[k] != w_light[k] and k in LIGHT_LAYER_MAY_DIFFER]
    l_missing = sorted(set(m_light) - set(w_light))
    print(f"\n=== 浅色段：共有 {len(l_shared)} 项")
    print(f"    不该差异却差异了：{len(l_bad)}；第 5 节浅色层级允许的差异：{len(l_ok)}")
    for k, a, b in l_bad:
        print(f"    违规 {k}: macos={a}  windows={b}")
        violations += 1
    for k, a, b in l_ok:
        print(f"    允许 {k}: macos={a}  windows={b}")
    for k in l_missing:
        print(f"    违规·windows 浅色段缺失 {k}")
        violations += 1

print(f"\n总计 {violations} 项违规")
sys.exit(1 if violations else 0)
