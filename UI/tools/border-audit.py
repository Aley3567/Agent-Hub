"""按 DESIGN.md 第 2.2.1 节审计边框 token 的承重用法。

规则：
  独立容器（卡片/面板/浮层/输入框/表格外框）用 --border-default；
  --border-subtle 只用于容器内部的行间分隔线。

启发式判定（会有少量误报，输出是给人看的清单而非硬门禁）：
  - `border: <w> solid var(--border-subtle)` —— 包一圈，疑似独立容器仍用 subtle
  - `border-bottom|top: ... var(--border-default)` 且选择器带 :not(:last-child)/tr/li
    —— 疑似内部分隔线错用 default

    python3 UI/tools/border-audit.py UI/macos/src
"""
import re, sys, pathlib

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
ALL_ROUND = re.compile(r'\bborder:\s*[\d.]+px\s+solid\s+var\(--border-subtle\)')
ONE_SIDE_DEFAULT = re.compile(r'\bborder-(bottom|top|left|right):\s*[\d.]+px\s+solid\s+var\(--border-default\)')
ROWISH = re.compile(r':not\(:last-child\)|^\s*tr\b|\bli\b|Row\b|thead|tbody', re.I)

round_subtle, side_default, counts = [], [], {}
for f in sorted(root.rglob('*')):
    if f.suffix not in ('.css', '.tsx') or f.name == 'tokens.css':
        continue
    text = f.read_text(encoding='utf-8')
    lines = text.splitlines()
    rel = f.relative_to(root)
    # 统计只数真正的 var() 声明。注释里提到 token 名（本次改动加了 6 处这类注释）
    # 会让分布数字虚高——首版就因此把 9 处转换报成了 subtle -8 / default +13。
    no_comment = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    for tok in ('subtle', 'default', 'strong'):
        n = len(re.findall(rf'var\(--border-{tok}\)', no_comment))
        if n:
            counts[tok] = counts.get(tok, 0) + n
    for i, line in enumerate(lines, 1):
        if ALL_ROUND.search(line):
            ctx = ' '.join(lines[max(0, i - 6):i])
            round_subtle.append((rel, i, line.strip(), bool(ROWISH.search(ctx))))
        if ONE_SIDE_DEFAULT.search(line):
            ctx = ' '.join(lines[max(0, i - 6):i])
            if ROWISH.search(ctx):
                side_default.append((rel, i, line.strip()))

print("=== token 使用分布（只数 var() 声明，已排除 tokens.css 与注释）===")
for k in ('subtle', 'default', 'strong'):
    print(f"  --border-{k}: {counts.get(k, 0)}")

print(f"\n=== 疑似「独立容器仍用 subtle」：{len(round_subtle)} 处 ===")
for rel, i, line, rowish in round_subtle:
    flag = '  (上下文像列表行，可能是合理的)' if rowish else ''
    print(f"  {rel}:{i}  {line}{flag}")

print(f"\n=== 疑似「内部分隔线错用 default」：{len(side_default)} 处 ===")
for rel, i, line in side_default:
    print(f"  {rel}:{i}  {line}")
