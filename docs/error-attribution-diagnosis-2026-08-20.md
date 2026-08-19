# claude-hub 502/504 归因诊断

诊断日期:2026-08-19 至 2026-08-20。数据源 `~/.cc-switch/logs/claude-hub-errors.jsonl`(269 条,
08-16 至 08-19)、`claude-hub-usage.jsonl`(7905 条)与遗留桥日志 `$TMPDIR/claude1-bridge-*/hub.log`
(12 份共 1607 条请求行)。起因是"明明开了梯子还是 502 直连错误"这一报告。

渠道用化名:**中转 A** 是 504 的主要来源,**中转 B** 是给出 524 的另一上游,
**渠道 C** 是 08-17 出现同类 502 的渠道。真实渠道名与上游域名属 CC Switch 私密数据,
`scripts/secret_guard.py` 会拦,故不写入仓库;对照组里的 Any router / Kimi / glm /
deepseek 是公共标签,照原样保留。

## 结论一句话

两类错误都与代理无关,且根因完全不同:**502 是本地协议层白名单漏了 `completed_at` 导致的
fail-closed 误拒(已修)**;**504 是上游中转网关一道 120 秒 Proxy Read Timeout(本地无可改)**。
报告里的"direct"是渠道标签名,不是"绕过代理直连"。

## 一、代理无关性(先排除)

- Clash 在 `127.0.0.1:7897`,`scutil --proxy` 与 `HTTP(S)_PROXY` 环境变量齐全,
  `urllib.request.getproxies()` 正常返回;`claude-hub.json` 未写 `transport`,走默认
  `{mode: auto, proxies: ["system"]}`,候选为 `[direct, proxy:7897]`。
- 四天 269 条错误里**网络层异常 0 条**:`ClientConnectorError` / `ClientConnectionResetError`
  一次未出现,`transport ... failed before response` 从未打印。每条错误都带上游返回的真实
  HTTP 状态码,说明 DNS、TCP、TLS、HTTP 全程打通。
- 对照:08-01 那批 `CONNECT FAIL: ClientConnectionResetError` 才是真实连接失败的长相。
- `channel: "direct"` 是 claude1 的 provider 直连模式(不经命名 hub 的协议桥)这一通道名,
  与 `claude1_transport.py` 的 `TransportCandidate(None, "direct")` 只是撞名。

## 二、502 根因:白名单漏 `completed_at`

`_RESPONSES_STREAM_RESPONSE_FIELDS` 收了 `created_at` 却漏了 `completed_at`,而 OpenAI
Responses 完成态响应体会带它。两条路径共用同一常量,一个字段引发两处 502:

| 路径 | 位置 | 报错 path | 08-19 次数 |
| --- | --- | --- | --- |
| 非流式 JSON | `responses_to_anthropic` | `$.completed_at` | 8 |
| 流式 lifecycle | `_validate_response_snapshot_fields` | `$.response.completed_at` | 1 |

08-17 已在渠道 C 上出现过 2 次同样的拒绝,故本次为复发。

**反向验证**:用 `git show HEAD:claude1_protocol.py` 的修复前版本跑真实载荷,报错文本与日志
逐字一致(`OpenAI Responses response field 'completed_at' is unsupported` /
`Responses response snapshot field 'completed_at' is unsupported`);修复后两条路径都正常
转换并记 `HUB_DEGRADE_UPSTREAM_RESPONSE_METADATA_DROPPED`。

这违反 AGENTS.md 的总规则:`completed_at` 是无害的生命周期元数据,属"有损但能用→放行并记
degrade"那一档。同一个 hub 里 `openai_chat` 的顶层未知元数据**早就是降级放行**,只有
`openai_responses` 侧 fail-closed,两种格式的契约本就不对称。

修复采取改策略而非补字段:删除两处顶层 allowlist 拒绝,未消费字段统一走
`_record_response_metadata_degradation`;保留 `error` 非空即拒、`output` 必须是数组、
`id`/`model` 形状校验这三道安全与因果边界。随之成为死代码的
`_require_upstream_response_allowlist` 与 `_RESPONSES_STREAM_RESPONSE_FIELDS` 一并删除。

## 三、504 根因:上游 120 秒 Proxy Read Timeout

