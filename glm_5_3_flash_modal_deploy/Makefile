# GLM-5.3-Flash @ Modal — 管理命令
# 前置: pip install modal && modal setup；export GLM_API_KEY=<自定义密钥>（Secret 注入）

APP      := glm-5-3-flash
MODAL_URL?= https://<your-label>.modal.run   # deploy 后由输出提示填入

.PHONY: help download secret deploy run logs stop smoke test clean

help:
	@echo "make download  # 首次一次性: 官方 FP8 权重(~330GB)灌入 Volume"
	@echo "make secret    # 注入鉴权密钥 Secret（GLM_API_KEY）"
	@echo "make deploy    # 常驻部署(随用随停), 输出里可拿到公网 URL"
	@echo "make run       # 临时前台跑一版试效果, Ctrl-C 结束即断电计费"
	@echo "make logs      # 跟踪引擎日志"
	@echo "make stop      # 立即停服断电"
	@echo "make smoke     # 五级冒烟(健康/401/对话)"
	@echo "make test      # 协议层离线单测(零依赖)"

download:
	modal run download_weights.py

secret:
	modal secret create glm-auth-secret GLM_API_KEY=$${GLM_API_KEY:?先 export GLM_API_KEY}

deploy:
	modal deploy deploy.py

run:
	modal serve deploy.py

logs:
	modal app logs $(APP)

stop:
	modal app stop $(APP)

test:
	python3 -m unittest discover -s tests -p 'test_*.py'

# 冒烟: 第二条无凭证应得 401 —— 鉴权生效的最终验收
smoke:
	curl -s $(MODAL_URL)/healthz | head -c 200; echo
	@echo "--- 无 key 应返回 401 ---"
	curl -s -o /dev/null -w '%{http_code}\n' -X POST $(MODAL_URL)/v1/messages \
	  -H 'content-type: application/json' -d '{"max_tokens":16,"messages":[]}'
	@echo "--- 带 key 正常对话(流式) ---"
	curl -sN -X POST $(MODAL_URL)/v1/messages \
	  -H "x-api-key: $${GLM_API_KEY:?先 export GLM_API_KEY}" \
	  -H 'content-type: application/json' \
	  -d '{"model":"glm-5.3-flash","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"用一句话介绍你自己"}]}'
