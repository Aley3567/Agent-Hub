# UI — Agent Hub 桌面端

`claude1` / `claude-hub` 的官方桌面壳，产品展示名为 **Agent Hub**。**核心永远 headless，桌面端只是遥控器**——这是
`docs/product-definition.md` 写死的架构约束，本目录的一切实现都不得违反。

## 目录约定

```text
UI/
├── README.md        ← 本文：方案、构建、状态
├── DESIGN.md        ← 设计系统（唯一视觉真理来源）
├── CONTRACT.md      ← 数据契约 + IPC 命令 + 文件所有权
├── macos/           ← macOS 桌面端，独立工程，独立构建
└── windows/         ← Windows 桌面端，独立工程，独立构建
```

`macos/` 与 `windows/` **各自独立管理**：各有 `package.json`、`src-tauri/`、`node_modules/`、
版本号与构建产物；互不 import、互不共享构建配置，一侧改动不会构建失败另一侧。

两者共享的只有**文档**（`DESIGN.md` / `CONTRACT.md`）与**Python 侧的真实数据源**。设计 token
在两个工程里各存一份 `src/styles/tokens.css`——数值同源于 `DESIGN.md`，但平台各自可以偏离
（圆角、字体、动效时长、亚克力层），这正是分目录的意义。

## 技术方案：Tauri v2 + React 19 + TypeScript

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | **Tauri v2**（Rust + 系统 WebView） | 继承 cc-switch 已验证栈（`CLAUDE.md`：继承优先于发明）。内存与安装体积比 Electron 小一个数量级，冷启动 <1s，符合"高性能方案"要求 |
| 前端 | React 19 + TypeScript 5 + Vite 7 | 与 cc-switch 同栈，生态与调试路径已知 |
| 样式 | **原生 CSS + CSS 变量 token**，每组件一个 `.module.css` | 偏离 cc-switch 的 Tailwind。理由：零 PostCSS/Tailwind 版本链路，构建面更小；且组件自带样式文件使并发编写互不冲突 |
| 状态 | Zustand | 数据量小（渠道数十、日志数千行），无需 react-query 的缓存层 |
| 图表 | **手写 SVG 原语**（sparkline / bar / donut） | 偏离 cc-switch 的 recharts。理由：用量图只有三种形态，手写可完全跟随主题 token，且省掉 ~400KB 依赖 |
| 图标 | 手写 SVG 组件集，统一 1.5px 线宽 | 保证线重一致，避免 lucide 全量依赖 |
| 数据接入 | Rust 侧只读 `~/.cc-switch/*`，写操作只碰 `claude1-config.json` / `claude-hub.json` | 凭证边界见 `CONTRACT.md`，与 CLI 完全一致 |

**不引入的东西**：Tailwind、shadcn/ui、Radix、recharts、lucide、react-query、i18next。
桌面端界面文案直接用中文，不做 i18n 抽象层（CLI 也没有）。

## 安全边界（fail-closed，不容协商）

- **绝不显示、绝不复制、绝不日志化 API key**。DB 的 `settings_config` 里的凭证字段在
  Rust 侧就必须剥离，永远不进 IPC 响应体。UI 只显示"已配置 / 未配置"。
- CC Switch 数据库**只读打开**（`mode=ro`），任何写入路径都不允许存在。
- 不发任何遥测、不连任何外部域名；CSP 禁止 `connect-src` 外部主机。
- 桌面端不实现协议转换、不实现转发。它不是第二个网关。

## 构建

两侧命令相同，在各自目录内执行：

```bash
cd UI/macos      # 或 UI/windows
npm install
npm run dev      # Tauri 开发窗口（自动起 Vite）
npm run build    # 打包 .app / .msi
npm run typecheck
npm run build:renderer   # 只构建前端，不需要 Rust 工具链
```

前置依赖：Node ≥ 20、Rust ≥ 1.85、macOS 侧 Xcode CLT、Windows 侧 MSVC 生成工具 +
WebView2 Runtime。`UI/windows` 的 Rust 侧只能在 Windows 上构建；在 macOS 上开发它时用
`npm run build:renderer` 验证前端。

## 状态

首版由编排式子代理实现，范围是**界面与数据读取**。产品展示层已从 `claude1` 改名为 **Agent Hub**，
并完成一轮视觉去简陋升级（说明文字收敛、协议徽章去色、slots 警告条收敛、effort 控件截断修复、
空态 hero）。以下明确未做，不要在文档或界面里暗示已做：

- 桌面端**写**槽位/覆盖配置的落盘能力仅覆盖 `claude1-config.json` 与 `claude-hub.json`；
  账号池编辑为只读展示。
- 成本呈现只读现有定价数据：`model-pricing.json` 优先，为空时回退 CC Switch DB 的
  `model_pricing` 表，仍无价则明确显示「不估算」——不做预估与拦截，绝不自订单价。
- 无自动更新、无托盘常驻、无 deep link。
- 契约已扩展 chat / plugins / tasks 三视图：本轮对话为演示实现（不接真实后端）、计划任务为本地清单
  （CRUD + 展示，执行层未做），后端 seam 留在 IPC 层，签名不变。
- 插件视图的渠道级扩展点（settings_config 内）只读展示；可写项（enabled 切换）只落
  `claude1-config.json` 本地覆盖，绝不写 DB。
