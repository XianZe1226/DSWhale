# 贡献指南

欢迎提交问题报告、文档改进和代码贡献。

## 开发环境

需要 Python 3.12、Node.js 22 和 FFmpeg/ffprobe。

```bash
uv venv --python 3.12
uv pip install -e '.[dev]'
npm ci --ignore-scripts --no-audit --no-fund --prefix dswhale/bili_bridge
```

## 测试与检查

```bash
uv run --no-project python -m pytest -q
node --test tests/*.test.mjs dswhale/bili_bridge/upstream/tests/*.test.mjs
uv run --no-project python -m ruff check .
uv run --no-project python -m ruff format --check .
```

GitHub Actions 在 Linux、macOS 和 Windows 上执行测试与构建，并在 Windows PowerShell 5.1 中检查完整源码的首次安装和重复升级。

平台、模型和视频端点使用测试替身，测试不需要个人账号或模型密钥。AstrBot SDK 和 FFmpeg 测试使用实际依赖。Windows Job Object 等平台专属测试在对应系统运行。

LivingMemory 集成测试可通过以下命令准备：

```bash
uv run --no-project python -m dswhale install --astrbot-dir .memory-fixture --with-memory
```

安装其 `requirements.txt`，将 `DSWHALE_LIVINGMEMORY_SOURCE` 指向 `.memory-fixture/data/plugins/astrbot_plugin_livingmemory` 后运行 pytest。CI 会执行该集成测试。

## 构建

```bash
uv run --no-project python -m build
uv run --no-project python -m scripts.build_release
```

`dist` 包含 wheel、源码 ZIP/tar.gz、AstrBot 插件 ZIP 和 SHA-256 校验文件。源码包供首次安装使用，插件 ZIP 供现有 AstrBot 环境使用。

## 提交要求

- 行为变更附回归测试，保持用户隔离、活动持久化和资源限制。
- 功能说明应区分字幕、评论和抽样画面的能力范围。
- 不提交账号、聊天、个人配置、密钥或运行数据。
- 修改集成代码时保留上游版权与许可证，补充对应的适配说明。

问题报告请说明版本、系统、复现步骤和预期结果，并按 [安全说明](SECURITY.md)处理敏感信息。
