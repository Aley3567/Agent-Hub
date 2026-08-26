# /// script
# requires-python = ">=3.11"
# dependencies = ["modal>=0.73"]
# ///
"""把 GLM-5.3-Flash 官方 FP8 权重灌入 Modal Volume。

一次性操作：约 328 GB（62 个 safetensors 分片），在数据中心带宽下执行，
避免本地下载再上传的双倍搬运。运行： make download  （即 modal run 本文件）
"""

import modal

VOLUME_NAME = "glm-5-3-flash-weights"
MODEL_DIR = "/models/glm-5-3-flash"
REPO_ID = "zai-org/GLM-5.3-Flash"

app = modal.App("glm-5-3-flash-download")
volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

download_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("huggingface_hub[hf_transfer]==0.35.*", "hf_transfer")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)


@app.function(image=download_image, volumes={MODEL_DIR: volume}, timeout=4 * 3600)
def download():
    import os
    from huggingface_hub import snapshot_download

    # gated=false 实查无需 token；如仓库策略变化在此显式取 Secret 即可
    snapshot_download(
        repo_id=REPO_ID,
        local_dir=MODEL_DIR,
        max_workers=8,
    )
    files = sorted(os.listdir(MODEL_DIR))
    n_shards = sum(1 for f in files if f.endswith(".safetensors"))
    print(f"完成: {len(files)} 个文件, 其中 safetensors 分片 {n_shards} (期望 62)")
    if n_shards != 62:
        raise RuntimeError(f"分片数 {n_shards} != 62, 下载不完整")


@app.local_entrypoint()
def main():
    download.remote()
