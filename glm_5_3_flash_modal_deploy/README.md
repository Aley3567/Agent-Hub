# GLM-5.3-Flash @ Modal — 干净重写版 (v2)

> **失效条件**: 当且仅当官方权重仓库 `zai-org/GLM-5.3-Flash` 的 config.json 发生
> 结构性变更（层数/专家数/注意力配比改动）、或 SGLang v0.5.18 之后出现该模型的
> 官方推荐部署 recipe 时，本文显存模型与启动参数需要重审；纯参数级更新不触发。

单文件 Modal 部署：**SGLang v0.5.18 + Anthropic Messages 原生格式门面**。
随用随停、10 分钟无请求自动断电、鉴权 fail-closed。

```
Modal 容器 H100×8
  ├─ SGLang 子进程 (127.0.0.1:8000, 仅容器内)
  └─ FastAPI 门面 (唯一公网入口, 鉴权 + 协议翻译)
       ├─ POST /v1/messages            Anthropic 原生（流式 SSE / 非流式）
       ├─ POST /v1/messages/count_tokens
       ├─ GET  /healthz
       └─ /* 其余路径原样反代 OpenAI 接口（调试用）
```

## 快速上手

```bash
pip install modal && modal setup          # 一次性
export GLM_API_KEY=$(openssl rand -hex 24)   # 自定密钥，客户端要用它

make download    # 首次一次性: 官方 FP8 权重(~330GB)灌入 Volume(数据中心带宽直拉)
make secret      # 密钥注入 Secret glm-auth-secret
make deploy      # 上线; 输出给出公网 URL, 填进 Makefile MODAL_URL 变量后可 make smoke
make stop        # 用完立停(不想等 10 分钟闲置窗的话)
```

直接对接 Anthropic SDK：

```python
from anthropic import Anthropic
client = Anthropic(base_url="https://<label>.modal.run", api_key=KEY)
msg = client.messages.create(model="glm-5.3-flash", max_tokens=1024,
                             messages=[{"role": "user", "content": "hi"}])
# 流式 client.messages.stream(...) 同样可用; 思考内容以 thinking block 返回
```

## 事实底座（三轮审计修正后的存档，勿凭记忆改）

| 项 | 值 | 来源 |
|---|---|---|
| 架构 | 45 层 = 34 KDA 线性 + 11 稀疏 MLA(nope, kv_lora_rank 512, rope 维 0)；288+1 专家 top-8；d_model 4096 | 官方 config.json 已实读 |
| 权重 | 单套 FP8(e4m3 block128)，62 分片 ≈ 328 GB，gated=false 无需 token | HF tree API 已实查 |
| KV/token | ~5.5 KiB(MLA) + indexer 缓存 ≈ **7.0–7.5 KiB 推断值** | 首次真实长文本跑通后校准 |
| 选型 | **8×H100 (640GB) 黄金档 $31.60/hr**；8×H200 属过度配置；10并发@1M 负载 ~68% | Modal 定价页已核实 |
| 启动参数 | tp8 / fp8_e4m3 KV / mem-frac 0.85 / chunked-prefill 16384 / cuda-graph-max-bs 16(压冷启动) | 见 deploy.py |
| 计费语义 | scaledown_window=600 即「10 分钟无请求自动关停」；keep_warm=0 随用随停 | Modal 平台原生 |

## 设计要点

- **低启动时间三杠杆**：官方锁定镜像（零 pip 解析）、Volume 只读挂载（零下载）、
  `--cuda-graph-max-bs 16`（个人并发内够用，显著缩短捕获）。首启仍需数分钟量级，
  这是 330 GB 权重的物理下限；容器存活期内复用不受影响。
- **安全 fail-closed**：Secret 缺失引擎拒绝启动；上游仅绑回环；无凭证打 /v1/messages 得 401
  （Makefile smoke 第二条是最终验收）。
- **断流纪律**：上游连接中断只补 `error` 事件、绝不伪造 `message_stop`；
  无法无损翻译的字段记 `[degrade] ADAPTER_DEGRADE_*` 日志后放行，与主仓库协议桥同规。
- **历史 thinking 不回传**：多轮中 assistant 的旧思考块在进上游前剥离，避免方言字段被拒。

## 已知边界（有意为之，不是缺陷）

1. 多模态输入未接（模型本身是多模态架构）：非文本块降级丢弃并留痕；图像接入了再解禁。
2. count_tokens 先走上游 `/v1/tokenize`，失败时按字符数÷3 估算——估算值仅够预算用途。
3. MTP 投机解码第一版关闭；文本链路稳定后再 A/B 加速 decode。
4. `--attention-backend` 未强制指定，由 v0.5.18 对 DSA 家族自适应选择 FlashMLA 系默认路径。

## 目录

```
glm_5_3_flash_modal_deploy/
├── deploy.py               # Modal App 全部: 引擎生命周期 + ASGI 门面
├── anthropic_adapter.py    # 纯函数协议翻译层(零第三方依赖)
├── download_weights.py     # modal run 权重落卷(一次性)
├── tests/test_anthropic_adapter.py   # 10 项离线协议测试(make test)
└── Makefile
```
