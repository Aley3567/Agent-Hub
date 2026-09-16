# Provider 管理与导入

Agent Hub 0.2 的 provider 由 Hub 自己保存。CC Switch 是可选的一次性导入来源；关闭、更新或卸载 CC Switch 不会改变已经导入的 provider。运行时读取 `~/.agent-hub/providers.db`，不会后台同步 CC Switch 数据库。

## TUI

运行 `agent-hub`：

- `a`：手动添加。选择 Claude Code 或 Codex，填写稳定 ID、名称、API 地址、协议、默认模型和隐藏输入的 API key。填写已有 ID 可以确认后更新。
- `i`：从 CC Switch 导入，按序号多选或 `all` 全选。确认前会显示新增和保留数量。
- `f`：从统一 JSON 文件导入，支持多选。
- `r`：重新读取 Hub 本地配置。不会重新读取 CC Switch。

导入确认输入 `yes` 仅新增；输入 `replace` 明确覆盖所选同 ID 的已有配置。导入不会删除源文件中已不存在的本地条目。API key 只保存在权限为 `0600` 的本地数据库中，不通过列表、日志或桌面 IPC 返回。

## CLI

```sh
agent-hub provider init
agent-hub provider import --cc-switch --preview
agent-hub provider import --cc-switch
agent-hub provider import --file /absolute/path/providers.json --preview
agent-hub provider import --file /absolute/path/providers.json
agent-hub provider add
agent-hub provider list --json
```

需要更新已有 provider 时，为导入命令添加 `--replace`。`--source-db PATH` 可指定 CC Switch 源库；它只与 `--cc-switch` 一起使用。`AGENT_HUB_PROVIDER_DB` 可以覆盖目标存储路径。原 `CLAUDE1_DB_PATH`、`CODEX1_DB_PATH`、`CLAUDE_HUB_DB` 显式覆盖继续有效；如果主动把它们指回 CC Switch，就仍然使用该外部库。

## 统一文件格式

`version` 为 1；`providers` 可以包含多条记录。每条记录的 `(app_type, id)` 是稳定身份，改名不改 ID。`settings_config` 与现有运行时格式兼容，`meta.apiFormat` 明确上游协议。

```json
{
  "version": 1,
  "providers": [
    {
      "id": "example-provider",
      "app_type": "claude",
      "name": "Example",
      "settings_config": {
        "env": {
          "ANTHROPIC_BASE_URL": "https://api.example.com",
          "ANTHROPIC_AUTH_TOKEN": "REPLACE_WITH_YOUR_KEY",
          "ANTHROPIC_MODEL": "your-model"
        }
      },
      "meta": { "apiFormat": "anthropic" }
    }
  ]
}
```

Claude provider 的协议可以是 `anthropic`、`openai_chat`、`openai_responses`。Codex provider 使用 `auth.OPENAI_API_KEY` 和 `config` TOML 字符串，协议为 `openai_responses`；建议用 TUI 表单生成，避免手写 TOML 字符串。导入文件含凭据，应保存在本地受限目录，勿提交到版本库。

## 数据所有权和兼容

Hub 自有 SQLite 继续使用运行时已验证的 `providers` 记录格式，但维护自己的 schema；`provider_sources` 记录来源和最近导入时间。外部导入为批量事务，格式校验失败不写入半批数据。相同导入重复执行默认幂等，本地编辑不会被静默覆盖。

为了保留已有路由、账号池和历史用量，0.2 不搬迁 `~/.cc-switch` 中原有的 Hub JSON 配置与日志。这些是 Hub 自身文件，目录名称不代表必须安装 CC Switch。定价可以继续通过 `~/.cc-switch/model-pricing.json` 提供。

## 桌面渠道管理与系统凭证库：实施设计草案

> 2026-09-16，分层实施中，当前完成基线核对，产品能力仍以每张卡的验收状态为准；实施基线为 `main@ed63114`。本节是本轮实施的唯一设计依据，唯一执行队列为 `work-queue.md` 的 S25，两者共同取代外部旧计划。上文描述现行版本；本节描述拟实现合同，不提前改写当前存储承诺。完成一张卡后同步对应现状。

### 目标与范围

