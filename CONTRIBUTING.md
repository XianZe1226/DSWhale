# 开发与贡献

需要 Python 3.12 和 ffmpeg（含 ffprobe）。

```bash
uv venv --python 3.12
uv pip install -e '.[dev]'
uv run --no-project python -m pytest -q
uv run --no-project python -m ruff check .
uv run --no-project python -m ruff format --check .
uv run --no-project python -m build
uv run --no-project python -m scripts.build_release
```

发布产物位于 dist：Python wheel（含插件资源）、源码 tar.gz（含安装脚本）、AstrBot 插件 ZIP 和校验文件。插件 ZIP 适合已有 AstrBot；新用户用完整源码包。

测试不需要 QQ、Cookie 或模型 API Key。平台与模型边界用替身，AstrBot 类型和 ffmpeg 处理使用真实依赖。改动必须维持主人隔离、活动持久化、资源限额与证据范围声明；不要向测试或示例中提交真实密钥、聊天或记忆。重要行为变更附回归测试。

GitHub Actions 已配置 Linux/macOS/Windows；本地结果和 CI 结果分开记录。发布前完成 docs/validation.md 的账号验收流程。提交 issue 时提供脱敏错误类型、版本和 doctor 检查结果，不上传 data、Cookie 或数据库。

可选的真实 LivingMemory 集成测试：使用 `python -m dswhale install --astrbot-dir .memory-fixture --with-memory` 获取固定校验版本；把 `DSWHALE_LIVINGMEMORY_SOURCE` 环境变量指向 `.memory-fixture/data/plugins/astrbot_plugin_livingmemory`，再运行 pytest。未设置时仅跳过该上游集成测试；GitHub Actions 会准备该依赖并运行。