栈形状:Cloudflare(524 是其专有码)→ nginx(120s `proxy_read_timeout`,生成 504 页)→
中转后端 → 源站。四条独立证据锁定同一道闸门:

1. **上游自述**。errors.jsonl 里 2 条 524 的错误体原文:"did not return a complete response
   within the **120-second Proxy Read Timeout** window"。
2. **耗时**。从遗留桥日志找回 32 条 504 的完整请求行,耗时 **120.47s ± 0.46s**。标准差 0.46
   说明是闸门,不是后端抖动。
3. **错误体恒为 160B**,32 条无一例外。nginx 默认 504 页(CRLF)正好 160 字节
   (openresty 变体 164,LF-only 153),故该 504 由上游栈内的 nginx 层生成。
4. **分布硬截断**。中转 A 975 条成功流的首字节延迟 p50=6.4s / p90=37.7s / p95=62.1s /
   p99=107.0s / **max=120.242s**,右端被削平在 120s。

归因:以 usage 的 `account` 做 ±180s 同 model 邻近匹配,**92/102 条落在中转 A**,
含 08-17 的 59 条、08-19 全部 26 条、08-20 全部 7 条;5 条歧义、2 条无邻近。2 条 524 来自
中转 B,同为 120s——这是该中转家族的共性配置。

对照组首字节 max:Any router 63.0s、Kimi 54.4s、glm 31.5s、deepseek 22.2s,560 条请求
**504 数为 0**。唯一能真正降 504 的手段是上游选型,不是代码。

### 两个被证伪的直觉

- **大上下文不是原因,只调节风险**。Spearman(首字节, 上下文)=0.539(最快四分位中位上下文
  71k,最慢四分位 175k,驱动量是未缓存的 `in`:39.7k→133.7k,`cr` 四分位稳定在约 17k)。
  但 08-20 00 点那段全部请求 `in=2`、`cr` 高达 141k、几乎零 prefill 时,504 率反而升到
  **13%**(7/53),高于 08-19 上午 `in` 中位 94k 时的 4.9%;同会话同缓存前缀的两条近乎相同
  请求,首字节相差 30 倍。另:08-19 那 26 条 504 里 22 条带 `HUB_DEGRADE_SYSTEM_ROLE_PROMOTED`,
  08-20 缓存修复后 7 条一条不带,504 照旧。主因是上游排队方差。
- **上午 9–11 点集中是请求量,不是上游时段性负载**。中转 A 逐小时 n=284/343/106,
  733/1018 条挤在这三小时,但 504 *比率*为 4.9% / **0.6%** / 2.8%,10 点是全天最好的一小时;
  00 点 11.8%、23 点 6.7%、15 点 20%。`headers_ms` p95 在 09 点是 22.3s,在 17 点是 105.6s。

### 本地不需要改动

- **无重试放大**。`_post_with_account_failover` 只在 `upstream.status in (401,403,429)` 且账号
  managed 时换号;`ROUTE_FAILOVER_STATUSES = (401,403,429)`;`UpstreamExecutor.open` 的
  `retry_response` 只认 403,`_retryable` 只认响应到达前的传输异常。504 是已提交的 HTTP 响应,
  直接 yield。实证:桥日志窗口内 32 条 504 请求行 ↔ 32 条 errors 记录,双向零漏零重。
  那 50% 的紧邻间隔(≤120s 占 49/98)是**并发**:按 120.4s 在飞区间还原,08-17 峰值并发 4、
  08-19 峰值 2,2–4 个各烧 120s 的请求同时在飞,完成时刻自然每 20–40s 落一个。
- **timeout 配置合理**。`ClientTimeout(total=None, connect=15, sock_read=600)`,600s 是闸门的
  5 倍,所以本地永不先超时——四天 280 条错误里 `asyncio.TimeoutError` / `ServerTimeoutError`
  出现 **0 次**,每次超时都以上游真实状态码呈现,正是 AGENTS.md 要的行为。下调到 150s 会砍掉
  真实成功的长流(实测最长成功流 517.5s,最大流内空隙 117.8s)。

## 四、暴露出的观测缺陷(已修)

排查过程本身撞上三处失明,均违反 AGENTS.md"保证事后能在 errors/usage 里查到":