让用户在桌面端完成渠道导入、手工新增、编辑、删除和显式凭证迁移；CLI/TUI 与桌面端复用同一写入规则，Claude Code/Codex 实际启动读取同一渠道身份。三种自动发现来源为 CC Switch、Claude 用户 settings、Codex 用户配置；已有 JSON 文件导入继续保留。

不把本轮扩展成工作区/会话侧栏改造、Agent 编排、协议重写或整库历史整理。沿用现有渠道页面、Dialog、Field 与反馈方式。macOS、Windows 共用数据合同，分别交付和验证。Linux 现有用户不能在升级时被静默切到不可用的凭证后端。

完成信号必须覆盖两条链路：

1. 来源预览 → 用户选择 → 明确新增/覆盖 → 安全保存 → 两类渠道在桌面/CLI 可见 → 对应启动器取到正确账号。
2. 旧记录检查 → 显式迁移 → 读取链路通过 → DB 中的有效配置不再含已迁移秘密 → 再次迁移无变化。

“Hub 持久数据库不保存明文秘密”与“包括启动临时文件在内，所有秘密均不落明文盘”是不同验收等级。后者需要先完成真实 CLI 优先级及认证入口实验，不能由前者推导。

### 已核对的事实与设计约束

| 原说法或遗漏 | 本轮核对结果与处理 |
|---|---|
| 当前少 4 个渠道、各源候选数量固定 | 历史运行态快照，未重新读取真实数据库。实施时只重新统计数量与身份，不在文档固定真实渠道数。 |
| MRU 由 CC Switch 本体写入 | `claude-provider-once.py::record_use` 和 `codex-provider-once.py::record_use` 均自行写入。目录名不能证明依赖关系；删除这条错误的解耦任务。 |
| 只需增加桌面写 IPC | `Channel` 无 `appType`，`claude_provider_rows()` 只列 Claude，启动器选择也固定 Claude。必须补足跨应用身份、列表投影和启动选择；同 ID 的 Claude/Codex 不能互相覆盖。 |
| 临时 settings 凭证可直接去掉 | `launch_with_settings()` 和 `test_temporary_settings_are_0600_and_removed_after_fake_claude` 保留了高优先级凭证覆盖。必须先做实际 CLI 实验，防止全局账号反向覆盖选中账号。 |
| Codex config 固定读取 `[model_providers.custom]` | 现有 `build_profile()` 根据 `model_provider` 动态选段；凭证可能不在 TOML。需要辨别 profile、API key、环境引用与登录态。 |
| 一个 Keychain 成功即代表数据库事务可回滚 | 两个存储没有共同事务；固定 account 原地更新会让 SQL 回滚后旧元数据指向新秘密。需明确提交点和故障恢复。 |
| 给 `ImportProvider` 加 Serialize/Debug 供 IPC 使用 | 该结构含原始 `settings_config`。秘密结构保持后端私有，另建安全预览 DTO；禁止通过通用派生把秘密带进响应或日志。 |
| 扩大 `ensure_inside` 全局白名单 | 现函数用于打开/显示文件。导入使用独立来源解析与路径校验，避免扩大现有打开文件权限。 |
| rusqlite 版本不同会编进两份 SQLite | 同一依赖图可能因 `libsqlite3-sys` 的 `links` 唯一性直接解析失败。统一 rusqlite 是接入前置；dirs 5/6 并非同类硬冲突。 |
| UI 的 `metadata --no-deps` 能列出共享 crate；根测试不覆盖它 | 前者只列所属 workspace 成员；根虚拟 workspace 在未限制默认成员时会覆盖成员测试。UI 构建依赖不等于执行依赖的单元测试。 |
| 使用同一个 security 可保证始终无弹窗 | 只可作为原实验特定上下文的结论；签名 App、锁定状态、拒绝授权与无 TTY 仍需覆盖。 |

### 实施基线

实施分支为 `s25/provider-foundation`，从含最新设计的 `main@ed63114` 创建；不合并或改写旧 `ui/workspace-shell`。当前可执行环境为 macOS 15.6 arm64，Claude Code 2.1.261、Codex 0.154.0-alpha.6.2。Windows 仅有交叉编译 target，尚无实机凭证和窗口验收；Linux 保留原写路径，后端未验收前不切换。分层检查点与变更状态只记录在 S25，本文维护行为合同。

### 所有权和最小接口

