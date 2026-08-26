# /// script
# requires-python = ">=3.11"
# dependencies = ["modal>=0.73"]
# ///
"""GLM-5.3-Flash 单文件 Modal 部署: SGLang v0.5.18 + Anthropic 原生格式门面。

架构：
    Modal 容器 (H100 x8)
      ├─ SGLang 子进程 (--host 127.0.0.1:8000, 仅容器内可达)
      └─ FastAPI 门面 (对外唯一入口)
           ├─ POST /v1/messages            Anthropic Messages 原生格式（流式/非流式）
           ├─ POST /v1/messages/count_tokens
           ├─ GET  /healthz                门面健康探针
           └─ 其余路径原样反代上游 OpenAI 接口

生命周期：
    - 随用随停：keep_warm=0，无流量即按 scaledown_window=600 秒闲置自动关停；
    - 鉴权 fail-closed：GLM_API_KEY Secret 缺失时引擎直接拒绝启动；
    - 权重预存于 Volume（约 330 GB FP8），冷启动只付加载与 CUDA Graph 时间。

用法见 README.md / Makefile。
"""

import asyncio
import json
import os
import subprocess
import sys
import threading
import time

import httpx
import modal
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from anthropic_adapter import (
    MODEL_NAME,
    StreamTranslator,
    anthropic_error,
    from_openai_response,
    sse_frame,
    to_openai_request,
)

# ---------------------------------------------------------------------------
# 配置（改这里即可切硬件档位）
# ---------------------------------------------------------------------------

APP_NAME = "glm-5-3-flash"
VOLUME_NAME = "glm-5-3-flash-weights"
MODEL_DIR = "/models/glm-5-3-flash"          # Volume 挂载点（只读使用）
ENGINE_HOST = "127.0.0.1"
ENGINE_PORT = 8000
GPU_SPEC = "H100:8"                          # 640 GB；审计修正后的黄金推荐
IMAGE_TAG = "lmsysorg/sglang:v0.5.18"        # Docker Hub 实查存在的 tag；勿写 cu124 等不存在版本
WARMUP_WAIT_S = 900                          # 请求等待引擎就绪的兜底上限

app = modal.App(APP_NAME)
weights = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

image = modal.Image.from_docker_image(IMAGE_TAG).env(
    {
        "HF_HUB_ENABLE_HF_TRANSFER": "1",
        # 引擎日志走行缓冲，Modal logs 里能实时看到起服进度
        "PYTHONUNBUFFERED": "1",
    }
)


def engine_command() -> list[str]:
    """构建 SGLang 启动命令。鉴权 fail-closed：无密钥直接抛错，不开裸奔窗口。"""
    api_key = os.environ.get("GLM_API_KEY")
    if not api_key:
        raise RuntimeError("Secret GLM_API_KEY 未注入：拒绝以无鉴权状态暴露 Anthropic 兼容端点")
    return [
        "python3", "-m", "sglang.launch_server",
        "--model-path", MODEL_DIR,
        "--served-model-name", MODEL_NAME,
        "--tp", "8",
        "--host", ENGINE_HOST,               # 仅绑定回环，公网只能经鉴权门面进入
        "--port", str(ENGINE_PORT),
        "--context-length", "1048576",
        "--chunked-prefill-size", "16384",
        "--kv-cache-dtype", "fp8_e4m3",      # FlashMLA FP8 路径要求 e4m3
        "--mem-fraction-static", "0.85",
        "--cuda-graph-max-bs", "16",         # 个人并发上限内够用；显著压缩捕获时间与显存
        "--trust-remote-code",
        "--tool-call-parser", "glm47",
        "--reasoning-parser", "glm45",
        "--api-key", api_key,
    ]


# ---------------------------------------------------------------------------
# 引擎子进程管理（每容器一份；asgi 构造函数冷启动时执行一次）
# ---------------------------------------------------------------------------

_engine_state = {
    "proc": None,          # subprocess.Popen
    "ready": threading.Event(),
    "ready_detail": "",    # 未就绪原因，透给客户端与日志
}


