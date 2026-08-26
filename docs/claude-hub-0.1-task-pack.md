> 失效条件：当 0.1 的包结构、Store 合约和 Companion 只读入口被正式发布验收取代时，本任务包应归档。

# 0.1 任务包：可安装、可调用、只读理解 Companion

## 交付目标

安装后，Agent 可以通过 `switchctl detect/list/inspect` 理解 CC Switch；程序能够明确区分 Companion、Standalone 和不兼容状态，但本版本不写 CC Switch 内部配置。

## 前置条件

- 先确认执行基线是当前 canonical recovery/main，而不是旧 `codex/tracer-bullet-*` 堆叠分支。
- 先阅读 `CLAUDE.md`、`docs/product-definition.md`、`docs/cc-switch-implementation-research.md`。
- 不把旧 PR #74、#76、#77、#78、#79、#80、#81 直接 cherry-pick 到当前基线。

## 任务卡

### 0.1-A 包结构与命令入口（#5）

- 目标：建立可安装包及 `claude-hub`、`claude1`、`switchctl` 入口。
- 依赖：无。
- Red：在干净临时环境安装后，三个入口缺失或指向不同业务实现。
- Green：三个入口可启动；`switchctl` 输出稳定 JSON envelope；协议层无第三方运行时依赖。
- 验收：临时环境安装 smoke test、入口帮助/版本测试、全量测试。
- 不做：GUI、自动更新、发布包签名。

### 0.1-B 共享 DTO 与 Store 合约（#6）

- 目标：定义不可变的运行模式、Provider 引用、能力和 Store 读接口，fake store 与真实适配器遵守同一合同。
- 依赖：0.1-A。
- Red：同一 Provider 在 CLI、fake store 和 adapter 中出现不同字段语义或可变对象被调用方修改。
- Green：DTO 字段、枚举和错误语义稳定；Provider capability 不再由 store-level capability 偷代。
- 验收：DTO 不可变测试、fake/adapter 合同测试、序列化稳定性测试。
- 不做：凭证写入、模型字段 apply。

### 0.1-C `switchctl detect` envelope（#7）

- 目标：输出版本化、脱敏、可机器消费的 detect 结果。
- 依赖：0.1-B。
- Red：数据库不存在、schema 不兼容或权限异常时输出无法区分的成功/空结果。
- Green：结果包含 mode、availability、schema capability 和可操作错误；不泄漏路径中的凭证或私密值。
- 验收：正常、缺失、损坏、权限不足、未知 schema 五类 fixture。
- 不做：任何内部 DB 写入。

### 0.1-D CC Switch 定位与 schema 能力（#8）

- 目标：定位受支持数据库并只读判断 schema/版本能力。
- 依赖：0.1-C。
- Red：发现错误数据库、误把未知 schema 当兼容，或在锁定/运行态不明时继续写入。
- Green：能力枚举可解释；未知能力进入 fail-closed；所有路径只读。
- 验收：多路径、旧 schema、新字段、损坏 DB、进程运行中 fixture。
- 不做：迁移数据库、自动修复 schema。

### 0.1-E 运行模式路由（#9）

- 目标：首次启动稳定选择 Companion、Standalone 或显式退出。
- 依赖：0.1-D。
- Red：CC Switch 不存在或不兼容时错误进入 Companion，或静默回退到另一个 Provider。
- Green：模式选择由 detect 结果驱动；不兼容时 fail-closed，用户可显式选 Standalone。
- 验收：存在/不存在/不兼容/运行态不明四类启动测试。
- 不做：全局配置修改。

### 0.1-F Companion 只读 Provider 列表（#10）

- 目标：只读列出 Provider，输出稳定引用和脱敏状态。
- 依赖：0.1-E。
- Red：列表读取异常变成空列表，或输出 key、完整 URL、真实渠道信息。
- Green：错误保持可归因；Provider 引用与显示名称分离；敏感字段不可见。
- 验收：正常、空、损坏、权限、敏感字段 fixture。
- 不做：编辑、删除、current Provider 切换。

### 0.1-G Companion inspect 与模型映射（#11）

- 目标：以只读方式展示脱敏模型映射和状态。
- 依赖：0.1-F。
- Red：未知模型被伪装成已知能力，或 inspect 为方便而暴露完整 provider UUID/私密数据。
- Green：未知值明确标为 unknown；映射拥有稳定 schema；输出可供 Agent 判断但不能触发写入。
- 验收：已知、未知、空映射、损坏字段和脱敏回归测试。
- 不做：模型建议、模型测试、模型写入。

## 0.1 Exit Gate

- `switchctl detect/list/inspect` 在干净环境可运行。
- Companion 全链路只读；没有写 DB、改 current Provider 或注入凭证的路径。
- 不兼容状态 fail-closed，错误可解释且不泄漏敏感信息。
- 关联测试和全量测试通过。
- 交付 agent 提供 commit、命令输出摘要和真实 CC Switch 验证是否执行。
