[English](README.md) | **简体中文**

# Octopus Scout

[![CI](https://github.com/octoryn/octopus-scout/actions/workflows/ci.yml/badge.svg)](https://github.com/octoryn/octopus-scout/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/octoryn/octopus-scout?sort=semver)](https://github.com/octoryn/octopus-scout/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](.nvmrc)
[![No Docker required](https://img.shields.io/badge/infra-no%20Docker%20required-success.svg)](#storage)

> **[Octopus Core](https://github.com/octoryn) 的一部分 —— 受治理 AI 的开源基础设施栈。** 每个仓库只做一件事，沿 agent 生命周期组合：[Scout](https://github.com/octoryn/octopus-scout) · [Observe](https://github.com/octoryn/octopus-observe) · [Experience](https://github.com/octoryn/octopus-experience) · [Blackboard](https://github.com/octoryn/octopus-blackboard) · [Runtime](https://github.com/octoryn/octopus-runtime) · [Replay](https://github.com/octoryn/octopus-replay) —— [Inspect](https://github.com/octoryn/octopus-inspect) 横贯每一环做治理。
>
> **本仓库 —— Scout · 采集：** 采集证据，而非网页。

Octoryn Web Ingestion Engine：一个可治理 (governance)、可审计 (auditable)、AI 原生的网页、PDF 与知识工作流摄取管线 (ingestion pipeline)。

这个首发版本针对常规的 80% 网络场景做了优化：抓取 (fetch)、可选的浏览器渲染 (render)、抽取 (extract)、归一化为 Markdown/JSON、构建证据锚点 (evidence anchor)、缓存/版本化结果，并通过 API、CLI、队列以及兼容 MCP 的工具将其暴露出来。

> 📐 **架构、技术说明，以及与 Firecrawl 的对标**：见 [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md)。

## Quick Start

从 npm 安装(已发布的包——CLI、MCP server、库三用):

```bash
# 全局 CLI
npm install -g octopus-scout
octopus-scout scrape https://example.com --render static

# 或者免安装直接运行
npx octopus-scout scrape https://example.com --render static

# 把 MCP server 接入 Claude Desktop / Claude Code
npx octopus-scout-mcp
```

> 从 npm 安装后,CLI 直接用 `octopus-scout <command>`(或 `npx octopus-scout <command>`);下文的 `npm run cli -- <command>` 是从源码运行的等价写法。

或者从源码运行(用于开发):

```bash
npm install
npm run playwright:install
npm run dev
```

```bash
curl -s http://localhost:8787/health
curl -s http://localhost:8787/scrape \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","render":"static"}'
```

> 🔒 SSRF 防护默认会拦截私有/回环 (loopback) 主机——在本地开发和测试中若要抓取 `localhost`
> 或其他私有地址，请设置 `OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=true`。

CLI：

```bash
npm run cli -- scrape https://example.com --render static
npm run cli -- sitemap https://example.com/sitemap.xml
npm run cli -- map https://example.com --search docs --limit 100
npm run cli -- crawl https://example.com --max-depth 1 --max-pages 25
npm run cli -- export https://example.com --embed --jsonl
npm run cli -- ingest https://example.com
npm run cli -- search "what is this page about" --top-k 5 --mode hybrid
npm run cli -- extract https://example.com --schema '{"type":"object","properties":{"title":{"type":"string"}}}'
npm run cli -- ingest-site https://example.com --max-depth 1 --max-pages 25
npm run cli -- crawl https://example.com --resume <crawlId>
npm run cli -- crawls
npm run cli -- retention --snapshot-versions 5 --audit-days 90
npm run cli -- refresh --max-age-days 7
npm run cli -- approvals pending
npm run cli -- approve <approval-id> --by you@org.com --note "reviewed"
```

作为库使用：

该包（`octopus-scout`）通过其 `dist/index.js` 入口暴露引擎，
因此你可以直接调用管线，而无需经过 HTTP/CLI/MCP 接口：

```ts
import { scrapeUrl, searchKnowledge } from "octopus-scout";

const result = await scrapeUrl({ url: "https://example.com", render: "static" });
console.log(result.extraction.markdown);

const hits = await searchKnowledge({ query: "what is this page about", topK: 5 });
console.log(hits);
```

### Storage

无需 Docker 或外部数据库。默认情况下 octopus-scout 使用一个内嵌的 **SQLite**
数据库（数据目录下的单个 `octopus-scout.db` 文件）来存放快照 (snapshot)、向量、审计、审批
以及爬取任务——克隆即可运行。

> **在任意平台都能用。** SQLite 由可选的原生模块 `better-sqlite3` 提供；`npm install`
> 即便无法编译它也绝不会失败，运行时 octopus-scout 会在驱动可用时使用 SQLite，否则
> 透明回退到文件后端（并给出一次性提示）。因此即使在没有预编译二进制或构建工具链的
> 环境中，"克隆即运行"的承诺依然成立。

- 设置 `OCTORYN_SCOUT_STORAGE_BACKEND=file` 以使用纯 JSON 回退方案（文件位于
  `.octoryn-scout/` 下）。
- 设置 `DATABASE_URL=postgres://...` 改用 **Postgres + pgvector**，
  以应对大规模语料或多实例部署。当设置了 `REDIS_URL` 时，
  `/jobs/scrape` 与 `npm run worker` 会使用 BullMQ 提供持久化队列。

Postgres 和 Redis 完全是可选项；只有当你的规模超出内嵌默认方案时才需要引入它们：

```bash
docker compose up
```

## API

摄取 (Ingestion)：

- `GET /health`
- `POST /fetch` 静态抓取，遵循 robots 与限流策略
- `POST /render` Playwright 浏览器渲染
- `POST /scrape` 完整摄取管线（哈希去重 + 治理门控；浏览器渲染支持抓取前的 `actions`）
- `POST /sitemap` 站点地图 URL 抽取
- `POST /map` 快速站点 URL 发现（站点地图 + 根页面链接、同源/子域名 + 路径/搜索过滤）——对标 Firecrawl `/map`
- `POST /crawl` 深度受限爬取（BFS、站点地图种子、同源 + 正则过滤；`resumeCrawlId` 用于续跑已检查点的爬取）
- `GET /crawls` / `GET /crawls/:id` 列出 / 读取已持久化的爬取任务
- `POST /jobs/scrape` / `POST /jobs/crawl` / `POST /jobs/ingest-site` 在配置了 Redis 时入队持久化任务
- `GET /jobs/:id?queue=scrape|crawl|site|dead` 任务状态 / 结果 / 失败

知识与检索 (Knowledge & retrieval)：

- `POST /export` 将一个页面分块 (chunk) 并（可选地）嵌入 (embed) 为一个 RAG 文档 / JSONL
- `POST /ingest` 抓取 → 分块 → 嵌入 → 存入向量索引
- `POST /ingest-site` 爬取整个站点并将每个页面索引进向量库
- `POST /search` 在知识库上做检索——`mode` = `vector` | `lexical` | `hybrid`（默认），可选 `rerank`；返回带引用锚点、信任度 (trust) 与治理状态的分块
- `POST /extract` LLM 结构化抽取——抓取一个 URL 并返回符合所提供 JSON Schema 的 JSON（对标 Firecrawl `/extract`）
- `POST /extract/batch` 对一个显式的 URL 列表运行相同的 JSON Schema 抽取（每个输入 URL 一个结果）
- `POST /extract/site` 发现一个站点的 URL（`/map`）并对每个页面抽取该 schema
- `GET /extractions` 列出已持久化的抽取（治理读取：默认排除非 `allowed`；`includeUnapproved` 显式开启）
- `GET /extractions/:id` 按 id 读取单个已持久化的抽取
- `GET /versions?url=` 某 URL 的版本历史（内容哈希快照）
- `GET /snapshots/:id` 读取一份已保存的快照

治理与运维 (Governance & operations)：

- `GET /governance/approvals?status=` 列出审批请求（pending/approved/rejected）
- `GET /governance/approvals/:id` 读取单个审批请求
- `POST /governance/approvals/:id/decision` 批准/驳回（记录一条审计事件）
- `GET /audit?target=&action=` 查询只追加 (append-only) 的审计轨迹
- `POST /admin/retention` 清理旧的快照版本、审计事件以及已决议的审批
- `POST /admin/refresh` 运行陈旧度扫描——重新摄取超过阈值的快照
- `GET /events` 跟踪近期的内部事件（scrape/approval/crawl/ingest）
- `GET /webhooks` webhook 投递日志（状态、尝试次数、响应码）
- `GET /metrics`（`?format=prometheus`）请求/状态/治理计数器 + 按域名统计
- `GET /ready` 就绪探针（在配置时检查 Redis/Postgres 可达性）

## Pipeline

```text
URL Input
  -> Fetcher / Browser Renderer (pooled) / Crawler (depth-bounded BFS)
  -> Content Extractor
  -> Markdown / JSON Normalizer
  -> Evidence + Citation Builder
  -> Governance (trust score, sensitive-domain gating, audit, human approval)
  -> Cache / Hash-Dedup / Versioning
  -> Knowledge Pipeline (chunking + embedding hook + RAG/JSONL export)
  -> Agent / RAG / Workflow (CLI, HTTP API, MCP server)
```

## Knowledge & RAG

`POST /export`（或 `cli export`）按标题结构将一个页面的 Markdown 切分为受 token 数量约束、
带重叠的分块，把每个分块映射回一个引用锚点以及它在源 Markdown 中的字符偏移量，并产出一个
`RagDocument`（或 JSONL，每个分块一行）。

`POST /ingest` 运行完整的读取路径——抓取 → 分块 → 嵌入 → 存储——存入一个向量索引，
而 `POST /search` 为查询检索最近邻分块，每个分块都携带其源 URL、引用锚点、信任度评分
以及治理状态。被治理拦截的内容永不入索引；`requires_approval` 的内容会连同其状态一起入索引，
以便检索可对其过滤（`includeBlocked`、`minTrust`、`url`）。

检索（`POST /search`）支持三种模式：`vector`（嵌入向量余弦相似度）、
`lexical`（默认用 SQLite FTS5，文件后端用内存 BM25，Postgres 上用 Postgres 全文检索），以及
`hybrid`（默认），它用 **Reciprocal Rank Fusion**（倒数排名融合）融合两组候选集。
随后结果会经过一个可插拔的重排器 (reranker)（`OCTORYN_SCOUT_RERANK_PROVIDER` =
默认 `heuristic` | `cohere` | `voyage` | `none`）；启发式重排器是
确定性的且离线运行，而 Cohere/Voyage 在设置了对应 API key 时启用。
一个可选的 `rewrite` 开关会启用**启发式查询改写**：查询会被扩展成一小组
确定性、离线的变体（原始查询、一个归一化形式，以及一个去停用词的关键词形式），
每个变体各自检索后再融合命中——无 LLM 调用、无需 key。

`POST /extract`（或 `cli extract`）执行 **LLM 结构化抽取**：它抓取一个
URL，然后返回符合你所提供 JSON Schema 的 JSON。提供方可插拔
（`OCTORYN_SCOUT_EXTRACTION_PROVIDER` = 默认 `none` | `anthropic` | `openai` | `bedrock`）：Anthropic
使用官方 SDK，搭配 `claude-opus-4-8` 以及 `output_config` 的 json-schema 输出，OpenAI
使用 json-schema 的 `response_format`，而 `bedrock` 通过一个 Bedrock API key
（`AWS_BEARER_TOKEN_BEDROCK` + `OCTORYN_SCOUT_BEDROCK_REGION`，用强制 tool-use 产出 JSON、
无需 AWS SDK 依赖）在 **Amazon Bedrock** 上运行 Anthropic 模型；被治理拦截的页面会被跳过，绝不抽取。

抽取也能扩展到单页之外：`POST /extract/batch` 对一个显式的 URL 列表运行相同的 schema，
而 `POST /extract/site` 会先发现一个站点的 URL（即 `/map` 路径），再对每个页面抽取该
schema——每个 URL 一个结果，单个失败会被记为一个 skipped 结果而非中止整次运行。每个
未被拦截的结果都会持久化进一个**受治理的 `ExtractionStore`**（File / SQLite / Postgres，
选择逻辑与快照存储完全一致），并携带其 `governanceStatus`；`GET /extractions` 与
`GET /extractions/:id` 将其读回，默认排除非 `allowed` 的行，并提供 `includeUnapproved`
显式开启——与 search 相同的安全默认 (secure-by-default) 契约。

> 🔌 **框架集成**：要把受治理的检索读取路径接入 LangChain 或 LlamaIndex，
> 见 [docs/INTEGRATIONS.zh-CN.md](docs/INTEGRATIONS.zh-CN.md)——一个框架无关的
> `searchAsDocuments` 辅助函数，外加可直接粘贴的 retriever 代码片段（octopus-scout
> 不引入任何框架运行时依赖）。

嵌入向量通过一个可插拔的 `EmbeddingProvider` 产生
（`OCTORYN_SCOUT_EMBEDDING_PROVIDER` = `stub` | `voyage` | `openai`）：默认是一个
确定性、无需网络的桩 (stub)，而 Voyage/OpenAI 在设置了对应 API key 时启用
（`VOYAGE_API_KEY` / `OPENAI_API_KEY`），否则回退到桩。

> ⚠️ **默认的嵌入提供方是一个确定性的、非语义 (NON-SEMANTIC) 的桩**——它
> 产生稳定的离线向量用于测试，但不捕捉语义，因此只有当你将
> `OCTORYN_SCOUT_EMBEDDING_PROVIDER` 设为 `voyage` 或 `openai`（并配上匹配的 API key）后，`vector`
> 与 `hybrid` 检索才具备语义意义。向量
> 库默认是内嵌的 **SQLite** 后端（进程内余弦相似度）；当设置了 `DATABASE_URL`
> 时则使用 **pgvector**（一个 `vector(dim)` 列 + HNSW 余弦索引、`<=>` 距离），
> 并在 `vector` 扩展不可用时透明回退到 jsonb + 进程内余弦相似度。

## Access control

设置 `OCTORYN_SCOUT_AUTH_MODE`（`off` | `write` | `all`）与 `OCTORYN_SCOUT_API_KEYS`
（逗号分隔），即可要求通过 `Authorization: Bearer <key>` 或
`x-api-key` 提供 API key。`write` 保护所有写操作请求，外加治理敏感的
`/governance` 与 `/audit` 读取；`all` 保护除 `GET /health` 外的一切。若
未配置任何 key，认证将被禁用（向后兼容）。

## Per-domain policy

将 `OCTORYN_SCOUT_POLICY_FILE`（或放置 `<dataDir>/policy.json`）指向一个
`GovernancePolicy`：按域名设置 `action`（`allow` | `block` | `require_approval`）、
`rateLimitMs` 以及 `trustOverride`。策略升级会叠加在
关键词/robots 决策之上（它只能收紧，绝不放松一个 block），并以
最具体的域名匹配优先。

```json
{
  "version": "v1",
  "defaultAction": "allow",
  "domains": [{ "domain": "example.com", "action": "require_approval", "rateLimitMs": 3000 }]
}
```

## Scale & reliability

- **浏览器池 (Browser pool)** ——单个 Chromium 实例，配有受限的并发页面
  信号量 (semaphore)（`OCTORYN_SCOUT_BROWSER_MAX_PAGES`）以及空闲自动关闭。
- **分布式限流** ——在设置了 `REDIS_URL` 时，按域名的间隔通过 Redis
  跨进程强制执行（原子 EVAL），否则回退到内存；遵循
  robots 的 `crawl-delay`。
- **死信队列 (Dead-letter queue)** ——耗尽重试的 scrape/crawl 任务会被推入
  死信队列，并附带一个分类后的失败原因（`timeout`、`robots_blocked`、
  `http_error`、`render_error`、`unknown`）。
- **可续跑的爬取** ——爬取任务每 `OCTORYN_SCOUT_CRAWL_CHECKPOINT_EVERY` 个页面
  就将其边界 (frontier)/已访问/结果检查点到一个存储；带 `resumeCrawlId` 的
  `POST /crawl` 会从最近一次检查点继续。`GET /crawls` 列出任务。
- **整站摄取** ——`POST /ingest-site` 爬取一个站点并在一次调用中将每个
  允许的页面索引进向量库；`POST /jobs/ingest-site` 将其作为一个
  持久化的 BullMQ 任务运行（轮询 `GET /jobs/:id`），耗尽重试的任务会被路由到
  死信队列。
- **分布式调度锁** ——计划中的陈旧度扫描被包裹在一个 Redis
  锁中（`SET NX PX` + Lua 比较-删除），因此多个实例不会重复扫描；在没有
  Redis 时它退化为单实例照常运行。
- **保留 (Retention)** ——`POST /admin/retention`（或 `cli retention`）清理超过
  `OCTORYN_SCOUT_SNAPSHOT_RETENTION_VERSIONS`/`_DAYS` 的快照版本、超过
  `OCTORYN_SCOUT_AUDIT_RETENTION_DAYS` 的审计事件，以及已决议的审批（待定审批
  绝不会被清理）。`0` = 全部保留。
- **可观测性** ——`GET /metrics`（JSON 或 Prometheus）与 `GET /ready`。

## Eventing & automation

引擎在一个进程内总线 (bus) 上发出内部事件（`scrape.completed`、`approval.requested`、
`approval.decided`、`crawl.completed`、`site_ingest.completed`）；
`GET /events` 跟踪它们。

- **Webhooks** ——设置 `OCTORYN_SCOUT_WEBHOOK_URLS`（逗号列表）即可将事件作为
  JSON POST 转发出去。当设置了 `OCTORYN_SCOUT_WEBHOOK_SECRET` 时，每次投递都会携带一个
  `x-octoryn-signature: sha256=<hmac>` 头用于验证；投递会以
  退避 (backoff) 方式重试，最多 `OCTORYN_SCOUT_WEBHOOK_MAX_ATTEMPTS` 次，并记录在 `GET /webhooks`。
  用 `OCTORYN_SCOUT_WEBHOOK_EVENTS` 过滤哪些事件触发。这闭合了
  人在回路 (human-in-the-loop)：一个 `approval.requested` webhook 可以呼叫一位审核者。
- **计划刷新** ——在 `OCTORYN_SCOUT_SCHEDULE_ENABLED=true` 时，一个后台扫描
  每 `OCTORYN_SCOUT_REFRESH_INTERVAL_MS` 重新摄取超过
  `OCTORYN_SCOUT_STALENESS_MAX_AGE_DAYS` 的快照（每轮至多 `OCTORYN_SCOUT_REFRESH_LIMIT` 个），
  以保持知识库新鲜。可用 `POST /admin/refresh` 或
  `cli refresh` 手动触发。

## Discovery & interaction

- **`POST /map`**（或 `cli map`）——对一个站点的快速 URL 发现：从站点地图与
  根页面链接播种 (seed)、去重、按同源/子域名以及 `includePaths` /
  `excludePaths` / `search` 过滤，并以 `limit` 封顶。不做按 URL 抓取——这是一张廉价的地图。
- **抓取前 actions (Pre-scrape actions)** ——`/scrape` 与 `/render` 接受一个 `actions` 数组，在浏览器渲染
  捕获 DOM 之前按顺序执行：`wait`、`waitForSelector`、`click`、
  `scroll`、`type`、`press`、`screenshot`（每个 action 的截图返回在
  `actionScreenshots` 中）。适用于 cookie 横幅、"加载更多"以及标签页内容。
- **Stealth-plus（增强隐身）** ——`OCTORYN_SCOUT_STEALTH=true` 以全面的、
  手写（零依赖）的反检测方式渲染：真实的 Chrome UA + UA-CH 头部、
  locale/时区/视口、隐藏自动化启动标志，以及一个 init 脚本来修补
  `navigator.webdriver`/`languages`/`plugins`、桩掉 `window.chrome`、并伪造 WebGL
  vendor/renderer + `hardwareConcurrency`。`OCTORYN_SCOUT_EXTRA_HEADERS`（JSON）在
  静态抓取与渲染两条路径上都注入自定义头部。
- **BYO proxy（自带代理）** ——`OCTORYN_SCOUT_PROXY_URLS`（逗号列表，`http://user:pass@host:port`）
  以轮询轮转 (round-robin) 的方式将请求经由你的代理路由：渲染路径上是 Playwright 原生支持，
  静态路径上是手写的 `node:net`/`node:tls` **CONNECT 隧道**（零依赖）。自带你的代理——
  这里没有托管代理池。
- **JS 挑战处理** ——Cloudflare 风格的"Just a moment"过渡页会被检测到，
  并由真实浏览器执行该挑战来等待通过（不做破解）。`FetchProvider`
  是一个可插拔的接缝 (seam)（目前是 `LocalFetchProvider`），为未来的后端预留。
- **CAPTCHA** ——存在一个 `CaptchaSolver` 接缝，但只附带一个 `NoopCaptchaSolver`
  占位实现（TODO）。破解现代 CAPTCHA 需要外部服务/模型，因此
  有意未内置。
- **超出范围（有意为之）：** 托管代理池以及对抗级 (adversarial-grade) 的反爬虫
  规避。上述的隐身 + 自带代理 + 等待挑战已能应对日常网络的大部分场景；
  对于躲在激进反机器人防御或 CAPTCHA 之后的硬目标，则不作保证。

## Security

- **SSRF 防护** ——每一次出站抓取/渲染都经过一个 URL 守卫，它会
  拒绝非 `http(s)` 协议，以及任何解析到私有/回环/链路本地 (link-local)
  地址（包括云元数据 IP `169.254.169.254`）的主机，通过检查_已解析_的 IP
  来挫败 DNS 重绑定 (DNS-rebinding)。按环境用
  `OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=true` 覆盖（用于 localhost 开发/测试），或用
  `OCTORYN_SCOUT_HOST_ALLOWLIST` / `_BLOCKLIST` 限定范围。
- **内容限制** ——超过 `OCTORYN_SCOUT_MAX_CONTENT_BYTES` 的响应会被拒绝
  （流式读取提前中止），且只处理 `OCTORYN_SCOUT_ALLOWED_CONTENT_TYPES`；
  正文会依据 content-type 头部做字符集解码。
- **API-key 认证** ——见上面的 Access control；`/governance`、`/audit` 与 `/admin`
  的读/写在 `write` 模式下受保护。

## MCP server (Claude & Codex)

引擎附带一个 MCP stdio 服务器，暴露八个工具——`octoryn_scrape`、
`octoryn_crawl`、`octoryn_map`、`octoryn_export`、`octoryn_ingest`、
`octoryn_ingest_site`、`octoryn_search`、`octoryn_extract`——这样智能体就能直接抓取、爬取、
绘制地图、摄取、**对受治理的知识库做语义检索**，并运行结构化
抽取。

```bash
npm run build         # produces dist/mcp.js
npx octopus-scout-mcp  # or: node dist/mcp.js
```

开箱即用、可直接粘贴的配置位于 [`docs/mcp/`](docs/mcp/)（Claude Code `.mcp.json`、
Claude Desktop、Codex `config.toml`）；完整指南见 [docs/MCP.zh-CN.md](docs/MCP.zh-CN.md)。

## Governance Defaults

引擎默认遵循 `robots.txt`、施加按域名的限流、记录
内容哈希与来源元数据、从抽取出的 Markdown 创建引用锚点，
并赋予一个基础的来源信任度评分。

医疗/法律/金融类内容会被标记为 `requires_approval`：会创建一条待定的
`ApprovalRecord`，页面会等待人工通过
`/governance/approvals/:id/decision`（或 `cli approve/reject`）做出决定。每一次抓取、审批
请求与决定都会被写入只追加的**审计轨迹**（`/audit`）。
`OCTORYN_SCOUT_APPROVAL_MODE`（`off` | `flag` | `enforce`）控制门控的严格程度。

对未变更内容的重新抓取会按内容哈希**去重**，而每个不同的
版本都会作为可查询的快照保留（`/versions?url=`）。

这些策略有意保持保守，且易于替换为更严格的 Octoryn 治理规则。

## Contributing

参见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) 了解环境搭建与本地检查门禁
（`typecheck` + `format:check` + `test`）。安全问题：请遵循
[SECURITY.zh-CN.md](SECURITY.zh-CN.md)，而不要公开提 issue。

## License

[Apache-2.0](LICENSE) © Octoryn。一个宽松许可证——可在其条款下使用、修改和分发
（包括用于商业与闭源产品），但你必须保留许可证与署名声明。
