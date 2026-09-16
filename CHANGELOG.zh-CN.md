# 更新记录

[English](CHANGELOG.md) · [简体中文](CHANGELOG.zh-CN.md) · [返回首页](README.zh-CN.md)

按用户可感知的行为整理主要变化，完整提交历史仍以 Git 为准。下方的本地构建记录不代表已经发布远端版本。

## 尚未发布

- 以 Agent-Hub 品牌重写项目介绍，提供独立的英文、中文 README 与更新记录。
- 同步独立渠道存储、可用的源码安装流程，以及渠道管理和会话启动仍使用独立入口的现状。
- 简化 macOS 与 Windows 界面的渠道选择和启动操作（`082bbfa`、`f1010e5`）。
- 保留可用于排障的 transport 失败诊断信息（`70241aa`）。

## 0.2.1 — macOS 本地构建 · 2026-09-10

- 渠道由 Hub 自有数据库保存，支持通过 TUI/CLI 添加，以及从 CC Switch 或 JSON 显式导入（`1932051`）。
- macOS 新增带来源归属的用量图、缓存覆盖率与分页用量明细（`ae3e677`）。
- 更新 Agent-Hub 品牌，制作本地签名的 macOS 安装包（`ff166e6`）。
- 同步 Windows 品牌与公共表格展示改进（`7e2175d`）。

交付与验证记录见 `13dabc2` 和[工作队列 S22](docs/work-queue.md#s22--provider-独立管理与用量图表)。macOS 产物为 ad-hoc 签名，未记录 Developer ID 公证或远端发布。本次不包含 Windows 安装器。
