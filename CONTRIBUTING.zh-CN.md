[English](CONTRIBUTING.md) | **简体中文**

# 为 Octopus Scout 做贡献

感谢你有兴趣参与贡献。本指南介绍一些基础内容。

## 开发环境搭建

```bash
npm install
npm run playwright:install   # for browser-render features
npm run dev                  # http://localhost:8787
```

需要 Node ≥ 22。

## 提交 PR 之前

运行完整的本地检查门禁 —— CI 会执行相同的检查：

```bash
npm run typecheck                                   # tsc --noEmit, must be clean
npm run format:check                                # prettier
OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=true npm test     # vitest (the flag lets localhost-fixture tests run)
```

- **类型安全 (type safety)：** 项目启用 `strict`。除非无法避免并已加注释，否则不允许出现 `any` 这样的逃逸。
- **测试：** 新增行为需要配套测试。测试必须是**自洽隔离的 (hermetic)** —— 仅使用 localhost（不访问外部网络）、使用独立的临时目录，并在结束后清理。需要 API key / 真实数据库的测试必须用 `describe.skipIf(...)` 加以门控，以保证默认测试套件始终通过。
- **桩实现 (stub) 的 embedder 基于哈希** —— 在测试中切勿断言余弦得分的*正负号*；只能在使用真实 provider 时断言其有限性 / 排序关系。
- **零依赖反爬虫 (anti-bot)：** `src/fetcher` 中的反爬虫代码（stealth、proxy、challenge、captcha）不得引入第三方库 —— 只能使用 Node 内置模块 + Playwright。

## 项目结构

模块映射与数据流请参见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.zh-CN.md)。

## 提交 / PR

- 保持 PR 聚焦。说明改了什么以及为什么改。
- 对于影响用户的改动，更新 `CHANGELOG.md`（Unreleased 部分）。
- 当你改动 API/CLI/MCP 外部接口时，更新相关文档（`README.md`、`docs/`）。

## 报告 Bug / 安全问题

普通 Bug 请正常提交 issue。对于安全漏洞，请遵循
[SECURITY.md](SECURITY.zh-CN.md) 的流程，而不要公开提交 issue。