`crates/provider-store` 负责 Hub schema、provider 身份与读写、来源解析、导入计划、凭证引用和跨存储提交。CLI/TUI 负责交互，Tauri 负责命令边界、授权输入及展示 DTO，前端负责表单状态；Python 只读取并为请求/子进程组装运行态凭证，不重复实现 Rust 的写入规则。

共享层内部按 `model / store / sources / credentials` 分文件即可，不引入通用插件框架。CLI 的简表 DTO 与桌面的丰富 Channel 投影保持各自用途，不为了复用丢掉 notes、颜色、排序或本地覆盖字段。`provider-schema.sql` 暂留根目录作为唯一真相，保留安装器与 npm 产物引用。

建议对外能力是读取、准备变更、应用变更和凭证迁移；新增、编辑和导入共用验证及提交过程。适配器注入 OS 凭证存储和文件读取能力，测试通过同一接口制造 NotFound、拒绝、超时、SQL 失败与进程中断。

**身份与路径：** provider 身份固定为 `(app_type, id)`，保留原 ID 不重命名。界面 list key、编辑/删除参数、导入冲突判断及启动选择均带应用类型。Claude 专用槽位和账号池仍只接受 Claude 身份，不把 Codex 记录硬塞进去；Codex 不支持的操作显式隐藏或禁用并说明。

写目标只取 Hub 自有路径（`AGENT_HUB_PROVIDER_DB` 或默认 `~/.agent-hub/providers.db`）。CC Switch 来源路径、旧运行时只读覆盖路径独立解析。写入口不能继承 `CLAUDE1_DB_PATH` 后误写 CC Switch；对来源与目标同文件、符号链接别名和已知外部库身份都必须拒绝。Windows 默认改读 Hub 库，并明确空库导入引导，不能静默改回外部库。定价来源另行解析；不得把切换 provider 路径变成偷偷扩大 CC Switch 运行依赖的理由。

### 凭证合同与提交顺序

**保留原有 `service=claude-hub`，不复用已有 standalone UUID 条目。** 新 provider 的命名合同建议固定为 `service=claude-hub`、`account=provider/v1/<uuid>`，其中 `<uuid>` 为随机 UUID 的小写规范字符串；DB 的 `credential_ref` 保存完整 account，另存 envelope 格式版本。Rust/Python 用同一引用原样查找，引用与复合 provider 身份在 DB 关联，不把未转义的任意 ID 直接拼成 account，也不以 hash(token) 充当存储身份。

同一版本的秘密载荷为版本化 envelope，装入认证类型、API key/授权字段以及含认证信息的代理配置；SQLite 只存非秘密配置与引用。已知秘密字段从嵌套 env、auth、TOML 和代理 URL 中拆出。既有 Codex OAuth 记录的兼容读/迁移与新来源 OAuth 导入分开验收，前者保留现有 auth 语义，后者未支持时明确标记不支持，不把 OAuth 整包随意降格成 API key；Windows credential blob 大小限制需在 adapter 层验证，超限不截断。

**推荐不可变版本引用，而非覆盖固定 account：**

1. 完整验证所选记录；先判定 unchanged/skipped，跳过项不读写系统凭证库。
2. 取得该 Hub 库的写入协调锁，在 DB 持久记录本次 op_id 与待创建引用（不含秘密），再在 OS 凭证库写入新版本并读回校验；尚未替换 provider 的旧引用。
3. 开 SQL 事务、复核目标 revision，原子提交整批非秘密配置、引用和来源记录。SQL 提交是用户可见的生效点。
4. SQL 提交前失败，旧记录继续有效；仅清理本次创建的新引用。清理失败返回“未应用，存在待清理记录”，不掩盖原错误。
5. SQL 提交同时将旧引用记入 Hub DB 的持久清理表，字段至少包含 op_id、credential_ref、状态和最近错误码；清理失败不伪装整次写入未发生。恢复必须取得同一写入协调锁，并核对引用仍未被 provider 使用，才能处理未完成写入意图或清理项。清单没有秘密；不能扫描或删除其他应用条目。
6. 删除先检查 Hub 槽位、路由和账号池引用，有引用则阻断并列出位置。先提交记录删除，再回收对应秘密；不隐式级联、不宣称终止已经运行的会话。

