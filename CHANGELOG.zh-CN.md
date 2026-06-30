[English](CHANGELOG.md) | **简体中文**

# 更新日志

本项目所有重要变更都记录于此。格式基于
[Keep a Changelog](https://keepachangelog.com/)，并且本项目在到达 1.0 之后将遵循语义化版本 (semantic versioning)。

## [0.2.0] - 2026-07-01

### Added

- 存储：内嵌的 **SQLite** 现在是默认后端（零基础设施），覆盖全部五个存储家族（快照、向量、审计、审批、爬取任务），与文件后端完全平价。通过 `OCTORYN_SCOUT_STORAGE_BACKEND=file` 使用 JSON 文件回退；通过 `DATABASE_URL` 可选启用 Postgres + pgvector。SQLite 作为**可选**原生依赖发布——`npm install` 即便无法编译也绝不失败，驱动不可用时后端会透明回退到文件后端。
- 抽取：多页（`POST /extract/batch`）与全站（`POST /extract/site`）结构化抽取；每个未被拦截的结果都会持久化进一个受治理的 `ExtractionStore`（file/SQLite/Postgres），并通过 `GET /extractions` / `GET /extractions/:id` 读取（默认排除非 `allowed`，`includeUnapproved` 显式开启）。新增 CLI 命令 + MCP `octoryn_extract_site`。
- 抽取提供方 `bedrock`：通过一个 Bedrock API key（`AWS_BEARER_TOKEN_BEDROCK` + `OCTORYN_SCOUT_BEDROCK_REGION`）在 **Amazon Bedrock** 上运行 Anthropic 模型，用强制 tool-use 产出 JSON——无需 AWS SDK 依赖。
- 检索：启发式**查询改写**（`rewrite` 开关）——确定性、离线的查询变体，用倒数排名融合 (RRF) 合并；无需 LLM/key。
- 集成：`searchAsDocuments` 检索器助手，返回 LangChain `Document` 形状的对象 + `docs/INTEGRATIONS.md` 中可复制粘贴的 LangChain/LlamaIndex 适配器（无 langchain 运行时依赖）。
- 文档：所有文档现在都是**双语**（English + 简体中文），并带有文件顶部的语言切换。

### Changed

- `npm install`/运行时不再硬性要求构建工具链：`better-sqlite3` 移入 `optionalDependencies`，惰性加载并在失败时优雅回退到文件后端。

## [0.1.0] - 2026-07-01

首个公开发布版本。

### Added

- 核心采集 (ingestion)：`/scrape`、`/fetch`、`/render`、静态 + 池化浏览器 (pooled-browser) 抓取、HTML/PDF → Markdown、表格、robots.txt + 按域名限速、内容哈希去重 (content-hash dedup)、版本快照 (version snapshots)、引用锚点 (citation anchors)、来源信任评分 (source trust score)。
- 爬取 (crawl)：带 sitemap 种子的深度受限 BFS、过滤器、检查点 / 续爬 (checkpoint/resume)；全站采集；`/map` 快速 URL 发现。
- 知识 / RAG：分块 (chunking)、可插拔 embeddings（stub / Voyage / OpenAI）、向量存储（SQLite / 文件余弦 / Postgres jsonb / **pgvector**）、混合检索（向量 + 词法 BM25 / SQLite FTS5 + RRF）配合可插拔重排序 (reranking)、RAG/JSONL 导出、`/ingest` + `/search`。
- LLM 结构化抽取 (`/extract`)，支持 Anthropic（官方 SDK）与 OpenAI provider。
- 治理 (governance)：审计轨迹 (audit trail)、人工审批工作流、按域名策略、敏感域名门控；保留 / 清理 (retention/pruning)。
- 事件机制 (eventing)：内部事件总线 (event bus)、HMAC 签名的 webhook、定时的陈旧度刷新 (staleness refresh)。
- 分布式 (distributed)：持久化的 BullMQ 任务（scrape/crawl/site-ingest）+ 死信队列 (dead-letter queue)、用于调度器的 Redis 分布式锁。
- 反爬虫 (anti-bot)（零新增依赖）：stealth-plus、自带 (BYO) 代理并手写 CONNECT 隧道、Cloudflare JS-challenge 等待、`FetchProvider` 接缝 (seam)、CAPTCHA provider 接缝（检测 + 注册表 + 规范；不做求解 —— 参见 `docs/CAPTCHA.md`）。
- 接口 (interfaces)：HTTP API（Fastify）、CLI、MCP stdio 服务器（8 个工具）；可选的 API-key 认证。
- 存储 (storage)：**内嵌 SQLite 是默认后端**（单个 `octopus-scout.db`，零基础设施），覆盖全部五个存储家族（快照、向量、审计、审批、爬取任务）；JSON 文件回退 (`OCTORYN_SCOUT_STORAGE_BACKEND=file`)；面向大规模语料 / 多实例时可选 Postgres + pgvector (`DATABASE_URL`)。SQLite 作为可选的原生依赖发布 —— `npm install` 永远不会因构建失败而中断，且当驱动不可用时后端会透明地降级为文件存储。

### Governance (enforcement)

- 治理现在会对**每一个对外服务通道**进行门控，而不仅仅是索引：`blocked` 的内容永远不会被持久化或对外提供；`requires_approval` 的内容默认被排除在搜索之外（可通过 `includeUnapproved` 主动开启）、被 `/export` 拒绝、在 `/snapshots/:id` 中被脱敏处理，并且 `/render` + `/fetch` 会应用域名策略（命中拦截时返回 `451`）。
- `enforce` 模式会隔离 (quarantine) `requires_approval` 的内容（在获批前永不索引）；**批准 (approve) 会释放**该内容，**拒绝 (reject) 会从索引和快照存储中清除**它；保留策略 (retention) 会清理向量存储。

### Security

- SSRF 守卫会在直连、走代理和浏览器抓取三条路径上对每一跳重定向重新校验。
- API-key 认证采用**失败即关闭 (fail closed)** 策略（配置了认证模式但未配置任何 key 时会拒绝受保护的路由），并使用常量时间 (constant-time) 的 key 比较；5xx 响应不再泄露内部错误信息。
- 严格的环境变量布尔值解析（例如 `OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=false` 会被正确识别 —— 此前任何非空值，包括 `"false"`，都会关闭守卫）。
- Stub embeddings（离线默认实现）现在会发出一次性警告，并在 `/ready` 中显示出来，从而让静默的非语义搜索不再成为一个陷阱。

### Changed

- 将所有依赖固定到 caret 范围（此前为 `"latest"`），新增了发布元数据、`files`/`exports`/类型声明，以及一个库 (library) 入口点。