def _watchdog(proc, log_path):
    """阻塞轮询 /health；结果写入共享状态。跑在守护线程里。"""
    deadline = time.monotonic() + WARMUP_WAIT_S
    url = f"http://{ENGINE_HOST}:{ENGINE_PORT}/health"
    while time.monotonic() < deadline:
        rc = proc.poll()
        if rc is not None:
            tail = ""
            try:
                with open(log_path) as fh:
                    tail = "".join(fh.readlines()[-30:])
            except OSError:
                pass
            print(f"[engine] 进程退出 code={rc}\n{tail}", flush=True)
            return  # 不置 ready：后续请求会看到进程已死并报错
        try:
            with __import__("urllib.request", fromlist=["urlopen"]).urlopen(url, timeout=3) as resp:
                if resp.status == 200:
                    _engine_state["ready"].set()
                    print("[engine] SGLang 就绪", flush=True)
                    return
        except Exception:
            time.sleep(3)
    print(f"[engine] {WARMUP_WAIT_S}s 内未就绪", flush=True)


@app.function(
    image=image,
    gpu=GPU_SPEC,
    volumes={MODEL_DIR: weights},
    scaledown_window=600,       # 10 分钟无请求自动关停 —— 计费随断
    max_containers=1,           # 个人使用单实例
    timeout=24 * 3600,          # 容器最长驻留保护值，正常由 scaledown 提前结束
)
@modal.concurrent(max_inputs=10)
@modal.asgi_app(label=APP_NAME)
def gateway():
    """容器冷启动钩子：拉起引擎子进程后立刻返回 ASGI 应用（后台线程盯就绪）。"""
    weights.reload()

    def ensure_weights():
        index_json = os.path.join(MODEL_DIR, "model.safetensors.index.json")
        if not os.path.exists(index_json):
            raise RuntimeError(
                f"{MODEL_DIR} 缺少权重索引 —— 请先执行 make download 把权重灌入 Volume"
            )

    ensure_weights()
    log_path = os.path.join("/tmp", "sglang-engine.log")
    log_fh = open(log_path, "wb")
    proc = subprocess.Popen(engine_command(), stdout=log_fh, stderr=subprocess.STDOUT)
    _engine_state["proc"] = proc
    threading.Thread(target=_watchdog, args=(proc, log_path), daemon=True).start()

    client = httpx.AsyncClient(
        base_url=f"http://{ENGINE_HOST}:{ENGINE_PORT}",
        timeout=httpx.Timeout(connect=10.0, read=None, write=None, pool=None),
    )
    web = FastAPI(title=f"{APP_NAME} anthropic-gateway")

    async def _wait_ready(timeout_s=WARMUP_WAIT_S):
        loop = asyncio.get_running_loop()
        ok = await loop.run_in_executor(None, _engine_state["ready"].wait, timeout_s)
        return ok

    def _deny(detail):
        return JSONResponse(anthropic_error("invalid_request_error", detail), status_code=503)

    async def _check_auth(request: Request):
        key = os.environ.get("GLM_API_KEY") or ""
        supplied = request.headers.get("x-api-key") or ""
        auth = request.headers.get("authorization") or ""
        if supplied != key and not auth.startswith(f"Bearer {key}"):
            return JSONResponse(
                anthropic_error("authentication_error", "missing or invalid API key"),
                status_code=401,
            )
        return None

    async def _guard(request: Request):
        """就绪检查 + 鉴权。返回 None 表示放行。"""
        proc = _engine_state["proc"]
        if proc is not None and proc.poll() is not None:
            return JSONResponse(
                anthropic_error("api_error", f"SGLang 进程已退出(code={proc.returncode})，容器将重建"),
                status_code=502,
            )
        if not _engine_state["ready"].is_set():
            if not await _wait_ready():
                return _deny(f"engine warm-up exceeded {WARMUP_WAIT_S}s")
        return await _check_auth(request)

    @web.get("/healthz")
    async def healthz():
        proc = _engine_state["proc"]
        alive = proc is not None and proc.poll() is None
        return {"gateway": "ok", "engine_alive": alive,
                "engine_ready": _engine_state["ready"].is_set()}

    @web.post("/v1/messages")
    async def messages(request: Request):
        denied = await _guard(request)
        if denied:
            return denied

        try:
            body = await request.json()
        except Exception:
            return JSONResponse(anthropic_error("invalid_request_error", "malformed JSON"), status_code=400)

        payload, warns = to_openai_request(body)
        for w in warns:
            print(f"[degrade] ADAPTER_DEGRADE_{w}", flush=True)

        if payload.pop("stream", False):
            return StreamingResponse(
                _stream_messages(payload),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-store"},
            )
        resp = await client.post("/v1/chat/completions", json=payload)
        if resp.status_code != 200:
            return _passthrough_error(resp)
        return JSONResponse(from_openai_response(resp.json()))

    async def _stream_messages(payload):
        translator = StreamTranslator()
        try:
            async with client.stream("POST", "/v1/chat/completions", json=payload) as resp:
                if resp.status_code != 200:
                    raw = (await resp.aread()).decode(errors="replace")
                    yield sse_frame({"event": "error", "data":
                                     anthropic_error("api_error", f"upstream {resp.status_code}: {raw}")})
                    return
                async for line in resp.aiter_lines():
                    if not line.startswith("data:") or line.strip() == "data: [DONE]":
                        continue
                    chunk = json.loads(line[5:].strip())
                    for event in translator.feed(chunk):
                        yield sse_frame(event)
                    if translator._stop_reason:
                        break
            for event in translator.flush():   # 只在上游真实读完或 finish 后收尾
                yield sse_frame(event)
        except httpx.HTTPError as exc:
            for event in translator.aborted_error(f"upstream stream broken: {exc!r}"):
                yield sse_frame(event)   # 断流不补 message_stop，终态只能来自上游

    @web.post("/v1/messages/count_tokens")
    async def count_tokens(request: Request):
        denied = await _guard(request)
        if denied:
            return denied
        body = await request.json()
        payload, _ = to_openai_request({**body, "stream": False})
        payload.pop("stream_options", None)
        try:
            resp = await client.post("/v1/tokenize", json=payload)
            resp.raise_for_status()
            data = resp.json()
            count = int(data.get("count") or (data.get("usage") or {}).get("prompt_tokens") or 0)
            assert count > 0
            return {"input_tokens": count}
        except Exception:
            total_chars = sum(len(json.dumps(m.get("content", ""), ensure_ascii=False))
                              for m in payload["messages"])
            return {"input_tokens": max(1, round(total_chars / 3))}

    @web.api_route("/{path:path}", methods=["GET", "POST"])
    async def passthrough(path: str, request: Request):
        """其余路径原样转发上游（/v1/models、/v1/chat/completions 直连调试等）。
        /health 免鉴权；其余路径鉴权通过后替请求方携带上游密钥。"""
        if path == "health":
            denied = None
        else:
            denied = await _check_auth(request)
        if denied:
            return denied
        body = await request.body()
        headers = {"content-type": request.headers.get("content-type", "")}
        if path != "health":
            headers["authorization"] = f"Bearer {os.environ.get('GLM_API_KEY', '')}"
        resp = await client.request(request.method, f"/{path}", content=body, headers=headers)
        return Response(content=resp.content, status_code=resp.status_code,
                        media_type=resp.headers.get("content-type"))

    return web


def _passthrough_error(resp: httpx.Response) -> JSONResponse:
    """错误原样还给下游，不裁剪语义；仅包一层 Anthropic 错误信封。"""
    return JSONResponse(
        anthropic_error("api_error", f"upstream {resp.status_code}: {resp.text}"),
        status_code=resp.status_code,
    )


if __name__ == "__main__":
    sys.exit(__import__("subprocess").call(["modal", "deploy", __file__]))