1. **协议转换类 502 不记 status**。`ProtocolTransformError` 与传输失败两个分支实际返回 502,
   `record_error` 却只记 `code`,导致 9 条 502 在 journal 里显示 `status: null`——"最近几日
   502 有多少"无法回答,这正是最初误判为网络问题的直接原因。已补 `status=502`。
   注意 `phase="stream"` 的 5 处**不记 status**:下游已收到 200 与 SSE,流中途失败时记 502
   属于伪造终态。
2. **`record_error` 无 provider/account 归因**(`record_usage` 早有)。100 条 504 里 `account`
   与 `route` 全空,"是哪个上游"本来无解,只能靠遗留临时文件加 usage 邻近推断;08-17 那 67 条
   的桥日志已消失,永久不可精确归因。已加 `instance_id`/`account_id`,键名与 `record_usage`
   一致以便对接。传输层在拿到响应前失败时 `account_attempt` 根本未绑定,故用
   `journal_account` 哨兵,避免 except 里以 `NameError` 冲垮转发主路径;
   `RouteTargetExhausted` 也补了 `account_id`,让路由耗尽能回答"哪个账号拒的"。
3. **耗时与 HTML 错误体落不到盘**。耗时只存在于 `claude1-bridge-*/hub.log`,而那是
   `tempfile.TemporaryDirectory`,会话正常退出即删——本次能查清纯属侥幸,靠的是崩溃会话遗留的
   孤儿目录。504 的 160B 是 HTML,`upstream_error_evidence` 只认 JSON 形状故返回空,`message`
   与 `code` 全丢;524 因上游给了 JSON,一条记录就说透根因,差别就在这。已加 `elapsed_ms`,
   并让 `upstream_error_evidence` 把 HTML 页缩成 `<title>` 加服务器签名一行证据
   (nginx 504 页 → `504 Gateway Time-out / nginx`),仍走同一个 `sanitize_error_text`。

## 已排除的可能

- 梯子未生效、代理配置错误、`NO_PROXY` 误绕过(见第一节)。
- hub 本地超时(0 次 TimeoutError)、hub 重试放大(32↔32 一一对应)。
- 上游时段性负载(10 点请求最多而 504 率最低)。
- 缓存污染导致 504(08-20 修复后 504 率反升)。
- 单一站点配置问题(两个不同上游同为 120s)。

## 未开的卡

把 504 加入 `ROUTE_FAILOVER_STATUSES` 在语义上是安全的:该检查发生在
`response.prepare(request)` 之前,下游尚未提交任何字节,请求体可安全重放,与现有 401/403/429
的理由一致。但代价是失败请求再烧一次 120s,属"写重试",需单独决策,本次未做。

把响应输出块的未知字段一并降级放行。`a9e8ae3` 只把 `_response_function_call_item`(流式
function_call)一处改成了记 `HUB_DEGRADE_UPSTREAM_TOOL_CALL_METADATA_DROPPED` 后放行,
`_require_upstream_field_allowlist` 余下 13 处仍以 `HUB_UPSTREAM_OUTPUT_BLOCK_UNSUPPORTED`
硬拒成 502,分布在 `chat_to_anthropic`、`responses_to_anthropic`、
`_response_reasoning_item_snapshot`、`_response_message_item_snapshot`、
`_validate_response_output_item_added` 五个函数里。实测同一个未知字段的待遇:

| 载荷 | 结果 |
| --- | --- |
| 流式 function_call 未知字段 | 放行(a9e8ae3) |
| 非流式 function_call 未知字段 | 502 `$.output[0].future_call_meta` |
| 非流式 message item / output_text 部件 | 502 |
| 流式 message item | 502 `$.item.future_item_meta` |
| `openai_chat` tool call | 502 |

与本次 `completed_at` 是同一缺陷类,且非流式正是本次 9 条 502 里占 8 条的那条路径。按总规则
这些都属"我不认识这个字段"——不是安全或因果理由。未在本次一并改,因为要动 13 处、涉及 5 个
函数与相应的 strict 模式契约,应作为独立一卡决策;`id`/`call_id` 形状、`type` 必须是
`function_call`、status 与事件冲突这三道校验必须留在原地。