这允许“元数据全批生效或全批不生效”，但不承诺 OS 凭证库与 SQLite 的物理分布式事务。读取旧快照时可短暂遇到已回收引用：仅在发出上游请求前、收到 NotFound 时，强制重载 DB 并重试解析一次；引用未变或重试仍失败则返回稳定的 `credential_missing`。这不是请求重放；Denied/Locked/Corrupt 不重试，也不回落旧明文。DB 引用切换推进 revision，清理工作不另建凭证轮询机制。Keychain-only 写能力启用前，上述旧版本回收策略必须通过并发读取测试。

**读取合同：**有 `credential_ref` 就必须解析该引用；缺失、拒绝、锁定、超时、损坏分别报错，绝不靠旧明文兜底。只有“没有引用的旧版记录”才允许兼容读取原明文并发出可观察提示。已有 `MacOSKeychainStore.get_secret()` 将所有非零状态当 NotFound，不能直接继承其实现。

根级 `claude1_credentials.py` 保证脚本分发可用。原 `src/claude_hub/credentials.py` 的接口与 UUID 使用者保持兼容；共享载荷和错误合同用跨语言 fixtures 约束。警告由公共读取层产出结构化状态，调用者接入 CLI/Hub journal，按 provider revision 去重；桌面迁移数量来自元数据，不依赖恰好出现过请求日志。

快照缓存必须包含凭证引用/revision。更新密钥必须通过存储写接口推进 DB revision，不支持“改 Keychain 同名值但让长期进程继续用旧缓存”。批量预取只在实际刷新时发生，不能每请求启动多个 `security` 进程。

### 平台和启动器前置实验

macOS 首选共同使用 `/usr/bin/security`，统一跨进程访问方式；凭证不进 argv、错误串和日志。Apple 源码显示末尾 `-w` 会调用两次 `getpass`，因此要分别验证无控制终端、CLI 终端和签名 App 启动场景。单纯 stdin 失败后可评估受控 PTY，但必须证明无回显、超时退出与进程清理；不能直接退回明文 argv。所有 OS 实验使用独立测试条目/测试钥匙串和合成秘密，不触碰真实 provider。

Windows 使用 Credential Manager，验收覆盖读写删、错误码、Unicode、blob 长度和当前用户上下文。macOS 上的编译/类型检查不能代替 Windows 实机验收；未验证的 Windows backend 不启用真实迁移。Linux 写入后端未定案前，不发布会替换现有 Linux 写能力的版本；不能静默回退明文来满足“安全写入”。

Claude 临时 settings 与 Codex shadow auth 是独立的运行态认证接口，不是删除字段即可解决的数据库问题。先固定受支持 CLI 版本，用合成上游确认实际请求使用选定的凭证且全局配置未变，再选择零文件注入或本地凭证代理方案。如果该验证未通过，只能交付“持久存储迁移完成，运行态仍有 0600 临时认证文件”，不能宣称全程不落盘；是否允许该中间交付需用户明确选择。

显式迁移采用与新增相同的提交协议，先支持 reader 再移除 DB 明文。`doctor --fix` 必须只改原始非秘密元数据，不能将 resolver 注入过凭证的运行态对象写回 DB 或备份。覆盖 API key、代理认证和已支持的其他秘密载荷；不得先清空 DB 后尝试写入 OS。迁移是幂等操作。检查 active DB、WAL 和本次生成的文件，区分逻辑移除与历史备份/文件系统残留；不自动销毁用户备份，不承诺安全擦除旧介质。

### 来源解析和预览合同

| 来源 | 解析范围 | 不允许的猜测 |
|---|---|---|
| CC Switch | 只读导入 Claude/Codex，多选；必需列缺失给明确列名，可选列兼容；缺凭证的记录单列原因 | 不写 current，不后台同步，不把缺失列变成整页无解释报错 |
| Claude 用户配置 | 显式读取用户 settings 的 env，保留协议/模型映射，认证 token/API key 优先级与当前启动器一致 | 不把 hooks、permissions、命令型 credential helper 当可执行导入配置；不执行来源中的命令 |
| Codex 用户配置 | 解析实际 `model_provider` 与选定 profile，定位对应 `model_providers`；API key 来源可能另在用户 auth 文件或指定环境引用 | 不硬编码 custom；不扫描所有环境变量；不把 ChatGPT 登录态复制成普通 API 渠道 |
| 原有 JSON 文件 | 继续支持 version:1 格式，与前三源进入同一验证/计划/提交过程 | 不因增加三源入口删除旧文件导入能力 |

