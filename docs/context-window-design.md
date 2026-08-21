# 上下文窗口判定设计

> 2026-08-20 落地。解决的问题：`[1M]` 后缀是人工断言，既不精确也不校验上游，
> 却被写进模型 ID 并在多处剥离。本文记录判定规则的**依据**与**维护方式**。
> 规则本身以 `claude1_context_window.py` 为准，本文不复述实现细节。

## 为什么 `[1M]` 是错的抽象

Claude Code 在**客户端**决定会话窗口，这个数字驱动 auto-compact 与上下文计。
窗口被高估比低估更糟：客户端不再压缩，改由上游回 `400 prompt is too long`。

`[1M]` 只有两个取值（1M 或不写），无法表达 256k 这类真实窗口；而且它对第三方模型
同样生效，于是产生"假 1M"——客户端相信 1M，上游并不支持。

2026-08-20 对本机 21 个 Claude 渠道的体检结果：5 个 provider 共 14 个模型槽位处于
假 1M 状态（`glm-5.3[1m]`、`deepseek-v4-flash[1M]`、`k3[1M]` 等），另有 1 个
provider 的 `claude-opus-5[1M]` 属于多余后缀。

## Claude Code 的三套机制（证据）

括号内是 Claude Code v2.1.229 可执行文件里的压缩标识符，保留下来是为了在新版本上
可以重新验证，而不是重新猜测。

| 机制 | 实现 | 作用域 |
| --- | --- | --- |
| `[1m]` 后缀 | `Ov` 是 `/\[1m\]/i` 纯正则，`JAu` 第一行即 `if(Ov(e))return 1e6` | **任意**模型 ID，不查注册表 |
| `anthropic-beta: context-1m-2025-08-07` | `EW`：注册表看 `supports_1m_beta`；未知模型看 provider 是否属于 first-party/Bedrock/Vertex/Foundry/Mantle（`_W`） | 自定义 base URL **发不出去** |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | `JAu` 末段，可表达精确 token 数 | 仅当模型 ID **不以 `claude-` 开头** |

两个相关开关：`CLAUDE_CODE_DISABLE_1M_CONTEXT`（`sae`，同时关掉前两者）、
`DISABLE_COMPACT` + `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（`YAu`，无条件覆盖）。

未知模型时 CLI 自己的提示给出三条路：加 `[1m]`、设 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`、
或 `map it in the modelOverrides setting`。

### 为什么不用 `modelOverrides`

它是"官方模型 ID → 上游真实 ID"的反向映射，能让第三方模型继承一个官方模型的完整
身份（窗口、capabilities、定价）。但读取路径是 `policySettings` 且要求
`availableModels` 同时存在，即系统级 managed settings；`Hgo` 还会在
host-managed 场景下把它删掉。对"每次启动切一个 provider"这种用法过重，因此不采用。
代价是第三方模型只能拿到精确数字，拿不到 capabilities。

## 1M 支持矩阵

提取自 v2.1.229，14 个模型。`window` 是不加后缀时的窗口。

| model id | window | native_1m | 3p native | 1m_beta | 1m_suffix |
| --- | --- | --- | --- | --- | --- |
| claude-haiku-4-5 | 200k | | | | ✓ |
| claude-sonnet-4-0 | 200k | | | ✓ | ✓ |
| claude-sonnet-4-5 | 200k | | | ✓ | ✓ |
| claude-sonnet-4-6 | 200k | | | ✓ | ✓ |
| claude-sonnet-5 | 1M | ✓ | ✓ | ✓ | |
| claude-opus-4-0 | 200k | | | | ✓ |
| claude-opus-4-1 | 200k | | | | ✓ |
| claude-opus-4-5 | 200k | | | | ✓ |
| claude-opus-4-6 | 200k | | | ✓ | ✓ |
| claude-opus-4-7 | 1M | ✓ | | ✓ | ✓ |
| claude-opus-4-8 | 1M | ✓ | | ✓ | ✓ |
| claude-opus-5 | 1M | ✓ | | ✓ | ✓ |
| claude-fable-5 | 1M | ✓ | | ✓ | |
| claude-mythos-5 | 1M | ✓ | | ✓ | |

注意 `haiku-4-5` 与 `opus-4-0/4-1/4-5`：`supports_1m_suffix` 为真但没有
`supports_1m_beta`。后缀会说服客户端，上游却给不了 1M——这一组是最容易踩的坑。

## 判定规则

事实源优先级：**内建注册表 > 人工声明 > 探测 > CLI 假设值**。

- 模型在注册表内 → 窗口由注册表决定，声明与探测都不参与（`CLAUDE_CODE_MAX_CONTEXT_TOKENS`
  对 `claude-` 前缀无效，声明也无处落地）。原生 1M 的模型会被**去掉**多余后缀。
- 注册表内但需 beta 才到 1M → 只有 `supports_1m_beta` 且 provider 发得出 header 时
  才加后缀；否则保留注册表窗口并报 `CTX_SUFFIX_WITHOUT_BETA`。
- `claude-` 开头但不在注册表 → 无法表达精确窗口，报 `CTX_UNKNOWN_OFFICIAL_MODEL`，
  提示升级 CLI 后重跑提取脚本。
- 非 `claude-` 开头 → 用 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 写精确窗口，并去掉后缀。
  没有任何窗口来源时保留 CLI 的假设值并报 `CTX_WINDOW_UNDECLARED`——不编造数字。

窗口未知时宁可让客户端按较小的假设值压缩，也不假装 1M。

## 组件

| 位置 | 职责 |
| --- | --- |
| `claude1_context_window.py` | 矩阵 + 纯判定函数。零 I/O、零依赖，供启动器、Hub 与将来的 TUI 共用同一结论 |
| `tools/extract_1m_matrix.py` | 从 CLI 二进制重新提取；`--check` 比对内嵌矩阵，`--emit` 打印可粘贴常量 |
| `claude-provider-once.py` | `provider_context_kind`、`/v1/models` 探测、缓存读写、`slot_context_plan`、`context_window_findings` |
| `claude1 doctor` | 体检并按 provider 聚合；`--probe` 才连上游 |

探测缓存落在 `~/.cc-switch/claude1-context-cache.json`（`CLAUDE1_CONTEXT_CACHE`
可改），**不写 CC Switch DB**：该 app 有内存 store 并在切换时重写 provider 行，
写 `meta` 会与它竞争。缓存是可丢弃的，删掉后下次 `--probe` 重新填充。

启动路径只读声明与缓存，不发网络请求。

## CLI 升级后怎么维护

```
python3 tools/extract_1m_matrix.py --check
```

- 输出"矩阵一致" → 只需把 `MATRIX_CLI_VERSION` 更新到新版本号。
- 列出差异 → `--emit` 生成新常量，替换 `CONTEXT_MATRIX` 与 `MATRIX_CLI_VERSION`。
- 报"解析不到模型表" → CLI 的压缩形状变了，先修脚本正则；此时**不要**当作一致，
  空矩阵会让所有官方模型退化成"未识别"。

## 已知边界

- 探测依赖上游模型列表返回 `context_length` 一类字段。很多网关不返回，此时窗口仍需
  人工声明；探测拿不到就返回空，不做推断。
- 第三方模型拿不到 capabilities 与定价，只有窗口是准的。要完整身份得走
  `modelOverrides` + managed settings，见上文。
- `native_1m_3p` 已提取但暂未参与判定：它描述 Bedrock/Vertex/Foundry 上的原生 1M，
  而本仓库的渠道都不是这三种 provider。
