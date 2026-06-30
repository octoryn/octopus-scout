[English](MCP.md) | **简体中文**

# Octopus Scout MCP 服务器

`octopus-scout` 附带一个 [MCP](https://modelcontextprotocol.io) 服务器，将其
受治理的 Web 摄取与知识检索引擎以工具形式暴露出来，供任意 MCP 客户端
（Claude Code、Claude Desktop、Codex CLI 等）调用。它通过 stdio 进行 MCP 通信，
因此客户端会将其作为子进程启动，并通过 stdin/stdout 与之通信。

- 服务器名称：`octopus-scout`
- 版本：`0.1.0`
- 传输方式：stdio（`StdioServerTransport`）

## 工具

| 工具                  | 功能                                                                                   | 关键输入                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `octoryn_scrape`      | 将一个 URL 抓取为受治理的 Markdown/JSON，并带有证据锚点 (evidence anchors)。           | `url`（必填）、`render`（`auto`\|`static`\|`browser`）、`forceRefresh`                              |
| `octoryn_crawl`       | 从根 URL 爬取站点，按深度界限跟随链接，返回一个 CrawlResult。                          | `url`（必填）、`maxDepth`、`maxPages`                                                               |
| `octoryn_map`         | 通过站点地图 (sitemap) 与根页面链接快速发现站点 URL，无需逐页抓取。                    | `url`（必填）、`limit`、`search`、`includeSubdomains`、`useSitemap`、`includePaths`、`excludePaths` |
| `octoryn_export`      | 抓取一个 URL 并构建带证据、可选嵌入 (embeddings) 的分块 RAG 文档。                     | `url`（必填）、`embed`                                                                              |
| `octoryn_ingest`      | 抓取、分块、嵌入并将一个 URL 索引进向量库 (vector store) 以供检索。                    | `url`（必填）、`maxTokens`、`overlapTokens`、`forceRefresh`                                         |
| `octoryn_ingest_site` | 从根 URL 爬取整个站点，并将每个页面索引进向量库。                                      | `url`（必填）、`maxDepth`、`maxPages`、`maxTokens`、`overlapTokens`                                 |
| `octoryn_search`      | 在已索引的知识上进行语义搜索，返回最匹配的若干分块。                                   | `query`（必填）、`topK`、`url`、`minTrust`、`includeBlocked`                                        |
| `octoryn_extract`     | 抓取一个 URL，并经由某个 LLM 提供方将结构化数据提取进调用方提供的 JSON 模式 (schema)。 | `url`（必填）、`schema`（必填）、`prompt`、`forceRefresh`                                           |

每个工具都将其结果作为单个文本内容块返回，其中包含
美化打印的 JSON。失败会以 MCP 工具错误的形式呈现。

## 构建与运行

首先将 TypeScript 源码构建到 `dist/`：

```bash
npm run build
```

随后可用以下任一方式运行服务器：

```bash
npx octopus-scout-mcp     # uses the bin mapping (octopus-scout-mcp -> dist/mcp.js)
node dist/mcp.js          # run the built file directly
npm run mcp               # run from source via tsx (no build needed)
```

服务器读写 stdin/stdout，单独运行时自身不会打印任何有用信息——
请将 MCP 客户端指向它，而不要交互式地运行它。

## 环境变量

在没有任何配置时，服务器也能优雅降级（回退到本地
数据目录与一个桩 (stub) 嵌入提供方）。常用变量：

- `OCTORYN_SCOUT_DATA_DIR`——快照、审计日志以及本地向量库
  的存放位置（默认 `.octoryn-scout`）。
- `OCTORYN_SCOUT_EMBEDDING_PROVIDER`——`stub`（默认）、`voyage` 或 `openai`。
- `OPENAI_API_KEY`——当嵌入提供方为 `openai` 时必填。
- `VOYAGE_API_KEY`——当嵌入提供方为 `voyage` 时必填。
- `DATABASE_URL`——用于共享向量库的 Postgres（pgvector）连接字符串。
- `REDIS_URL`——用于队列/调度器的 Redis 连接字符串。

## 客户端配置

在下面的每个片段中，请将 `/absolute/path/to/octopus-scout/dist/mcp.js`
替换为你构建产物的真实绝对路径。每份配置的可直接粘贴副本
都与本文档放在一起：

- `docs/mcp/claude_code.mcp.json`
- `docs/mcp/claude_desktop.json`
- `docs/mcp/codex.config.toml`

### (a) Claude Code——`.mcp.json`

在你的项目根目录创建一个 `.mcp.json`（或合并进现有文件）：

```json
{
  "mcpServers": {
    "octopus-scout": {
      "command": "node",
      "args": ["/absolute/path/to/octopus-scout/dist/mcp.js"],
      "env": {
        "OCTORYN_SCOUT_DATA_DIR": "/absolute/path/to/octopus-scout/.octoryn-scout",
        "OPENAI_API_KEY": "sk-...",
        "OCTORYN_SCOUT_EMBEDDING_PROVIDER": "openai"
      }
    }
  }
}
```

### (b) Claude Desktop——`claude_desktop_config.json`

在你的 Claude Desktop 配置文件
（macOS 上为 `~/Library/Application Support/Claude/claude_desktop_config.json`）
的 `mcpServers` 下添加同样的服务器块：

```json
{
  "mcpServers": {
    "octopus-scout": {
      "command": "node",
      "args": ["/absolute/path/to/octopus-scout/dist/mcp.js"],
      "env": {
        "OCTORYN_SCOUT_DATA_DIR": "/absolute/path/to/octopus-scout/.octoryn-scout",
        "OPENAI_API_KEY": "sk-...",
        "OCTORYN_SCOUT_EMBEDDING_PROVIDER": "openai"
      }
    }
  }
}
```

编辑该文件后请重启 Claude Desktop。

### (c) Codex CLI——`~/.codex/config.toml`

将以下表添加到 `~/.codex/config.toml`：

```toml
[mcp_servers.octopus-scout]
command = "node"
args = ["/absolute/path/to/octopus-scout/dist/mcp.js"]

[mcp_servers.octopus-scout.env]
OCTORYN_SCOUT_DATA_DIR = "/absolute/path/to/octopus-scout/.octoryn-scout"
OPENAI_API_KEY = "sk-..."
OCTORYN_SCOUT_EMBEDDING_PROVIDER = "openai"
```