“用户配置”来源导入一次选定的有效配置，可能为 0 条可导入记录；未知或缺失认证要在预览说明。保留模型、effort、协议和必要上游设置，不把用户级安全策略整包复制。

扫描和预览不写目标 DB 或 Keychain；目标库不存在时也不借 `open()` 顺带创建。后台保留短期计划，向前端返回安全候选标识、名称、应用、脱敏 endpoint、协议、凭证状态、冲突和计数。导入请求只传计划 ID、选中的候选 ID 与显式 replace 选择，不让前端往返传输原始 settings。

预览绑定源 revision 与目标 revision。确认时任一变化、计划过期或选择集合变化，都需重新预览，不能以旧计数覆盖新记录。返回结构化结果：新增、更新、跳过、不支持与原因；零变化不能只弹“导入成功”。

### IPC 与界面边界

凭证的 IPC 边界为：**不进入任何 IPC 响应、事件、预览、共享状态或日志；手工输入只允许作为写命令请求中的敏感字段传入一次**。表单关闭/成功后清空，编辑默认保持原秘密，需要用户显式选择替换或清除。秘密对象不派生通用 Debug/Serialize；安全 DTO 独立定义。

IPC 以扫描/预览/确认变更为核心，新增、更新、删除和迁移均调用共享层。输入错误映射为稳定错误码与字段；字段错误、OS错误和清理错误均不得回显请求秘密，不输出后端命令全文和原始解析内容。离线示例模式继续拒绝所有真实写操作。

两平台同步 `UI/CONTRACT.md`、types、api、store 和 Tauri command 注册。渠道页新增导入与编辑弹窗、来源状态、候选选择与冲突提示；成功刷新受影响渠道/Hub/账号池数据。Codex 行不能调用 Claude 专用操作；启动必须明确分派到对应 launcher。保留已有视觉语言，不搬设置页、不重构侧栏。错误已在弹窗展示时，不重复弹 error toast。

### 验证与放行

各任务先跑最近接口的行为测试。存储层至少覆盖同 ID 跨应用、重复导入、覆盖/跳过、source 不变、预览零副作用、版本冲突、事务各故障点、迁移重入、删除引用检查。凭证 fixture 使用合成秘密，断言它不在 SQL、日志、错误、argv 或 IPC 响应。

```sh
cargo test --workspace --locked
cargo test --manifest-path UI/macos/src-tauri/Cargo.toml --locked
python3 -m unittest discover -s tests -p 'test_*.py'
npm --prefix UI/macos run typecheck
npm --prefix UI/macos run build:renderer
npm --prefix UI/windows run typecheck
npm --prefix UI/windows run build:renderer
./tests/test_install.zsh
python3 scripts/secret_guard.py --staged
```

新增共享 crate 后可用 `cargo test -p provider-store --locked` 做局部验证。UI 全依赖 metadata/check 验证 path 依赖和 links，不能用 `--no-deps` 代替。前端 typecheck 只证明类型；还须真实 Tauri 窗口验证取消、失败、重复点击、空列表、部分跳过、覆盖和刷新，并用实际渠道走一次启动与合成上游请求。Windows 独立运行对应 Rust 测试、安装与 Credential Manager 验收，分别提交平台变化。

### 核对依据

本地入口：`crates/agent-hub/src/{db,provider_store,provider_form}.rs`、`src/claude_hub/credentials.py`、`claude1_providers.py`、`claude-provider-once.py::launch_with_settings/record_use`、`codex-provider-once.py::build_profile/build_shadow_home`、`UI/{macos,windows}/src-tauri/src/{paths,db,channels,launch}.rs`。

外部规则核对：[Cargo metadata 的 --no-deps](https://doc.rust-lang.org/cargo/commands/cargo-metadata.html)、[Cargo links 唯一性](https://doc.rust-lang.org/cargo/reference/resolver.html#links)、[Cargo workspace 默认成员](https://doc.rust-lang.org/cargo/reference/workspaces.html)、[Apple security 密码提示实现](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/keychain_add.c)。官方源码说明机制，不代替本机签名 App、CLI 版本与 Windows 运行环境的验证。
